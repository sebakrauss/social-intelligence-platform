/**
 * Step H7-D0v2a — the live bake-off EVIDENCE contract (sanitized, local, ignored `.wrenkind-local/`).
 *
 *   identity     `classification-live-evidence.v2` (v1 = the unversioned files of H7-D0 FINAL and earlier — left as
 *                they are and still read as historical output)
 *   provenance   evaluator, prompt (version + pinned hash), corpus (version + SHA-256 of the very bytes the runner
 *                parsed), promotion policy, transport schemas — never a second hand-typed hash
 *   per case     only what evaluator v2 CONCLUDED, as closed values / booleans (`SANITIZED_CASE_FIELDS`): never the
 *                input text, the provider response, a provider message, reasoning, a request body or a credential
 */
import { createHash } from "node:crypto";
import { ANTHROPIC_TRANSPORT_SCHEMA_VERSION } from "@/ai/providers/anthropic/schema-projection";
import { UNDERSTANDING_PROMPT_HASH, UNDERSTANDING_PROMPT_VERSION } from "@/prompts/classification/understanding.v2";
import type { EvalCorpus } from "../corpus";
import { EVALUATOR_VERSION } from "../evaluate";
import { PROMOTION_POLICY } from "../promotion";

export const LIVE_EVIDENCE_VERSION = "classification-live-evidence.v2" as const;

/** The per-case evidence keys (the contract a guard test pins; a new CaseResult outcome must be classified). */
export const SANITIZED_CASE_FIELDS = [
  "id",
  "pass",
  "failureClass",
  "failureCause",
  "protection",
  "needsReview",
  "criticalFailures",
  "labels",
  "rawLanguageCapExceedance",
  "languageSupport",
  "effectiveCapViolation",
  "protectedIntent",
  "attempts",
] as const;

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** The benchmark artifacts the evidence was produced with (corpus hash = the bytes actually parsed). */
export function liveEvidenceProvenance(corpus: Pick<EvalCorpus, "corpusVersion">, corpusSha256: string) {
  return {
    evidenceVersion: LIVE_EVIDENCE_VERSION,
    evaluatorVersion: EVALUATOR_VERSION,
    promptVersion: UNDERSTANDING_PROMPT_VERSION,
    promptHash: UNDERSTANDING_PROMPT_HASH,
    corpusVersion: corpus.corpusVersion,
    corpusSha256,
    promotionVersion: PROMOTION_POLICY.version,
    transportSchemas: { openai: "canonical-strict" as const, anthropic: ANTHROPIC_TRANSPORT_SCHEMA_VERSION },
  };
}
