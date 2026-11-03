/**
 * The INTELLIGENCE task `classification.understand_ai` (Step H7-D1d; H7-A0 §8–§12, D-H7-1; migration 0025). Two short
 * workspace-scoped transactions around ONE gateway run, never a transaction held across the provider call:
 *
 *   tx1  reload the request (row-locked) and check its identity against the IDs-only payload: same workspace (RLS),
 *        interaction and text version · pipeline `classification.intelligence.v1` (a deterministic.v1 request is never
 *        continued) · not terminal · AI_PENDING with a generation (a duplicate or stale delivery of a running or
 *        finished request is skipped) · the R6 effect claim of THIS generation's dispatch key. Then reload the
 *        canonical target and re-run every pre-model check (canonical, route, A1 input): a refusal ends the request
 *        AI_FAILED without any provider call. Otherwise commit AI_PENDING → AI_RUNNING (before the call, R6)
 *   call the gateway (understandInteraction): route → kill switch → model → input bound → budget (the reservation is its
 *        own committed transaction: classification.reserve_ai_budget()) → provider → at most ONE re-ask. Step H7-D1e2b:
 *        BEFORE EACH provider call (initial and re-ask) the egress fence commits the call's durable identity
 *        (classification.ai_call_intents) in its own transaction, under the request's row lock, only while the request
 *        is still AI_RUNNING at this generation — otherwise no call. Step H7-D1g-prep: in that same fence transaction,
 *        immediately before the identity is written, the operational kill switch (`ai.task_kill`) is re-read: killed
 *        (or unreadable) ⇒ no identity, no call, AI_UNAVAILABLE(kill_switch) — so an operator's kill stops the initial
 *        call AND the re-ask of a run already in flight, without leaving an identity that would derive as
 *        UNKNOWN_PROVIDER_OUTCOME for a call that never happened; and right AFTER each call its final attempt row
 *        (ai_attempts) is committed in its own transaction, so no completed call waits for tx2 to become durable
 *   tx2  re-assert the ledger rows idempotently (same ids); then, only if the request is STILL AI_RUNNING at this
 *        generation: a validated output ⇒ the shadow result (ai_results) + the canonical A1 composition
 *        (deriveUnderstandingOutcome) + its AI assessments, all SHADOW ⇒ COMPLETED; a failure ⇒ AI_FAILED with its
 *        class, or — transient transport only, below MAX_TRANSPORT_GENERATIONS — the next generation's dispatch
 *
 * Retry authority, one per concern: the gateway owns the ONE re-ask (schema); this runtime owns transport retries, as
 * new dispatch generations (≤ MAX_TRANSPORT_GENERATIONS, each re-checked and re-budgeted); the task itself is
 * single-attempt (no Trigger.dev retry); a crashed or lost run is MAIN's stale-request recovery, which counts toward
 * the same generation bound. Protection and Needs review are derived by code here and returned, never model output and
 * never an action: nothing in this file hides, deletes, replies, blocks, moderates or alerts.
 */
import type { AiGateway, AttemptRecord, BudgetPort, EgressPort } from "@/ai/gateway";
import { parseInstant, type Instant } from "@/domain/instant";
import { parseAnalysisTarget } from "../../domain/assessment";
import {
  INTELLIGENCE_PIPELINE_VERSION,
  MAX_TRANSPORT_GENERATIONS,
  isIntelligencePipelineRequest,
  understandAiDispatchKey,
  type UnderstandAiJobPayload,
  type UnderstandAiModelRef,
  type UnderstandAiRoutePolicy,
} from "../../domain/intelligence-routing";
import { LANGUAGE_POLICY_VERSION } from "../../domain/language";
import type { NeedsReview } from "../../domain/needs-review";
import type { ProtectionEvaluation } from "../../domain/protection";
import { canonicalEligibility, prepareUnderstandingInput } from "../../domain/understanding-eligibility";
import { deriveUnderstandingOutcome } from "../../domain/understanding-outcome";
import { UNDERSTANDING_DIMENSIONS, type UnderstandingFailureClass } from "../../domain/understanding-output";
import { operationallyKilled, routeDecisionFor } from "../intelligence-dispatch";
import type { AiAttemptRow, ClassificationClock, IntelligenceScope, RequestState } from "../ports";
import { toAttemptLedgerEntries, type IntelligenceAttemptLedgerEntry, type IntelligenceRecordContext } from "./understand-ai-contract";
import { understandInteraction } from "./understand-interaction";
import { UNDERSTANDING_TASK_ID } from "./understanding-task";

/** One step's scope: the intelligence ports plus the R6 effect claim of that step's transaction. */
export interface IntelligenceRunScope extends IntelligenceScope {
  readonly claimEffect: (effectKey: string) => Promise<"claimed" | "already_applied">;
}

/** The qualified binding the composition installs (provenance of every attempt and result). */
export interface UnderstandingModelBinding {
  readonly model: UnderstandAiModelRef;
  /** The provider model id requested (the descriptor's configured model). */
  readonly modelRequested: string;
  readonly transportSchemaVersion: string;
  /** SHA-256 of the qualified route configuration (QUALIFIED_UNDERSTANDING_FINGERPRINT for the qualified model). */
  readonly routeFingerprint: string;
}

export interface UnderstandingRunDependencies {
  readonly inScope: <T>(work: (scope: IntelligenceRunScope) => Promise<T>) => Promise<T>;
  readonly policy: UnderstandAiRoutePolicy;
  /**
   * The gateway of this run, bound to its budget and egress ports (the composition supplies registry, routes, providers,
   * kill switch). Step H7-D1e2b: it must be the ledgered gateway — every provider call goes through `egress`.
   */
  readonly gatewayFor: (budget: BudgetPort, egress: EgressPort) => AiGateway;
  readonly binding: UnderstandingModelBinding;
  readonly clock: ClassificationClock;
  /**
   * Step H7-D1g-prep: told of each egress the fence AUTHORIZED (its identity committed) and of each attempt durably
   * RECORDED right after its call — counts only, never content — so a run that throws can still report whether a
   * provider call may have happened without its attempt (UNKNOWN_PROVIDER_OUTCOME). Observation only: no decision.
   */
  readonly egressObserver?: { readonly authorized: () => void; readonly recorded: () => void };
}

export const RUN_SKIP_REASONS = ["request_not_found", "request_identity_mismatch", "pipeline_not_intelligence", "already_terminal", "already_running", "not_dispatched", "duplicate_delivery"] as const;
export type RunSkipReason = (typeof RUN_SKIP_REASONS)[number];

export type UnderstandingRunOutcome =
  | { readonly kind: "skipped"; readonly reason: RunSkipReason }
  /** A pre-model check refused at execution: AI_FAILED, zero provider calls. */
  | { readonly kind: "refused"; readonly failureClass: UnderstandingFailureClass; readonly reason: string }
  | { readonly kind: "completed"; readonly generation: number; readonly attempts: number; readonly assessments: number; readonly protection: ProtectionEvaluation; readonly needsReview: NeedsReview }
  | { readonly kind: "failed"; readonly generation: number; readonly attempts: number; readonly failureClass: UnderstandingFailureClass; readonly cause: string; readonly redispatched: boolean; readonly protection: ProtectionEvaluation; readonly needsReview: NeedsReview }
  /** The request moved on while the call ran (recovery dispatched a newer generation): ledger kept, nothing accepted. */
  | { readonly kind: "generation_superseded"; readonly generation: number; readonly attempts: number };

const TERMINAL: readonly RequestState[] = ["COMPLETED", "AI_FAILED", "DETERMINISTIC_ONLY", "SKIPPED_OWN_BRAND", "SKIPPED_SUPERSEDED"];

/** Worst case of one gateway run: the initial call + the one re-ask (each sends at most the initial input + the closed issue list). */
const PROVIDER_CALLS_PER_RUN = 2;
const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

const instantOf = (now: Date): Instant => {
  const instant = parseInstant(now.toISOString());
  if (instant === undefined) throw new TypeError("instant_invalid");
  return instant;
};

const sameModel = (a: UnderstandAiModelRef, b: UnderstandAiModelRef): boolean => a.providerKey === b.providerKey && a.modelKey === b.modelKey;

function attemptRow(entry: IntelligenceAttemptLedgerEntry, ids: { readonly id: string; readonly organizationId: string; readonly createdAt: Date }): AiAttemptRow {
  const version = (key: string): string => {
    const value = entry.versions[key];
    if (value === undefined) throw new TypeError(`attempt_version_missing:${key}`);
    return value;
  };
  return Object.freeze({
    id: ids.id,
    organizationId: ids.organizationId,
    workspaceId: entry.workspaceId,
    understandingRequestId: entry.understandingRequestId,
    interactionId: entry.interactionId,
    sourceTextVersionId: entry.sourceTextVersionId,
    pipelineVersion: entry.pipelineVersion,
    dispatchGeneration: entry.dispatchGeneration,
    attemptNumber: entry.attemptNumber,
    attemptKind: entry.attemptKind,
    taskId: entry.taskId,
    taskVersion: entry.taskVersion,
    promptVersion: entry.promptVersion,
    promptHash: entry.promptHash,
    outputSchemaVersion: entry.outputSchemaVersion,
    transportSchemaVersion: entry.transportSchemaVersion,
    taxonomyVersion: version("taxonomy"),
    confidencePolicyVersion: version("confidencePolicy"),
    languagePolicyVersion: version("languagePolicy"),
    inputContractVersion: version("inputContract"),
    provider: entry.providerKey,
    modelRequested: entry.modelRequested,
    modelReported: entry.modelReported,
    startedAt: new Date(entry.startedAt),
    completedAt: new Date(entry.completedAt),
    latencyMs: entry.latencyMs,
    inputChars: entry.inputChars,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cachedInputTokens: entry.cachedInputTokens,
    // TA-Q-23 OPEN: no approved pricing table ⇒ no estimate (both stay null together).
    costEstimateUsd: entry.costEstimate?.amountUsd ?? null,
    pricingTableVersion: entry.costEstimate?.pricingTableVersion ?? null,
    outcome: entry.outcome,
    failureClass: entry.failureClass,
    issueCodes: entry.issueCodes,
    correlationId: entry.correlationId,
    triggerRunId: entry.triggerRunId,
    createdAt: ids.createdAt,
  });
}

export async function runUnderstanding(deps: UnderstandingRunDependencies, payload: UnderstandAiJobPayload, run: { readonly runId: string }): Promise<UnderstandingRunOutcome> {
  const { policy, clock, binding } = deps;

  // ── tx1: identity, eligibility, claim ─────────────────────────────────────────────────────────────────────
  const pre = await deps.inScope(async (scope) => {
    const skip = (reason: RunSkipReason) => ({ kind: "skipped" as const, reason });
    const request = await scope.intelligence.lockRequest(payload.understandingRequestId);
    if (request === undefined) return skip("request_not_found");
    if (request.workspaceId !== payload.workspaceId || request.interactionId !== payload.interactionId || request.sourceTextVersionId !== payload.sourceTextVersionId) return skip("request_identity_mismatch");
    if (!isIntelligencePipelineRequest(request)) return skip("pipeline_not_intelligence");
    if (TERMINAL.includes(request.state)) return skip("already_terminal");
    if (request.state === "AI_RUNNING") return skip("already_running");
    const generation = request.aiGeneration;
    if (request.state !== "AI_PENDING" || generation === null) return skip("not_dispatched");
    // Check 13: one execution per (request, generation) — the dispatch key is the effect key (R6).
    if ((await scope.claimEffect(understandAiDispatchKey(request.id, generation))) === "already_applied") return skip("duplicate_delivery");

    const now = clock.now();
    const refuse = async (failureClass: UnderstandingFailureClass, reason: string) => {
      const moved = await scope.intelligence.transition({ id: request.id, from: "AI_PENDING", fromGeneration: generation, to: "AI_FAILED", generation, failureClass, now });
      if (!moved) throw new Error("classification_request_moved_concurrently");
      return { kind: "refused" as const, failureClass, reason };
    };
    const target = await scope.texts.understandingContext(request.interactionId, request.sourceTextVersionId);
    if (target === undefined || target.workspaceId !== request.workspaceId) return refuse("AI_UNAVAILABLE", "target_not_found");
    const source = target.contentItemId === null ? undefined : await scope.contents.reportedSource(target.contentItemId);
    const canonical = canonicalEligibility(target, source);
    if (!canonical.ok) return refuse("AI_UNAVAILABLE", canonical.reason);
    const route = routeDecisionFor(policy, request);
    if (route.kind === "skip") return refuse("AI_UNAVAILABLE", route.reason);
    if (await operationallyKilled(scope)) return refuse("AI_UNAVAILABLE", "kill_switch");
    if (!sameModel(route.model, binding.model)) return refuse("AI_UNAVAILABLE", "model_binding_mismatch");
    const prepared = prepareUnderstandingInput(canonical.params);
    if (prepared.kind === "failed") return refuse("AI_INPUT_TOO_LARGE", "input_too_large");
    if (prepared.kind === "invalid") return refuse("AI_UNAVAILABLE", "input_invalid");
    // R6: AI_RUNNING is committed BEFORE any provider call.
    const running = await scope.intelligence.transition({ id: request.id, from: "AI_PENDING", fromGeneration: generation, to: "AI_RUNNING", generation, failureClass: null, now });
    if (!running) throw new Error("classification_request_moved_concurrently");
    return { kind: "call" as const, request, generation, input: prepared.input, budget: route.budget };
  });
  if (pre.kind !== "call") return pre;
  const { request, generation } = pre;

  // ── the call: budget reserved in its own committed transaction, before any provider call (check 11) ──────
  const budget: BudgetPort = {
    reserve: async (reservation) => {
      if (reservation.workspaceId !== request.workspaceId || reservation.taskId !== UNDERSTANDING_TASK_ID) return "denied";
      const reserved = await deps.inScope((scope) => scope.intelligence.reserveBudget({
        taskId: reservation.taskId,
        day: utcDay(clock.now()),
        calls: PROVIDER_CALLS_PER_RUN,
        inputChars: reservation.inputChars * PROVIDER_CALLS_PER_RUN,
        maxCalls: pre.budget.maxCallsPerDay,
        maxInputChars: pre.budget.maxInputCharsPerDay,
      }));
      return reserved ? "allowed" : "denied";
    },
  };
  const target = parseAnalysisTarget({ workspaceId: request.workspaceId, interactionId: request.interactionId, sourceTextVersionId: request.sourceTextVersionId });
  if (target === undefined) throw new TypeError("classification_target_invalid");
  const context: IntelligenceRecordContext = {
    target,
    understandingRequestId: request.id,
    pipelineVersion: INTELLIGENCE_PIPELINE_VERSION,
    dispatchGeneration: generation,
    correlationId: payload.correlationId,
    triggerRunId: run.runId,
    modelRequested: binding.modelRequested,
    transportSchemaVersion: binding.transportSchemaVersion,
  };
  // Stable ids for this run's two possible calls: the per-call write and tx2's re-assertion name the SAME rows.
  const intentIds: Readonly<Record<1 | 2, string>> = { 1: clock.newId(), 2: clock.newId() };
  const attemptIds: Readonly<Record<1 | 2, string>> = { 1: clock.newId(), 2: clock.newId() };
  const ledgerRows = (attempts: readonly AttemptRecord[], createdAt: Date): readonly AiAttemptRow[] =>
    toAttemptLedgerEntries(attempts, context).map((entry) => attemptRow(entry, { id: attemptIds[entry.attemptNumber], organizationId: request.organizationId, createdAt }));

  // ── egress: the durable identity of each provider call, committed BEFORE the call (fence under the row lock) ──
  const egress: EgressPort = {
    authorize: async (call) => {
      if (call.workspaceId !== request.workspaceId || call.taskId !== UNDERSTANDING_TASK_ID) return "denied";
      const decision = await deps.inScope(async (scope) => {
        const current = await scope.intelligence.lockRequest(request.id);
        // The fence: same workspace and request, still AI_RUNNING, still exactly this generation (never superseded).
        if (current === undefined || current.workspaceId !== request.workspaceId || current.state !== "AI_RUNNING" || current.aiGeneration !== generation) return "denied" as const;
        // H7-D1g-prep: the operator's kill, re-read at the last transactional point before egress (fail safe: unreadable ⇒ killed).
        if (await operationallyKilled(scope)) return "killed" as const;
        const written = await scope.intelligence.recordCallIntent({
          id: intentIds[call.attemptNumber],
          organizationId: request.organizationId,
          workspaceId: request.workspaceId,
          understandingRequestId: request.id,
          interactionId: request.interactionId,
          sourceTextVersionId: request.sourceTextVersionId,
          pipelineVersion: INTELLIGENCE_PIPELINE_VERSION,
          dispatchGeneration: generation,
          attemptNumber: call.attemptNumber,
          attemptKind: call.kind,
          taskId: call.taskId,
          provider: call.providerKey,
          modelRequested: binding.modelRequested,
          routeFingerprint: binding.routeFingerprint,
          inputChars: call.inputChars,
          correlationId: payload.correlationId,
          triggerRunId: run.runId,
          createdAt: clock.now(),
        });
        // A second authorization of the same egress identity is refused (exactly one intent per call).
        return written === "inserted" ? ("authorized" as const) : ("denied" as const);
      });
      if (decision === "authorized") deps.egressObserver?.authorized();
      return decision;
    },
    recorded: async (attempt) => {
      await deps.inScope((scope) => scope.intelligence.recordAttempts(ledgerRows([attempt], clock.now())));
      deps.egressObserver?.recorded();
    },
  };
  const result = await understandInteraction(deps.gatewayFor(budget, egress), pre.input, {
    workspaceId: request.workspaceId,
    interactionId: request.interactionId,
    sourceTextVersionId: request.sourceTextVersionId,
    pipelineVersion: INTELLIGENCE_PIPELINE_VERSION,
    reference: understandAiDispatchKey(request.id, generation),
  });

  // ── tx2: ledger, then (still this generation) result + shadow assessments, or the failure / next generation ──
  return deps.inScope(async (scope) => {
    const now = clock.now();
    // Already durable per call (egress.recorded); re-asserted idempotently with the SAME ids (a no-op when present).
    const rows = ledgerRows(result.attempts, now);
    const current = await scope.intelligence.lockRequest(request.id);
    await scope.intelligence.recordAttempts(rows);
    if (current === undefined || current.state !== "AI_RUNNING" || current.aiGeneration !== generation) return { kind: "generation_superseded" as const, generation, attempts: rows.length };

    if (result.kind === "assessed") {
      const accepted = rows.find((row) => row.outcome === "accepted");
      if (accepted === undefined) throw new Error("classification_ai_accepted_attempt_missing");
      const resultId = clock.newId();
      const written = await scope.intelligence.recordResult({
        id: resultId,
        organizationId: request.organizationId,
        workspaceId: request.workspaceId,
        understandingRequestId: request.id,
        interactionId: request.interactionId,
        sourceTextVersionId: request.sourceTextVersionId,
        pipelineVersion: INTELLIGENCE_PIPELINE_VERSION,
        dispatchGeneration: generation,
        attemptId: accepted.id,
        acceptanceMode: "shadow",
        provider: accepted.provider,
        modelRequested: accepted.modelRequested,
        modelReported: accepted.modelReported,
        routeFingerprint: binding.routeFingerprint,
        taskId: accepted.taskId,
        taskVersion: accepted.taskVersion,
        promptVersion: accepted.promptVersion,
        promptHash: accepted.promptHash,
        outputSchemaVersion: accepted.outputSchemaVersion,
        transportSchemaVersion: accepted.transportSchemaVersion,
        taxonomyVersion: accepted.taxonomyVersion,
        confidencePolicyVersion: accepted.confidencePolicyVersion,
        languagePolicyVersion: accepted.languagePolicyVersion,
        inputContractVersion: accepted.inputContractVersion,
        summary: result.output.summary,
        evidence: result.output.evidence,
        correlationId: payload.correlationId,
        triggerRunId: run.runId,
        createdAt: now,
      });
      // ai_results_once: one validated output per request — under this row lock a second one is an impossible invariant.
      if (written !== "inserted") throw new Error("classification_ai_result_exists");
      const refs = Object.fromEntries(UNDERSTANDING_DIMENSIONS.map((dimension) => [dimension, clock.newId()]));
      const outcome = deriveUnderstandingOutcome({
        target,
        ruleAssessments: await scope.intelligence.ruleAssessments(target),
        run: { kind: "assessed", output: result.output, method: result.method, assessedAt: instantOf(now), refs },
      });
      await scope.intelligence.recordShadowAssessments(outcome.aiAssessments.map((assessment) => ({
        assessment, organizationId: request.organizationId, aiResultId: resultId, pipelineVersion: INTELLIGENCE_PIPELINE_VERSION, languagePolicyVersion: LANGUAGE_POLICY_VERSION, createdAt: now,
      })));
      if (!(await scope.intelligence.transition({ id: request.id, from: "AI_RUNNING", fromGeneration: generation, to: "COMPLETED", generation, failureClass: null, now }))) {
        throw new Error("classification_request_moved_concurrently");
      }
      return { kind: "completed" as const, generation, attempts: rows.length, assessments: outcome.aiAssessments.length, protection: outcome.protection, needsReview: outcome.needsReview };
    }

    // A failure yields no assessment: Protection UNCERTAIN, Needs review follows (TA §23.2).
    const failedOutcome = deriveUnderstandingOutcome({ target, ruleAssessments: await scope.intelligence.ruleAssessments(target), run: { kind: "failed" } });
    const { failure } = result;
    const retry = failure.retryable && generation < MAX_TRANSPORT_GENERATIONS;
    const moved = retry
      ? await scope.intelligence.transition({ id: request.id, from: "AI_RUNNING", fromGeneration: generation, to: "AI_PENDING", generation: generation + 1, failureClass: null, now })
      : await scope.intelligence.transition({ id: request.id, from: "AI_RUNNING", fromGeneration: generation, to: "AI_FAILED", generation, failureClass: failure.class, now });
    if (!moved) throw new Error("classification_request_moved_concurrently");
    if (retry) {
      const appended = await scope.intelligence.appendDispatch({ request, generation: generation + 1, correlationId: payload.correlationId, outboxId: clock.newId(), now });
      if (appended !== "appended") throw new Error("classification_dispatch_key_taken");
    }
    return {
      kind: "failed" as const, generation, attempts: rows.length, failureClass: failure.class, cause: failure.cause, redispatched: retry, protection: failedOutcome.protection, needsReview: failedOutcome.needsReview,
    };
  });
}

// ── Operator-visible terminal outcome (Step H7-D1g-prep) ──────────────────────────────────────────────────────────

/**
 * The closed vocabulary of a run's TERMINAL outcome, for logs and operators: derived from the outcome's kinds, reasons
 * and causes only (all closed, identifier-shaped) — never text, prompt, response, provider error body or secret.
 *   unknown_provider_outcome  the run threw after the fence authorized a call whose attempt never became durable
 *                             (potentially billable; the ledger derivation tools/db/ai-call-accounting.ts is authoritative)
 *   run_error                 the run threw with every authorized call durably recorded (or none authorized)
 */
export const UNDERSTANDING_RUN_REPORT_CATEGORIES = [
  "completed", "skipped", "request_not_found", "refused", "killed", "budget_denied", "model_unavailable", "input_too_large", "provider_failed",
  "provider_refused", "timeout", "reask_exhausted", "egress_denied", "generation_superseded", "unknown_provider_outcome", "run_error",
] as const;
export type UnderstandingRunReportCategory = (typeof UNDERSTANDING_RUN_REPORT_CATEGORIES)[number];

export interface UnderstandingRunReport {
  readonly category: UnderstandingRunReportCategory;
  /** The closed reason or cause behind the category (identifier-shaped). */
  readonly detail: string;
  /** false ⇒ the run did not produce its shadow result (logged at warn, outcome "error"). */
  readonly ok: boolean;
}

const FAILURE_CATEGORY: Readonly<Record<string, UnderstandingRunReportCategory>> = Object.freeze({
  kill_switch: "killed",
  budget_exhausted: "budget_denied",
  task_disabled: "model_unavailable",
  model_unavailable: "model_unavailable",
  timeout: "timeout",
  invalid_output: "reask_exhausted",
  refused: "provider_refused",
  input_limit: "input_too_large",
  provider_input_limit: "input_too_large",
  egress_unrecorded: "egress_denied",
  provider_unavailable: "provider_failed",
  rate_limited: "provider_failed",
  provider_auth_failed: "provider_failed",
  provider_request_rejected: "provider_failed",
  model_mismatch: "provider_failed",
});

const report = (category: UnderstandingRunReportCategory, detail: string, ok: boolean): UnderstandingRunReport => Object.freeze({ category, detail, ok });

export function understandingRunReport(outcome: UnderstandingRunOutcome): UnderstandingRunReport {
  switch (outcome.kind) {
    case "completed":
      return report("completed", "shadow_result", true);
    case "generation_superseded":
      return report("generation_superseded", "generation_superseded", true);
    case "skipped":
      return outcome.reason === "request_not_found" ? report("request_not_found", outcome.reason, false) : report("skipped", outcome.reason, true);
    case "refused":
      if (outcome.reason === "kill_switch") return report("killed", outcome.reason, false);
      if (outcome.reason === "model_binding_mismatch") return report("model_unavailable", outcome.reason, false);
      if (outcome.failureClass === "AI_INPUT_TOO_LARGE") return report("input_too_large", outcome.reason, false);
      return report("refused", outcome.reason, false);
    case "failed":
      return report(FAILURE_CATEGORY[outcome.cause] ?? "provider_failed", outcome.cause, false);
  }
}

/** The report of a run that THREW, from the egress observer's counts (authorized vs durably recorded calls). */
export function interruptedRunReport(egress: { readonly authorized: number; readonly recorded: number }): UnderstandingRunReport {
  return egress.authorized > egress.recorded ? report("unknown_provider_outcome", "attempt_unrecorded", false) : report("run_error", "exception", false);
}
