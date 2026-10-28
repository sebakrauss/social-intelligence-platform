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
 *      defers or schedules), a CONFIRM mark of the canonical interaction (H6-F4d: one durable mark coalesces every
 *      change/removal signal; the database's claim decides whether ONE H6-E confirmation is requested now, in this
 *      transaction), or a SKIPPED_* outcome;
 *   5. a paused provider RETAINS the signal: its mark (relist, account or confirm) is kept and revisited.
 * Due mark ({connected_account_id}): the account's due confirm marks (bounded claims; direct-read authority, never a
 * run) and then the shared review of its account/relist marks (account > relist priority applies there only).
 *
 * Duplicate deliveries converge: one pending mark per (account, kind, content) and one open run per account (database
 * authority); a redelivery may only count the signal again and move its last-signal time later (never earlier).
 */
import type { CorrelationId } from "@/domain/correlation";
import { coveredInteractionKinds } from "@/modules/coverage";
import { SIGNAL_RUNTIME, classifySignal, type SignalAction, type SignalMarkKind, type SignalOutcome } from "../domain/signals";
import { availabilityInput, gate, providerPaused } from "./authority-gate";
import { noteConfirmationSignal, reviewDueConfirmations, type AccountRef } from "./confirm-marks";
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
  /** The signal coalesced into a confirm mark whose confirmation is already pending or cooling down (nothing appended). */
  readonly coalesced: boolean;
  /** H6-E confirmations this invocation requested (each in the same transaction as its claim). */
  readonly confirmationsRequested: number;
}

const VALIDATED_SCOPE = { contentKind: "post", source: "unknown" } as const;
const result = (outcome: SignalOutcome, extra: Partial<SignalResult> = {}): SignalResult => ({ outcome, expired: 0, contentNotCanonical: false, coalesced: false, confirmationsRequested: 0, ...extra });

export async function processProviderSignal(scope: ReconciliationScope, clock: ReconciliationClock, input: SignalInvocation): Promise<SignalResult> {
  if (input.providerEventHintId === null) {
    // Confirmations first (their own bounded lifecycle; MAIN only appends H6-E work), then account/relist marks.
    const owner = await scope.authority.account(input.connectedAccountId);
    const confirmations = owner?.status === "ACTIVE" ? await reviewDueConfirmations(scope, clock, owner, input.correlationId) : undefined;
    const review = await reviewSignalMarks(scope, clock, input.connectedAccountId);
    const requested = confirmations?.requested ?? 0;
    const idle = review.outcome === "NO_PENDING_MARKS" || review.outcome === "EXPIRED";
    return result(idle && requested > 0 ? "PLANNED_CONFIRMATION" : review.outcome, {
      expired: review.expired + (confirmations?.expired ?? 0),
      confirmationsRequested: requested,
      coalesced: (confirmations?.coalesced ?? 0) > 0,
    });
  }

  // 1. The routed hint, re-derived for THIS workspace's ACTIVE account by the 0022 boundary (identifiers + enums only).
  const hint = await scope.signals.routedHint(input.providerEventHintId, input.connectedAccountId);
  if (hint.outcome === "account_inactive") return result("SKIPPED_ACCOUNT_INACTIVE");
  if (hint.outcome === "not_found") return result("SKIPPED_HINT_UNAVAILABLE");
  const account = await scope.authority.account(input.connectedAccountId);
  if (account?.status !== "ACTIVE" || account.platform !== hint.platform) return result("SKIPPED_ACCOUNT_INACTIVE");
  const now = clock.now();
  const expired = await scope.signals.deleteExpired(account.id);

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
    const noted = await noteConfirmationSignal(scope, clock, { account, interactionId: action.interactionId, contentItemId: action.contentItemId, correlationId: input.correlationId, paused });
    if (noted.kind === "paused") return result("SKIPPED_PAUSED", { expired });
    if (noted.kind === "not_eligible") return result(action.removal ? "SKIPPED_NON_CANONICAL_REMOVAL" : "SKIPPED_CONTENT_NOT_CANONICAL", { expired });
    return result("PLANNED_CONFIRMATION", { expired, coalesced: noted.kind !== "requested", confirmationsRequested: noted.kind === "requested" ? 1 : 0 });
  }

  const kind: SignalMarkKind = action.kind;
  const contentItemId = action.kind === "relist" ? action.contentItemId : null;
  const contentNotCanonical = action.kind === "account" && action.contentNotCanonical;
  if (paused) return { ...(await retain(scope, clock, account, kind, contentItemId, now, expired)), contentNotCanonical };
  await upsertMark(scope, clock, account, kind, contentItemId, now);
  const review = await reviewSignalMarks(scope, clock, account.id, now);
  return result(review.outcome, { expired: expired + review.expired, contentNotCanonical });
}

async function upsertMark(scope: ReconciliationScope, clock: ReconciliationClock, account: AccountRef, kind: SignalMarkKind, contentItemId: string | null, now: Date): Promise<void> {
  await scope.signals.upsert({
    id: clock.newId(),
    organizationId: account.organizationId,
    workspaceId: account.workspaceId,
    connectedAccountId: account.id,
    kind,
    contentItemId,
    signalAt: now,
  }, now);
}

/** A paused provider: the signal is kept as its mark and revisited after the pause (never requested now). */
async function retain(scope: ReconciliationScope, clock: ReconciliationClock, account: AccountRef, kind: SignalMarkKind, contentItemId: string | null, now: Date, expired: number): Promise<SignalResult> {
  await upsertMark(scope, clock, account, kind, contentItemId, now);
  await scope.signals.deferAll(account.id, SIGNAL_RUNTIME.revisitMs);
  return result("SKIPPED_PAUSED", { expired });
}
