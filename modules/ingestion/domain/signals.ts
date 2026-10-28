/**
 * Webhook-signal processing vocabulary and rules (Step H6-F4; design H6-F0 §9, §10, §12–§14; TL D-F3 = A, D-F5 = B;
 * migration 0022). Pure. A webhook is a SIGNAL: nothing here is source authority. A signal only ever becomes
 *   - a durable tenant mark (`relist` for one canonical content of the account, `account` for discovery), satisfied
 *     later by an authoritative traversal that started after it; or
 *   - a request for the H6-E stored-interaction confirmation of one canonical interaction; or
 *   - a closed SKIPPED_* outcome.
 * It never creates canonical text or an interaction, never removes, never claims visibility, coverage, a watermark or
 * a conversation.
 */
import { RECONCILIATION_DEFAULTS } from "./reconciliation-slice";
import { type ReconciliationBudgetSnapshot } from "./reconciliation-state";
import { CONFIRM_INTERACTION_TOPIC } from "./confirmation";

/** The MAIN tenant task of one routed hint or one due account (internal topic: produced only by the 0022 system definers). */
export const PROCESS_SIGNALS_TASK = "ingestion.process_signals" as const;

export const SIGNAL_RUNTIME = Object.freeze({
  /** D-F5 = B: every signal-initiated run (account or relist plan) may use at most 10 provider operations. */
  maxOperations: 10,
  /** D-F5 = B: signal-initiated runs per connected account in any rolling hour (manual Sync never counts). */
  runsPerAccountPerHour: 6,
  runWindowMs: 60 * 60 * 1000,
  /** §13.3: a traversal started at S satisfies only marks whose last signal is ≤ S − 120 s (provider skew margin). */
  skewMs: 120 * 1000,
  /** §13.6: a mark expires 7 days after its FIRST signal (never refreshed by later signals). */
  markTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** Revisit of marks waiting on an open run (a safety net beside the close hook) or a paused provider. */
  revisitMs: 15 * 60 * 1000,
  /** Revisit of marks whose account currently refuses the read (capability, connection, profile). */
  blockedRevisitMs: 60 * 60 * 1000,
  /** §9: a relist run reads at most 10 canonical contents (oldest pending mark first) and lists no content. */
  relistContentsPerRun: 10,
  /**
   * An account-plan signal run reads one listing page and at most 9 contents, so that one page per content fits its 10
   * operations; with the ordinary 10 contents it could never complete and its account mark could never be satisfied.
   */
  accountContentItemsPerRun: 9,
  /** Marks the router's due-mark sweep re-dispatches per run (0022 accepts 1..500). */
  dueMarkDispatchLimit: 100,
  /**
   * Step H6-F4d (D-F4B-5): the confirmation cooldown — fixed in ingestion.claim_signal_confirmation (0023); mirrored here
   * only to compute the back-off of non-authoritative reads (pinned equal by test).
   */
  confirmationCooldownMs: 5 * 60 * 1000,
  /** A non-authoritative read (ambiguous, failed, refused) defers the next claim 5 min × 2^(generation − 1), at most 6 h. */
  confirmationBackoffCapMs: 6 * 60 * 60 * 1000,
  /** Due confirm marks one process_signals invocation claims at most (the rest get a revisit and wait for the sweep). */
  confirmReviewLimit: 10,
});

/** The closed outcome of one `ingestion.process_signals` invocation (design §14, plus the cases implementation found). */
export const SIGNAL_OUTCOMES = [
  "PLANNED_RELIST",
  "PLANNED_ACCOUNT",
  "PLANNED_CONFIRMATION",
  "ABSORBED",
  "DEFERRED",
  "SKIPPED_ACCOUNT_INACTIVE",
  "SKIPPED_HINT_UNAVAILABLE",
  "SKIPPED_PAUSED",
  "SKIPPED_CAPABILITY",
  "SKIPPED_CONTENT_NOT_CANONICAL",
  "SKIPPED_NON_CANONICAL_REMOVAL",
  "SKIPPED_UNSUPPORTED",
  "EXPIRED",
  "NO_PENDING_MARKS",
] as const;
export type SignalOutcome = (typeof SIGNAL_OUTCOMES)[number];

export const SIGNAL_MARK_KINDS = ["relist", "account"] as const;
export type SignalMarkKind = (typeof SIGNAL_MARK_KINDS)[number];
export type SignalRunPlan = SignalMarkKind;

export const HINT_CHANGES = ["created", "edited", "removed", "hidden", "unhidden", "updated"] as const;
export type HintChange = (typeof HINT_CHANGES)[number];
export const isHintChange = (value: unknown): value is HintChange => typeof value === "string" && (HINT_CHANGES as readonly string[]).includes(value);

/**
 * Signal-run attribution: the correlation id of a run requested from signals is `sig.{mark id}` (the lead mark — the
 * account mark, else the oldest relist mark). Canonical Wrenkind ids only, never a provider id; with initiator `system`
 * it is what the hourly cap counts. Manual Sync runs are `user`-initiated and never match.
 */
export const SIGNAL_RUN_CORRELATION_PREFIX = "sig." as const;
export const signalRunCorrelation = (markId: string): string => `${SIGNAL_RUN_CORRELATION_PREFIX}${markId}`;

/** The persisted budget of a signal-initiated run: 10 operations (D-F5), the ordinary windows and page limits. */
export function signalRunBudget(plan: SignalRunPlan): ReconciliationBudgetSnapshot {
  return Object.freeze({
    listingPagesPerSlice: RECONCILIATION_DEFAULTS.listingPagesPerSlice,
    interactionPagesPerSlice: RECONCILIATION_DEFAULTS.interactionPagesPerSlice,
    continuationsPerContent: RECONCILIATION_DEFAULTS.continuationsPerContent,
    interactionPagesPerContent: RECONCILIATION_DEFAULTS.interactionPagesPerSlice * (1 + RECONCILIATION_DEFAULTS.continuationsPerContent),
    contentItems: plan === "relist" ? SIGNAL_RUNTIME.relistContentsPerRun : SIGNAL_RUNTIME.accountContentItemsPerRun,
    overlapSeconds: RECONCILIATION_DEFAULTS.overlapMs / 1000,
    maxOperations: SIGNAL_RUNTIME.maxOperations,
  });
}

/**
 * Step H6-F4d (D-F4B-3): the dispatch key of the ONE confirmation a claim of a confirm mark requests — per mark lifetime
 * (its id) and claim generation, canonical ids only. A new mark of the same interaction (after the previous was caught
 * up, expired or deleted) has a new id, so its first claim never collides with a finished confirmation's key.
 */
export function signalConfirmationDispatchKey(markId: string, generation: number): string {
  return `${CONFIRM_INTERACTION_TOPIC}:${markId}:g${String(generation)}`;
}

/** §13.3: whether a traversal that started at `startedAt` satisfies a mark last signalled at `lastSignalAt`. */
export const satisfiesMark = (lastSignalAt: Date, startedAt: Date): boolean => lastSignalAt.getTime() + SIGNAL_RUNTIME.skewMs <= startedAt.getTime();
/** The latest last-signal time a traversal started at `startedAt` satisfies. */
export const satisfactionBoundary = (startedAt: Date): Date => new Date(startedAt.getTime() - SIGNAL_RUNTIME.skewMs);

// ── classification (design §12) ─────────────────────────────────────────────────────────────────────────────
/** What the bound workspace's canonical persistence says about the hint's identifiers (never what the webhook says). */
export interface SignalFacts {
  readonly targetKind: "content" | "interaction";
  readonly change: HintChange;
  /** The hint names a parent interaction (a reply, on both platforms: H6-F1 drops a parent that is the post itself). */
  readonly isReply: boolean;
  /** A canonical OBSERVED interaction of THIS account for the target (placeholders are not canonical). */
  readonly canonicalInteraction: { readonly id: string; readonly contentItemId: string } | null;
  /** A canonical content of THIS account for the hint's content (null: unknown, or the hint named none). */
  readonly canonicalContent: { readonly id: string } | null;
  /** A content with that provider id exists but belongs to ANOTHER account: fail closed. */
  readonly contentOwnershipMismatch: boolean;
  /** The current capability reads replies for the content's scope (Instagram today: REPLIES_NOT_READ → false). */
  readonly repliesReadable: boolean;
}

export type SignalAction =
  | { readonly kind: "relist"; readonly contentItemId: string }
  | { readonly kind: "account"; readonly contentNotCanonical: boolean }
  | { readonly kind: "confirm"; readonly interactionId: string; readonly contentItemId: string; readonly removal: boolean }
  | { readonly kind: "skip"; readonly outcome: Extract<SignalOutcome, `SKIPPED_${string}`> };

/** The frozen matrix (§12), over canonical state. A signal never elevates capability and never fabricates content. */
export function classifySignal(facts: SignalFacts): SignalAction {
  if (facts.contentOwnershipMismatch) return { kind: "skip", outcome: "SKIPPED_CONTENT_NOT_CANONICAL" };
  if (facts.targetKind === "content") {
    // Content creation → discovery; content edits/removals have no content-state model in H6 (operational only).
    return facts.change === "created" ? { kind: "account", contentNotCanonical: false } : { kind: "skip", outcome: "SKIPPED_UNSUPPORTED" };
  }
  // A reply the capability does not read is never relisted, confirmed or synthesized (Instagram: REPLIES_NOT_READ).
  if (facts.isReply && !facts.repliesReadable) return { kind: "skip", outcome: "SKIPPED_CAPABILITY" };
  if (facts.change === "created") {
    return facts.canonicalContent === null ? { kind: "account", contentNotCanonical: true } : { kind: "relist", contentItemId: facts.canonicalContent.id };
  }
  if (facts.change === "removed") {
    // Urgent confirmation of a canonical interaction — never a tombstone; nothing for a non-canonical one.
    return facts.canonicalInteraction === null
      ? { kind: "skip", outcome: "SKIPPED_NON_CANONICAL_REMOVAL" }
      : { kind: "confirm", interactionId: facts.canonicalInteraction.id, contentItemId: facts.canonicalInteraction.contentItemId, removal: true };
  }
  // edited · hidden · unhidden · updated
  if (facts.canonicalInteraction !== null) return { kind: "confirm", interactionId: facts.canonicalInteraction.id, contentItemId: facts.canonicalInteraction.contentItemId, removal: false };
  if (facts.canonicalContent !== null) return { kind: "relist", contentItemId: facts.canonicalContent.id };
  return { kind: "skip", outcome: "SKIPPED_CONTENT_NOT_CANONICAL" };
}

// ── follow-up decision (§13.2, §13.4, §13.5) ────────────────────────────────────────────────────────────────
export interface PendingMarksSummary {
  readonly count: number;
  /** The account's pending account mark, if any (priority: discovery is the broader need). */
  readonly accountMark: { readonly id: string; readonly lastSignalAt: Date } | null;
  /** The oldest pending relist mark and the earliest last-signal time among relist marks. */
  readonly oldestRelistMark: { readonly id: string } | null;
  readonly earliestRelistSignalAt: Date | null;
}

export type FollowUpDecision =
  | { readonly kind: "none" }
  | { readonly kind: "absorbed" }
  | { readonly kind: "defer"; readonly until: Date; readonly reason: "cap" | "skew" }
  | { readonly kind: "request"; readonly plan: SignalRunPlan; readonly leadMarkId: string };

/**
 * One deterministic decision for an account's pending marks: an open run absorbs them (its close hook revisits);
 * otherwise an account mark wins over relist marks; the hourly cap defers; a run that could not yet satisfy the lead
 * mark (skew) is deferred until it could, so no run is spent that cannot satisfy anything.
 */
export function decideFollowUp(input: { readonly summary: PendingMarksSummary; readonly openRun: boolean; readonly signalRunsInWindow: readonly Date[]; readonly now: Date }): FollowUpDecision {
  const { summary, now } = input;
  if (summary.count === 0) return { kind: "none" };
  if (input.openRun) return { kind: "absorbed" };
  const windowStart = now.getTime() - SIGNAL_RUNTIME.runWindowMs;
  const inWindow = input.signalRunsInWindow.map((at) => at.getTime()).filter((at) => at > windowStart).sort((a, b) => a - b);
  if (inWindow.length >= SIGNAL_RUNTIME.runsPerAccountPerHour) {
    // Oldest first: once the run at index length − 6 leaves the window, fewer than six remain in it.
    const leaving = inWindow[inWindow.length - SIGNAL_RUNTIME.runsPerAccountPerHour] ?? now.getTime();
    return { kind: "defer", until: new Date(leaving + SIGNAL_RUNTIME.runWindowMs + 1000), reason: "cap" };
  }
  const plan: SignalRunPlan = summary.accountMark !== null ? "account" : "relist";
  const lead = summary.accountMark ?? summary.oldestRelistMark;
  const leadSignalAt = summary.accountMark?.lastSignalAt ?? summary.earliestRelistSignalAt;
  if (lead === null || leadSignalAt === null) return { kind: "none" };
  if (!satisfiesMark(leadSignalAt, now)) return { kind: "defer", until: new Date(leadSignalAt.getTime() + SIGNAL_RUNTIME.skewMs + 1000), reason: "skew" };
  return { kind: "request", plan, leadMarkId: lead.id };
}
