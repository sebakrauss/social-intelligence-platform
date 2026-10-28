/**
 * Webhook-signal marks: review, the run close hook and the relist planner (Step H6-F4; design H6-F0 §9, §13; D-F5 = B).
 * Application services over ONE workspace-scoped job transaction; no provider, no credential, no hint, no body.
 *
 *   reviewSignalMarks   the ONE decision for an account's pending marks, used by the routed-hint path, the due-mark
 *                       path and the close hook: expired marks are deleted (signal.mark_expired; nothing else changes);
 *                       an open run ABSORBS them (its close hook revisits; a 15-minute revisit is the safety net); the
 *                       account's authority is re-checked (paused → retained and revisited; inactive → dropped;
 *                       otherwise blocked → retained and revisited hourly); the hourly cap (6 signal runs) DEFERS; a
 *                       run that could not yet satisfy the lead mark (120 s skew rule) is scheduled for the instant it
 *                       could; otherwise exactly one run is requested through the 0019/0022 boundary — plan `account`
 *                       when an account mark is pending, else `relist` — with the 10-operation signal budget and the
 *                       correlation `sig.{lead mark}`. Every pending mark then carries a revisit time: the invariant is
 *                       that a pending mark is always either covered by an open run or due for the router's sweep.
 *   closeRunSignals     inside the transaction that closes a run (every finishRun): deletes the relist marks of every
 *                       content the run traversed to the provider's end, and the account mark of a COMPLETED account
 *                       run, when their last signal is ≤ the run's start − 120 s; then reviews what is left (at most one
 *                       follow-up run: the one-open index is the authority).
 *   planRelistSlices    a relist run's planner: no listing slice; one content_interactions slice per pending relist
 *                       mark it can satisfy (≤ 10, oldest first), each re-validated (canonical, this account's, readable
 *                       for its exact scope) and windowed exactly like an account run's content (watermark − overlap →
 *                       run start).
 * A mark is never satisfied by a request, a slice's creation, a first page, a receipt or a webhook time.
 */
import { SIGNAL_RUNTIME, decideFollowUp, satisfactionBoundary, signalRunBudget, signalRunCorrelation, type SignalOutcome, type SignalRunPlan } from "../domain/signals";
import { gate } from "./authority-gate";
import type { ReconciliationRunRecord } from "./reconciliation-ports";
import type { ReconciliationClock, ReconciliationScope } from "./reconciliation-scope";
import { insertContentTraversal } from "./traversal";

/** The validated read scope (H6-A1: post · unknown) — the account-level authority of a signal run. */
const VALIDATED_SCOPE = { contentKind: "post", source: "unknown" } as const;

export type ReviewOutcome = Extract<SignalOutcome,
  "PLANNED_RELIST" | "PLANNED_ACCOUNT" | "ABSORBED" | "DEFERRED" | "SKIPPED_PAUSED" | "SKIPPED_CAPABILITY" | "SKIPPED_ACCOUNT_INACTIVE" | "EXPIRED" | "NO_PENDING_MARKS">;

export interface MarkReview {
  readonly outcome: ReviewOutcome;
  readonly expired: number;
  readonly dropped: number;
  /** The run this review requested (traceability only), if any. */
  readonly requestedRunId: string | null;
  /** True when the plan waits for the skew boundary (scheduled through the due-mark sweep, not requested yet). */
  readonly scheduled: boolean;
}

const planned = (plan: SignalRunPlan): ReviewOutcome => (plan === "account" ? "PLANNED_ACCOUNT" : "PLANNED_RELIST");

export async function reviewSignalMarks(scope: ReconciliationScope, clock: ReconciliationClock, connectedAccountId: string, now: Date = clock.now()): Promise<MarkReview> {
  const expired = await scope.signals.deleteExpired(connectedAccountId);
  const result = (outcome: ReviewOutcome, extra: Partial<MarkReview> = {}): MarkReview => ({ outcome, expired, dropped: 0, requestedRunId: null, scheduled: false, ...extra });
  const summary = await scope.signals.summary(connectedAccountId);
  if (summary.count === 0) return result(expired > 0 ? "EXPIRED" : "NO_PENDING_MARKS");

  // One open run per account (0018): it absorbs the marks; its close hook revisits them, the sweep is the safety net.
  if ((await scope.reconciliation.openRun(connectedAccountId)) !== undefined) {
    await scope.signals.deferAll(connectedAccountId, SIGNAL_RUNTIME.revisitMs);
    return result("ABSORBED");
  }

  // The account's authority now (never the hint's): the capabilities the planned run will need, at the validated scope.
  const capabilities = summary.accountMark !== null ? (["read_content", "read_interactions"] as const) : (["read_interactions"] as const);
  for (const capability of capabilities) {
    const checked = await gate(scope, connectedAccountId, capability, VALIDATED_SCOPE.contentKind, VALIDATED_SCOPE.source);
    if (checked.kind === "readable") continue;
    if (checked.failureClass === "provider_paused") {
      await scope.signals.deferAll(connectedAccountId, SIGNAL_RUNTIME.revisitMs);
      return result("SKIPPED_PAUSED");
    }
    if (checked.failureClass === "account_not_found" || checked.failureClass === "account_inactive" || checked.failureClass === "connection_removed") {
      // An account that can never be read again keeps no pending work (no coverage changes: the gap stays truthful).
      const dropped = await dropAll(scope, connectedAccountId);
      return result("SKIPPED_ACCOUNT_INACTIVE", { dropped });
    }
    await scope.signals.deferAll(connectedAccountId, SIGNAL_RUNTIME.blockedRevisitMs);
    return result("SKIPPED_CAPABILITY");
  }

  const runs = await scope.signals.signalRunsSince(connectedAccountId, new Date(now.getTime() - SIGNAL_RUNTIME.runWindowMs));
  const decision = decideFollowUp({ summary, openRun: false, signalRunsInWindow: runs, now });
  if (decision.kind === "none") return result("NO_PENDING_MARKS");
  if (decision.kind === "absorbed") return result("ABSORBED");
  if (decision.kind === "defer") {
    // The decision is on the run clock; the revisit is DB-anchored (DB now + the same delay).
    await scope.signals.deferAll(connectedAccountId, decision.until.getTime() - now.getTime());
    if (decision.reason === "cap") return result("DEFERRED");
    return result(planned(summary.accountMark !== null ? "account" : "relist"), { scheduled: true });
  }

  const requested = await scope.reconciliation.requestRun({
    connectedAccountId,
    correlationId: signalRunCorrelation(decision.leadMarkId),
    requestedAt: now,
    budget: signalRunBudget(decision.plan),
    plan: decision.plan,
  });
  if (requested.outcome === "not_found") {
    const dropped = await dropAll(scope, connectedAccountId);
    return result("SKIPPED_ACCOUNT_INACTIVE", { dropped });
  }
  // A concurrent request won the one-open index: the marks wait for that run (exactly one run, never two).
  await scope.signals.deferAll(connectedAccountId, SIGNAL_RUNTIME.revisitMs);
  if (requested.outcome === "already_running") return result("ABSORBED");
  // Traceability only: which marks this run was requested for (never satisfaction).
  const linked = decision.plan === "account"
    ? [decision.leadMarkId]
    : (await scope.signals.relistCandidates(connectedAccountId, satisfactionBoundary(now), SIGNAL_RUNTIME.relistContentsPerRun)).map((mark) => mark.id);
  await scope.signals.linkRun(linked, requested.runId, now);
  return result(planned(decision.plan), { requestedRunId: requested.runId });
}

async function dropAll(scope: ReconciliationScope, connectedAccountId: string): Promise<number> {
  // Bounded: an account holds one account mark and at most one relist mark per canonical content.
  let dropped = 0;
  for (;;) {
    const marks = await scope.signals.relistCandidates(connectedAccountId, new Date(8.64e15), 500);
    if (marks.length === 0) break;
    dropped += await scope.signals.drop(marks.map((mark) => mark.id));
  }
  const summary = await scope.signals.summary(connectedAccountId);
  if (summary.accountMark !== null) dropped += await scope.signals.drop([summary.accountMark.id]);
  return dropped;
}

export interface RunCloseResult {
  readonly satisfiedRelist: number;
  readonly satisfiedAccount: number;
  readonly review: MarkReview;
}

/** The close hook: same transaction as the run's terminal state (called right after finishRun succeeded). */
export async function closeRunSignals(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord,
  finalState: "COMPLETED" | "PARTIAL" | "SKIPPED_UNAVAILABLE" | "FAILED", now: Date): Promise<RunCloseResult> {
  let satisfiedRelist = 0;
  let satisfiedAccount = 0;
  // A run that never started (SKIPPED_UNAVAILABLE) traversed nothing and satisfies nothing.
  if (run.startedAt !== null && finalState !== "SKIPPED_UNAVAILABLE") {
    // H6-F4d: each traversal satisfies by ITS OWN window end — a continued traversal's is its original start, so it
    // never satisfies a signal that arrived after that traversal began.
    const traversals = await scope.reconciliation.completedContentTraversals(run.id);
    satisfiedRelist = await scope.signals.satisfyRelist(run.connectedAccountId,
      traversals.map((traversal) => ({ contentItemId: traversal.contentItemId, boundary: satisfactionBoundary(traversal.windowEnd) })));
    // Discovery is satisfied only by an account-plan traversal that completed (listing and every content slice), as of
    // the OLDEST traversal start it contains.
    if (run.plan === "account" && finalState === "COMPLETED") {
      const asOf = Math.min(run.startedAt.getTime(), ...traversals.map((traversal) => traversal.windowEnd.getTime()));
      satisfiedAccount = await scope.signals.satisfyAccount(run.connectedAccountId, satisfactionBoundary(new Date(asOf)));
    }
  }
  const review = await reviewSignalMarks(scope, clock, run.connectedAccountId, now);
  return { satisfiedRelist, satisfiedAccount, review };
}

/** A relist run's content slices (no listing). Returns the slices created and the marks dropped as unreadable. */
export async function planRelistSlices(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, startedAt: Date): Promise<{ readonly created: number; readonly dropped: number }> {
  const candidates = await scope.signals.relistCandidates(run.connectedAccountId, satisfactionBoundary(startedAt), Math.min(run.budget.contentItems, SIGNAL_RUNTIME.relistContentsPerRun));
  const unreadable: string[] = [];
  let created = 0;
  for (const mark of candidates) {
    const content = await scope.ingestion.content.findById(mark.contentItemId);
    // Ownership is re-validated (the composite FK already refuses another account's content): fail closed.
    if (content === undefined || content.connectedAccountId !== run.connectedAccountId) {
      unreadable.push(mark.id);
      continue;
    }
    // A signal never elevates capability: the content's exact scope must be readable now.
    const checked = await gate(scope, run.connectedAccountId, "read_interactions", content.contentKind, content.reportedSource);
    if (checked.kind === "blocked") {
      if (checked.accountLevel) break;
      unreadable.push(mark.id);
      continue;
    }
    // H6-F4d: the one traversal helper — a parked continuation of this content is adopted with its ORIGINAL window.
    await insertContentTraversal(scope, clock, { run, contentItemId: content.id, startedAt, base: startedAt, order: created });
    created += 1;
  }
  const dropped = await scope.signals.drop(unreadable);
  return { created, dropped };
}
