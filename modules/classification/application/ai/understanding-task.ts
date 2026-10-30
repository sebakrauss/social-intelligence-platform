/**
 * Task A — classification understanding — as an AI Gateway task (Step H7-C; H7-A0 §10, §13, §14). It binds the frozen
 * H7-A1 contracts to the gateway and adds nothing semantic:
 *
 *   input      `UnderstandingInput` (A1 builder: bounded context, no author / handle / profile / credential / raw body /
 *              watch-term field by construction); the data block copies ONLY the allowlisted fields below
 *   prompt     prompts/classification/understanding.v2 (versioned, content-hashed; H7-D0k: v1 + the commercial-intent
 *              boundary — v1 stays the prompt of the H7-D0 FINAL bake-off)
 *   output     the A1 strict validator (`validateUnderstandingOutput`) — unknown keys / values fail, nothing coerced;
 *              H7-D0: a provider-neutral strict JSON Schema for native structured output, whose forced `null`s for
 *              optional fields are removed (`fromStructuredOutput`) BEFORE the A1 validator — which still decides
 *   re-ask     the gateway's one re-ask (A1 `nextStepAfterValidation` semantics)
 *
 * Not exported from the module index: no deployed runtime composes it yet (the INTELLIGENCE plane is a later gate).
 */
import type { GatewayTask } from "@/ai/gateway";
import { UNDERSTANDING_PROMPT_HASH, UNDERSTANDING_PROMPT_SYSTEM, UNDERSTANDING_PROMPT_VERSION } from "@/prompts/classification/understanding.v2";
import { CONFIDENCE_CONTRACT_VERSION } from "../../domain/confidence";
import { LANGUAGE_POLICY_VERSION } from "../../domain/language";
import { TAXONOMY_VERSION } from "../../domain/taxonomy";
import { UNDERSTANDING_INPUT_CONTRACT_VERSION, type UnderstandingInput } from "../../domain/understanding-input";
import { UNDERSTANDING_OUTPUT_SCHEMA_VERSION, validateUnderstandingOutput, type ValidatedUnderstanding } from "../../domain/understanding-output";
import { UNDERSTANDING_JSON_SCHEMA_NAME, UNDERSTANDING_OUTPUT_JSON_SCHEMA, fromStructuredOutput } from "./understanding-output-schema";

export const UNDERSTANDING_TASK_ID = "classification.understanding" as const;
/** v2 (H7-D0): adds the native structured-output schema + its null bridge; prompt and output schema unchanged (v1). */
export const UNDERSTANDING_TASK_VERSION = "understanding-task.v2" as const;

/** The ONLY fields the model ever receives (data minimization, H7-A0 §13; pinned by an architecture guard). */
export const UNDERSTANDING_DATA_FIELDS = [
  "contractVersion",
  "taxonomyVersion",
  "validatedLanguages",
  "interactionKind",
  "platform",
  "source",
  "brandName",
  "hints",
  "analyzedText",
  "parentExcerpt",
  "rootExcerpt",
  "captionExcerpt",
] as const;

export function understandingData(input: UnderstandingInput): Readonly<Record<(typeof UNDERSTANDING_DATA_FIELDS)[number], unknown>> {
  return Object.freeze({
    contractVersion: input.contractVersion,
    taxonomyVersion: input.taxonomyVersion,
    validatedLanguages: [...input.validatedLanguages],
    interactionKind: input.interactionKind,
    platform: input.platform,
    source: input.source,
    brandName: input.brandName,
    hints: { linkPresent: input.hints.linkPresent, parentByOwnBrand: input.hints.parentByOwnBrand, rootByOwnBrand: input.hints.rootByOwnBrand },
    analyzedText: input.text,
    parentExcerpt: input.parentExcerpt,
    rootExcerpt: input.rootExcerpt,
    captionExcerpt: input.captionExcerpt,
  });
}

export const UNDERSTANDING_TASK: GatewayTask<UnderstandingInput, ValidatedUnderstanding> = Object.freeze({
  taskId: UNDERSTANDING_TASK_ID,
  taskVersion: UNDERSTANDING_TASK_VERSION,
  prompt: Object.freeze({ version: UNDERSTANDING_PROMPT_VERSION, hash: UNDERSTANDING_PROMPT_HASH, system: UNDERSTANDING_PROMPT_SYSTEM }),
  outputSchemaVersion: UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
  outputJsonSchema: Object.freeze({ name: UNDERSTANDING_JSON_SCHEMA_NAME, schema: UNDERSTANDING_OUTPUT_JSON_SCHEMA }),
  versions: Object.freeze({
    taxonomy: TAXONOMY_VERSION,
    confidencePolicy: CONFIDENCE_CONTRACT_VERSION,
    languagePolicy: LANGUAGE_POLICY_VERSION,
    inputContract: UNDERSTANDING_INPUT_CONTRACT_VERSION,
  }),
  data: understandingData,
  validate: (parsed: unknown, input: UnderstandingInput) => {
    const validation = validateUnderstandingOutput(fromStructuredOutput(parsed), input.text);
    return validation.ok ? { ok: true as const, value: validation.output } : { ok: false as const, issues: validation.failure.issues };
  },
});
