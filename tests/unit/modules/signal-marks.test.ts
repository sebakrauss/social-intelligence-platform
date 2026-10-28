/**
 * Step H6-F4 — the signal-mark services over a fake scope (the authority gate is stubbed so each refusal can be driven):
 * the shared review, the close hook's satisfaction rules and the relist planner's bounds and re-validation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Gate } from "@/modules/ingestion/application/authority-gate";
import type { ReconciliationRunRecord, SignalMarkStore } from "@/modules/ingestion";

const gateResults: Gate[] = [];
const readable = { kind: "readable", account: {}, connection: {}, availability: { state: "AVAILABLE", reason: "SUPPORTED" }, profile: { catalogRevision: 5, revision: 1 } } as unknown as Gate;
vi.mock("@/modules/ingestion/application/authority-gate", () => ({
  gate: vi.fn(() => Promise.resolve(gateResults.shift() ?? readable)),
}));
const { closeRunSignals, planRelistSlices, reviewSignalMarks } = await import("@/modules/ingestion/application/signal-marks");

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-10-28T12:00:00.000Z");
const OLD = new Date("2026-10-28T11:50:00.000Z");
const blocked = (failureClass: string, accountLevel = true): Gate => ({ kind: "blocked", failureClass, accountLevel, availability: null });

function world(options: { marks?: { id: string; kind: "relist" | "account"; contentItemId: string | null; lastSignalAt: Date }[]; openRun?: boolean; signalRuns?: Date[]; request?: "requested" | "already_running" | "not_found";
  contents?: Record<string, { connectedAccountId: string; contentKind: string; reportedSource: string }>; completed?: string[]; windowEnds?: Record<string, Date>;
  parked?: Record<string, { sliceId: string; locallyEligible: boolean; windowStart: Date; windowEnd: Date }> } = {}) {
  const marks = [...(options.marks ?? [])];
  const calls: Record<string, unknown[]> = { requestRun: [], deferAll: [], linkRun: [], drop: [], satisfyRelist: [], satisfyAccount: [], insertSlice: [], relistCandidates: [], retired: [] };
  const unused = () => Promise.reject(new Error("unused"));
  const signals: SignalMarkStore = {
    routedHint: () => Promise.reject(new Error("unused")),
    upsert: () => Promise.resolve(),
    summary: () => {
      const account = marks.find((m) => m.kind === "account");
      const relist = marks.filter((m) => m.kind === "relist");
      return Promise.resolve({
        count: marks.length,
        accountMark: account === undefined ? null : { id: account.id, lastSignalAt: account.lastSignalAt },
        oldestRelistMark: relist[0] === undefined ? null : { id: relist[0].id },
        earliestRelistSignalAt: relist.length === 0 ? null : new Date(Math.min(...relist.map((m) => m.lastSignalAt.getTime()))),
      });
    },
    relistCandidates: (_account, boundary, limit) => {
      calls["relistCandidates"]?.push({ boundary, limit });
      return Promise.resolve(marks.filter((m) => m.kind === "relist" && m.lastSignalAt <= boundary).slice(0, limit).map((m) => ({ id: m.id, contentItemId: m.contentItemId ?? "" })));
    },
    deferAll: (_account, delayMs) => { calls["deferAll"]?.push(delayMs); return Promise.resolve(marks.length); },
    linkRun: (ids, runId) => { calls["linkRun"]?.push({ ids, runId }); return Promise.resolve(); },
    satisfyRelist: (_account, traversals) => { calls["satisfyRelist"]?.push(traversals); return Promise.resolve(traversals.length); },
    satisfyAccount: (_account, boundary) => { calls["satisfyAccount"]?.push(boundary); return Promise.resolve(1); },
    deleteExpired: () => Promise.resolve(0),
    drop: (ids) => {
      calls["drop"]?.push(ids);
      for (const id of ids) marks.splice(marks.findIndex((m) => m.id === id), 1);
      return Promise.resolve(ids.length);
    },
    signalRunsSince: () => Promise.resolve(options.signalRuns ?? []),
    upsertConfirm: unused,
    claimConfirmation: unused,
    beginConfirmationRead: unused,
    completeConfirmationRead: unused,
    backoffConfirmation: unused,
    dueConfirmations: unused,
    deferConfirmations: unused,
  };
  const scope = {
    signals,
    reconciliation: {
      openRun: () => Promise.resolve(options.openRun === true ? {} : undefined),
      requestRun: (input: unknown) => {
        calls["requestRun"]?.push(input);
        const outcome = options.request ?? "requested";
        return Promise.resolve(outcome === "not_found" ? { outcome } : { outcome, runId: "00000000-0000-4000-8000-0000000000e9", outboxId: "x" });
      },
      completedContentTraversals: () => Promise.resolve((options.completed ?? []).map((contentItemId) => ({ contentItemId, windowEnd: options.windowEnds?.[contentItemId] ?? new Date(NOW.getTime() - 60_000) }))),
      parkedContinuation: (_account: string, content: string) => {
        const parked = options.parked?.[content];
        return Promise.resolve(parked === undefined ? undefined : { ...parked, cursor: "meta1.cGFya2Vk", cursorIssuedAt: new Date(NOW.getTime() - 30 * 60_000) });
      },
      retireParkedCursor: (id: string) => { calls["retired"]?.push(id); return Promise.resolve(); },
      watermark: () => Promise.resolve(undefined),
      insertSlice: (slice: unknown) => { calls["insertSlice"]?.push(slice); return Promise.resolve(); },
    },
    ingestion: { content: { findById: (id: string) => Promise.resolve(options.contents?.[id] === undefined ? undefined : { id, ...options.contents[id] }) } },
    authority: {},
  };
  return { scope: scope as never, calls, marks };
}
const clock = { newId: () => "00000000-0000-4000-8000-0000000000f1", now: () => NOW };
const run = (overrides: Partial<ReconciliationRunRecord> = {}): ReconciliationRunRecord => ({
  id: "00000000-0000-4000-8000-0000000000e1", organizationId: "o", workspaceId: "w", connectedAccountId: ACCOUNT, state: "RUNNING", initiatorType: "system", initiatorUserId: null,
  correlationId: "sig.x", plan: "relist", requestedAt: NOW, startedAt: new Date(NOW.getTime() - 60_000), completedAt: null,
  budget: { listingPagesPerSlice: 1, interactionPagesPerSlice: 5, continuationsPerContent: 2, interactionPagesPerContent: 15, contentItems: 10, overlapSeconds: 86_400, maxOperations: 10 },
  operationsUsed: 0, pagesUsed: 0, contentItemsUsed: 0, failureClass: null, ...overrides,
});

beforeEach(() => { gateResults.length = 0; });

describe("reviewSignalMarks", () => {
  it("requests ONE run with the signal budget and attribution, links the run (traceability), and sets a revisit", async () => {
    const w = world({ marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }] });
    const review = await reviewSignalMarks(w.scope, clock, ACCOUNT, NOW);
    expect(review).toMatchObject({ outcome: "PLANNED_RELIST", scheduled: false });
    expect(w.calls["requestRun"]).toEqual([expect.objectContaining({ connectedAccountId: ACCOUNT, correlationId: "sig.m1", plan: "relist", requestedAt: NOW, budget: expect.objectContaining({ maxOperations: 10, contentItems: 10 }) as unknown })]);
    expect(w.calls["linkRun"]).toEqual([{ ids: ["m1"], runId: expect.any(String) as unknown }]);
    // H6-F4d: revisits are DB-anchored — the review hands the store a delay, never an application-clock instant.
    expect(w.calls["deferAll"]).toEqual([15 * 60_000]);
  });
  it("an open run absorbs (and the marks keep a revisit as a safety net); a concurrent winner is ABSORBED too", async () => {
    const open = world({ marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }], openRun: true });
    expect((await reviewSignalMarks(open.scope, clock, ACCOUNT, NOW)).outcome).toBe("ABSORBED");
    expect(open.calls["requestRun"]).toEqual([]);
    const raced = world({ marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }], request: "already_running" });
    expect((await reviewSignalMarks(raced.scope, clock, ACCOUNT, NOW)).outcome).toBe("ABSORBED");
    expect(raced.calls["linkRun"]).toEqual([]);
  });
  it("paused → retained + 15 min revisit; inactive account → marks dropped; any other refusal → retained + hourly revisit", async () => {
    const marks = () => [{ id: "m1", kind: "relist" as const, contentItemId: "c1", lastSignalAt: OLD }, { id: "a1", kind: "account" as const, contentItemId: null, lastSignalAt: OLD }];
    gateResults.push(blocked("provider_paused"));
    const paused = world({ marks: marks() });
    expect((await reviewSignalMarks(paused.scope, clock, ACCOUNT, NOW)).outcome).toBe("SKIPPED_PAUSED");
    expect(paused.calls["deferAll"]).toEqual([15 * 60_000]);
    gateResults.push(blocked("account_inactive"));
    const inactive = world({ marks: marks() });
    expect(await reviewSignalMarks(inactive.scope, clock, ACCOUNT, NOW)).toMatchObject({ outcome: "SKIPPED_ACCOUNT_INACTIVE", dropped: 2 });
    expect(inactive.marks).toEqual([]);
    gateResults.push(blocked("connection_degraded"));
    const degraded = world({ marks: marks() });
    expect((await reviewSignalMarks(degraded.scope, clock, ACCOUNT, NOW)).outcome).toBe("SKIPPED_CAPABILITY");
    expect(degraded.calls["deferAll"]).toEqual([60 * 60_000]);
    expect([paused, inactive, degraded].flatMap((x) => x.calls["requestRun"] ?? [])).toEqual([]);
  });
  it("the cap defers with no request; the skew schedules; the boundary refuses (not_found) by dropping", async () => {
    const runs = Array.from({ length: 6 }, (_, i) => new Date(NOW.getTime() - 50 * 60_000 + i * 1000));
    const capped = world({ marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }], signalRuns: runs });
    expect((await reviewSignalMarks(capped.scope, clock, ACCOUNT, NOW)).outcome).toBe("DEFERRED");
    expect(capped.calls["requestRun"]).toEqual([]);
    const fresh = world({ marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: new Date(NOW.getTime() - 10_000) }] });
    expect(await reviewSignalMarks(fresh.scope, clock, ACCOUNT, NOW)).toMatchObject({ outcome: "PLANNED_RELIST", scheduled: true, requestedRunId: null });
    expect(fresh.calls["deferAll"]).toEqual([111_000]);
    const gone = world({ marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }], request: "not_found" });
    expect(await reviewSignalMarks(gone.scope, clock, ACCOUNT, NOW)).toMatchObject({ outcome: "SKIPPED_ACCOUNT_INACTIVE", dropped: 1 });
  });
  it("account priority: the account mark leads (plan account, 9 contents) and alone is linked", async () => {
    const w = world({ marks: [{ id: "r1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }, { id: "a1", kind: "account", contentItemId: null, lastSignalAt: OLD }] });
    expect((await reviewSignalMarks(w.scope, clock, ACCOUNT, NOW)).outcome).toBe("PLANNED_ACCOUNT");
    expect(w.calls["requestRun"]).toEqual([expect.objectContaining({ plan: "account", correlationId: "sig.a1", budget: expect.objectContaining({ maxOperations: 10, contentItems: 9 }) as unknown })]);
    expect(w.calls["linkRun"]).toEqual([{ ids: ["a1"], runId: expect.any(String) as unknown }]);
  });
});

describe("closeRunSignals", () => {
  it("satisfies only completed contents' relist marks up to start − 120 s; account marks only for a COMPLETED account run", async () => {
    const w = world({ completed: ["c1", "c2"] });
    const started = new Date(NOW.getTime() - 60_000);
    await closeRunSignals(w.scope, clock, run({ plan: "account", startedAt: started }), "PARTIAL", NOW);
    expect(w.calls["satisfyRelist"]).toEqual([[{ contentItemId: "c1", boundary: new Date(started.getTime() - 120_000) }, { contentItemId: "c2", boundary: new Date(started.getTime() - 120_000) }]]);
    expect(w.calls["satisfyAccount"]).toEqual([]);
    await closeRunSignals(w.scope, clock, run({ plan: "account", startedAt: started }), "COMPLETED", NOW);
    expect(w.calls["satisfyAccount"]).toEqual([new Date(started.getTime() - 120_000)]);
    // A relist run never satisfies discovery.
    await closeRunSignals(w.scope, clock, run({ plan: "relist", startedAt: started }), "COMPLETED", NOW);
    expect(w.calls["satisfyAccount"]).toHaveLength(1);
  });
  it("a run that never started (SKIPPED_UNAVAILABLE) satisfies nothing, but still reviews what is pending", async () => {
    const w = world({ completed: ["c1"], marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }] });
    const result = await closeRunSignals(w.scope, clock, run({ startedAt: null }), "SKIPPED_UNAVAILABLE", NOW);
    expect(w.calls["satisfyRelist"]).toEqual([]);
    expect(result.review.outcome).toBe("PLANNED_RELIST");
    expect(w.calls["requestRun"]).toHaveLength(1);
  });
});

describe("planRelistSlices", () => {
  it("30. at most 10 contents, only marks the run can satisfy, windowed watermark − overlap → run start", async () => {
    const marks = Array.from({ length: 12 }, (_, i) => ({ id: `m${String(i).padStart(2, "0")}`, kind: "relist" as const, contentItemId: `c${String(i)}`, lastSignalAt: OLD }));
    const contents = Object.fromEntries(marks.map((m) => [m.contentItemId, { connectedAccountId: ACCOUNT, contentKind: "post", reportedSource: "unknown" }]));
    const w = world({ marks, contents });
    const started = NOW;
    expect(await planRelistSlices(w.scope, clock, run({ startedAt: started }), started)).toEqual({ created: 10, dropped: 0 });
    expect(w.calls["relistCandidates"]).toEqual([{ boundary: new Date(started.getTime() - 120_000), limit: 10 }]);
    const slices = w.calls["insertSlice"] as { unit: string; windowEnd: Date; windowStart: Date; maxPages: number; sequence: number }[];
    expect(slices).toHaveLength(10);
    for (const slice of slices) expect(slice).toMatchObject({ unit: "content_interactions", windowEnd: started, windowStart: new Date("2000-01-01T00:00:00.000Z"), maxPages: 5, sequence: 0 });
  });
  it("29. another account's content or an unreadable scope is dropped (fail closed); an account-level refusal stops planning", async () => {
    const w = world({
      marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }, { id: "m2", kind: "relist", contentItemId: "c2", lastSignalAt: OLD }, { id: "m3", kind: "relist", contentItemId: "c3", lastSignalAt: OLD }],
      contents: { c1: { connectedAccountId: "someone-else", contentKind: "post", reportedSource: "unknown" }, c2: { connectedAccountId: ACCOUNT, contentKind: "reel", reportedSource: "unknown" }, c3: { connectedAccountId: ACCOUNT, contentKind: "post", reportedSource: "unknown" } },
    });
    gateResults.push(blocked("capability_unsupported", false));
    expect(await planRelistSlices(w.scope, clock, run(), NOW)).toEqual({ created: 1, dropped: 2 });
    expect(w.calls["drop"]).toEqual([["m1", "m2"]]);
    const stop = world({ marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }], contents: { c1: { connectedAccountId: ACCOUNT, contentKind: "post", reportedSource: "unknown" } } });
    gateResults.push(blocked("connection_degraded", true));
    expect(await planRelistSlices(stop.scope, clock, run(), NOW)).toEqual({ created: 0, dropped: 0 });
  });
});

describe("H6-F4d: continued traversals", () => {
  it("each traversal satisfies by ITS OWN window end: a continuation finishing an older traversal can't satisfy a newer signal", async () => {
    const started = new Date(NOW.getTime() - 60_000);
    const originalStart = new Date(NOW.getTime() - 40 * 60_000);
    const w = world({ completed: ["c1", "c2"], windowEnds: { c1: originalStart, c2: started } });
    await closeRunSignals(w.scope, clock, run({ plan: "relist", startedAt: started }), "COMPLETED", NOW);
    expect(w.calls["satisfyRelist"]).toEqual([[
      { contentItemId: "c1", boundary: new Date(originalStart.getTime() - 120_000) },
      { contentItemId: "c2", boundary: new Date(started.getTime() - 120_000) },
    ]]);
    // An account run containing a continued traversal satisfies discovery only as of its OLDEST traversal start.
    const a = world({ completed: ["c1", "c2"], windowEnds: { c1: originalStart, c2: started } });
    await closeRunSignals(a.scope, clock, run({ plan: "account", startedAt: started }), "COMPLETED", NOW);
    expect(a.calls["satisfyAccount"]).toEqual([new Date(originalStart.getTime() - 120_000)]);
  });

  it("a relist adopts an eligible parked cursor with the ORIGINAL window, first in the chain, and retires it; a stale one is retired and replaced", async () => {
    const contents = { c1: { connectedAccountId: ACCOUNT, contentKind: "post", reportedSource: "unknown" }, c2: { connectedAccountId: ACCOUNT, contentKind: "post", reportedSource: "unknown" } };
    const originalStart = new Date(NOW.getTime() - 50 * 60_000);
    const w = world({
      marks: [{ id: "m1", kind: "relist", contentItemId: "c1", lastSignalAt: OLD }, { id: "m2", kind: "relist", contentItemId: "c2", lastSignalAt: OLD }],
      contents,
      parked: {
        c1: { sliceId: "p1", locallyEligible: true, windowStart: new Date("2000-01-01T00:00:00.000Z"), windowEnd: originalStart },
        c2: { sliceId: "p2", locallyEligible: false, windowStart: new Date("2000-01-01T00:00:00.000Z"), windowEnd: originalStart },
      },
    });
    expect(await planRelistSlices(w.scope, clock, run({ startedAt: NOW }), NOW)).toEqual({ created: 2, dropped: 0 });
    expect(w.calls["retired"]).toEqual(["p1", "p2"]);
    const slices = w.calls["insertSlice"] as { contentItemId: string; cursor: string | null; windowEnd: Date; createdAt: Date }[];
    const continued = slices.find((slice) => slice.contentItemId === "c1");
    const fresh = slices.find((slice) => slice.contentItemId === "c2");
    expect(continued).toMatchObject({ cursor: "meta1.cGFya2Vk", windowEnd: originalStart });
    expect(fresh).toMatchObject({ cursor: null, windowEnd: NOW });
    expect((continued?.createdAt.getTime() ?? 0)).toBeLessThan(fresh?.createdAt.getTime() ?? 0);
  });
});
