/**
 * `ingestion.process_signals` (Step H6-F4; design H6-F0 §9, §10, §12–§14): the tenant half of webhook signals, in ONE
 * workspace-scoped MAIN transaction. DB planning only — no credential, no provider call, no raw body, no hint text.
 *
 * Routed hint ({connected_account_id, provider_event_hint_id}):
 *   1. the 0022 worker definer returns the hint's identifiers only if it was ROUTED and its (platform, asset) is THIS
 *      workspace's ACTIVE account (else SKIPPED_ACCOUNT_INACTIVE / SKIPPED_HINT_UNAVAILABLE: no mark, no work);
 *   2. canonical lookups by (workspace, platform, provider id) — ownership by THIS account, never inferred from the hint;
 *   3. the capability is re-checked for the exact scope (a signal never elevates it; Instagram replies stay unread);
 *   4. the closed matrix (§12) picks ONE action: a relist / account mark (then the shared review requests, absorbs,
 *      defers or schedules), an H6-E confirmation (one per routed hint: a redelivery requests nothing new), or a
 *      SKIPPED_* outcome;
 *   5. a paused provider RETAINS the signal: its mark is kept and revisited (a confirmation becomes a relist mark of
 *      its canonical content — the only durable deferral; the pause never turns a valid signal into nothing).
 * Due mark ({connected_account_id}): the shared review of the account's currently pending marks.
 *
 * Duplicate deliveries converge: one pending mark per (account, kind, content) and one open run per account (database
 * authority); a redelivery may only count the signal again and move its last-signal time later (never earlier).
 */
import type { CorrelationId } from "@/domain/correlation";
import { coveredInteractionKinds } from "@/modules/coverage";
import { SIGNAL_RUNTIME, classifySignal, signalConfirmationDispatchKey, type SignalAction, type SignalMarkKind, type SignalOutcome } from "../domain/signals";
import { availabilityInput, gate, providerPaused } from "./authority-gate";
import { requestInteractionConfirmation } from "./confirm-interaction";
import type { ReconciliationClock, ReconciliationScope } from "./reconciliation-scope";
import { reviewSignalMarks } from "./signal-marks";

export interface SignalInvocation {
  readonly connectedAccountId: string;
  /** Null for a due-mark invocation (the router's sweep names the account only). */
  readonly providerEventHintId: string | null;
  readonly correlationId: CorrelationId;
}

export interface SignalResult {
  readonly outcome: SignalOutcome;
  /** Marks deleted because they expired (signal.mark_expired). */
  readonly expired: number;
  /** A new-interaction signal named content that is not canonical (signal.content_not_canonical). */
  readonly contentNotCanonical: boolean;
  /** A redelivered signal: its confirmation was already requested (nothing appended). */
  readonly coalesced: boolean;
}

const VALIDATED_SCOPE = { contentKind: "post", source: "unknown" } as const;
const result = (outcome: SignalOutcome, extra: Partial<SignalResult> = {}): SignalResult => ({ outcome, expired: 0, contentNotCanonical: false, coalesced: false, ...extra });

export async function processProviderSignal(scope: ReconciliationScope, clock: ReconciliationClock, input: SignalInvocation): Promise<SignalResult> {
  if (input.providerEventHintId === null) {
    const review = await reviewSignalMarks(scope, clock, input.connectedAccountId);
    return result(review.outcome, { expired: review.expired });
  }

  // 1. The routed hint, re-derived for THIS workspace's ACTIVE account by the 0022 boundary (identifiers + enums only).
  const hint = await scope.signals.routedHint(input.providerEventHintId, input.connectedAccountId);
  if (hint.outcome === "account_inactive") return result("SKIPPED_ACCOUNT_INACTIVE");
  if (hint.outcome === "not_found") return result("SKIPPED_HINT_UNAVAILABLE");
  const account = await scope.authority.account(input.connectedAccountId);
  if (account?.status !== "ACTIVE" || account.platform !== hint.platform) return result("SKIPPED_ACCOUNT_INACTIVE");
  const now = clock.now();
  const expired = await scope.signals.deleteExpired(account.id, now);

  // 2. Canonical state of the bound workspace, by platform + provider id; ownership is THIS account's or nothing.
  const interaction = hint.targetKind === "interaction" ? await scope.ingestion.interactions.findByKey(account.platform, hint.providerTargetId) : undefined;
  const interactionOfAccount = interaction !== undefined && interaction.connectedAccountId === account.id;
  const canonicalInteraction = interactionOfAccount && interaction.observed && interaction.kind !== null ? { id: interaction.id, contentItemId: interaction.contentItemId } : null;
  const contentProviderId = hint.targetKind === "content" ? hint.providerTargetId : (hint.providerContentId ?? (interactionOfAccount ? interaction.providerContentId : null));
  const content = contentProviderId === null ? undefined : await scope.ingestion.content.findByProviderId(account.platform, contentProviderId);
  const contentOwnershipMismatch = (content !== undefined && content.connectedAccountId !== account.id) || (interaction !== undefined && !interactionOfAccount);

  // 3. The capability now, for the exact scope (as if not paused: a pause retains the signal, step 5).
  const capabilities = hint.targetKind === "content" ? (["read_content", "read_interactions"] as const) : (["read_interactions"] as const);
  let repliesReadable = false;
  for (const capability of capabilities) {
    const kind = hint.targetKind === "content" || content === undefined || contentOwnershipMismatch ? VALIDATED_SCOPE.contentKind : content.contentKind;
    const source = hint.targetKind === "content" || content === undefined || contentOwnershipMismatch ? VALIDATED_SCOPE.source : content.reportedSource;
    const checked = await gate(scope, account.id, capability, kind, source, { ignorePause: true });
    if (checked.kind === "blocked") {
      const inactive = checked.failureClass === "account_not_found" || checked.failureClass === "account_inactive" || checked.failureClass === "connection_removed";
      return result(inactive ? "SKIPPED_ACCOUNT_INACTIVE" : "SKIPPED_CAPABILITY", { expired });
    }
    if (capability === "read_interactions") repliesReadable = coveredInteractionKinds(availabilityInput(checked.availability)).includes("reply");
  }

  // 4. The closed matrix over canonical state.
  const action: SignalAction = classifySignal({
    targetKind: hint.targetKind,
    change: hint.change,
    isReply: hint.targetKind === "interaction" && hint.providerParentId !== null,
    canonicalInteraction,
    canonicalContent: content === undefined || contentOwnershipMismatch ? null : { id: content.id },
    contentOwnershipMismatch,
    repliesReadable,
  });
  const paused = await providerPaused(scope, account.platform);
  if (action.kind === "skip") return result(action.outcome, { expired });

  if (action.kind === "confirm") {
    if (paused) return retain(scope, clock, account, "relist", action.contentItemId, now, expired);
    const confirmation = await requestInteractionConfirmation(scope, clock, {
      interactionId: action.interactionId,
      correlationId: input.correlationId,
      dispatchKey: signalConfirmationDispatchKey(action.interactionId, input.providerEventHintId),
    });
    if (confirmation.kind === "not_found" || confirmation.kind === "not_eligible") {
      return result(action.removal ? "SKIPPED_NON_CANONICAL_REMOVAL" : "SKIPPED_CONTENT_NOT_CANONICAL", { expired });
    }
    return result("PLANNED_CONFIRMATION", { expired, coalesced: confirmation.kind === "coalesced" });
  }

  const kind: SignalMarkKind = action.kind;
  const contentItemId = action.kind === "relist" ? action.contentItemId : null;
  const contentNotCanonical = action.kind === "account" && action.contentNotCanonical;
  if (paused) return { ...(await retain(scope, clock, account, kind, contentItemId, now, expired)), contentNotCanonical };
  await upsertMark(scope, clock, account, kind, contentItemId, now);
  const review = await reviewSignalMarks(scope, clock, account.id, now);
  return result(review.outcome, { expired: expired + review.expired, contentNotCanonical });
}

type AccountRef = { readonly id: string; readonly organizationId: string; readonly workspaceId: string };

async function upsertMark(scope: ReconciliationScope, clock: ReconciliationClock, account: AccountRef, kind: SignalMarkKind, contentItemId: string | null, now: Date): Promise<void> {
  await scope.signals.upsert({
    id: clock.newId(),
    organizationId: account.organizationId,
    workspaceId: account.workspaceId,
    connectedAccountId: account.id,
    kind,
    contentItemId,
    signalAt: now,
    expiresAt: new Date(now.getTime() + SIGNAL_RUNTIME.markTtlMs),
  }, now);
}

/** A paused provider: the signal is kept as its mark and revisited after the pause (never requested now). */
async function retain(scope: ReconciliationScope, clock: ReconciliationClock, account: AccountRef, kind: SignalMarkKind, contentItemId: string | null, now: Date, expired: number): Promise<SignalResult> {
  await upsertMark(scope, clock, account, kind, contentItemId, now);
  await scope.signals.deferAll(account.id, new Date(now.getTime() + SIGNAL_RUNTIME.revisitMs), now);
  return result("SKIPPED_PAUSED", { expired });
}
