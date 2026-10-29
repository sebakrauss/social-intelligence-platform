/**
 * The domain-shaped understanding call (Step H7-C; H7-A0 §10):
 *
 *   understandInteraction(gateway, input, context)
 *     → { kind: "assessed", output: ValidatedUnderstanding, method: AiMethod, attempts }   schema-valid only
 *     | { kind: "failed",   failure: { class: AI_INVALID_OUTPUT | AI_UNAVAILABLE | AI_REFUSED | AI_BUDGET |
 *                                     AI_INPUT_TOO_LARGE, cause, retryable, issues }, attempts }
 *
 * Callers never see a provider request, response or raw output. A failure yields NO assessment (TA §23.2); turning an
 * assessed output into assessments (`toAiAssessments`, language cap D-H7-5) and persisting them is a later runtime
 * gate. No vendor name is branched on here.
 */
import type { AiFailureClass, AiGateway, AttemptRecord } from "@/ai/gateway";
import type { AiMethod } from "../../domain/assessment";
import { CONFIDENCE_CONTRACT_VERSION } from "../../domain/confidence";
import { TAXONOMY_VERSION } from "../../domain/taxonomy";
import type { UnderstandingInput } from "../../domain/understanding-input";
import type { UnderstandingFailureClass, ValidatedUnderstanding } from "../../domain/understanding-output";
import { UNDERSTANDING_TASK } from "./understanding-task";

export interface UnderstandingCallContext {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly pipelineVersion: string;
  /** Opaque call reference (never derived from social text). */
  readonly reference: string;
}

export type UnderstandingResult =
  | { readonly kind: "assessed"; readonly output: ValidatedUnderstanding; readonly method: AiMethod; readonly attempts: readonly AttemptRecord[] }
  | {
    readonly kind: "failed";
    readonly failure: { readonly class: UnderstandingFailureClass; readonly cause: string; readonly retryable: boolean; readonly issues: readonly string[] };
    readonly attempts: readonly AttemptRecord[];
  };

/** The gateway's classes ARE the A1 understanding failure classes (exhaustive by type). */
const FAILURE_CLASS: Readonly<Record<AiFailureClass, UnderstandingFailureClass>> = Object.freeze({
  AI_INVALID_OUTPUT: "AI_INVALID_OUTPUT",
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
  AI_REFUSED: "AI_REFUSED",
  AI_BUDGET: "AI_BUDGET",
  AI_INPUT_TOO_LARGE: "AI_INPUT_TOO_LARGE",
});

export async function understandInteraction(gateway: AiGateway, input: UnderstandingInput, context: UnderstandingCallContext): Promise<UnderstandingResult> {
  const outcome = await gateway.run(UNDERSTANDING_TASK, input, {
    workspaceId: context.workspaceId,
    subject: { interactionId: context.interactionId, sourceTextVersionId: context.sourceTextVersionId },
    pipelineVersion: context.pipelineVersion,
    reference: context.reference,
  });
  if (outcome.kind === "failed") {
    const { failure } = outcome;
    return { kind: "failed", failure: Object.freeze({ class: FAILURE_CLASS[failure.class], cause: failure.cause, retryable: failure.retryable, issues: failure.issues }), attempts: outcome.attempts };
  }
  const { provenance } = outcome;
  const method: AiMethod = Object.freeze({
    kind: "ai" as const,
    provider: provenance.providerKey,
    model: provenance.modelKey,
    modelVersion: provenance.modelVersion,
    taskId: provenance.taskId,
    taskVersion: provenance.taskVersion,
    promptVersion: provenance.promptVersion,
    promptHash: provenance.promptHash,
    schemaVersion: provenance.outputSchemaVersion,
    taxonomyVersion: TAXONOMY_VERSION,
    confidencePolicyVersion: CONFIDENCE_CONTRACT_VERSION,
  });
  return { kind: "assessed", output: outcome.value, method, attempts: outcome.attempts };
}
