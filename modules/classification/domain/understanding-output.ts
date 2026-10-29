/**
 * The structured output contract of the future understanding task (task A) and its strict validator (Step H7-A1;
 * TA §23; H7-A0 §4.4–§4.5, §10, §11.3). Pure; no model is called.
 *
 * Shape (closed — any unexpected key anywhere fails validation; nothing is coerced, defaulted or mapped to "unknown"):
 *
 *   { schemaVersion: "understanding-output.v1", taxonomyVersion: "taxonomy.v1",
 *     dimensions: { <dim>?: DimensionResult },            // dims of task A only; an omitted dim = no assessment
 *     summary?: string,                                    // ≤ 240 chars, plain text, display only
 *     evidence?: [{ quote: string }] }                     // ≤ 3 exact substrings of the analyzed text, ≤ 60 chars
 *
 *   DimensionResult = { status: "assessed", values: [{ key, confidence: "low"|"medium"|"high", score? }], reasonCodes? }
 *                   | { status: "none_fits" } | { status: "insufficient_evidence" }
 *   language        = { status: "assessed", languages: [bcp47…], certainty: "certain"|"uncertain", confidence } | abstention
 *
 * There is no field for reasoning, thinking or chain-of-thought: the closed schema rejects any such key. Quotes are
 * verified against the analyzed text and stored as SOURCE SPANS only (the text is never copied into an assessment).
 *
 * Re-ask (TA §22.2, §23.2): the first invalid output ⇒ one re-ask with the validation issues; a second invalid output ⇒
 * no assessment (AI_INVALID_OUTPUT). The loop itself belongs to the gateway (later).
 *
 * Language cap (D-H7-5): `toAiAssessments` caps every semantic value at `medium` unless the output's language is
 * validated and certain (an output without a language result counts as unknown).
 */
import type { Instant } from "@/domain/instant";
import { createAssessment, type AiMethod, type AnalysisTarget, type Assessment, type AssessedValue } from "./assessment";
import { capConfidence, isConfidenceLevel, isConfidenceScore, type Abstention, type ConfidenceLevel } from "./confidence";
import { MAX_LANGUAGE_TAGS, maxSemanticConfidence, parseLanguageTag, type LanguageCertainty, type LanguageResult, type LanguageTag } from "./language";
import { TAXONOMY, TAXONOMY_VERSION, isReasonCode, isTaxonomyValue, type ClosedDimension, type ClosedDimensionDefinition } from "./taxonomy";
import type { SourceSpan } from "./text-segments";

export const UNDERSTANDING_OUTPUT_SCHEMA_VERSION = "understanding-output.v1" as const;

/** The dimensions task A assesses (topics belong to task C, `topics` module). */
export const UNDERSTANDING_DIMENSIONS = ["safety", "authenticity", "intent", "sentiment", "risk", "response_need", "language"] as const;
export type UnderstandingDimension = (typeof UNDERSTANDING_DIMENSIONS)[number];

export const UNDERSTANDING_OUTPUT_BOUNDS = Object.freeze({ summaryChars: 240, evidenceQuotes: 3, quoteChars: 60 });

/** Typed failures of one understanding attempt (produced by the gateway later; classification only consumes them). */
export const UNDERSTANDING_FAILURE_CLASSES = ["AI_INVALID_OUTPUT", "AI_UNAVAILABLE", "AI_REFUSED", "AI_BUDGET", "AI_INPUT_TOO_LARGE"] as const;
export type UnderstandingFailureClass = (typeof UNDERSTANDING_FAILURE_CLASSES)[number];

export const OUTPUT_ISSUES = [
  "NOT_AN_OBJECT",
  "UNEXPECTED_KEY",
  "SCHEMA_VERSION_MISMATCH",
  "TAXONOMY_VERSION_MISMATCH",
  "DIMENSIONS_INVALID",
  "UNKNOWN_DIMENSION",
  "STATUS_INVALID",
  "UNKNOWN_VALUE",
  "DUPLICATE_VALUE",
  "CARDINALITY_VIOLATION",
  "EXCLUSIVE_VALUE_COMBINED",
  "CONFIDENCE_INVALID",
  "SCORE_INVALID",
  "REASON_CODE_INVALID",
  "LANGUAGE_TAG_INVALID",
  "LANGUAGE_CERTAINTY_INVALID",
  "SUMMARY_INVALID",
  "EVIDENCE_INVALID",
  "QUOTE_NOT_IN_TEXT",
] as const;
export type OutputIssue = (typeof OUTPUT_ISSUES)[number];

export type ValidatedDimension =
  | { readonly status: "assessed"; readonly values: readonly AssessedValue[]; readonly reasonCodes: readonly string[] }
  | { readonly status: Abstention };

export interface ValidatedLanguageResult {
  readonly status: "assessed";
  readonly languages: readonly LanguageTag[];
  readonly certainty: LanguageCertainty;
  readonly confidence: ConfidenceLevel;
}

export interface ValidatedUnderstanding {
  readonly schemaVersion: typeof UNDERSTANDING_OUTPUT_SCHEMA_VERSION;
  readonly taxonomyVersion: typeof TAXONOMY_VERSION;
  readonly dimensions: Readonly<Partial<Record<Exclude<UnderstandingDimension, "language">, ValidatedDimension>>>;
  readonly language: ValidatedLanguageResult | { readonly status: Abstention } | null;
  readonly summary: string | null;
  readonly evidence: readonly SourceSpan[];
}

export type OutputValidation =
  | { readonly ok: true; readonly output: ValidatedUnderstanding }
  | { readonly ok: false; readonly failure: { readonly class: "AI_INVALID_OUTPUT"; readonly issues: readonly OutputIssue[] } };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[], issues: Set<OutputIssue>): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.add("UNEXPECTED_KEY");
};
// Plain text only: no control characters (tab and newline excepted).
const PLAIN_TEXT = /^[^\p{Cc}]*$/u;
const plain = (text: string): boolean => PLAIN_TEXT.test(text.replace(/[\t\n]/g, ""));

function validateClosedDimension(dimension: ClosedDimension, raw: unknown, issues: Set<OutputIssue>): ValidatedDimension | undefined {
  if (!isRecord(raw)) {
    issues.add("STATUS_INVALID");
    return undefined;
  }
  if (raw["status"] === "none_fits" || raw["status"] === "insufficient_evidence") {
    onlyKeys(raw, ["status"], issues);
    return Object.freeze({ status: raw["status"] });
  }
  if (raw["status"] !== "assessed") {
    issues.add("STATUS_INVALID");
    return undefined;
  }
  onlyKeys(raw, ["status", "values", "reasonCodes"], issues);
  const definition = TAXONOMY[dimension] as ClosedDimensionDefinition;
  const rawValues = raw["values"];
  if (!Array.isArray(rawValues) || rawValues.length === 0 || (definition.cardinality === "single" && rawValues.length !== 1) || rawValues.length > definition.values.length) {
    issues.add("CARDINALITY_VIOLATION");
    return undefined;
  }
  const values: AssessedValue[] = [];
  for (const entry of rawValues) {
    if (!isRecord(entry)) {
      issues.add("UNKNOWN_VALUE");
      continue;
    }
    onlyKeys(entry, ["key", "confidence", "score"], issues);
    if (!isTaxonomyValue(dimension, entry["key"])) issues.add("UNKNOWN_VALUE");
    if (!isConfidenceLevel(entry["confidence"])) issues.add("CONFIDENCE_INVALID");
    if (entry["score"] !== undefined && !isConfidenceScore(entry["score"])) issues.add("SCORE_INVALID");
    if (isTaxonomyValue(dimension, entry["key"]) && isConfidenceLevel(entry["confidence"])) {
      values.push(Object.freeze({ key: entry["key"] as string, confidence: Object.freeze({ level: entry["confidence"], score: isConfidenceScore(entry["score"]) ? entry["score"] : null }) }));
    }
  }
  const keys = values.map((v) => v.key);
  if (new Set(keys).size !== keys.length) issues.add("DUPLICATE_VALUE");
  if (keys.length > 1 && keys.some((key) => definition.exclusive.includes(key))) issues.add("EXCLUSIVE_VALUE_COMBINED");
  const rawReasons = raw["reasonCodes"] ?? [];
  if (!Array.isArray(rawReasons) || !rawReasons.every((code) => isReasonCode(dimension, code)) || new Set(rawReasons).size !== rawReasons.length) issues.add("REASON_CODE_INVALID");
  return Object.freeze({ status: "assessed" as const, values: Object.freeze(values), reasonCodes: Object.freeze(Array.isArray(rawReasons) ? rawReasons.map(String) : []) });
}

function validateLanguage(raw: unknown, issues: Set<OutputIssue>): ValidatedLanguageResult | { readonly status: Abstention } | undefined {
  if (!isRecord(raw)) {
    issues.add("STATUS_INVALID");
    return undefined;
  }
  if (raw["status"] === "none_fits" || raw["status"] === "insufficient_evidence") {
    onlyKeys(raw, ["status"], issues);
    return Object.freeze({ status: raw["status"] });
  }
  if (raw["status"] !== "assessed") {
    issues.add("STATUS_INVALID");
    return undefined;
  }
  onlyKeys(raw, ["status", "languages", "certainty", "confidence"], issues);
  const rawTags = raw["languages"];
  if (!Array.isArray(rawTags) || rawTags.length === 0 || rawTags.length > MAX_LANGUAGE_TAGS) {
    issues.add("CARDINALITY_VIOLATION");
    return undefined;
  }
  const tags = rawTags.map(parseLanguageTag);
  if (tags.some((tag) => tag === undefined)) issues.add("LANGUAGE_TAG_INVALID");
  if (new Set(tags).size !== tags.length) issues.add("DUPLICATE_VALUE");
  if (raw["certainty"] !== "certain" && raw["certainty"] !== "uncertain") issues.add("LANGUAGE_CERTAINTY_INVALID");
  if (!isConfidenceLevel(raw["confidence"])) issues.add("CONFIDENCE_INVALID");
  if (tags.some((tag) => tag === undefined) || (raw["certainty"] !== "certain" && raw["certainty"] !== "uncertain") || !isConfidenceLevel(raw["confidence"])) return undefined;
  return Object.freeze({ status: "assessed" as const, languages: Object.freeze(tags as LanguageTag[]), certainty: raw["certainty"], confidence: raw["confidence"] });
}

/** Validates one raw model output against the closed schema, for the analyzed text the quotes must come from. */
export function validateUnderstandingOutput(raw: unknown, analyzedText: string): OutputValidation {
  const issues = new Set<OutputIssue>();
  const fail = (): OutputValidation => ({ ok: false, failure: Object.freeze({ class: "AI_INVALID_OUTPUT" as const, issues: Object.freeze((OUTPUT_ISSUES as readonly OutputIssue[]).filter((i) => issues.has(i))) }) });
  if (!isRecord(raw)) {
    issues.add("NOT_AN_OBJECT");
    return fail();
  }
  onlyKeys(raw, ["schemaVersion", "taxonomyVersion", "dimensions", "summary", "evidence"], issues);
  if (raw["schemaVersion"] !== UNDERSTANDING_OUTPUT_SCHEMA_VERSION) issues.add("SCHEMA_VERSION_MISMATCH");
  if (raw["taxonomyVersion"] !== TAXONOMY_VERSION) issues.add("TAXONOMY_VERSION_MISMATCH");
  const rawDimensions = raw["dimensions"];
  const dimensions: Partial<Record<Exclude<UnderstandingDimension, "language">, ValidatedDimension>> = {};
  let language: ValidatedUnderstanding["language"] = null;
  if (!isRecord(rawDimensions)) {
    issues.add("DIMENSIONS_INVALID");
  } else {
    for (const [key, value] of Object.entries(rawDimensions)) {
      if (!(UNDERSTANDING_DIMENSIONS as readonly string[]).includes(key)) {
        issues.add("UNKNOWN_DIMENSION");
        continue;
      }
      if (key === "language") {
        language = validateLanguage(value, issues) ?? null;
        continue;
      }
      const validated = validateClosedDimension(key as ClosedDimension, value, issues);
      if (validated !== undefined) dimensions[key as Exclude<UnderstandingDimension, "language">] = validated;
    }
  }
  let summary: string | null = null;
  if (raw["summary"] !== undefined) {
    const value = raw["summary"];
    if (typeof value !== "string" || value.length === 0 || value.length > UNDERSTANDING_OUTPUT_BOUNDS.summaryChars || !plain(value)) issues.add("SUMMARY_INVALID");
    else summary = value;
  }
  const evidence: SourceSpan[] = [];
  if (raw["evidence"] !== undefined) {
    const value = raw["evidence"];
    if (!Array.isArray(value) || value.length > UNDERSTANDING_OUTPUT_BOUNDS.evidenceQuotes) issues.add("EVIDENCE_INVALID");
    else {
      for (const entry of value) {
        if (!isRecord(entry)) {
          issues.add("EVIDENCE_INVALID");
          continue;
        }
        onlyKeys(entry, ["quote"], issues);
        const quote = entry["quote"];
        if (typeof quote !== "string" || quote.length === 0 || quote.length > UNDERSTANDING_OUTPUT_BOUNDS.quoteChars) {
          issues.add("EVIDENCE_INVALID");
          continue;
        }
        const start = analyzedText.indexOf(quote);
        if (start < 0) issues.add("QUOTE_NOT_IN_TEXT");
        else evidence.push(Object.freeze({ start, end: start + quote.length }));
      }
    }
  }
  if (issues.size > 0) return fail();
  return {
    ok: true,
    output: Object.freeze({
      schemaVersion: UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
      taxonomyVersion: TAXONOMY_VERSION,
      dimensions: Object.freeze(dimensions),
      language,
      summary,
      evidence: Object.freeze(evidence),
    }),
  };
}

/** The gateway's next step after validating attempt 1 or 2 (TA §23.2): accept, re-ask once, or write no assessment. */
export function nextStepAfterValidation(attempt: 1 | 2, validation: OutputValidation): "accept" | "reask" | "no_assessment" {
  if (validation.ok) return "accept";
  return attempt === 1 ? "reask" : "no_assessment";
}

/** The language result an output carries (none ⇒ unknown). */
export function languageResultOf(output: ValidatedUnderstanding): LanguageResult {
  return output.language !== null && output.language.status === "assessed"
    ? Object.freeze({ kind: "detected" as const, languages: output.language.languages, certainty: output.language.certainty })
    : Object.freeze({ kind: "unknown" as const });
}

/**
 * The AI assessments of one validated output for one target (refs supplied by the caller, one per dimension). Semantic
 * values are capped by the language policy (D-H7-5); the language assessment itself keeps its own confidence.
 */
export function toAiAssessments(output: ValidatedUnderstanding, input: { readonly target: AnalysisTarget; readonly method: AiMethod; readonly assessedAt: Instant; readonly refs: Readonly<Partial<Record<UnderstandingDimension, string>>> }): readonly Assessment[] {
  const cap = maxSemanticConfidence(languageResultOf(output));
  const out: Assessment[] = [];
  const add = (dimension: UnderstandingDimension, content: Assessment["content"], languageCertainty: LanguageCertainty | null = null): void => {
    const ref = input.refs[dimension];
    if (ref === undefined) throw new TypeError("assessment_ref_missing");
    const created = createAssessment({ ref, target: input.target, dimension, method: input.method, content, assessedAt: input.assessedAt, languageCertainty });
    if (!created.ok) throw new TypeError(`assessment_invalid:${created.violations.join(",")}`);
    out.push(created.assessment);
  };
  for (const dimension of UNDERSTANDING_DIMENSIONS) {
    if (dimension === "language") {
      const language = output.language;
      if (language === null) continue;
      if (language.status === "assessed") {
        add("language", { kind: "values", values: language.languages.map((tag) => ({ key: tag, confidence: { level: language.confidence, score: null } })), reasonCodes: [] }, language.certainty);
      } else {
        add("language", { kind: "abstained", abstention: language.status });
      }
      continue;
    }
    const result = output.dimensions[dimension];
    if (result === undefined) continue;
    add(dimension, result.status === "assessed"
      ? { kind: "values", values: result.values.map((v) => ({ key: v.key, confidence: capConfidence(v.confidence, cap) })), reasonCodes: result.reasonCodes }
      : { kind: "abstained", abstention: result.status });
  }
  return Object.freeze(out);
}
