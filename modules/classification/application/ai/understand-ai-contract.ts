/**
 * Step H7-D1b — the source-level runtime contract of the future INTELLIGENCE task `classification.understand_ai`
 * (H7-A0 §8–§12, D-H7-1; H7-D1a). Pure: no database, outbox, Trigger, provider, credential or clock. Nothing composes
 * it yet: the task is not registered (the intelligence plane is not a delivery plane before migration 0025), no topic
 * is admitted by the database, and no product consumer reads its results.
 *
 *   MAIN          owns the request state (deterministic stage, AI_PENDING), the future outbox row and sweep/recovery
 *   INTELLIGENCE  reloads the canonical input in tenant scope, runs the gateway (A1 validation), returns the normalized
 *                 result, and later writes the ledger / result / SHADOW assessments; it decides no action
 *   INTEGRATION   does not participate
 *
 *   pipeline      `classification.intelligence.v1` — a NEW identity. Requests are unique per (text version, pipeline),
 *                 so the runtime only ever continues requests of THIS pipeline: `classification.deterministic.v1`
 *                 requests (H7-B, left DETERMINISTIC_DONE) are never continued; reprocessing them would be an explicit,
 *                 budgeted operator job (H7-A0 §11.1), not this runtime
 *   generation    each dispatch of a request carries an attempt generation `a{n}` in its dispatch key
 *                 (`classification.understand_ai:{request}:a{n}`, H7-A0 §11.1), so a re-dispatch is a distinct key while
 *                 domain idempotency (one request, one machine assessment per method) stays authoritative
 *   payload       identifiers only (workspace, interaction, source text version, request, correlation); never text
 *   route         disabled by default; kill switch active; no model, timeout or budget; no real-data eligibility;
 *                 acceptance mode SHADOW (nothing is accepted for product consumers in H7-D1)
 *   input         the frozen A1 `UnderstandingInput` (builder + task data allowlist); the analyzed text is never
 *                 truncated: beyond its bound ⇒ AI_INPUT_TOO_LARGE before any provider call
 *   output        the A1 `ValidatedUnderstanding` (closed schema; Protection / Needs review / actions are NOT model
 *                 output — `deriveUnderstandingOutcome` derives them by code)
 *   records       ledger entries and results carry ids, versions, counts and outcome classes — never a prompt, model
 *                 input, provider response, reasoning or secret
 */
import type { AttemptRecord, ModelRef, TaskRoute } from "@/ai/gateway";
import { parseCorrelationId } from "@/domain/correlation";
import { isUuid } from "@/domain/ids";
import type { AiMethod, AnalysisTarget } from "../../domain/assessment";
import { buildUnderstandingInput, type UnderstandingInput, type UnderstandingInputParams, type UnderstandingInputViolation } from "../../domain/understanding-input";
import { UNDERSTANDING_FAILURE_CLASSES, type UnderstandingFailureClass, type ValidatedUnderstanding } from "../../domain/understanding-output";
import type { UnderstandingResult } from "./understand-interaction";
import { UNDERSTANDING_TASK_ID } from "./understanding-task";

// ── Topic, plane, pipeline and generation ────────────────────────────────────────────────────────────────────────

/** The future outbox topic / task (not registered; the 0021 inventory and 0011 plane check change in 0025). */
export const UNDERSTAND_AI_TOPIC = "classification.understand_ai" as const;
/** The execution plane it is declared for (platform/jobs EXECUTION_PLANES; not a delivery plane yet). */
export const UNDERSTAND_AI_PLANE = "intelligence" as const;

export const INTELLIGENCE_PIPELINE_VERSION = "classification.intelligence.v1" as const;

/** The only requests the INTELLIGENCE runtime may continue: those created under ITS pipeline version. */
export function isIntelligencePipelineRequest(request: { readonly pipelineVersion: string }): boolean {
  return request.pipelineVersion === INTELLIGENCE_PIPELINE_VERSION;
}

export const MAX_DISPATCH_GENERATION = 1_000;
const isGeneration = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_DISPATCH_GENERATION;

export function understandAiDispatchKey(understandingRequestId: string, generation: number): string {
  if (!isUuid(understandingRequestId)) throw new TypeError("dispatch_key_request_invalid");
  if (!isGeneration(generation)) throw new TypeError("dispatch_key_generation_invalid");
  return `${UNDERSTAND_AI_TOPIC}:${understandingRequestId}:a${String(generation)}`;
}

export function parseUnderstandAiDispatchKey(key: unknown): { readonly understandingRequestId: string; readonly generation: number } | undefined {
  if (typeof key !== "string") return undefined;
  const match = /^classification\.understand_ai:([0-9a-f-]{36}):a([1-9][0-9]{0,3})$/.exec(key);
  const [, requestId, digits] = match ?? [];
  if (requestId === undefined || digits === undefined || !isUuid(requestId)) return undefined;
  const generation = Number(digits);
  return isGeneration(generation) ? Object.freeze({ understandingRequestId: requestId, generation }) : undefined;
}

// ── Job payload (identifiers only) ───────────────────────────────────────────────────────────────────────────────

export const UNDERSTAND_AI_PAYLOAD_FIELDS = ["workspaceId", "interactionId", "sourceTextVersionId", "understandingRequestId", "correlationId"] as const;

export interface UnderstandAiJobPayload {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly understandingRequestId: string;
  readonly correlationId: string;
}

export type UnderstandAiPayloadParse =
  | { readonly ok: true; readonly payload: UnderstandAiJobPayload }
  | { readonly ok: false; readonly field: (typeof UNDERSTAND_AI_PAYLOAD_FIELDS)[number] | "payload" };

const plainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Closed validation: exactly the five identifier fields, every id a UUID, the correlation id a trace id. */
export function parseUnderstandAiJobPayload(raw: unknown): UnderstandAiPayloadParse {
  if (!plainObject(raw)) return { ok: false, field: "payload" };
  const keys = Object.keys(raw);
  if (keys.length !== UNDERSTAND_AI_PAYLOAD_FIELDS.length || !keys.every((key) => (UNDERSTAND_AI_PAYLOAD_FIELDS as readonly string[]).includes(key))) return { ok: false, field: "payload" };
  for (const field of ["workspaceId", "interactionId", "sourceTextVersionId", "understandingRequestId"] as const) {
    if (!isUuid(raw[field])) return { ok: false, field };
  }
  if (parseCorrelationId(raw["correlationId"]) === undefined) return { ok: false, field: "correlationId" };
  return {
    ok: true,
    payload: Object.freeze({
      workspaceId: raw["workspaceId"] as string,
      interactionId: raw["interactionId"] as string,
      sourceTextVersionId: raw["sourceTextVersionId"] as string,
      understandingRequestId: raw["understandingRequestId"] as string,
      correlationId: raw["correlationId"] as string,
    }),
  };
}

/** Subject names of the payload inside the generic tenant job envelope (platform/jobs `subjectIds`). */
export const UNDERSTAND_AI_SUBJECTS = Object.freeze({ interactionId: "interaction", sourceTextVersionId: "source_text_version", understandingRequestId: "understanding_request" });

export function understandAiSubjectIds(payload: UnderstandAiJobPayload): Readonly<Record<string, string>> {
  return Object.freeze({
    [UNDERSTAND_AI_SUBJECTS.interactionId]: payload.interactionId,
    [UNDERSTAND_AI_SUBJECTS.sourceTextVersionId]: payload.sourceTextVersionId,
    [UNDERSTAND_AI_SUBJECTS.understandingRequestId]: payload.understandingRequestId,
  });
}

/** The payload back from a tenant envelope; any other subject (or a missing one) fails closed. */
export function understandAiPayloadFromEnvelope(envelope: { readonly workspaceId: string; readonly subjectIds: Readonly<Record<string, string>>; readonly correlationId: string }): UnderstandAiPayloadParse {
  const names: readonly string[] = Object.values(UNDERSTAND_AI_SUBJECTS);
  const subjects = Object.keys(envelope.subjectIds);
  if (subjects.length !== names.length || !subjects.every((name) => names.includes(name))) return { ok: false, field: "payload" };
  return parseUnderstandAiJobPayload({
    workspaceId: envelope.workspaceId,
    interactionId: envelope.subjectIds[UNDERSTAND_AI_SUBJECTS.interactionId],
    sourceTextVersionId: envelope.subjectIds[UNDERSTAND_AI_SUBJECTS.sourceTextVersionId],
    understandingRequestId: envelope.subjectIds[UNDERSTAND_AI_SUBJECTS.understandingRequestId],
    correlationId: envelope.correlationId,
  });
}

// ── Acceptance mode and route policy ────────────────────────────────────────────────────────────────────────────

export const ACCEPTANCE_MODES = ["shadow", "accepting"] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];
/** Every H7-D1 result is SHADOW: stored non-accepting (TA §24.2), never read by a product consumer. */
export const H7_D1_ACCEPTANCE_MODE = "shadow" as const satisfies AcceptanceMode;

export type UnderstandAiBudget = { readonly kind: "deny_all" } | { readonly kind: "policy"; readonly policyRef: string };

export interface UnderstandAiRoutePolicy {
  readonly enabled: boolean;
  /** Integer 0–100: share of eligible requests (by a deterministic 0–99 bucket) that may call the model. */
  readonly samplingPercentage: number;
  /** Fail-safe: "active" = no call (combined with the global `ai.task_kill` flag, whose fail-safe is also killed). */
  readonly killSwitch: "active" | "inactive";
  readonly model: ModelRef | null;
  /** Per-call provider timeout; null ⇒ the route cannot call. */
  readonly timeoutMs: number | null;
  readonly budget: UnderstandAiBudget;
  readonly acceptanceMode: typeof H7_D1_ACCEPTANCE_MODE;
  /** Real (non-fixture) data eligibility: false until an explicit TL real-data gate (H7-D1a). */
  readonly realDataEligible: false;
}

export const DEFAULT_UNDERSTAND_AI_ROUTE_POLICY: UnderstandAiRoutePolicy = Object.freeze({
  enabled: false,
  samplingPercentage: 0,
  killSwitch: "active",
  model: null,
  timeoutMs: null,
  budget: Object.freeze({ kind: "deny_all" as const }),
  acceptanceMode: H7_D1_ACCEPTANCE_MODE,
  realDataEligible: false,
});

export const ROUTE_SKIP_REASONS = ["route_disabled", "kill_switch", "no_model", "no_timeout", "no_budget", "not_sampled", "real_data_not_eligible"] as const;
export type RouteSkipReason = (typeof ROUTE_SKIP_REASONS)[number];

export type UnderstandAiRouteDecision =
  | { readonly kind: "call"; readonly model: ModelRef; readonly timeoutMs: number; readonly budgetPolicyRef: string; readonly acceptanceMode: typeof H7_D1_ACCEPTANCE_MODE }
  | { readonly kind: "skip"; readonly reason: RouteSkipReason };

/** Pure route decision for one request; every missing piece of configuration skips (no provider call). */
export function decideUnderstandAiRoute(policy: UnderstandAiRoutePolicy, request: { readonly samplingBucket: number; readonly realData: boolean }): UnderstandAiRouteDecision {
  const skip = (reason: RouteSkipReason): UnderstandAiRouteDecision => Object.freeze({ kind: "skip" as const, reason });
  if (!policy.enabled) return skip("route_disabled");
  if (policy.killSwitch !== "inactive") return skip("kill_switch");
  if (policy.model === null) return skip("no_model");
  if (policy.timeoutMs === null || !Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1) return skip("no_timeout");
  if (policy.budget.kind !== "policy") return skip("no_budget");
  const percentage = Number.isInteger(policy.samplingPercentage) ? Math.min(Math.max(policy.samplingPercentage, 0), 100) : 0;
  if (!Number.isInteger(request.samplingBucket) || request.samplingBucket < 0 || request.samplingBucket > 99 || request.samplingBucket >= percentage) return skip("not_sampled");
  // Read as unknown: a policy built outside the type system must still say exactly `true` to admit real data (never in H7-D1).
  const realDataEligible: unknown = policy.realDataEligible;
  if (request.realData && realDataEligible !== true) return skip("real_data_not_eligible");
  return Object.freeze({ kind: "call" as const, model: policy.model, timeoutMs: policy.timeoutMs, budgetPolicyRef: policy.budget.policyRef, acceptanceMode: policy.acceptanceMode });
}

/** The gateway route table this policy yields: the understanding task is disabled unless the policy is complete. */
export function understandAiRouteTable(policy: UnderstandAiRoutePolicy): Readonly<Record<string, TaskRoute>> {
  const { model } = policy;
  const usable = policy.enabled && policy.killSwitch === "inactive" && policy.timeoutMs !== null && policy.budget.kind === "policy";
  return Object.freeze({ [UNDERSTANDING_TASK_ID]: usable && model !== null ? Object.freeze({ kind: "model" as const, model }) : Object.freeze({ kind: "disabled" as const }) });
}

// ── Canonical model input (the frozen A1 builder) ───────────────────────────────────────────────────────────────

export type PreparedUnderstandingInput =
  | { readonly kind: "ready"; readonly input: UnderstandingInput }
  /** The analyzed text exceeds the frozen bound: never truncated, no provider call; deterministic fail-safe. */
  | { readonly kind: "failed"; readonly failure: { readonly class: "AI_INPUT_TOO_LARGE"; readonly cause: "input_limit"; readonly retryable: false } }
  | { readonly kind: "invalid"; readonly violations: readonly UnderstandingInputViolation[] };

export function prepareUnderstandingInput(params: UnderstandingInputParams): PreparedUnderstandingInput {
  const built = buildUnderstandingInput(params);
  if (built.ok) return Object.freeze({ kind: "ready" as const, input: built.input });
  if (built.violations.includes("TEXT_TOO_LARGE")) return Object.freeze({ kind: "failed" as const, failure: Object.freeze({ class: "AI_INPUT_TOO_LARGE" as const, cause: "input_limit" as const, retryable: false as const }) });
  return Object.freeze({ kind: "invalid" as const, violations: built.violations });
}

// ── Failures ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Closed: exactly the A1 / gateway classes. Every failure ⇒ zero AI assessments, no action, Protection UNCERTAIN. */
export const INTELLIGENCE_FAILURE_CLASSES = UNDERSTANDING_FAILURE_CLASSES;

// ── Ledger and result records (pure types; persistence is H7-D1c / 0025) ────────────────────────────────────────

export interface IntelligenceRecordContext {
  readonly target: AnalysisTarget;
  readonly understandingRequestId: string;
  readonly pipelineVersion: typeof INTELLIGENCE_PIPELINE_VERSION;
  readonly dispatchGeneration: number;
  readonly correlationId: string;
  readonly triggerRunId: string;
  /** The model id requested (the registry descriptor's configured model). */
  readonly modelRequested: string;
  /** The provider transport schema version the adapter sent (e.g. a projection of the canonical schema). */
  readonly transportSchemaVersion: string;
}

export interface AttemptCostEstimate {
  readonly amountUsd: number;
  readonly pricingTableVersion: string;
}

/** One provider call (initial or the one re-ask). Ids, versions, counts and outcome classes only. */
export interface IntelligenceAttemptLedgerEntry {
  readonly ref: string;
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly understandingRequestId: string;
  readonly pipelineVersion: string;
  readonly dispatchGeneration: number;
  readonly attemptNumber: 1 | 2;
  readonly attemptKind: "initial" | "reask";
  readonly taskId: string;
  readonly taskVersion: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly outputSchemaVersion: string;
  readonly transportSchemaVersion: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly providerKey: string;
  readonly modelRequested: string;
  readonly modelReported: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly inputChars: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  /** TA-Q-23 OPEN: no pricing table is approved, so no estimate is produced yet. */
  readonly costEstimate: AttemptCostEstimate | null;
  readonly outcome: AttemptRecord["outcome"];
  readonly failureClass: UnderstandingFailureClass | null;
  readonly issueCodes: readonly string[];
  readonly correlationId: string;
  readonly triggerRunId: string;
}

export const LEDGER_ENTRY_FIELDS = [
  "ref", "workspaceId", "interactionId", "sourceTextVersionId", "understandingRequestId", "pipelineVersion", "dispatchGeneration", "attemptNumber", "attemptKind",
  "taskId", "taskVersion", "promptVersion", "promptHash", "outputSchemaVersion", "transportSchemaVersion", "versions", "providerKey", "modelRequested", "modelReported",
  "startedAt", "completedAt", "latencyMs", "inputChars", "inputTokens", "outputTokens", "cachedInputTokens", "costEstimate", "outcome", "failureClass", "issueCodes",
  "correlationId", "triggerRunId",
] as const satisfies readonly (keyof IntelligenceAttemptLedgerEntry)[];

export const attemptRef = (understandingRequestId: string, generation: number, attemptNumber: 1 | 2): string => `${understandAiDispatchKey(understandingRequestId, generation)}:${String(attemptNumber)}`;

export function toAttemptLedgerEntries(attempts: readonly AttemptRecord[], context: IntelligenceRecordContext): readonly IntelligenceAttemptLedgerEntry[] {
  return Object.freeze(attempts.map((attempt) => Object.freeze({
    ref: attemptRef(context.understandingRequestId, context.dispatchGeneration, attempt.attemptNumber),
    workspaceId: context.target.workspaceId,
    interactionId: context.target.interactionId,
    sourceTextVersionId: context.target.sourceTextVersionId,
    understandingRequestId: context.understandingRequestId,
    pipelineVersion: context.pipelineVersion,
    dispatchGeneration: context.dispatchGeneration,
    attemptNumber: attempt.attemptNumber,
    attemptKind: attempt.kind,
    taskId: attempt.taskId,
    taskVersion: attempt.taskVersion,
    promptVersion: attempt.promptVersion,
    promptHash: attempt.promptHash,
    outputSchemaVersion: attempt.outputSchemaVersion,
    transportSchemaVersion: context.transportSchemaVersion,
    versions: Object.freeze({ ...attempt.versions }),
    providerKey: attempt.providerKey,
    modelRequested: context.modelRequested,
    modelReported: attempt.modelVersion,
    startedAt: attempt.startedAt.toISOString(),
    completedAt: attempt.completedAt.toISOString(),
    latencyMs: Math.max(0, attempt.completedAt.getTime() - attempt.startedAt.getTime()),
    inputChars: attempt.inputChars,
    inputTokens: attempt.usage?.inputTokens ?? null,
    outputTokens: attempt.usage?.outputTokens ?? null,
    cachedInputTokens: attempt.usage?.cachedInputTokens ?? null,
    costEstimate: null,
    outcome: attempt.outcome,
    failureClass: attempt.failureClass,
    issueCodes: Object.freeze([...attempt.issueCodes]),
    correlationId: context.correlationId,
    triggerRunId: context.triggerRunId,
  })));
}

interface IntelligenceResultBase {
  readonly target: AnalysisTarget;
  readonly understandingRequestId: string;
  readonly pipelineVersion: string;
  readonly dispatchGeneration: number;
  readonly acceptanceMode: AcceptanceMode;
  readonly ledgerRefs: readonly string[];
  readonly correlationId: string;
  readonly triggerRunId: string;
}

/** A validated, normalized output (A1 dimensions, summary ≤ 240, ≤ 3 verified evidence spans) + its provenance. */
export interface IntelligenceAssessedResult extends IntelligenceResultBase {
  readonly kind: "assessed";
  readonly output: ValidatedUnderstanding;
  readonly method: AiMethod;
  readonly transportSchemaVersion: string;
  readonly versions: Readonly<Record<string, string>>;
}

export interface IntelligenceFailedResult extends IntelligenceResultBase {
  readonly kind: "failed";
  readonly failure: { readonly class: UnderstandingFailureClass; readonly cause: string; readonly retryable: boolean; readonly issues: readonly string[] };
}

export type IntelligenceResult = IntelligenceAssessedResult | IntelligenceFailedResult;

export const RESULT_FIELDS = Object.freeze({
  assessed: ["kind", "target", "understandingRequestId", "pipelineVersion", "dispatchGeneration", "acceptanceMode", "ledgerRefs", "correlationId", "triggerRunId", "output", "method", "transportSchemaVersion", "versions"],
  failed: ["kind", "target", "understandingRequestId", "pipelineVersion", "dispatchGeneration", "acceptanceMode", "ledgerRefs", "correlationId", "triggerRunId", "failure"],
} as const);

/** The provider-independent result of one understanding call; always SHADOW in H7-D1. */
export function toIntelligenceResult(result: UnderstandingResult, context: IntelligenceRecordContext): IntelligenceResult {
  const base = {
    target: Object.freeze({ ...context.target }),
    understandingRequestId: context.understandingRequestId,
    pipelineVersion: context.pipelineVersion,
    dispatchGeneration: context.dispatchGeneration,
    acceptanceMode: H7_D1_ACCEPTANCE_MODE,
    ledgerRefs: Object.freeze(result.attempts.map((a) => attemptRef(context.understandingRequestId, context.dispatchGeneration, a.attemptNumber))),
    correlationId: context.correlationId,
    triggerRunId: context.triggerRunId,
  };
  if (result.kind === "failed") return Object.freeze({ kind: "failed" as const, ...base, failure: Object.freeze({ ...result.failure, issues: Object.freeze([...result.failure.issues]) }) });
  const versions = result.attempts.at(-1)?.versions ?? {};
  return Object.freeze({ kind: "assessed" as const, ...base, output: result.output, method: result.method, transportSchemaVersion: context.transportSchemaVersion, versions: Object.freeze({ ...versions }) });
}
