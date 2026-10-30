/**
 * Step H7-D0v2a — the live bake-off EVIDENCE contract (sanitized, local, ignored `.wrenkind-local/`).
 *
 *   identity     `classification-live-evidence.v3` (H7-D0v2d: + per-case BAR_B `severity` + per-candidate configuration
 *                fingerprints; v2 = H7-D0 v2 FINAL, v1 = the unversioned files before — all left as they are and still
 *                read as historical output)
 *   provenance   evaluator, prompt (version + pinned hash), corpus (version + SHA-256 of the very bytes the runner
 *                parsed), promotion policy, transport schemas — never a second hand-typed hash
 *   per case     only what the evaluator CONCLUDED (v2 conclusions + v3 severity), as closed values / booleans
 *                (`SANITIZED_CASE_FIELDS`): never the input text, the provider response, a provider message, reasoning,
 *                a request body or a credential
 */
import { createHash } from "node:crypto";
import { ANTHROPIC_TRANSPORT_SCHEMA_VERSION } from "@/ai/providers/anthropic/schema-projection";
import { TAXONOMY_VERSION } from "@/modules/classification";
import { UNDERSTANDING_PROMPT_HASH, UNDERSTANDING_PROMPT_VERSION } from "@/prompts/classification/understanding.v2";
import type { EvalCorpus } from "../corpus";
import { EVALUATOR_VERSION } from "../evaluate";
import { PROMOTION_POLICY } from "../promotion";
import { LIVE_CALL_TIMEOUT_MS, MAX_OUTPUT_TOKENS, type Candidate } from "./candidates";

export const LIVE_EVIDENCE_VERSION = "classification-live-evidence.v3" as const;

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
  "severity",
  "attempts",
] as const;

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** The model-input-relevant configuration of a candidate (any change ⇒ a different fingerprint ⇒ no evidence reuse). */
export function candidateConfigFingerprint(candidate: Candidate): string {
  return sha256Hex(JSON.stringify({
    id: candidate.id,
    providerKey: candidate.providerKey,
    settings: candidate.settings,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    callTimeoutMs: LIVE_CALL_TIMEOUT_MS,
    transportSchema: candidate.providerKey === "anthropic" ? ANTHROPIC_TRANSPORT_SCHEMA_VERSION : "canonical-strict",
    taxonomyVersion: TAXONOMY_VERSION,
  }));
}

/** The benchmark artifacts the evidence was produced with (corpus hash = the bytes actually parsed). */
export function liveEvidenceProvenance(corpus: Pick<EvalCorpus, "corpusVersion">, corpusSha256: string, candidates: readonly Candidate[] = []) {
  return {
    taxonomyVersion: TAXONOMY_VERSION,
    evidenceVersion: LIVE_EVIDENCE_VERSION,
    evaluatorVersion: EVALUATOR_VERSION,
    promptVersion: UNDERSTANDING_PROMPT_VERSION,
    promptHash: UNDERSTANDING_PROMPT_HASH,
    corpusVersion: corpus.corpusVersion,
    corpusSha256,
    promotionVersion: PROMOTION_POLICY.version,
    transportSchemas: { openai: "canonical-strict" as const, anthropic: ANTHROPIC_TRANSPORT_SCHEMA_VERSION },
    candidateConfig: Object.fromEntries(candidates.map((c) => [c.id, candidateConfigFingerprint(c)])),
  };
}
