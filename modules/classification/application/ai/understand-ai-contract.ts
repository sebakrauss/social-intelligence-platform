/**
 * Step H7-D1b — the source-level runtime contract of the INTELLIGENCE task `classification.understand_ai`
 * (H7-A0 §8–§12, D-H7-1; H7-D1a). Pure: no database, outbox, Trigger, provider, credential or clock. Step H7-D1d: the
 * task is registered on the intelligence plane (0025) and its runner (run-understanding.ts) is the only consumer; no
 * product consumer reads its results.
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
import type { AttemptRecord, TaskRoute } from "@/ai/gateway";
import type { AiMethod, AnalysisTarget } from "../../domain/assessment";
import { UNDERSTANDING_FAILURE_CLASSES, type UnderstandingFailureClass, type ValidatedUnderstanding } from "../../domain/understanding-output";
import type { UnderstandingResult } from "./understand-interaction";
import { UNDERSTANDING_TASK_ID } from "./understanding-task";

// The pure identity, payload and route-policy contract lives in the domain (MAIN reads it without the gateway).
export * from "../../domain/intelligence-routing";
import { H7_D1_ACCEPTANCE_MODE, understandAiDispatchKey, type INTELLIGENCE_PIPELINE_VERSION, type AcceptanceMode, type UnderstandAiRoutePolicy } from "../../domain/intelligence-routing";

/** The gateway route table this policy yields: the understanding task is disabled unless the policy is complete. */
export function understandAiRouteTable(policy: UnderstandAiRoutePolicy): Readonly<Record<string, TaskRoute>> {
  const { model } = policy;
  const usable = policy.enabled && policy.killSwitch === "inactive" && policy.timeoutMs !== null && policy.budget.kind === "caps";
  return Object.freeze({ [UNDERSTANDING_TASK_ID]: usable && model !== null ? Object.freeze({ kind: "model" as const, model }) : Object.freeze({ kind: "disabled" as const }) });
}

// ── Canonical model input: the frozen A1 builder, prepared by the domain (MAIN and INTELLIGENCE share it) ────────
export { prepareUnderstandingInput, type PreparedUnderstandingInput } from "../../domain/understanding-eligibility";

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
