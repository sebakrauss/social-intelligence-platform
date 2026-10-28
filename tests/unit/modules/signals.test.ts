/** Step H6-F4 — the pure webhook-signal rules: the frozen matrix, the follow-up decision, budget, attribution, keys. */
import { describe, expect, it } from "vitest";
import { parseInstant } from "@/domain/instant";
import {
  RECONCILIATION_DEFAULTS,
  SIGNAL_OUTCOMES,
  SIGNAL_RUNTIME,
  classifySignal,
  decideFollowUp,
  defaultBudgetSnapshot,
  relistArrival,
  satisfactionBoundary,
  satisfiesMark,
  signalConfirmationDispatchKey,
  signalRunBudget,
  signalRunCorrelation,
  type HintChange,
  type PendingMarksSummary,
  type SignalFacts,
} from "@/modules/ingestion";

const facts = (overrides: Partial<SignalFacts> = {}): SignalFacts => ({
  targetKind: "interaction",
  change: "created",
  isReply: false,
  canonicalInteraction: null,
  canonicalContent: null,
  contentOwnershipMismatch: false,
  repliesReadable: true,
  ...overrides,
});
const CONTENT = { id: "00000000-0000-4000-8000-00000000c001" };
const INTERACTION = { id: "00000000-0000-4000-8000-00000000a001", contentItemId: CONTENT.id };
const at = (iso: string) => new Date(iso);
const instant = (iso: string) => {
  const parsed = parseInstant(iso);
  if (parsed === undefined) throw new Error(iso);
  return parsed;
};

describe("frozen constants (D-F5 = B, design §13)", () => {
  it("10 operations, 6 runs per account per hour, 120 s skew, 7-day marks, ≤ 10 relist contents", () => {
    expect(SIGNAL_RUNTIME).toMatchObject({ maxOperations: 10, runsPerAccountPerHour: 6, runWindowMs: 3_600_000, skewMs: 120_000, markTtlMs: 604_800_000, relistContentsPerRun: 10, accountContentItemsPerRun: 9 });
    expect(SIGNAL_OUTCOMES).toEqual(["PLANNED_RELIST", "PLANNED_ACCOUNT", "PLANNED_CONFIRMATION", "ABSORBED", "DEFERRED", "SKIPPED_ACCOUNT_INACTIVE", "SKIPPED_HINT_UNAVAILABLE",
      "SKIPPED_PAUSED", "SKIPPED_CAPABILITY", "SKIPPED_CONTENT_NOT_CANONICAL", "SKIPPED_NON_CANONICAL_REMOVAL", "SKIPPED_UNSUPPORTED", "EXPIRED", "NO_PENDING_MARKS"]);
  });
  it("signal runs use 10 operations for both plans; manual Sync keeps the ordinary 40", () => {
    expect(signalRunBudget("relist")).toMatchObject({ maxOperations: 10, contentItems: 10 });
    // One listing page plus one page for each of 9 contents fits 10 operations (an account mark can be satisfied).
    expect(signalRunBudget("account")).toMatchObject({ maxOperations: 10, contentItems: 9, listingPagesPerSlice: 1 });
    expect(defaultBudgetSnapshot().maxOperations).toBe(40);
    for (const plan of ["account", "relist"] as const) {
      const budget = signalRunBudget(plan);
      expect([budget.interactionPagesPerSlice, budget.continuationsPerContent, budget.overlapSeconds]).toEqual([RECONCILIATION_DEFAULTS.interactionPagesPerSlice, RECONCILIATION_DEFAULTS.continuationsPerContent, 86_400]);
    }
  });
  it("attribution is `sig.{mark id}` (canonical ids only) and fits the trace-id pattern", () => {
    expect(signalRunCorrelation(CONTENT.id)).toBe(`sig.${CONTENT.id}`);
    expect(signalRunCorrelation(CONTENT.id)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
  });
  it("H6-F4d: a confirmation's key is one per (confirm mark lifetime, claim generation) — canonical ids only", () => {
    const mark = "00000000-0000-4000-8000-0000000000e1";
    const a = signalConfirmationDispatchKey(mark, 1);
    expect(a).toBe(`ingestion.confirm_interaction:${mark}:g1`);
    expect(a).toBe(signalConfirmationDispatchKey(mark, 1));
    expect(a).not.toBe(signalConfirmationDispatchKey(mark, 2));
    expect(a).not.toBe(signalConfirmationDispatchKey("00000000-0000-4000-8000-0000000000e2", 1));
    expect(signalConfirmationDispatchKey(mark, 2_147_483_647)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    // The cooldown mirrors the one fixed in ingestion.claim_signal_confirmation (0023: interval '5 minutes').
    expect(SIGNAL_RUNTIME).toMatchObject({ confirmationCooldownMs: 300_000, confirmationBackoffCapMs: 21_600_000, confirmReviewLimit: 10 });
  });
});

describe("16–17. satisfaction rule: last signal + 120 s ≤ traversal start", () => {
  it("a signal 120 s before the start is satisfied; one second later is not", () => {
    const start = at("2026-10-28T12:10:00.000Z");
    expect(satisfiesMark(at("2026-10-28T12:08:00.000Z"), start)).toBe(true);
    expect(satisfiesMark(at("2026-10-28T12:08:00.001Z"), start)).toBe(false);
    expect(satisfiesMark(at("2026-10-28T12:11:00.000Z"), start)).toBe(false);
    expect(satisfactionBoundary(start).toISOString()).toBe("2026-10-28T12:08:00.000Z");
  });
});

describe("34. relist arrival: provider creation time against the epoch, never webhook time", () => {
  it("first traversal and pre-epoch → backfill; after the epoch → realtime", () => {
    const epoch = instant("2026-10-28T10:00:00.000Z");
    expect(relistArrival({ epoch: null, providerCreatedAt: instant("2026-10-28T11:00:00.000Z") })).toBe("backfill");
    expect(relistArrival({ epoch, providerCreatedAt: instant("2026-10-28T09:59:59.999Z") })).toBe("backfill");
    expect(relistArrival({ epoch, providerCreatedAt: instant("2026-10-28T10:00:00.000Z") })).toBe("realtime");
  });
});

describe("classification (design §12)", () => {
  it("new interaction: canonical content → relist; unknown content → account (measured gap); never fabricated", () => {
    expect(classifySignal(facts({ canonicalContent: CONTENT }))).toEqual({ kind: "relist", contentItemId: CONTENT.id });
    expect(classifySignal(facts())).toEqual({ kind: "account", contentNotCanonical: true });
    // A Facebook reply (replies readable) of canonical content is a relist too: the reread is the parent's authority.
    expect(classifySignal(facts({ isReply: true, canonicalContent: CONTENT }))).toEqual({ kind: "relist", contentItemId: CONTENT.id });
  });
  it("12. Instagram reply (REPLIES_NOT_READ) → SKIPPED_CAPABILITY for every change, canonical or not", () => {
    for (const change of ["created", "edited", "removed", "hidden"] as const) {
      expect(classifySignal(facts({ change, isReply: true, repliesReadable: false, canonicalContent: CONTENT, canonicalInteraction: INTERACTION }))).toEqual({ kind: "skip", outcome: "SKIPPED_CAPABILITY" });
    }
  });
  it("change: canonical → confirmation; non-canonical with canonical content → relist; neither → skip", () => {
    for (const change of ["edited", "hidden", "unhidden", "updated"] as const) {
      expect(classifySignal(facts({ change, canonicalInteraction: INTERACTION, canonicalContent: CONTENT }))).toEqual({ kind: "confirm", interactionId: INTERACTION.id, contentItemId: CONTENT.id, removal: false });
      expect(classifySignal(facts({ change, canonicalContent: CONTENT }))).toEqual({ kind: "relist", contentItemId: CONTENT.id });
      expect(classifySignal(facts({ change }))).toEqual({ kind: "skip", outcome: "SKIPPED_CONTENT_NOT_CANONICAL" });
    }
  });
  it("removal: canonical → urgent confirmation (never a tombstone); non-canonical → skipped even with canonical content", () => {
    expect(classifySignal(facts({ change: "removed", canonicalInteraction: INTERACTION, canonicalContent: CONTENT }))).toEqual({ kind: "confirm", interactionId: INTERACTION.id, contentItemId: CONTENT.id, removal: true });
    expect(classifySignal(facts({ change: "removed", canonicalContent: CONTENT }))).toEqual({ kind: "skip", outcome: "SKIPPED_NON_CANONICAL_REMOVAL" });
    expect(classifySignal(facts({ change: "removed" }))).toEqual({ kind: "skip", outcome: "SKIPPED_NON_CANONICAL_REMOVAL" });
  });
  it("content: created → account; any other content change → SKIPPED_UNSUPPORTED (no content-state model in H6)", () => {
    expect(classifySignal(facts({ targetKind: "content", change: "created" }))).toEqual({ kind: "account", contentNotCanonical: false });
    for (const change of ["edited", "removed", "hidden", "unhidden", "updated"] as const satisfies readonly HintChange[]) {
      expect(classifySignal(facts({ targetKind: "content", change }))).toEqual({ kind: "skip", outcome: "SKIPPED_UNSUPPORTED" });
    }
  });
  it("29. a content owned by another account fails closed", () => {
    expect(classifySignal(facts({ contentOwnershipMismatch: true, canonicalContent: CONTENT }))).toEqual({ kind: "skip", outcome: "SKIPPED_CONTENT_NOT_CANONICAL" });
  });
});

describe("follow-up decision (design §13)", () => {
  const now = at("2026-10-28T12:00:00.000Z");
  const old = at("2026-10-28T11:50:00.000Z");
  const summary = (overrides: Partial<PendingMarksSummary> = {}): PendingMarksSummary => ({ count: 1, accountMark: null, oldestRelistMark: { id: "relist-1" }, earliestRelistSignalAt: old, ...overrides });

  it("nothing pending → none; an open run absorbs", () => {
    expect(decideFollowUp({ summary: summary({ count: 0, oldestRelistMark: null, earliestRelistSignalAt: null }), openRun: false, signalRunsInWindow: [], now })).toEqual({ kind: "none" });
    expect(decideFollowUp({ summary: summary(), openRun: true, signalRunsInWindow: [], now })).toEqual({ kind: "absorbed" });
  });
  it("13. an account mark has priority over relist marks", () => {
    expect(decideFollowUp({ summary: summary({ count: 2, accountMark: { id: "account-1", lastSignalAt: old } }), openRun: false, signalRunsInWindow: [], now })).toEqual({ kind: "request", plan: "account", leadMarkId: "account-1" });
    expect(decideFollowUp({ summary: summary(), openRun: false, signalRunsInWindow: [], now })).toEqual({ kind: "request", plan: "relist", leadMarkId: "relist-1" });
  });
  it("20–21, 43. the sixth signal run in an hour is allowed; at six the next is deferred until the oldest leaves the window", () => {
    const runs = (n: number) => Array.from({ length: n }, (_, i) => new Date(now.getTime() - 50 * 60_000 + i * 60_000));
    expect(decideFollowUp({ summary: summary(), openRun: false, signalRunsInWindow: runs(5), now }).kind).toBe("request");
    const deferred = decideFollowUp({ summary: summary(), openRun: false, signalRunsInWindow: runs(6), now });
    expect(deferred).toEqual({ kind: "defer", reason: "cap", until: new Date(now.getTime() - 50 * 60_000 + 3_600_000 + 1000) });
    // Runs older than an hour no longer count.
    expect(decideFollowUp({ summary: summary(), openRun: false, signalRunsInWindow: [new Date(now.getTime() - 3_600_000), ...runs(5)], now }).kind).toBe("request");
  });
  it("a run that could not satisfy the lead mark yet is scheduled for the instant it could (no futile run)", () => {
    const fresh = new Date(now.getTime() - 30_000);
    expect(decideFollowUp({ summary: summary({ earliestRelistSignalAt: fresh }), openRun: false, signalRunsInWindow: [], now })).toEqual({ kind: "defer", reason: "skew", until: new Date(fresh.getTime() + 121_000) });
    expect(decideFollowUp({ summary: summary({ accountMark: { id: "a", lastSignalAt: fresh } }), openRun: false, signalRunsInWindow: [], now })).toMatchObject({ kind: "defer", reason: "skew" });
  });
});
