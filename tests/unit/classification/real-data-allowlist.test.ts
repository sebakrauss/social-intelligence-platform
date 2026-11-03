/**
 * Step H7-D1g-prep — the separate REAL-workspace allowlist, the egress-fence kill recheck's closed vocabulary and the
 * operator-visible terminal run outcome. Pure: no database, no provider, no network, no real data (every workspace id
 * here is a random synthetic uuid; no real workspace is ever named).
 *
 *   real data ⇔ the real-data capability (`realDataEligible: true`) AND exact membership in `realDataWorkspaceIds`
 *   a fixture workspace is never real-authorized; a workspace in both lists is a conflict and is never routed
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_CLIENT_OPEN_TELEMETRY, createRuntimeAnthropicClient } from "@/ai/providers/anthropic/runtime-client";
import { INTELLIGENCE_ROUTE_POLICY } from "@/jobs/intelligence-policy";
import {
  DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
  ROUTE_SKIP_REASONS,
  decideUnderstandAiRoute,
  operationallyKilled,
  routeDecisionFor,
  workspaceDataClassOf,
  type UnderstandAiRoutePolicy,
} from "@/modules/classification";
import { UNDERSTANDING_RUN_REPORT_CATEGORIES, interruptedRunReport, understandingRunReport, type UnderstandingRunOutcome } from "@/modules/classification/intelligence-runtime";

const A = randomUUID();
const B = randomUUID();
const FIXTURE = randomUUID();
/** A version id in sampling bucket 0 (its first 8 hex digits are 0), so sampling never decides these cases. */
const VERSION = "00000000-0000-4000-8000-000000000001";

/** A complete simulator route: every gate open EXCEPT the real-data ones, which each case sets explicitly. */
const complete = (overrides: Partial<UnderstandAiRoutePolicy> = {}): UnderstandAiRoutePolicy => ({
  ...DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
  enabled: true,
  samplingPercentage: 100,
  killSwitch: "inactive",
  model: { providerKey: "simulator", modelKey: "sim" },
  timeoutMs: 30_000,
  budget: { kind: "caps", maxCallsPerDay: 2, maxInputCharsPerDay: 10_000 },
  ...overrides,
});
const decide = (policy: UnderstandAiRoutePolicy, workspaceId: string, arrival = "realtime") => routeDecisionFor(policy, { workspaceId, sourceTextVersionId: VERSION, arrival });

describe("H7-D1g-prep · the real-workspace allowlist", () => {
  it("defaults: both allowlists empty, the capability off, and the deployed policy IS that default", () => {
    expect(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY).toMatchObject({ realDataEligible: false, fixtureWorkspaceIds: [], realDataWorkspaceIds: [] });
    expect(INTELLIGENCE_ROUTE_POLICY).toBe(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY);
    expect(INTELLIGENCE_ROUTE_POLICY.realDataWorkspaceIds).toHaveLength(0);
    expect(Object.isFrozen(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY.realDataWorkspaceIds)).toBe(true);
    expect(decide(INTELLIGENCE_ROUTE_POLICY, A)).toEqual({ kind: "skip", reason: "route_disabled" });
  });

  it("A · real-data capability OFF + an allowlisted workspace ⇒ DENY (real_data_not_eligible)", () => {
    expect(decide(complete({ realDataEligible: false, realDataWorkspaceIds: [A] }), A)).toEqual({ kind: "skip", reason: "real_data_not_eligible" });
  });

  it("B · capability ON + an EMPTY real allowlist ⇒ DENY every real workspace (no implicit 'all real workspaces')", () => {
    const policy = complete({ realDataEligible: true, realDataWorkspaceIds: [] });
    for (const workspace of [A, B, randomUUID()]) expect(decide(policy, workspace)).toEqual({ kind: "skip", reason: "real_workspace_not_authorized" });
  });

  it("C · capability ON + A allowlisted ⇒ A may call (still subject to sampling / backfill / budget / model / kill); B ⇒ DENY", () => {
    const policy = complete({ realDataEligible: true, realDataWorkspaceIds: [A] });
    expect(decide(policy, A)).toMatchObject({ kind: "call", acceptanceMode: "shadow" });
    expect(decide(policy, B)).toEqual({ kind: "skip", reason: "real_workspace_not_authorized" });
    // A stays subject to every other gate.
    expect(decide({ ...policy, samplingPercentage: 0 }, A)).toEqual({ kind: "skip", reason: "not_sampled" });
    expect(decide(policy, A, "backfill")).toEqual({ kind: "skip", reason: "backfill_excluded" });
    expect(decide({ ...policy, budget: { kind: "deny_all" } }, A)).toEqual({ kind: "skip", reason: "no_budget" });
    expect(decide({ ...policy, model: null }, A)).toEqual({ kind: "skip", reason: "no_model" });
    expect(decide({ ...policy, killSwitch: "active" }, A)).toEqual({ kind: "skip", reason: "kill_switch" });
  });

  it("D · a synthetic fixture workspace never implies real authorization, and the two lists stay semantically separate", () => {
    const policy = complete({ realDataEligible: false, fixtureWorkspaceIds: [FIXTURE] });
    expect(workspaceDataClassOf(policy, FIXTURE)).toBe("synthetic_fixture");
    expect(decide(policy, FIXTURE)).toMatchObject({ kind: "call" }); // synthetic data needs no real-data capability
    // Fixtures authorize nothing real: a real workspace stays denied even with the capability on.
    expect(decide({ ...policy, realDataEligible: true }, A)).toEqual({ kind: "skip", reason: "real_workspace_not_authorized" });
    expect(workspaceDataClassOf(policy, A)).toBe("real_unauthorized");
    // Being REAL-allowlisted never makes a workspace synthetic (no capability ⇒ still denied as real data).
    expect(workspaceDataClassOf(complete({ realDataWorkspaceIds: [A] }), A)).toBe("real_authorized");
    expect(decide(complete({ realDataWorkspaceIds: [A] }), A)).toEqual({ kind: "skip", reason: "real_data_not_eligible" });
    // Named by BOTH lists: a misconfiguration — never routed, whatever the capability says.
    const both = complete({ realDataEligible: true, fixtureWorkspaceIds: [A], realDataWorkspaceIds: [A] });
    expect(workspaceDataClassOf(both, A)).toBe("class_conflict");
    expect(decide(both, A)).toEqual({ kind: "skip", reason: "workspace_class_conflict" });
  });

  it("exact membership only: no wildcard, no prefix, no case folding, no non-uuid entry", () => {
    for (const entry of ["*", "%", A.slice(0, 8), A.toUpperCase(), ` ${A}`, ""]) {
      expect(decide(complete({ realDataEligible: true, realDataWorkspaceIds: [entry] }), A), JSON.stringify(entry)).toEqual({ kind: "skip", reason: "real_workspace_not_authorized" });
    }
    expect(workspaceDataClassOf(complete({ realDataWorkspaceIds: ["*"] }), "*")).toBe("real_unauthorized");
  });

  it("fail closed outside the type system: a capability that isn't exactly `true`, or an unknown data class, never admits real data", () => {
    const loose = { ...complete({ realDataWorkspaceIds: [A] }), realDataEligible: "true" } as unknown as UnderstandAiRoutePolicy;
    expect(decide(loose, A)).toEqual({ kind: "skip", reason: "real_data_not_eligible" });
    const bogus = { samplingBucket: 0, dataClass: "real" } as unknown as Parameters<typeof decideUnderstandAiRoute>[1];
    expect(decideUnderstandAiRoute(complete({ realDataEligible: true, realDataWorkspaceIds: [A] }), bogus)).toEqual({ kind: "skip", reason: "real_workspace_not_authorized" });
    expect(ROUTE_SKIP_REASONS).toEqual(expect.arrayContaining(["real_data_not_eligible", "real_workspace_not_authorized", "workspace_class_conflict"]));
  });

  it("E · the DB kill: active, unreadable or non-boolean ⇒ killed (no egress); only an explicit `false` lets a run continue", async () => {
    expect(await operationallyKilled({ aiTaskKilled: () => Promise.resolve(true) })).toBe(true);
    expect(await operationallyKilled({ aiTaskKilled: () => Promise.reject(new Error("db down")) })).toBe(true);
    expect(await operationallyKilled({ aiTaskKilled: () => Promise.resolve("no" as unknown as boolean) })).toBe(true);
    expect(await operationallyKilled({ aiTaskKilled: () => Promise.resolve(false) })).toBe(false);
  });
});

describe("H7-D1g-prep · the operator-visible terminal run outcome (closed vocabulary, never text)", () => {
  const protection = {} as never;
  const needsReview = {} as never;
  const failed = (cause: string, failureClass = "AI_UNAVAILABLE"): UnderstandingRunOutcome =>
    ({ kind: "failed", generation: 1, attempts: 1, failureClass, cause, redispatched: false, protection, needsReview }) as UnderstandingRunOutcome;
  const cases: readonly [UnderstandingRunOutcome, string, string, boolean][] = [
    [{ kind: "completed", generation: 1, attempts: 1, assessments: 7, protection, needsReview }, "completed", "shadow_result", true],
    [{ kind: "skipped", reason: "duplicate_delivery" }, "skipped", "duplicate_delivery", true],
    [{ kind: "skipped", reason: "request_not_found" }, "request_not_found", "request_not_found", false],
    [{ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "kill_switch" }, "killed", "kill_switch", false],
    [{ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "real_workspace_not_authorized" }, "refused", "real_workspace_not_authorized", false],
    [{ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "model_binding_mismatch" }, "model_unavailable", "model_binding_mismatch", false],
    [{ kind: "refused", failureClass: "AI_INPUT_TOO_LARGE", reason: "input_too_large" }, "input_too_large", "input_too_large", false],
    [failed("kill_switch"), "killed", "kill_switch", false],
    [failed("budget_exhausted", "AI_BUDGET"), "budget_denied", "budget_exhausted", false],
    [failed("model_unavailable"), "model_unavailable", "model_unavailable", false],
    [failed("provider_unavailable"), "provider_failed", "provider_unavailable", false],
    [failed("timeout"), "timeout", "timeout", false],
    [failed("invalid_output", "AI_INVALID_OUTPUT"), "reask_exhausted", "invalid_output", false],
    [failed("refused", "AI_REFUSED"), "provider_refused", "refused", false],
    [failed("egress_unrecorded"), "egress_denied", "egress_unrecorded", false],
    [{ kind: "generation_superseded", generation: 2, attempts: 1 }, "generation_superseded", "generation_superseded", true],
  ];

  it("each terminal outcome maps to its category, its closed detail and ok/error — never a hard-coded `ok`", () => {
    for (const [outcome, category, detail, ok] of cases) expect(understandingRunReport(outcome), `${category}.${detail}`).toEqual({ category, detail, ok });
    for (const [outcome] of cases) expect(`${understandingRunReport(outcome).category}.${understandingRunReport(outcome).detail}`).toMatch(/^[a-z][a-z0-9_.]{0,127}$/);
  });

  it("a run that THREW: UNKNOWN_PROVIDER_OUTCOME when an authorized call has no durable attempt, otherwise a plain run error", () => {
    expect(interruptedRunReport({ authorized: 1, recorded: 0 })).toEqual({ category: "unknown_provider_outcome", detail: "attempt_unrecorded", ok: false });
    expect(interruptedRunReport({ authorized: 2, recorded: 1 })).toEqual({ category: "unknown_provider_outcome", detail: "attempt_unrecorded", ok: false });
    expect(interruptedRunReport({ authorized: 1, recorded: 1 })).toEqual({ category: "run_error", detail: "exception", ok: false });
    expect(interruptedRunReport({ authorized: 0, recorded: 0 })).toEqual({ category: "run_error", detail: "exception", ok: false });
  });

  it("the vocabulary covers every category the gate requires", () => {
    expect(UNDERSTANDING_RUN_REPORT_CATEGORIES).toEqual(expect.arrayContaining(["completed", "skipped", "killed", "budget_denied", "model_unavailable", "request_not_found", "provider_failed", "timeout", "unknown_provider_outcome", "reask_exhausted"]));
  });
});

describe("H7-D1g-prep · no trace context reaches the model provider", () => {
  it("the INTELLIGENCE runtime's Anthropic client has OpenTelemetry propagation OFF and metadata-only spans", () => {
    expect(ANTHROPIC_CLIENT_OPEN_TELEMETRY).toEqual({ propagation: false, traces: { contentMode: "metadata_only" } });
    // The client's own settled option (the SDK's getter): fails if the option is removed (the SDK default propagates).
    const client = createRuntimeAnthropicClient("placeholder-not-a-credential") as unknown as { readonly openTelemetry: { readonly propagation: boolean; readonly traces: { readonly contentMode: string } } };
    expect(client.openTelemetry.propagation).toBe(false);
    expect(client.openTelemetry.traces.contentMode).toBe("metadata_only");
  });
});
