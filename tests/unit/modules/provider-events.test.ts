/** Step H6-F3 — the provider-event router and purge orchestration over a fake system store (no database). */
import { describe, expect, it } from "vitest";
import { PROVIDER_EVENT_RUNTIME, ROUTE_OUTCOMES, purgeExpiredProviderEvents, routeDueProviderEvents, type ProviderEventStore, type RouteOutcome } from "@/modules/ingestion";

function fake(options: { due?: string[]; outcome?: (id: string) => RouteOutcome; purge?: number[] } = {}) {
  const calls = { transactions: 0, routed: [] as string[], listLimits: [] as number[], purgeLimits: [] as number[] };
  const purges = [...(options.purge ?? [0])];
  const store: ProviderEventStore = {
    listDueHints: (limit) => { calls.listLimits.push(limit); return Promise.resolve((options.due ?? []).slice(0, limit)); },
    routeHint: (id) => { calls.routed.push(id); return Promise.resolve(options.outcome?.(id) ?? "routed"); },
    purgeExpired: (limit) => { calls.purgeLimits.push(limit); const n = purges.shift() ?? 0; return Promise.resolve({ inboxDeleted: n, hintsDeleted: n * 2 }); },
  };
  return { calls, deps: { inSystem: <T>(work: (s: ProviderEventStore) => Promise<T>) => { calls.transactions += 1; return work(store); } } };
}

describe("routeDueProviderEvents", () => {
  it("30–34. routes every listed hint in its own transaction and tallies the closed outcome vocabulary", async () => {
    const outcomes: Record<string, RouteOutcome> = { a: "routed", b: "retry", c: "unmapped", d: "multi_org_limit", e: "not_pending", f: "not_due" };
    const { calls, deps } = fake({ due: Object.keys(outcomes), outcome: (id) => outcomes[id] ?? "not_found" });
    const summary = await routeDueProviderEvents(deps);
    expect(calls.routed).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(calls.transactions).toBe(7); // one to list + one per hint
    expect(summary).toEqual({ listed: 6, outcomes: { routed: 1, retry: 1, unmapped: 1, multi_org_limit: 1, not_due: 1, not_pending: 1, not_found: 0 } });
    expect(Object.keys(summary.outcomes)).toEqual([...ROUTE_OUTCOMES]);
  });
  it("36. never lists or routes more than 500 per run (a larger limit is clamped)", async () => {
    const due = Array.from({ length: 700 }, (_, i) => `h${String(i)}`);
    const { calls, deps } = fake({ due });
    expect(PROVIDER_EVENT_RUNTIME.routerBatchLimit).toBe(500);
    const summary = await routeDueProviderEvents(deps, 10_000);
    expect(calls.listLimits).toEqual([500]);
    expect(calls.routed).toHaveLength(500);
    expect(summary.listed).toBe(500);
  });
  it("a store failure propagates (the task retries; earlier hints stay routed, idempotently)", async () => {
    const { deps } = fake({ due: ["a", "b"], outcome: (id) => { if (id === "b") throw new Error("db"); return "routed"; } });
    await expect(routeDueProviderEvents(deps)).rejects.toThrow("db");
  });
});

describe("purgeExpiredProviderEvents", () => {
  it("39–40. bounded: batches of 1000, at most 5 per run; a short batch ends the run", async () => {
    expect(PROVIDER_EVENT_RUNTIME).toMatchObject({ purgeBatchSize: 1000, purgeMaxBatches: 5 });
    const short = fake({ purge: [1000, 300] });
    expect(await purgeExpiredProviderEvents(short.deps)).toEqual({ batches: 2, inboxDeleted: 1300, hintsDeleted: 2600, remainderPossible: false });
    expect(short.calls.purgeLimits).toEqual([1000, 1000]);
    const full = fake({ purge: [1000, 1000, 1000, 1000, 1000, 1000] });
    expect(await purgeExpiredProviderEvents(full.deps)).toMatchObject({ batches: 5, inboxDeleted: 5000, remainderPossible: true });
    const empty = fake({ purge: [0] });
    expect(await purgeExpiredProviderEvents(empty.deps)).toEqual({ batches: 1, inboxDeleted: 0, hintsDeleted: 0, remainderPossible: false });
  });
});
