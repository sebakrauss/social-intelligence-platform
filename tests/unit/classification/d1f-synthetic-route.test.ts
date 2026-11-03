/**
 * Step H7-D1f-prep — the TEMPORARY bounded synthetic live-test route (jobs/intelligence-policy.ts), without a database
 * (the DB suite tests/db/suites/intelligence-runtime.ts proves the same on the real stores). Fakes only: no provider
 * call, no network, no credential.
 *
 *   ELIGIBLE ⇔ workspace == D1F_SYNTHETIC_WORKSPACE_ID (and arrival ≠ backfill), for MAIN dispatch, MAIN recovery and
 *   the INTELLIGENCE run alike: every other workspace is real data and real data is never eligible.
 */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderDataBlock } from "@/ai/gateway/task";
import {
  QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS,
  QUALIFIED_UNDERSTANDING_DESCRIPTOR,
  QUALIFIED_UNDERSTANDING_FINGERPRINT,
  QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL,
  QUALIFIED_UNDERSTANDING_MODEL_REF,
  QUALIFIED_UNDERSTANDING_QUALIFICATION,
} from "@/ai/providers/anthropic/qualified";
import { PRODUCTION_INTELLIGENCE } from "@/jobs/intelligence";
import {
  D1F_MAX_INPUT_CHARS_PER_DAY,
  D1F_SYNTHETIC_FIXTURE_TEXT,
  D1F_SYNTHETIC_ROUTE_POLICY,
  D1F_SYNTHETIC_WORKSPACE_ID,
  INTELLIGENCE_ROUTE_POLICY,
} from "@/jobs/intelligence-policy";
import {
  DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
  canonicalEligibility,
  dispatchUnderstanding,
  prepareUnderstandingInput,
  recoverStaleUnderstanding,
  STALE_IN_FLIGHT_MS,
  type IntelligenceRequestRecord,
  type RequestTransition,
} from "@/modules/classification";
import { runUnderstanding, type IntelligenceRunScope } from "@/modules/classification/intelligence-runtime";
import { UNDERSTANDING_TASK } from "@/modules/classification/application/ai/understanding-task";
import { QUALIFIED_UNDERSTANDING_BINDING } from "@/jobs/intelligence";
import { codeOf, sourceFiles } from "../../support/source-scan";

const D1F = D1F_SYNTHETIC_WORKSPACE_ID;
const ORG = "d1f5e000-0000-4000-8000-0000000000a0";
const INTERACTION = "d1f5e000-0000-4000-8000-0000000000a1";
const VERSION = "d1f5e000-0000-4000-8000-0000000000a2";
const REQUEST = "d1f5e000-0000-4000-8000-0000000000a3";
/** Workspaces that must stay ineligible: the protected synthetic workspace, the H7 acceptance fixture, unit fixtures, look-alikes. */
const OTHER_WORKSPACES = [
  "5eed2e00-0000-4000-8000-000000000001",
  "a7b1b000-0000-4000-8000-000000000002",
  "5a5e0000-0000-4000-8000-0000000001d1",
  "d1f5e000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000001",
  randomUUID(),
  randomUUID(),
] as const;
const clock = { newId: () => randomUUID(), now: () => new Date("2026-11-03T12:00:00.000Z") };

/** A recording IntelligenceRunScope: every read and write of the run is counted (all synthetic). */
function fakeScope(workspaceId: string, options: { readonly state?: "PENDING" | "AI_PENDING"; readonly arrival?: "realtime" | "reconciliation" | "backfill" } = {}) {
  const reads: string[] = [];
  const transitions: RequestTransition[] = [];
  const dispatches: number[] = [];
  const writes: string[] = [];
  const record: IntelligenceRequestRecord = {
    id: REQUEST, organizationId: ORG, workspaceId, interactionId: INTERACTION, sourceTextVersionId: VERSION, pipelineVersion: "classification.intelligence.v1",
    arrival: options.arrival ?? "realtime", state: options.state ?? "PENDING", aiGeneration: options.state === "AI_PENDING" ? 1 : null, updatedAt: new Date("2026-11-03T10:00:00.000Z"),
  };
  const scope: IntelligenceRunScope = {
    texts: {
      analysisText: () => Promise.resolve(undefined),
      understandingContext: () => {
        reads.push("context");
        return Promise.resolve({ organizationId: ORG, workspaceId, interactionId: INTERACTION, sourceTextVersionId: VERSION, observed: true, kind: "comment", authorRole: "user",
          sourceText: D1F_SYNTHETIC_FIXTURE_TEXT, platform: "facebook", contentItemId: null, currentSourceTextVersionId: VERSION, parent: null, root: null });
      },
    },
    contents: { reportedSource: () => { reads.push("source"); return Promise.resolve("organic"); } },
    store: {
      ensureRequest: () => { writes.push("ensure"); return Promise.resolve({ id: REQUEST, state: "PENDING" as const, created: true }); },
      advanceRequest: () => Promise.resolve(true),
      recordSignal: () => Promise.resolve("inserted"),
    },
    intelligence: {
      lockRequest: () => { reads.push("lock"); return Promise.resolve(record); },
      transition: (t) => { transitions.push(t); return Promise.resolve(true); },
      recordCallIntent: () => { writes.push("intent"); return Promise.resolve("inserted"); },
      appendDispatch: ({ generation }) => { dispatches.push(generation); return Promise.resolve("appended"); },
      recordAttempts: () => { writes.push("attempts"); return Promise.resolve(0); },
      recordResult: () => { writes.push("result"); return Promise.resolve("inserted"); },
      recordShadowAssessments: () => { writes.push("assessments"); return Promise.resolve(0); },
      ruleAssessments: () => Promise.resolve([]),
      staleInFlight: () => Promise.resolve(options.state === "AI_PENDING" ? [record] : []),
      reserveBudget: () => { writes.push("budget"); return Promise.resolve(false); },
    },
    aiTaskKilled: () => Promise.resolve(false),
    claimEffect: () => Promise.resolve("claimed"),
  };
  return { scope, reads, transitions, dispatches, writes };
}
const dispatchInput = (workspaceId: string, arrival: "realtime" | "reconciliation" | "backfill" = "realtime") =>
  ({ workspaceId, interactionId: INTERACTION, sourceTextVersionId: VERSION, arrival, correlationId: "h7d1f-prep-unit-01" });

describe("H7-D1f-prep · the temporary bounded synthetic policy (static)", () => {
  it("is exactly the bounded route: one synthetic workspace, no real data, no backfill, 2 calls/day, the qualified model, 30 s, SHADOW", () => {
    expect(D1F_SYNTHETIC_ROUTE_POLICY).toEqual({
      enabled: true, samplingPercentage: 100, killSwitch: "inactive", model: { providerKey: "anthropic", modelKey: "claude-sonnet-5-5" }, timeoutMs: 30_000,
      budget: { kind: "caps", maxCallsPerDay: 2, maxInputCharsPerDay: 8_730 }, acceptanceMode: "shadow", realDataEligible: false, fixtureWorkspaceIds: [D1F], includeBackfill: false,
    });
    expect(D1F_SYNTHETIC_ROUTE_POLICY.realDataEligible).toBe(false);
    expect(D1F_SYNTHETIC_ROUTE_POLICY.fixtureWorkspaceIds).toHaveLength(1);
    expect(D1F_SYNTHETIC_ROUTE_POLICY.fixtureWorkspaceIds[0]).toBe(D1F);
    expect(D1F_SYNTHETIC_ROUTE_POLICY.includeBackfill).toBe(false);
    expect(D1F_SYNTHETIC_ROUTE_POLICY.budget.kind === "caps" && D1F_SYNTHETIC_ROUTE_POLICY.budget.maxCallsPerDay <= 2).toBe(true);
    expect(D1F_SYNTHETIC_ROUTE_POLICY.model).toEqual(QUALIFIED_UNDERSTANDING_MODEL_REF);
    expect(D1F_SYNTHETIC_ROUTE_POLICY.timeoutMs).toBe(QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS);
    expect(Object.isFrozen(D1F_SYNTHETIC_ROUTE_POLICY) && Object.isFrozen(D1F_SYNTHETIC_ROUTE_POLICY.fixtureWorkspaceIds) && Object.isFrozen(D1F_SYNTHETIC_ROUTE_POLICY.budget)).toBe(true);
  });

  it("both planes apply it (MAIN through INTELLIGENCE_ROUTE_POLICY, INTELLIGENCE through its composition); the domain default is unchanged", () => {
    expect(INTELLIGENCE_ROUTE_POLICY).toBe(D1F_SYNTHETIC_ROUTE_POLICY);
    expect(PRODUCTION_INTELLIGENCE.policy).toBe(D1F_SYNTHETIC_ROUTE_POLICY);
    expect(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY).toEqual({ enabled: false, samplingPercentage: 0, killSwitch: "active", model: null, timeoutMs: null, budget: { kind: "deny_all" }, acceptanceMode: "shadow", realDataEligible: false, fixtureWorkspaceIds: [], includeBackfill: false });
  });

  it("the workspace id is new: no other source, fixture or tool names it, and no known workspace is allowlisted", () => {
    for (const other of OTHER_WORKSPACES) expect(D1F_SYNTHETIC_ROUTE_POLICY.fixtureWorkspaceIds).not.toContain(other);
    const naming = sourceFiles(["app", "ui", "server", "domain", "modules", "mutations", "integrations", "ai", "jobs", "platform", "db", "prompts", "fixtures", "tools", "tests"])
      .filter((file) => codeOf(file).includes(D1F))
      .filter((file) => file !== "tests/unit/classification/d1f-synthetic-route.test.ts");
    expect(naming).toEqual(["jobs/intelligence-policy.ts"]);
  });

  it("a second fixture workspace (or any workspace read from the environment) fails this guard", () => {
    const code = codeOf("jobs/intelligence-policy.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)).toEqual([D1F]);
    expect(code).toMatch(/fixtureWorkspaceIds: Object\.freeze\(\[D1F_SYNTHETIC_WORKSPACE_ID\]\),/);
    expect(code).toMatch(/realDataEligible: false,/);
    expect(code).toMatch(/includeBackfill: false,/);
    expect(code).not.toMatch(/process\.env|import\.meta\.env|readFileSync|fetch\(/);
    expect([...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual(["@/modules/classification"]);
  });

  it("the qualified descriptor is executable but its qualification is untouched and it is NOT production-selected", () => {
    expect(QUALIFIED_UNDERSTANDING_DESCRIPTOR.enabled).toBe(true);
    expect(PRODUCTION_INTELLIGENCE.models).toEqual([QUALIFIED_UNDERSTANDING_DESCRIPTOR]);
    expect(Object.keys(QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL)).not.toContain("enabled");
    expect(createHash("sha256").update(JSON.stringify(QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL)).digest("hex")).toBe(QUALIFIED_UNDERSTANDING_FINGERPRINT);
    expect(QUALIFIED_UNDERSTANDING_FINGERPRINT).toBe("76e0ca1f5478239fe0cb11df2994071f1a20825c12fc90c3c82e6d53f1d4b53b");
    expect(QUALIFIED_UNDERSTANDING_BINDING.routeFingerprint).toBe(QUALIFIED_UNDERSTANDING_FINGERPRINT);
    expect(QUALIFIED_UNDERSTANDING_QUALIFICATION.productionModelSelected).toBe(false);
  });

  it("the character cap is exactly ONE run of the declared fixture (2 × its worst platform / source input); a second run can't fit", () => {
    const sizes: number[] = [];
    for (const platform of ["facebook", "instagram", "tiktok"] as const) {
      for (const source of ["organic", "paid", "mixed", "unknown"] as const) {
        const eligible = canonicalEligibility({ sourceTextVersionId: VERSION, currentSourceTextVersionId: VERSION, observed: true, kind: "comment", authorRole: "user", sourceText: D1F_SYNTHETIC_FIXTURE_TEXT, platform, parent: null, root: null }, source);
        if (!eligible.ok) throw new Error("fixture must be eligible");
        const prepared = prepareUnderstandingInput(eligible.params);
        if (prepared.kind !== "ready") throw new Error("fixture must be ready");
        sizes.push(UNDERSTANDING_TASK.prompt.system.length + renderDataBlock(UNDERSTANDING_TASK.data(prepared.input)).length);
      }
    }
    expect(Math.max(...sizes)).toBe(4_365);
    expect(D1F_MAX_INPUT_CHARS_PER_DAY).toBe(2 * Math.max(...sizes));
    expect(4 * Math.min(...sizes)).toBeGreaterThan(D1F_MAX_INPUT_CHARS_PER_DAY);
  });
});

describe("H7-D1f-prep · MAIN dispatch: ELIGIBLE ⇔ workspace == D1F", () => {
  it("the dedicated synthetic workspace dispatches (AI_PENDING generation 1 + one dispatch)", async () => {
    const fake = fakeScope(D1F);
    expect(await dispatchUnderstanding(fake.scope, clock, INTELLIGENCE_ROUTE_POLICY, dispatchInput(D1F))).toEqual({ kind: "dispatched", requestId: REQUEST, generation: 1 });
    expect(fake.dispatches).toEqual([1]);
  });

  it("every other workspace is real data: skipped before anything is read or written (NON_D1F_WORKSPACE_ELIGIBLE_COUNT = 0)", async () => {
    let eligible = 0;
    for (const workspaceId of OTHER_WORKSPACES) {
      for (const arrival of ["realtime", "reconciliation", "backfill"] as const) {
        const fake = fakeScope(workspaceId);
        const outcome = await dispatchUnderstanding(fake.scope, clock, INTELLIGENCE_ROUTE_POLICY, dispatchInput(workspaceId, arrival));
        if (outcome.kind !== "skipped") eligible += 1;
        expect(outcome).toEqual({ kind: "skipped", reason: "real_data_not_eligible" });
        expect([fake.reads, fake.writes, fake.transitions, fake.dispatches]).toEqual([[], [], [], []]);
      }
    }
    expect(eligible).toBe(0);
  });

  it("backfill is never eligible, even for the dedicated workspace (BACKFILL_ELIGIBLE = NO)", async () => {
    const fake = fakeScope(D1F);
    expect(await dispatchUnderstanding(fake.scope, clock, INTELLIGENCE_ROUTE_POLICY, dispatchInput(D1F, "backfill"))).toEqual({ kind: "skipped", reason: "backfill_excluded" });
    expect([fake.reads, fake.writes, fake.dispatches]).toEqual([[], [], []]);
  });

  it("recovery never re-dispatches another workspace's stale request: it ends AI_FAILED, no dispatch", async () => {
    const fake = fakeScope(OTHER_WORKSPACES[0], { state: "AI_PENDING" });
    const later = { ...clock, now: () => new Date(clock.now().getTime() + STALE_IN_FLIGHT_MS * 10) };
    expect(await recoverStaleUnderstanding(fake.scope, later, INTELLIGENCE_ROUTE_POLICY, { correlationId: "h7d1f-prep-unit-02" })).toEqual({ redispatched: 0, failed: 1 });
    expect(fake.transitions.map((t) => [t.to, t.failureClass])).toEqual([["AI_FAILED", "AI_UNAVAILABLE"]]);
    expect(fake.dispatches).toEqual([]);
  });
});

describe("H7-D1f-prep · INTELLIGENCE re-filter: a stale or forged payload for another workspace never reaches budget, intent or egress", () => {
  const run = (fake: ReturnType<typeof fakeScope>, workspaceId: string, gatewayReached: () => never) => runUnderstanding({
    inScope: (work) => work(fake.scope),
    policy: PRODUCTION_INTELLIGENCE.policy,
    binding: QUALIFIED_UNDERSTANDING_BINDING,
    clock,
    gatewayFor: gatewayReached,
  }, { workspaceId, interactionId: INTERACTION, sourceTextVersionId: VERSION, understandingRequestId: REQUEST, correlationId: "h7d1f-prep-unit-03" }, { runId: "run_d1fprep" });

  it("another workspace's AI_PENDING request is refused AI_UNAVAILABLE(real_data_not_eligible): no AI_RUNNING, no budget, no intent, no gateway", async () => {
    for (const workspaceId of OTHER_WORKSPACES) {
      const fake = fakeScope(workspaceId, { state: "AI_PENDING" });
      const outcome = await run(fake, workspaceId, () => { throw new Error("gateway must not be composed"); });
      expect(outcome).toEqual({ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "real_data_not_eligible" });
      expect(fake.transitions.map((t) => [t.from, t.to])).toEqual([["AI_PENDING", "AI_FAILED"]]);
      expect(fake.writes).toEqual([]);
    }
  });

  it("a backfill request of the dedicated workspace is refused the same way (backfill_excluded)", async () => {
    const fake = fakeScope(D1F, { state: "AI_PENDING", arrival: "backfill" });
    expect(await run(fake, D1F, () => { throw new Error("gateway must not be composed"); })).toEqual({ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "backfill_excluded" });
    expect(fake.writes).toEqual([]);
  });

  it("only the dedicated workspace passes the re-check and reaches the gateway, after AI_RUNNING is committed", async () => {
    const fake = fakeScope(D1F, { state: "AI_PENDING" });
    await expect(run(fake, D1F, () => { throw new Error("gateway_reached"); })).rejects.toThrow("gateway_reached");
    expect(fake.transitions.map((t) => [t.from, t.to])).toEqual([["AI_PENDING", "AI_RUNNING"]]);
    expect(fake.writes).toEqual([]);
  });
});

