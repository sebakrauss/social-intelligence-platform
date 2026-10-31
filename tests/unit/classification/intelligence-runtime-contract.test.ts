/**
 * Step H7-D1b — the INTELLIGENCE runtime contracts, offline (simulator, synthetic ids, no network): the declared-only
 * intelligence plane and its environment boundary, the qualified model registry entry (fingerprint pinned to the H7-D0
 * candidate), the fail-safe route policy, the pipeline / generation identity, the IDs-only job payload, the frozen A1
 * model input, the oversized-input and budget contracts, the provider-independent result / ledger records and the
 * deterministic outcome (Protection and Needs review are derived by code, never model output).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AI_FAILURE_CLASSES, DENY_ALL_BUDGET, createAiGateway, createModelRegistry, type BudgetPort, type GatewayDependencies, type ModelProvider, type ProviderRequest } from "@/ai/gateway";
import { ANTHROPIC_TRANSPORT_SCHEMA_VERSION } from "@/ai/providers/anthropic/schema-projection";
import {
  QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS,
  QUALIFIED_UNDERSTANDING_DESCRIPTOR,
  QUALIFIED_UNDERSTANDING_FINGERPRINT,
  QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL,
  QUALIFIED_UNDERSTANDING_MAX_OUTPUT_TOKENS,
  QUALIFIED_UNDERSTANDING_MODEL_REF,
  QUALIFIED_UNDERSTANDING_QUALIFICATION,
  QUALIFIED_UNDERSTANDING_SETTINGS,
} from "@/ai/providers/anthropic/qualified";
import { createSimulatorProvider, simulatorModel } from "@/ai/providers/simulator";
import { MODEL_PROVIDER_AMBIENT_CREDENTIALS, MODEL_PROVIDER_AMBIENT_OVERRIDES, MODEL_PROVIDER_AMBIENT_VARIABLES } from "@/domain/model-provider-variables";
import { parseInstant } from "@/domain/instant";
import { INTEGRATION_AWS_IDENTITY_VARIABLES, INTELLIGENCE_MODEL_API_KEY_ENV, INTELLIGENCE_PLANE_VARIABLES, PLANE_FORBIDDEN_VARIABLES, RETIRED_INTEGRATION_AWS_BOOTSTRAP_VARIABLES, assertPlaneEnvironment, planeEnvironmentProblems } from "@/jobs/plane-environment";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import {
  DETERMINISTIC_PIPELINE_VERSION,
  TAXONOMY_VERSION,
  UNDERSTANDING_FAILURE_CLASSES,
  UNDERSTANDING_INPUT_BOUNDS,
  buildUnderstandingInput,
  deriveUnderstandingOutcome,
  parseAnalysisTarget,
  validateUnderstandingOutput,
  type UnderstandingInput,
} from "@/modules/classification";
import {
  ACCEPTANCE_MODES,
  DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
  H7_D1_ACCEPTANCE_MODE,
  INTELLIGENCE_FAILURE_CLASSES,
  INTELLIGENCE_PIPELINE_VERSION,
  LEDGER_ENTRY_FIELDS,
  RESULT_FIELDS,
  UNDERSTAND_AI_PAYLOAD_FIELDS,
  UNDERSTAND_AI_PLANE,
  UNDERSTAND_AI_TOPIC,
  decideUnderstandAiRoute,
  isIntelligencePipelineRequest,
  parseUnderstandAiDispatchKey,
  parseUnderstandAiJobPayload,
  prepareUnderstandingInput,
  toAttemptLedgerEntries,
  toIntelligenceResult,
  understandAiDispatchKey,
  understandAiPayloadFromEnvelope,
  understandAiRouteTable,
  understandAiSubjectIds,
  type IntelligenceRecordContext,
  type UnderstandAiRoutePolicy,
} from "@/modules/classification/application/ai/understand-ai-contract";
import { understandInteraction } from "@/modules/classification/application/ai/understand-interaction";
import { UNDERSTANDING_OUTPUT_JSON_SCHEMA } from "@/modules/classification/application/ai/understanding-output-schema";
import { UNDERSTANDING_DATA_FIELDS, UNDERSTANDING_TASK_ID, UNDERSTANDING_TASK_VERSION } from "@/modules/classification/application/ai/understanding-task";
import { DELIVERY_PLANES, EXECUTION_PLANES, TaskRegistryError, defineTaskRegistry, isDeliveryPlane, isExecutionPlane, RETRY_POLICIES } from "@/platform/jobs";
import { UNDERSTANDING_PROMPT_HASH, UNDERSTANDING_PROMPT_SYSTEM, UNDERSTANDING_PROMPT_VERSION } from "@/prompts/classification/understanding.v2";
import { FORBIDDEN_WEB_VARIABLES, forbiddenWebVariables } from "@/server/http/web-environment";
import { CORPUS_FILE, CORPUS_VERSION, parseEvalCorpus } from "../../eval/classification/corpus";
import { EVALUATOR_VERSION, evaluateCorpus } from "../../eval/classification/evaluate";
import { goldenOutput, goldenScript } from "../../eval/classification/golden";
import { CANDIDATES, LIVE_CALL_TIMEOUT_MS, MAX_OUTPUT_TOKENS, candidateModel } from "../../eval/classification/live/candidates";
import { candidateConfigFingerprint } from "../../eval/classification/live/evidence";
import { STABILITY_POLICY_VERSION } from "../../eval/classification/live/stability-policy";
import { PROMOTION_POLICY } from "../../eval/classification/promotion";
import { REPOSITORY_ROOT } from "../../support/source-scan";

const PINNED = { kind: "pinned", releaseId: "commit-synthetic-1" } as const;
const DEVELOPMENT = { kind: "development" } as const;
const SYNTHETIC = "synthetic-value";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const CORPUS_BYTES = readFileSync(path.join(REPOSITORY_ROOT, CORPUS_FILE));
const CORPUS = parseEvalCorpus(JSON.parse(CORPUS_BYTES.toString("utf8")));
const GOLDEN = goldenScript(CORPUS);

const WORKSPACE = "5a5e0000-0000-4000-8000-0000000000d1";
const INTERACTION = "5a5e0000-0000-4000-8000-0000000000d2";
const VERSION = "5a5e0000-0000-4000-8000-0000000000d3";
const REQUEST = "5a5e0000-0000-4000-8000-0000000000d4";
const TARGET = parseAnalysisTarget({ workspaceId: WORKSPACE, interactionId: INTERACTION, sourceTextVersionId: VERSION }) ?? (() => { throw new Error("target"); })();
const AT = parseInstant("2026-10-31T12:00:00.000Z") ?? (() => { throw new Error("instant"); })();
const SIM_REF = { providerKey: "simulator", modelKey: "sim" } as const;
const COMPLETE_POLICY: UnderstandAiRoutePolicy = { ...DEFAULT_UNDERSTAND_AI_ROUTE_POLICY, enabled: true, killSwitch: "inactive", model: SIM_REF, timeoutMs: 30_000, budget: { kind: "policy", policyRef: "synthetic-budget" }, samplingPercentage: 100 };
const ALLOW: BudgetPort = { reserve: () => Promise.resolve("allowed" as const) };

const caseInput = (id: string): UnderstandingInput => {
  const testCase = CORPUS.cases.find((c) => c.id === id) ?? (() => { throw new Error(id); })();
  const params = Object.fromEntries(Object.entries(testCase.input).filter(([key, value]) => value !== null && key !== "textRepeat"));
  const built = buildUnderstandingInput({ ...params, interactionKind: params["interactionKind"], platform: params["platform"], source: params["source"], linkPresent: params["linkPresent"], text: testCase.text });
  if (!built.ok) throw new Error(built.violations.join(","));
  return built.input;
};

const recordingGateway = (overrides: Partial<GatewayDependencies> = {}, model = simulatorModel("sim")) => {
  const simulator = createSimulatorProvider(GOLDEN);
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = { providerKey: simulator.providerKey, complete: (request, call) => { requests.push(request); return simulator.complete(request, call); } };
  const deps: GatewayDependencies = { registry: createModelRegistry([model]), routes: understandAiRouteTable(COMPLETE_POLICY), providers: [provider], budget: ALLOW, killed: () => false, now: () => new Date("2026-10-31T12:00:00.000Z"), ...overrides };
  return { gateway: createAiGateway(deps), requests, simulator };
};

const CONTEXT: IntelligenceRecordContext = { target: TARGET, understandingRequestId: REQUEST, pipelineVersion: INTELLIGENCE_PIPELINE_VERSION, dispatchGeneration: 1, correlationId: "corr-h7-d1b-contract", triggerRunId: "run_synthetic_h7d1b", modelRequested: "sim", transportSchemaVersion: "canonical-strict" };
const callContext = (reference: string) => ({ workspaceId: WORKSPACE, interactionId: INTERACTION, sourceTextVersionId: VERSION, pipelineVersion: INTELLIGENCE_PIPELINE_VERSION, reference });

describe("1 · the intelligence plane is a declared SOURCE plane, not yet a delivery plane", () => {
  it("execution planes are main / integration / intelligence; only main / integration can carry a delivery", () => {
    expect([...EXECUTION_PLANES]).toEqual(["main", "integration", "intelligence"]);
    expect([...DELIVERY_PLANES]).toEqual(["main", "integration"]);
    expect(isExecutionPlane("intelligence") && !isDeliveryPlane("intelligence")).toBe(true);
    expect(UNDERSTAND_AI_PLANE).toBe("intelligence");
  });

  it("the task registry refuses an intelligence task (no outbox binding before 0025), and none is registered", () => {
    const declaration = { name: "classification.understand_ai", scope: "workspace", executionPlane: "intelligence", lane: 4, retry: RETRY_POLICIES.transient, concurrency: { by: "workspace" }, subjects: [] };
    expect(() => defineTaskRegistry([declaration as never])).toThrow(TaskRegistryError);
    expect(PRODUCTION_TASKS.tasks.some((task) => (task.executionPlane as string) === "intelligence" || task.name === UNDERSTAND_AI_TOPIC)).toBe(false);
  });
});

describe("2–7 · credential isolation (deployed runs; names only, synthetic values)", () => {
  const refused = (plane: "main" | "integration" | "intelligence", name: string) => planeEnvironmentProblems(plane, PINNED, { [name]: SYNTHETIC }).includes(name);

  it("2–4 · INTELLIGENCE refuses Meta, the integration KMS/AWS identity and AWS chain, the system DB and the other planes' Trigger keys", () => {
    const required = [
      "PROVIDER_META_CLIENT_ID", "PROVIDER_META_CONFIG_ID", "PROVIDER_META_CLIENT_SECRET", "PROVIDER_META_WEBHOOK_VERIFY_TOKEN",
      ...INTEGRATION_AWS_IDENTITY_VARIABLES, ...RETIRED_INTEGRATION_AWS_BOOTSTRAP_VARIABLES, "INTEGRATION_KMS_DIAGNOSTIC_FIXTURE",
      "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE",
      "DATABASE_SYSTEM_URL", "TRIGGER_INTEGRATION_TASK_OPERATOR_KEY", "TRIGGER_MAIN_RELAY_TRIGGER_KEY", "TRIGGER_INTELLIGENCE_TASK_OPERATOR_KEY",
    ];
    for (const name of required) expect(refused("intelligence", name), name).toBe(true);
    expect(() => { assertPlaneEnvironment("intelligence", PINNED, { DATABASE_SYSTEM_URL: SYNTHETIC }); }).toThrow("plane_environment_refused");
  });

  it("INTELLIGENCE holds only its permitted variables; every SDK-ambient model variable is refused there too", () => {
    expect([...INTELLIGENCE_PLANE_VARIABLES]).toEqual(["TRIGGER_SECRET_KEY", "DATABASE_WORKER_URL", "DATABASE_SSL_ROOT_CERT", "DATABASE_SSL_ROOT_CERT_PEM", "INTELLIGENCE_MODEL_API_KEY"]);
    expect(planeEnvironmentProblems("intelligence", PINNED, Object.fromEntries(INTELLIGENCE_PLANE_VARIABLES.map((name) => [name, SYNTHETIC])))).toEqual([]);
    for (const name of MODEL_PROVIDER_AMBIENT_VARIABLES) expect(refused("intelligence", name), name).toBe(true);
    expect(planeEnvironmentProblems("intelligence", DEVELOPMENT, { DATABASE_SYSTEM_URL: SYNTHETIC })).toEqual([]);
  });

  it("5–6 · MAIN and INTEGRATION refuse the model credential and every SDK-ambient model variable", () => {
    for (const plane of ["main", "integration"] as const) {
      for (const name of [INTELLIGENCE_MODEL_API_KEY_ENV, ...MODEL_PROVIDER_AMBIENT_VARIABLES]) expect(refused(plane, name), `${plane} ${name}`).toBe(true);
      expect(() => { assertPlaneEnvironment(plane, PINNED, { [INTELLIGENCE_MODEL_API_KEY_ENV]: SYNTHETIC }); }, plane).toThrow("plane_environment_refused");
    }
    expect(refused("integration", "TRIGGER_INTELLIGENCE_TASK_OPERATOR_KEY")).toBe(true);
    expect(PLANE_FORBIDDEN_VARIABLES.main).not.toContain("TRIGGER_INTELLIGENCE_TASK_OPERATOR_KEY"); // MAIN dispatches intelligence (H7-D1d)
  });

  it("7 · the hosted WEB refuses the model credential, the intelligence operator key and every SDK-ambient model variable", () => {
    for (const name of [INTELLIGENCE_MODEL_API_KEY_ENV, "TRIGGER_INTELLIGENCE_TASK_OPERATOR_KEY", ...MODEL_PROVIDER_AMBIENT_VARIABLES]) {
      expect(FORBIDDEN_WEB_VARIABLES as readonly string[], name).toContain(name);
      expect(forbiddenWebVariables({ NODE_ENV: "production", [name]: SYNTHETIC }), name).toEqual([name]);
    }
  });

  it("the SDK-ambient inventory is exactly what the pinned SDKs' reached client paths read (no wildcard, no guess)", () => {
    const pkg = (name: string) => JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "node_modules", name, "package.json"), "utf8")) as { version: string };
    expect([pkg("@anthropic-ai/sdk").version, pkg("openai").version]).toEqual(["1.3.0", "7.45.1"]);
    const files = [
      "@anthropic-ai/sdk/client.js", "@anthropic-ai/sdk/core/credentials.js", "@anthropic-ai/sdk/lib/credentials/credential-chain.js",
      "@anthropic-ai/sdk/internal/tracing.js", "@anthropic-ai/sdk/internal/utils/log.js", "openai/client.js",
    ];
    const read = new Set(files.flatMap((file) => [...readFileSync(path.join(REPOSITORY_ROOT, "node_modules", file), "utf8").matchAll(/readEnv\)?\(['"]((?:ANTHROPIC|OPENAI)_[A-Z_]+)['"]\)/g)].map((m) => m[1] ?? "")));
    expect([...read].sort()).toEqual([...MODEL_PROVIDER_AMBIENT_VARIABLES].sort());
    expect(new Set(MODEL_PROVIDER_AMBIENT_VARIABLES).size).toBe(MODEL_PROVIDER_AMBIENT_CREDENTIALS.length + MODEL_PROVIDER_AMBIENT_OVERRIDES.length);
  });
});

describe("8–10 · the qualified registry entry and the fail-safe route", () => {
  it("8 · the qualified configuration reproduces the H7-D0 candidate fingerprint exactly", () => {
    const sonnet = CANDIDATES["claude-sonnet-5-5"];
    expect(sha256(JSON.stringify(QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL))).toBe(QUALIFIED_UNDERSTANDING_FINGERPRINT);
    expect(candidateConfigFingerprint(sonnet)).toBe(QUALIFIED_UNDERSTANDING_FINGERPRINT);
    expect(QUALIFIED_UNDERSTANDING_FINGERPRINT).toBe("76e0ca1f5478239fe0cb11df2994071f1a20825c12fc90c3c82e6d53f1d4b53b");
    expect(QUALIFIED_UNDERSTANDING_SETTINGS).toEqual(sonnet.settings);
    expect(QUALIFIED_UNDERSTANDING_SETTINGS).toEqual({ model: "claude-sonnet-5-5", effort: "low", thinking: "between_tools", speed: "omitted", maxTokens: 2_000 });
    expect([QUALIFIED_UNDERSTANDING_MAX_OUTPUT_TOKENS, QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS]).toEqual([MAX_OUTPUT_TOKENS, LIVE_CALL_TIMEOUT_MS]);
    expect(QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS).toBe(30_000);
    expect(QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL.transportSchema).toBe(ANTHROPIC_TRANSPORT_SCHEMA_VERSION);
    expect(ANTHROPIC_TRANSPORT_SCHEMA_VERSION).toBe("anthropic-transport-schema.v2");
    expect(QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL.taxonomyVersion).toBe(TAXONOMY_VERSION);
    expect(QUALIFIED_UNDERSTANDING_DESCRIPTOR).toEqual({ ...candidateModel(sonnet), enabled: false });
    expect(QUALIFIED_UNDERSTANDING_MODEL_REF).toEqual({ providerKey: "anthropic", modelKey: "claude-sonnet-5-5" });
    expect(QUALIFIED_UNDERSTANDING_QUALIFICATION).toMatchObject({
      recommendation: "RECOMMEND_CLAUDE_SONNET_5_5", productionModelSelected: false, promptVersion: UNDERSTANDING_PROMPT_VERSION, promptHash: UNDERSTANDING_PROMPT_HASH,
      taskVersion: UNDERSTANDING_TASK_VERSION, corpusVersion: CORPUS_VERSION, corpusSha256: createHash("sha256").update(CORPUS_BYTES).digest("hex"),
      evaluatorVersion: EVALUATOR_VERSION, promotionVersion: PROMOTION_POLICY.version, stabilityPolicyVersion: STABILITY_POLICY_VERSION,
    });
  });

  it("9 · the route is disabled by default: no provider call even with the qualified descriptor registered", async () => {
    expect(understandAiRouteTable(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY)).toEqual({ [UNDERSTANDING_TASK_ID]: { kind: "disabled" } });
    const { gateway, requests } = recordingGateway({ routes: understandAiRouteTable(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY) });
    const result = await understandInteraction(gateway, caseInput("es-ar-complaint-01"), callContext("es-ar-complaint-01"));
    expect(result).toMatchObject({ kind: "failed", failure: { class: "AI_UNAVAILABLE", cause: "task_disabled" } });
    expect(requests).toEqual([]);
    const enabledRoute = { [UNDERSTANDING_TASK_ID]: { kind: "model" as const, model: QUALIFIED_UNDERSTANDING_MODEL_REF } };
    const disabledModel = await createAiGateway({ registry: createModelRegistry([QUALIFIED_UNDERSTANDING_DESCRIPTOR]), routes: enabledRoute, providers: [], budget: ALLOW, killed: () => false, now: () => new Date() })
      .run({ ...(await import("@/modules/classification/application/ai/understanding-task")).UNDERSTANDING_TASK }, caseInput("es-ar-complaint-01"), { workspaceId: WORKSPACE, subject: {}, pipelineVersion: INTELLIGENCE_PIPELINE_VERSION, reference: "x" });
    expect(disabledModel).toMatchObject({ kind: "failed", failure: { cause: "model_unavailable" } });
  });

  it("10 · the default policy is deny-by-default; every missing piece skips; a complete synthetic policy calls in SHADOW", () => {
    expect(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY).toEqual({ enabled: false, samplingPercentage: 0, killSwitch: "active", model: null, timeoutMs: null, budget: { kind: "deny_all" }, acceptanceMode: "shadow", realDataEligible: false });
    const request = { samplingBucket: 0, realData: false };
    expect(decideUnderstandAiRoute(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY, request)).toEqual({ kind: "skip", reason: "route_disabled" });
    const steps: [Partial<UnderstandAiRoutePolicy>, string][] = [
      [{ killSwitch: "active" }, "kill_switch"], [{ model: null }, "no_model"], [{ timeoutMs: null }, "no_timeout"],
      [{ budget: { kind: "deny_all" } }, "no_budget"], [{ samplingPercentage: 0 }, "not_sampled"],
    ];
    for (const [change, reason] of steps) expect(decideUnderstandAiRoute({ ...COMPLETE_POLICY, ...change }, request), reason).toEqual({ kind: "skip", reason });
    expect(decideUnderstandAiRoute({ ...COMPLETE_POLICY, samplingPercentage: 50 }, { samplingBucket: 50, realData: false })).toEqual({ kind: "skip", reason: "not_sampled" });
    expect(decideUnderstandAiRoute(COMPLETE_POLICY, { samplingBucket: 0, realData: true })).toEqual({ kind: "skip", reason: "real_data_not_eligible" });
    expect(decideUnderstandAiRoute(COMPLETE_POLICY, request)).toEqual({ kind: "call", model: SIM_REF, timeoutMs: 30_000, budgetPolicyRef: "synthetic-budget", acceptanceMode: "shadow" });
    expect(understandAiRouteTable({ ...COMPLETE_POLICY, killSwitch: "active" })).toEqual({ [UNDERSTANDING_TASK_ID]: { kind: "disabled" } });
  });
});

describe("pipeline and generation identity", () => {
  it("a NEW pipeline: deterministic.v1 requests are never continued by the intelligence runtime", () => {
    expect(INTELLIGENCE_PIPELINE_VERSION).toBe("classification.intelligence.v1");
    expect(INTELLIGENCE_PIPELINE_VERSION).not.toBe(DETERMINISTIC_PIPELINE_VERSION);
    expect(isIntelligencePipelineRequest({ pipelineVersion: INTELLIGENCE_PIPELINE_VERSION })).toBe(true);
    expect(isIntelligencePipelineRequest({ pipelineVersion: DETERMINISTIC_PIPELINE_VERSION })).toBe(false);
  });

  it("dispatch keys carry the attempt generation a{n}; malformed keys and generations fail closed", () => {
    expect(understandAiDispatchKey(REQUEST, 1)).toBe(`classification.understand_ai:${REQUEST}:a1`);
    expect(understandAiDispatchKey(REQUEST, 2)).not.toBe(understandAiDispatchKey(REQUEST, 1));
    expect(parseUnderstandAiDispatchKey(understandAiDispatchKey(REQUEST, 7))).toEqual({ understandingRequestId: REQUEST, generation: 7 });
    for (const bad of [0, -1, 1.5, 1_001]) expect(() => understandAiDispatchKey(REQUEST, bad), String(bad)).toThrow("dispatch_key_generation_invalid");
    expect(() => understandAiDispatchKey("not-a-uuid", 1)).toThrow("dispatch_key_request_invalid");
    for (const bad of [`classification.understand_ai:${REQUEST}:a0`, `classification.understand_ai:${REQUEST}:a1001`, `classification.understand:${REQUEST}:a1`, `classification.understand_ai:${REQUEST}`, 3]) expect(parseUnderstandAiDispatchKey(bad), String(bad)).toBeUndefined();
  });
});

describe("11–12 · the job payload carries identifiers only", () => {
  const PAYLOAD = { workspaceId: WORKSPACE, interactionId: INTERACTION, sourceTextVersionId: VERSION, understandingRequestId: REQUEST, correlationId: "corr-h7-d1b-payload" };

  it("11 · exactly five identifier fields; the tenant envelope round-trips through named subjects", () => {
    expect([...UNDERSTAND_AI_PAYLOAD_FIELDS]).toEqual(["workspaceId", "interactionId", "sourceTextVersionId", "understandingRequestId", "correlationId"]);
    expect(parseUnderstandAiJobPayload(PAYLOAD)).toEqual({ ok: true, payload: PAYLOAD });
    const subjectIds = understandAiSubjectIds(PAYLOAD);
    expect(subjectIds).toEqual({ interaction: INTERACTION, source_text_version: VERSION, understanding_request: REQUEST });
    expect(understandAiPayloadFromEnvelope({ workspaceId: WORKSPACE, subjectIds, correlationId: PAYLOAD.correlationId })).toEqual({ ok: true, payload: PAYLOAD });
    expect(understandAiPayloadFromEnvelope({ workspaceId: WORKSPACE, subjectIds: { ...subjectIds, comment: INTERACTION }, correlationId: PAYLOAD.correlationId })).toEqual({ ok: false, field: "payload" });
  });

  it("12 · raw text, unknown fields, missing fields and non-identifiers are refused", () => {
    expect(parseUnderstandAiJobPayload({ ...PAYLOAD, text: "Muy caro el precio" })).toEqual({ ok: false, field: "payload" });
    expect(parseUnderstandAiJobPayload({ ...PAYLOAD, analyzedText: "x" })).toEqual({ ok: false, field: "payload" });
    const missing: Record<string, string> = { ...PAYLOAD };
    delete missing["correlationId"];
    expect(parseUnderstandAiJobPayload(missing)).toEqual({ ok: false, field: "payload" });
    expect(parseUnderstandAiJobPayload({ ...PAYLOAD, interactionId: "Muy caro el precio" })).toEqual({ ok: false, field: "interactionId" });
    expect(parseUnderstandAiJobPayload({ ...PAYLOAD, correlationId: "has space in it" })).toEqual({ ok: false, field: "correlationId" });
    for (const bad of [null, [], "x", new Map()]) expect(parseUnderstandAiJobPayload(bad)).toEqual({ ok: false, field: "payload" });
  });
});

describe("13–17 · the model sees only the frozen A1 input; oversized input never reaches a provider", () => {
  it("13–15 · no workspace / interaction id, author, handle, profile or watch-term match is model-visible", async () => {
    const built = buildUnderstandingInput({
      interactionKind: "comment", platform: "instagram", source: "organic", text: "Muy caro el precio", linkPresent: false, brandName: "Café Aurora",
      ...{ authorName: "Ana Pérez", authorHandle: "@ana_handle_h7", profileId: "profile-h7", watchTermMatches: ["precio-watch-h7"], workspaceId: WORKSPACE, webhookBody: "{}" },
    });
    if (!built.ok) throw new Error("input");
    expect(Object.keys(built.input).sort()).toEqual(["brandName", "captionExcerpt", "contractVersion", "hints", "interactionKind", "parentExcerpt", "platform", "rootExcerpt", "source", "taxonomyVersion", "text", "validatedLanguages"]);
    const { gateway, requests } = recordingGateway();
    await understandInteraction(gateway, built.input, callContext("not-scripted"));
    const [request] = requests;
    if (request === undefined) throw new Error("no request");
    const visible = request.system + request.data;
    for (const hidden of [WORKSPACE, INTERACTION, VERSION, REQUEST, "Ana Pérez", "@ana_handle_h7", "profile-h7", "precio-watch-h7", "webhookBody"]) expect(visible.includes(hidden), hidden).toBe(false);
    expect([...UNDERSTANDING_DATA_FIELDS]).toEqual(["contractVersion", "taxonomyVersion", "validatedLanguages", "interactionKind", "platform", "source", "brandName", "hints", "analyzedText", "parentExcerpt", "rootExcerpt", "captionExcerpt"]);
  });

  it("16 · context excerpts respect the frozen bounds (parent ≤ 1 000, root ≤ 500, caption ≤ 500)", () => {
    expect(UNDERSTANDING_INPUT_BOUNDS).toMatchObject({ maxAnalyzedTextLength: 32_768, parentExcerptChars: 1_000, rootExcerptChars: 500, captionExcerptChars: 500 });
    const prepared = prepareUnderstandingInput({ interactionKind: "reply", platform: "facebook", source: "paid", text: "¿y en azul?", parentText: "p".repeat(5_000), rootText: "r".repeat(5_000), captionText: "c".repeat(5_000), linkPresent: false, parentByOwnBrand: false, rootByOwnBrand: true });
    if (prepared.kind !== "ready") throw new Error(prepared.kind);
    expect([prepared.input.parentExcerpt?.length, prepared.input.rootExcerpt?.length, prepared.input.captionExcerpt?.length]).toEqual([1_000, 500, 500]);
    expect(prepared.input.hints).toEqual({ linkPresent: false, parentByOwnBrand: false, rootByOwnBrand: true });
    expect([prepared.input.interactionKind, prepared.input.platform, prepared.input.source]).toEqual(["reply", "facebook", "paid"]);
  });

  it("17 · an analyzed text over its bound ⇒ AI_INPUT_TOO_LARGE, never truncated, no provider call; Protection UNCERTAIN", async () => {
    const big = prepareUnderstandingInput({ interactionKind: "comment", platform: "instagram", source: "organic", text: "a".repeat(UNDERSTANDING_INPUT_BOUNDS.maxAnalyzedTextLength + 1), linkPresent: false });
    expect(big).toEqual({ kind: "failed", failure: { class: "AI_INPUT_TOO_LARGE", cause: "input_limit", retryable: false } });
    expect(prepareUnderstandingInput({ interactionKind: "comment", platform: "nowhere", source: "organic", text: "x", linkPresent: false })).toEqual({ kind: "invalid", violations: ["PLATFORM_INVALID"] });
    const { gateway, requests } = recordingGateway({}, simulatorModel("sim", { maxInputChars: 100 }));
    const result = await understandInteraction(gateway, caseInput("es-ar-complaint-01"), callContext("es-ar-complaint-01"));
    expect(result).toMatchObject({ kind: "failed", failure: { class: "AI_INPUT_TOO_LARGE", retryable: false } });
    expect(requests).toEqual([]);
    const outcome = deriveUnderstandingOutcome({ target: TARGET, ruleAssessments: [], run: { kind: "failed" } });
    expect([outcome.aiAssessments.length, outcome.protection.result, outcome.needsReview.needsReview]).toEqual([0, "uncertain", true]);
  });
});

describe("18–22 · the model output is semantic only; outcomes are derived by code", () => {
  const body = goldenOutput(CORPUS.cases.find((c) => c.id === "es-ar-complaint-01") ?? (() => { throw new Error("case"); })());
  const text = caseInput("es-ar-complaint-01").text;

  it("18–20 · action, Protection and Needs-review fields make the output invalid (closed schema); none is in the JSON schema", () => {
    expect(validateUnderstandingOutput(body, text).ok).toBe(true);
    for (const extra of [{ action: "hide" }, { hide: true }, { delete: true }, { reply: "hola" }, { alert: true }, { automationDecision: "HIDE" }, { protection: "not_protected" }, { needsReview: false }, { priority: "high" }]) {
      const validation = validateUnderstandingOutput({ ...body, ...extra }, text);
      expect(validation.ok, JSON.stringify(extra)).toBe(false);
      if (!validation.ok) expect(validation.failure.issues, JSON.stringify(extra)).toContain("UNEXPECTED_KEY");
    }
    const withDimensionAction = { ...body, dimensions: { ...body.dimensions, intent: { ...(body.dimensions["intent"] as object), hide: true } } };
    expect(validateUnderstandingOutput(withDimensionAction, text).ok).toBe(false);
    const schemaText = JSON.stringify(UNDERSTANDING_OUTPUT_JSON_SCHEMA);
    expect(schemaText).not.toMatch(/"(action|hide|delete|reply|block|alert|automation\w*|protection|needsReview|needs_review|priority)"/);
    expect(UNDERSTANDING_OUTPUT_JSON_SCHEMA).toMatchObject({ additionalProperties: false });
  });

  it("21 · the runtime result is provider-independent: exact fields, A1 output only, vendor reasoning dropped", async () => {
    const { gateway } = recordingGateway();
    const result = toIntelligenceResult(await understandInteraction(gateway, caseInput("es-ar-complaint-01"), callContext("es-ar-complaint-01")), CONTEXT);
    if (result.kind !== "assessed") throw new Error(result.kind);
    expect(Object.keys(result).sort()).toEqual([...RESULT_FIELDS.assessed].sort());
    expect(Object.keys(result.output).sort()).toEqual(["dimensions", "evidence", "language", "schemaVersion", "summary", "taxonomyVersion"]);
    expect(Object.keys(result.output.dimensions)).not.toContain("topics");
    expect(JSON.stringify(result)).not.toMatch(/reasoning|thinking|"text"|"raw"|choices|stop_reason|content_block/i);
    const failed = toIntelligenceResult(await understandInteraction(gateway, caseInput("es-ar-complaint-01"), callContext("unscripted")), CONTEXT);
    expect(Object.keys(failed).sort()).toEqual([...RESULT_FIELDS.failed].sort());
  });

  it("22 · the failure vocabulary is closed: exactly the five A1 / gateway classes", () => {
    const five = ["AI_INVALID_OUTPUT", "AI_UNAVAILABLE", "AI_REFUSED", "AI_BUDGET", "AI_INPUT_TOO_LARGE"];
    expect([[...INTELLIGENCE_FAILURE_CLASSES], [...UNDERSTANDING_FAILURE_CLASSES], [...AI_FAILURE_CLASSES]]).toEqual([five, five, five]);
  });

  it("every failure ⇒ zero AI assessments, Protection UNCERTAIN, Needs review — the model never decides them", () => {
    const failed = deriveUnderstandingOutcome({ target: TARGET, ruleAssessments: [], run: { kind: "failed" } });
    expect(failed).toMatchObject({ aiAssessments: [], understandingFailed: true, protection: { result: "uncertain" }, needsReview: { needsReview: true } });
    expect(failed.protection.reasons).toContain("understanding_failed");
    const notRun = deriveUnderstandingOutcome({ target: TARGET, ruleAssessments: [], run: { kind: "not_run" } });
    expect([notRun.protection.result, notRun.needsReview.needsReview]).toEqual(["uncertain", true]);
  });

  it("the derived outcome equals the frozen evaluator's Protection / Needs review on every golden corpus case", async () => {
    const report = await evaluateCorpus(CORPUS, { provider: createSimulatorProvider(GOLDEN), model: simulatorModel("sim"), realModel: false });
    const { gateway } = recordingGateway({ routes: { [UNDERSTANDING_TASK_ID]: { kind: "model", model: SIM_REF } } });
    for (const testCase of CORPUS.cases) {
      const expected = report.cases.find((c) => c.id === testCase.id);
      const prepared = prepareUnderstandingInput({ ...Object.fromEntries(Object.entries(testCase.input).filter(([key, value]) => value !== null && key !== "textRepeat")), text: testCase.text } as Parameters<typeof prepareUnderstandingInput>[0]);
      let run: Parameters<typeof deriveUnderstandingOutcome>[0]["run"] = { kind: "failed" };
      if (prepared.kind === "ready") {
        const result = await understandInteraction(gateway, prepared.input, callContext(testCase.id));
        if (result.kind === "assessed") run = { kind: "assessed", output: result.output, method: result.method, assessedAt: AT, refs: Object.fromEntries(["language", "safety", "authenticity", "intent", "sentiment", "risk", "response_need"].map((d) => [d, `${testCase.id}:${d}`])) };
      }
      const outcome = deriveUnderstandingOutcome({ target: TARGET, ruleAssessments: [], run });
      expect([outcome.protection.result, outcome.needsReview.needsReview], testCase.id).toEqual([expected?.protection.actual, expected?.needsReview.actual]);
    }
  });
});

describe("23–25 · shadow by default, budget deny by default, records without raw content", () => {
  it("23 · SHADOW is the only H7-D1 acceptance mode: the default policy and every result are shadow", async () => {
    expect([...ACCEPTANCE_MODES]).toEqual(["shadow", "accepting"]);
    expect([H7_D1_ACCEPTANCE_MODE, DEFAULT_UNDERSTAND_AI_ROUTE_POLICY.acceptanceMode]).toEqual(["shadow", "shadow"]);
    const { gateway } = recordingGateway();
    for (const reference of ["es-ar-complaint-01", "unscripted"]) {
      const result = toIntelligenceResult(await understandInteraction(gateway, caseInput("es-ar-complaint-01"), callContext(reference)), CONTEXT);
      expect(result.acceptanceMode, reference).toBe("shadow");
    }
  });

  it("24 · a denying, throwing or unknown budget answer ⇒ AI_BUDGET and no provider call; the default budget denies", async () => {
    const budgets: BudgetPort[] = [DENY_ALL_BUDGET, { reserve: () => Promise.reject(new Error("budget store down")) }, { reserve: () => Promise.resolve("maybe" as never) }];
    for (const budget of budgets) {
      const { gateway, requests } = recordingGateway({ budget });
      const result = await understandInteraction(gateway, caseInput("es-ar-complaint-01"), callContext("es-ar-complaint-01"));
      expect(result).toMatchObject({ kind: "failed", failure: { class: "AI_BUDGET", cause: "budget_exhausted", retryable: false } });
      expect(requests).toEqual([]);
    }
    expect(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY.budget).toEqual({ kind: "deny_all" });
  });

  it("25 · ledger entries and results hold ids, versions, counts and classes — never prompt, input, response, reasoning or secret", async () => {
    const { gateway } = recordingGateway();
    const input = caseInput("es-ar-complaint-01");
    const understood = await understandInteraction(gateway, input, callContext("es-ar-complaint-01"));
    const entries = toAttemptLedgerEntries(understood.attempts, CONTEXT);
    expect(entries).toHaveLength(1);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual([...LEDGER_ENTRY_FIELDS].sort());
    expect(entries[0]).toMatchObject({ ref: `classification.understand_ai:${REQUEST}:a1:1`, attemptKind: "initial", costEstimate: null, transportSchemaVersion: "canonical-strict", modelRequested: "sim", latencyMs: 0, promptHash: UNDERSTANDING_PROMPT_HASH });
    const result = toIntelligenceResult(understood, CONTEXT);
    const serialized = JSON.stringify([entries, result]);
    for (const leaked of [input.text, UNDERSTANDING_PROMPT_SYSTEM.slice(0, 120), "reasoning", "thinking", "apiKey", "authorization"]) expect(serialized.includes(leaked), leaked.slice(0, 20)).toBe(false);
    for (const key of [...LEDGER_ENTRY_FIELDS, ...RESULT_FIELDS.assessed, ...RESULT_FIELDS.failed]) expect(key, key).not.toMatch(/^(prompt|promptText|input|modelInput|response|raw|rawResponse|reasoning|thinking|secret|credential|apiKey|text)$/i);
    expect(result.ledgerRefs).toEqual([entries[0]?.ref]);
  });
});
