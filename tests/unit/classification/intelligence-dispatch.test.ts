/**
 * Step H7-D1d — the MAIN dispatch, the pre-model eligibility and the INTELLIGENCE composition, without a database (the
 * DB suite tests/db/suites/intelligence-runtime.ts proves the same paths on schema 0025). Fakes only: no provider call,
 * no network, no credential (synthetic values only).
 */
import { describe, expect, it } from "vitest";
import { ANTHROPIC_PROVIDER_KEY } from "@/ai/providers/anthropic";
import { QUALIFIED_UNDERSTANDING_DESCRIPTOR, QUALIFIED_UNDERSTANDING_FINGERPRINT } from "@/ai/providers/anthropic/qualified";
import { PRODUCTION_INTELLIGENCE, QUALIFIED_UNDERSTANDING_BINDING, intelligenceProviders } from "@/jobs/intelligence";
import { INTELLIGENCE_ROUTE_POLICY } from "@/jobs/intelligence-policy";
import {
  DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
  canonicalEligibility,
  dispatchUnderstanding,
  prepareUnderstandingInput,
  type IntelligenceRequestRecord,
  type IntelligenceScope,
  type RequestTransition,
  type UnderstandAiRoutePolicy,
  type UnderstandingCandidate,
} from "@/modules/classification";
import type { UnderstandingContextRecord } from "@/modules/interactions";
import { MODEL_PROVIDER_AMBIENT_VARIABLES } from "@/domain/model-provider-variables";
import { codeOf } from "../../support/source-scan";

const WS = "5a5e0000-0000-4000-8000-0000000001d1";
const ORG = "5a5e0000-0000-4000-8000-0000000001d0";
const INTERACTION = "5a5e0000-0000-4000-8000-0000000001d2";
const VERSION = "5a5e0000-0000-4000-8000-0000000001d3";
const REQUEST = "5a5e0000-0000-4000-8000-0000000001d4";
const POLICY: UnderstandAiRoutePolicy = {
  ...DEFAULT_UNDERSTAND_AI_ROUTE_POLICY, enabled: true, samplingPercentage: 100, killSwitch: "inactive", model: { providerKey: "simulator", modelKey: "sim" }, timeoutMs: 30_000,
  budget: { kind: "caps", maxCallsPerDay: 10, maxInputCharsPerDay: 100_000 }, fixtureWorkspaceIds: [WS],
};

const candidate = (overrides: Partial<UnderstandingCandidate> = {}): UnderstandingCandidate => ({
  sourceTextVersionId: VERSION, currentSourceTextVersionId: VERSION, observed: true, kind: "comment", authorRole: "user", sourceText: "Muy buen servicio", platform: "facebook", parent: null, root: null, ...overrides,
});

function fakeScope(context: Partial<UnderstandingContextRecord> = {}, options: { readonly killed?: boolean | "throws"; readonly state?: string } = {}) {
  const transitions: RequestTransition[] = [];
  const dispatches: number[] = [];
  const reads: string[] = [];
  const record: IntelligenceRequestRecord = { id: REQUEST, organizationId: ORG, workspaceId: WS, interactionId: INTERACTION, sourceTextVersionId: VERSION, pipelineVersion: "classification.intelligence.v1", arrival: "realtime", state: "PENDING", aiGeneration: null, updatedAt: new Date() };
  const scope: IntelligenceScope = {
    texts: {
      analysisText: () => Promise.resolve(undefined),
      understandingContext: () => {
        reads.push("context");
        return Promise.resolve({ organizationId: ORG, workspaceId: WS, interactionId: INTERACTION, sourceTextVersionId: VERSION, observed: true, kind: "comment", authorRole: "user", sourceText: "Muy buen servicio",
          platform: "facebook", contentItemId: null, currentSourceTextVersionId: VERSION, parent: null, root: null, ...context });
      },
    },
    contents: { reportedSource: () => Promise.resolve("organic") },
    store: {
      ensureRequest: () => Promise.resolve({ id: REQUEST, state: (options.state ?? "PENDING") as "PENDING", created: true }),
      advanceRequest: () => Promise.resolve(true),
      recordSignal: () => Promise.resolve("inserted"),
    },
    intelligence: {
      lockRequest: () => Promise.resolve(record),
      transition: (t) => { transitions.push(t); return Promise.resolve(true); },
      recordCallIntent: () => Promise.resolve("inserted"),
      appendDispatch: ({ generation }) => { dispatches.push(generation); return Promise.resolve("appended"); },
      recordAttempts: () => Promise.resolve(0),
      recordResult: () => Promise.resolve("inserted"),
      recordShadowAssessments: () => Promise.resolve(0),
      ruleAssessments: () => Promise.resolve([]),
      staleInFlight: () => Promise.resolve([]),
      reserveBudget: () => Promise.resolve(false),
    },
    aiTaskKilled: () => (options.killed === "throws" ? Promise.reject(new Error("unreadable")) : Promise.resolve(options.killed ?? false)),
  };
  return { scope, transitions, dispatches, reads };
}

const clock = { newId: () => "5a5e0000-0000-4000-8000-0000000001ff", now: () => new Date("2026-10-31T12:00:00.000Z") };
const input = { workspaceId: WS, interactionId: INTERACTION, sourceTextVersionId: VERSION, arrival: "realtime" as const, correlationId: "h7d1d-unit-000001" };

describe("H7-D1d · pre-model eligibility (checks 1–5, 10)", () => {
  it("refuses unsupported state, superseded versions, own brand, empty and emoji-only text — never by a watch term", () => {
    expect(canonicalEligibility(candidate({ observed: false }), "organic")).toEqual({ ok: false, reason: "event_not_supported" });
    expect(canonicalEligibility(candidate({ kind: "reaction" }), "organic")).toEqual({ ok: false, reason: "event_not_supported" });
    expect(canonicalEligibility(candidate({ platform: "myspace" }), "organic")).toEqual({ ok: false, reason: "event_not_supported" });
    expect(canonicalEligibility(candidate({ currentSourceTextVersionId: "5a5e0000-0000-4000-8000-0000000001ee" }), "organic")).toEqual({ ok: false, reason: "version_superseded" });
    expect(canonicalEligibility(candidate({ authorRole: "account_identity" }), "organic")).toEqual({ ok: false, reason: "own_brand" });
    expect(canonicalEligibility(candidate({ sourceText: "  \n " }), "organic")).toEqual({ ok: false, reason: "text_empty" });
    expect(canonicalEligibility(candidate({ sourceText: "🔥🔥" }), "organic")).toEqual({ ok: false, reason: "text_emoji_only" });
  });

  it("builds the A1 parameters only: a reply's context and own-brand hints; unknown content source stays unknown; no brand name / caption source yet", () => {
    const comment = canonicalEligibility(candidate({ sourceText: "mira https://example.com" }), "paid");
    expect(comment).toMatchObject({ ok: true, params: { interactionKind: "comment", source: "paid", linkPresent: true, brandName: null, captionText: null } });
    if (comment.ok) expect(Object.keys(comment.params)).not.toContain("parentByOwnBrand");
    const reply = canonicalEligibility(candidate({ kind: "reply", parent: { sourceText: "¿Precio?", authorRole: "account_identity" }, root: { sourceText: "Hola", authorRole: "unknown" } }), "weird");
    expect(reply).toMatchObject({ ok: true, params: { interactionKind: "reply", source: "unknown", parentText: "¿Precio?", rootText: "Hola", parentByOwnBrand: true, rootByOwnBrand: null } });
    if (reply.ok) expect(prepareUnderstandingInput(reply.params).kind).toBe("ready");
  });

  it("an analyzed text over the A1 bound is AI_INPUT_TOO_LARGE (never truncated)", () => {
    const big = canonicalEligibility(candidate({ sourceText: "a".repeat(32_769) }), "organic");
    if (!big.ok) throw new Error("eligible");
    expect(prepareUnderstandingInput(big.params)).toEqual({ kind: "failed", failure: { class: "AI_INPUT_TOO_LARGE", cause: "input_limit", retryable: false } });
  });
});

describe("H7-D1d · MAIN dispatch (fakes)", () => {
  it("the default policy reads nothing and writes nothing", async () => {
    const fake = fakeScope();
    expect(await dispatchUnderstanding(fake.scope, clock, DEFAULT_UNDERSTAND_AI_ROUTE_POLICY, input)).toEqual({ kind: "skipped", reason: "route_disabled" });
    expect(fake.reads).toEqual([]);
    expect(fake.transitions).toEqual([]);
  });

  it("a complete policy: PENDING → AI_PENDING(1) + one dispatch; an oversized text → AI_FAILED(AI_INPUT_TOO_LARGE), no dispatch", async () => {
    const ok = fakeScope();
    expect(await dispatchUnderstanding(ok.scope, clock, POLICY, input)).toEqual({ kind: "dispatched", requestId: REQUEST, generation: 1 });
    expect(ok.transitions.map((t) => [t.from, t.fromGeneration, t.to, t.generation, t.failureClass])).toEqual([["PENDING", null, "AI_PENDING", 1, null]]);
    expect(ok.dispatches).toEqual([1]);
    const big = fakeScope({ sourceText: "a".repeat(32_769) });
    expect(await dispatchUnderstanding(big.scope, clock, POLICY, input)).toEqual({ kind: "input_too_large", requestId: REQUEST });
    expect(big.transitions.map((t) => [t.to, t.generation, t.failureClass])).toEqual([["AI_FAILED", 1, "AI_INPUT_TOO_LARGE"]]);
    expect(big.dispatches).toEqual([]);
  });

  it("an existing request is left as it is; the global kill switch (or an unreadable one) skips before any read", async () => {
    const existing = fakeScope({}, { state: "AI_PENDING" });
    expect(await dispatchUnderstanding(existing.scope, clock, POLICY, input)).toEqual({ kind: "existing", requestId: REQUEST, state: "AI_PENDING" });
    expect(existing.transitions).toEqual([]);
    for (const killed of [true, "throws"] as const) {
      const fake = fakeScope({}, { killed });
      expect(await dispatchUnderstanding(fake.scope, clock, POLICY, input)).toEqual({ kind: "skipped", reason: "kill_switch" });
      expect(fake.reads).toEqual([]);
    }
  });

  it("another workspace's target, an invalid input (reply without parent text) or real data never dispatch", async () => {
    expect(await dispatchUnderstanding(fakeScope({ workspaceId: "5a5e0000-0000-4000-8000-0000000001aa" }).scope, clock, POLICY, input)).toEqual({ kind: "skipped", reason: "target_not_found" });
    expect(await dispatchUnderstanding(fakeScope({ kind: "reply", parent: null }).scope, clock, POLICY, input)).toEqual({ kind: "skipped", reason: "input_invalid" });
    expect(await dispatchUnderstanding(fakeScope().scope, clock, { ...POLICY, fixtureWorkspaceIds: [] }, input)).toEqual({ kind: "skipped", reason: "real_data_not_eligible" });
  });
});

describe("H7-D1d · the INTELLIGENCE composition", () => {
  it("binds the QUALIFIED descriptor (still disabled), its fingerprint and the deny-by-default policy", () => {
    expect(PRODUCTION_INTELLIGENCE.policy).toBe(INTELLIGENCE_ROUTE_POLICY);
    expect(INTELLIGENCE_ROUTE_POLICY).toBe(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY);
    expect(PRODUCTION_INTELLIGENCE.models).toEqual([QUALIFIED_UNDERSTANDING_DESCRIPTOR]);
    expect(QUALIFIED_UNDERSTANDING_DESCRIPTOR.enabled).toBe(false);
    expect(QUALIFIED_UNDERSTANDING_BINDING).toEqual({ model: { providerKey: "anthropic", modelKey: "claude-sonnet-5-5" }, modelRequested: "claude-sonnet-5-5", transportSchemaVersion: "anthropic-transport-schema.v2", routeFingerprint: QUALIFIED_UNDERSTANDING_FINGERPRINT });
  });

  it("composes a provider only from INTELLIGENCE_MODEL_API_KEY, passed explicitly; ANTHROPIC_API_KEY or any ambient variable alone yields none", () => {
    expect(intelligenceProviders({})).toEqual([]);
    expect(intelligenceProviders({ INTELLIGENCE_MODEL_API_KEY: "" })).toEqual([]);
    const ambient = Object.fromEntries(MODEL_PROVIDER_AMBIENT_VARIABLES.map((name) => [name, "synthetic-value"]));
    expect(intelligenceProviders(ambient)).toEqual([]);
    const providers = intelligenceProviders({ INTELLIGENCE_MODEL_API_KEY: "synthetic-value" });
    expect(providers.map((p) => p.providerKey)).toEqual([ANTHROPIC_PROVIDER_KEY]);
    const code = codeOf("jobs/intelligence.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/ANTHROPIC_API_KEY|process\.env\[|process\.env\./);
    expect(code).toMatch(/const apiKey = environment\[INTELLIGENCE_MODEL_API_KEY_ENV\];/);
    // H7-D1g-prep: the key goes explicitly to the runtime client (no SDK retries, no trace propagation to the provider).
    expect(code).toMatch(/createRuntimeAnthropicClient\(apiKey\)/);
  });
});
