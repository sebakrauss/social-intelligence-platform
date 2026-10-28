/**
 * Confirm marks: bounded coalescing of stored-interaction confirmations (Step H6-F4d; TL D-F4B-3 … D-F4B-5; migration
 * 0023). Application services over ONE workspace-scoped job transaction (MAIN, DB only): no provider call ever.
 *
 *   noteConfirmationSignal   a change/removal signal of a CANONICAL interaction upserts its one confirm mark (DB-time
 *                            signal times; the count and the last signal only move forward), then — unless the provider
 *                            is paused (the mark is then retained with a revisit) — asks the database for a claim.
 *   claimAndRequest          ingestion.claim_signal_confirmation decides, under the mark's row lock: `claimed` → the ONE
 *                            H6-E confirmation of that generation is appended to the outbox IN THE SAME TRANSACTION
 *                            (dispatch key per mark lifetime and generation: a crash can't separate the claim from its
 *                            work); `cooling_down` → nothing (the signal already coalesced into the mark); `caught_up`
 *                            → the newest signal was already re-read after it: the mark is deleted, no provider call;
 *                            `expired` → deleted (the system expiry would too). TypeScript never re-decides any of this.
 *   reviewDueConfirmations   the due-mark path: at most `confirmReviewLimit` due confirm marks are claimed per
 *                            invocation; any left over get a short revisit so the router's sweep comes back for them.
 * Confirmation marks schedule reads only: what counts as provider truth stays H6-E's (stored provenance, no bare-id
 * reread, Meta 100/33 ambiguous, no webhook removal authority).
 */
import type { CorrelationId } from "@/domain/correlation";
import { SIGNAL_RUNTIME, signalConfirmationDispatchKey } from "../domain/signals";
import { requestInteractionConfirmation } from "./confirm-interaction";
import type { ReconciliationClock, ReconciliationScope } from "./reconciliation-scope";

export interface AccountRef {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}

export type ClaimResult =
  | { readonly kind: "requested"; readonly generation: number }
  | { readonly kind: "coalesced" }
  | { readonly kind: "caught_up" }
  | { readonly kind: "expired" }
  | { readonly kind: "not_eligible" }
  | { readonly kind: "not_found" };

/** A short revisit for due confirm marks this invocation did not reach (bounded work per task). */
const LEFTOVER_REVISIT_MS = 60 * 1000;

export async function claimAndRequest(scope: ReconciliationScope, clock: ReconciliationClock, account: AccountRef, interactionId: string, correlationId: CorrelationId): Promise<ClaimResult> {
  const claim = await scope.signals.claimConfirmation(account.id, interactionId);
  if (claim.outcome === "not_found") return { kind: "not_found" };
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "cooling_down") return { kind: "coalesced" };
    await scope.signals.drop([claim.markId]);
    return { kind: claim.outcome };
  }
  const requested = await requestInteractionConfirmation(scope, clock, {
    interactionId,
    correlationId,
    dispatchKey: signalConfirmationDispatchKey(claim.markId, claim.generation),
  });
  if (requested.kind === "not_found" || requested.kind === "not_eligible") {
    // The canonical target can no longer be re-read (gone or a placeholder): nothing could ever satisfy the mark.
    await scope.signals.drop([claim.markId]);
    return { kind: "not_eligible" };
  }
  return requested.kind === "requested" ? { kind: "requested", generation: claim.generation } : { kind: "coalesced" };
}

export async function noteConfirmationSignal(
  scope: ReconciliationScope,
  clock: ReconciliationClock,
  input: { readonly account: AccountRef; readonly interactionId: string; readonly contentItemId: string; readonly correlationId: CorrelationId; readonly paused: boolean },
): Promise<ClaimResult | { readonly kind: "paused" }> {
  await scope.signals.upsertConfirm({
    id: clock.newId(),
    organizationId: input.account.organizationId,
    workspaceId: input.account.workspaceId,
    connectedAccountId: input.account.id,
    contentItemId: input.contentItemId,
    interactionId: input.interactionId,
  });
  if (input.paused) {
    // Retained, not claimed: the due-mark sweep reconsiders it after the revisit.
    const due = await scope.signals.dueConfirmations(input.account.id, SIGNAL_RUNTIME.confirmReviewLimit);
    await scope.signals.deferConfirmations(due.filter((mark) => mark.interactionId === input.interactionId).map((mark) => mark.id), SIGNAL_RUNTIME.revisitMs);
    return { kind: "paused" };
  }
  const first = await claimAndRequest(scope, clock, input.account, input.interactionId, input.correlationId);
  if (first.kind !== "expired") return first;
  // A week-old mark expired under this signal: the signal starts a fresh mark (and its immediate claim).
  await scope.signals.upsertConfirm({
    id: clock.newId(),
    organizationId: input.account.organizationId,
    workspaceId: input.account.workspaceId,
    connectedAccountId: input.account.id,
    contentItemId: input.contentItemId,
    interactionId: input.interactionId,
  });
  return claimAndRequest(scope, clock, input.account, input.interactionId, input.correlationId);
}

export interface ConfirmationReview {
  readonly requested: number;
  readonly coalesced: number;
  readonly caughtUp: number;
  readonly expired: number;
  readonly notEligible: number;
  readonly deferred: number;
}

export async function reviewDueConfirmations(scope: ReconciliationScope, clock: ReconciliationClock, account: AccountRef, correlationId: CorrelationId): Promise<ConfirmationReview> {
  const limit = SIGNAL_RUNTIME.confirmReviewLimit;
  const due = await scope.signals.dueConfirmations(account.id, limit + 1);
  const review = { requested: 0, coalesced: 0, caughtUp: 0, expired: 0, notEligible: 0, deferred: 0 };
  for (const mark of due.slice(0, limit)) {
    const result = await claimAndRequest(scope, clock, account, mark.interactionId, correlationId);
    if (result.kind === "requested") review.requested += 1;
    else if (result.kind === "coalesced") review.coalesced += 1;
    else if (result.kind === "caught_up") review.caughtUp += 1;
    else if (result.kind === "expired") review.expired += 1;
    else if (result.kind === "not_eligible") review.notEligible += 1;
  }
  if (due.length > limit) {
    // More due than one invocation claims: the rest get a short revisit (bounded work; the sweep continues).
    const rest = await scope.signals.dueConfirmations(account.id, 500);
    await scope.signals.deferConfirmations(rest.map((mark) => mark.id), LEFTOVER_REVISIT_MS);
    review.deferred = rest.length;
  }
  return review;
}
