/**
 * Step H6-C1 — the reconciliation runtime contract frozen before any persistence or job (pure; no database, provider,
 * job or network): the slice dispatch key derived from the persistent slice id alone, the approved default budgets
 * (TL D-C3) and overlap (TL D-C4) inside their hard ceilings, and the arrival rule (backfill vs reconciliation).
 * Synthetic ids only.
 */
import { describe, expect, it } from "vitest";
import { parseInstant, type Instant } from "@/domain/instant";
import { AUTHORITY_CONFLICTS } from "@/modules/interactions";
import {
  INGESTION_CONFLICT_CLASSES,
  INITIAL_IMPORT_POLICY,
  OPEN_RUN_STATES,
  OPEN_SLICE_STATES,
  RECONCILIATION_RUN_STATES,
  RECONCILIATION_SLICE_STATES,
  defaultBudgetSnapshot,
  RECONCILE_SLICE_TOPIC,
  RECONCILIATION_DEFAULTS,
  SLICE_MAX_PAGES,
  SLICE_OVERLAP_MAX_MS,
  maxInteractionPagesPerContent,
  reconciliationArrival,
  sliceDispatchKey,
} from "@/modules/ingestion";

const at = (iso: string): Instant => {
  const parsed = parseInstant(iso);
  if (parsed === undefined) throw new Error("instant");
  return parsed;
};
/** The outbox dispatch_key CHECK (0004): 8–128 characters of [A-Za-z0-9._:-], starting alphanumeric. */
const DISPATCH_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const HOUR = 60 * 60 * 1000;

describe("slice dispatch key (supersedes the H6-A1 window-derived key)", () => {
  it("17. is `ingestion.reconcile_slice:{slice id}` — the slice id alone, deterministic, ≤ 128 characters", () => {
    const id = "a1a1a1a1-0000-4000-8000-0000000000c1";
    const key = sliceDispatchKey({ sliceId: id });
    expect(key).toBe(`ingestion.reconcile_slice:${id}`);
    expect(RECONCILE_SLICE_TOPIC).toBe("ingestion.reconcile_slice");
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(DISPATCH_KEY);
    expect(sliceDispatchKey({ sliceId: id })).toBe(key);
    // Distinct rows (e.g. a continuation, or a second run over the same window) never share a key.
    expect(sliceDispatchKey({ sliceId: "a1a1a1a1-0000-4000-8000-0000000000c2" })).not.toBe(key);
    expect(() => sliceDispatchKey({ sliceId: "window-2026-10-20" })).toThrow("slice_id_invalid");
  });
});

describe("approved reconciliation defaults (TL D-C3, D-C4)", () => {
  it("19. the defaults are pinned", () => {
    expect(RECONCILIATION_DEFAULTS).toEqual({
      listingPagesPerSlice: 1,
      interactionPagesPerSlice: 5,
      continuationsPerContent: 2,
      contentItemsPerRun: 10,
      openRunsPerAccount: 1,
      overlapMs: 24 * HOUR,
    });
    expect(maxInteractionPagesPerContent()).toBe(15);
    expect(Object.isFrozen(RECONCILIATION_DEFAULTS)).toBe(true);
  });

  it("20. the overlap is 24 h and the hard ceilings stay separate: pages ≤ 10 per slice, overlap ≤ 7 days", () => {
    expect(RECONCILIATION_DEFAULTS.overlapMs).toBe(24 * HOUR);
    expect(SLICE_OVERLAP_MAX_MS).toBe(7 * 24 * HOUR);
    expect(SLICE_MAX_PAGES).toBe(10);
    expect(RECONCILIATION_DEFAULTS.overlapMs).toBeLessThanOrEqual(SLICE_OVERLAP_MAX_MS);
    expect(RECONCILIATION_DEFAULTS.listingPagesPerSlice).toBeLessThanOrEqual(SLICE_MAX_PAGES);
    expect(RECONCILIATION_DEFAULTS.interactionPagesPerSlice).toBeLessThanOrEqual(SLICE_MAX_PAGES);
  });
});

describe("arrival (frozen from H6-C0)", () => {
  it("the first traversal of a content is backfill; later traversals are reconciliation, except items created before the epoch", () => {
    const epoch = at("2026-10-27T12:00:00.000Z");
    expect(reconciliationArrival({ epoch: null, providerCreatedAt: at("2026-10-27T13:00:00.000Z") })).toBe("backfill");
    expect(reconciliationArrival({ epoch, providerCreatedAt: at("2026-10-27T11:59:59.999Z") })).toBe("backfill");
    expect(reconciliationArrival({ epoch, providerCreatedAt: epoch })).toBe("reconciliation");
    expect(reconciliationArrival({ epoch, providerCreatedAt: at("2026-10-28T00:00:00.000Z") })).toBe("reconciliation");
    // Arrival claims no historical depth.
    expect(INITIAL_IMPORT_POLICY).toMatchObject({ claimsHistoricalDepth: false, arrival: "backfill" });
  });
});

describe("reconciliation runtime vocabularies (H6-C2, migration 0018)", () => {
  it("run and slice states are closed; only REQUESTED/RUNNING runs and PENDING/RUNNING slices are open", () => {
    expect(RECONCILIATION_RUN_STATES).toEqual(["REQUESTED", "RUNNING", "COMPLETED", "PARTIAL", "SKIPPED_UNAVAILABLE", "FAILED"]);
    expect(OPEN_RUN_STATES).toEqual(["REQUESTED", "RUNNING"]);
    expect(RECONCILIATION_SLICE_STATES).toEqual(["PENDING", "RUNNING", "COMPLETED", "CONTINUED", "FAILED_TRANSIENT", "FAILED_RATE_LIMITED", "FAILED_PERMANENT", "ABANDONED_BUDGET"]);
    expect(OPEN_SLICE_STATES).toEqual(["PENDING", "RUNNING"]);
  });

  it("the conflict classes are the identity conflicts plus the ingestion scope and ancestry conflicts, without THREAD_ANCHOR_CONFLICT", () => {
    expect(INGESTION_CONFLICT_CLASSES.slice(0, AUTHORITY_CONFLICTS.length)).toEqual([...AUTHORITY_CONFLICTS]);
    expect(INGESTION_CONFLICT_CLASSES.slice(AUTHORITY_CONFLICTS.length)).toEqual([
      "CONTENT_SCOPE_CONFLICT", "PLACEHOLDER_SCOPE_CONFLICT", "PARENT_SCOPE_CONFLICT", "ANCESTRY_CYCLE", "ANCESTRY_DEPTH_EXCEEDED", "DESCENDANT_CONVERSATION_CONFLICT",
    ]);
    expect(INGESTION_CONFLICT_CLASSES).not.toContain("THREAD_ANCHOR_CONFLICT");
  });

  it("the budget snapshot a run persists is the approved defaults, with the effective 15 pages per content", () => {
    expect(defaultBudgetSnapshot()).toEqual({
      listingPagesPerSlice: 1, interactionPagesPerSlice: 5, continuationsPerContent: 2, interactionPagesPerContent: 15, contentItems: 10, overlapSeconds: 86_400,
    });
    expect(defaultBudgetSnapshot().interactionPagesPerContent).toBe(maxInteractionPagesPerContent());
  });
});
