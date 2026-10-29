/**
 * Step H7-C — the offline evaluation corpus of task A (fixtures/intelligence/classification/understanding-eval.v1.json):
 * its strict format and parser. Hand-authored synthetic cases only; labels are taxonomy.v1 keys, never prose.
 *
 *   expected.<dimension>   { values: [gold…], allowed?: [tolerated extras], forbidden?: [critical errors], reasonCodes? }
 *                          | { abstain: true }          (an abstention or no assessment is the right answer)
 *   expectedProtection     protected · not_protected · uncertain · protected_or_uncertain
 *   expectedNeedsReview    true · false · null (not scored: legitimately depends on the model's confidence)
 *   expectedFailure        null · one of the gateway failure classes (e.g. AI_INPUT_TOO_LARGE for an over-bound text)
 *   tags                   protected_critical (protected meaning: complaint, problem, fraud accusation, objection) ·
 *                          safety_critical (hate, threat, harassment, insult, scam, impersonation review) · others
 *   goldConfidence         the confidence the GOLDEN simulator emits (high, or medium for capped / ambiguous cases)
 */
import { CLOSED_DIMENSIONS, TAXONOMY, TAXONOMY_VERSION, UNDERSTANDING_FAILURE_CLASSES, UNDERSTANDING_INPUT_CONTRACT_VERSION, isReasonCode, isTaxonomyValue, type ClosedDimension, type ClosedDimensionDefinition } from "@/modules/classification";

export const CORPUS_VERSION = "eval-corpus.v1";
export const PROTECTION_EXPECTATIONS = ["protected", "not_protected", "uncertain", "protected_or_uncertain"] as const;
export type ProtectionExpectation = (typeof PROTECTION_EXPECTATIONS)[number];
export const LANGUAGE_GROUPS = ["es", "pt-BR", "en", "es+en", "es+pt-BR", "unsupported", "uncertain", "unknown"] as const;
export type LanguageGroup = (typeof LANGUAGE_GROUPS)[number];
export const CASE_TAGS = ["protected_critical", "safety_critical", "prompt_injection", "price_contrast", "scam_contrast", "profanity", "negative_not_harmful", "ambiguous", "sarcasm", "emoji", "slang",
  "reply_context", "spam", "code_switching", "unsupported_language", "uncertain_language", "long_input"] as const;
export type CaseTag = (typeof CASE_TAGS)[number];
export const CATEGORIES = ["neutral_praise", "support_request", "product_service_question", "purchase_intent", "generic_price_question", "explicit_price_objection", "complaint", "fraud_accusation_against_brand",
  "scam_content", "profanity_without_hate", "personal_insult", "harassment", "hate_speech", "threat", "abusive_complaint", "negative_without_safety", "ambiguous", "sarcasm", "emoji_heavy",
  "misspelling_slang", "unsupported_language", "prompt_injection", "long_input", "suggestion"] as const;

export type DimensionExpectation =
  | { readonly kind: "values"; readonly values: readonly string[]; readonly allowed: readonly string[]; readonly forbidden: readonly string[]; readonly reasonCodes: readonly string[] }
  | { readonly kind: "abstain" };

export interface EvalCase {
  readonly id: string;
  readonly category: (typeof CATEGORIES)[number];
  readonly locale: string;
  readonly language: { readonly group: LanguageGroup; readonly tags: readonly string[]; readonly certainty: "certain" | "uncertain" };
  readonly input: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly expected: Readonly<Partial<Record<ClosedDimension, DimensionExpectation>>>;
  readonly expectedProtection: ProtectionExpectation;
  readonly expectedNeedsReview: boolean | null;
  readonly expectedFailure: (typeof UNDERSTANDING_FAILURE_CLASSES)[number] | null;
  readonly tags: readonly CaseTag[];
  readonly weight: number;
  readonly goldConfidence: "high" | "medium";
}

export interface EvalCorpus {
  readonly corpusId: string;
  readonly corpusVersion: typeof CORPUS_VERSION;
  readonly cases: readonly EvalCase[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown, path: string): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new TypeError(`corpus_invalid:${path}`);
  return value;
};
const oneOf = <T extends string>(values: readonly T[], value: unknown, path: string): T => {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw new TypeError(`corpus_invalid:${path}`);
  return value as T;
};
const keysOnly = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`corpus_invalid:${path}.${key}`);
};

function parseDimension(dimension: ClosedDimension, raw: unknown, path: string): DimensionExpectation {
  if (!isRecord(raw)) throw new TypeError(`corpus_invalid:${path}`);
  if (raw["abstain"] === true) {
    keysOnly(raw, ["abstain"], path);
    return { kind: "abstain" };
  }
  keysOnly(raw, ["values", "allowed", "forbidden", "reasonCodes"], path);
  const values = strings(raw["values"], `${path}.values`);
  const allowed = strings(raw["allowed"], `${path}.allowed`);
  const forbidden = strings(raw["forbidden"], `${path}.forbidden`);
  const reasonCodes = strings(raw["reasonCodes"], `${path}.reasonCodes`);
  const definition = TAXONOMY[dimension] as ClosedDimensionDefinition;
  if (values.length === 0 || (definition.cardinality === "single" && values.length !== 1)) throw new TypeError(`corpus_invalid:${path}.values`);
  for (const value of [...values, ...allowed, ...forbidden]) if (!isTaxonomyValue(dimension, value)) throw new TypeError(`corpus_unknown_value:${path}:${value}`);
  for (const code of reasonCodes) if (!isReasonCode(dimension, code)) throw new TypeError(`corpus_unknown_reason:${path}:${code}`);
  if (values.some((value) => forbidden.includes(value) || allowed.includes(value)) || allowed.some((value) => forbidden.includes(value))) throw new TypeError(`corpus_overlap:${path}`);
  return { kind: "values", values, allowed, forbidden, reasonCodes };
}

/** The analyzed text of a case: literal, or a deterministic repetition (bound cases). */
function textOf(input: Record<string, unknown>, path: string): string {
  if (typeof input["text"] === "string") return input["text"];
  const repeat = input["textRepeat"];
  if (isRecord(repeat) && typeof repeat["unit"] === "string" && Number.isInteger(repeat["count"]) && (repeat["count"] as number) > 0 && (repeat["count"] as number) <= 5_000) return repeat["unit"].repeat(repeat["count"] as number);
  throw new TypeError(`corpus_invalid:${path}.text`);
}

export function parseEvalCorpus(value: unknown): EvalCorpus {
  if (!isRecord(value) || value["corpusVersion"] !== CORPUS_VERSION || value["synthetic"] !== true || value["taxonomyVersion"] !== TAXONOMY_VERSION || value["inputContractVersion"] !== UNDERSTANDING_INPUT_CONTRACT_VERSION || !Array.isArray(value["cases"])) {
    throw new TypeError("corpus_invalid:$");
  }
  const ids = new Set<string>();
  const cases = value["cases"].map((raw: unknown, index): EvalCase => {
    const path = `cases[${String(index)}]`;
    if (!isRecord(raw)) throw new TypeError(`corpus_invalid:${path}`);
    keysOnly(raw, ["id", "category", "locale", "language", "input", "expected", "expectedProtection", "expectedNeedsReview", "expectedFailure", "tags", "weight", "goldConfidence", "notes"], path);
    const id = raw["id"];
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(id) || ids.has(id)) throw new TypeError(`corpus_invalid:${path}.id`);
    ids.add(id);
    const language = raw["language"];
    if (!isRecord(language)) throw new TypeError(`corpus_invalid:${path}.language`);
    const input = raw["input"];
    const expected = raw["expected"];
    if (!isRecord(input) || !isRecord(expected)) throw new TypeError(`corpus_invalid:${path}`);
    const dims: Partial<Record<ClosedDimension, DimensionExpectation>> = {};
    for (const [dimension, spec] of Object.entries(expected)) dims[oneOf(CLOSED_DIMENSIONS, dimension, `${path}.expected`)] = parseDimension(dimension as ClosedDimension, spec, `${path}.expected.${dimension}`);
    const needsReview = raw["expectedNeedsReview"];
    if (needsReview !== null && typeof needsReview !== "boolean") throw new TypeError(`corpus_invalid:${path}.expectedNeedsReview`);
    const weight = raw["weight"];
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1) throw new TypeError(`corpus_invalid:${path}.weight`);
    const tags = strings(raw["tags"], `${path}.tags`).map((tag) => oneOf(CASE_TAGS, tag, `${path}.tags`));
    const failure = raw["expectedFailure"] === null ? null : oneOf(UNDERSTANDING_FAILURE_CLASSES, raw["expectedFailure"], `${path}.expectedFailure`);
    if (failure === null && Object.keys(dims).length === 0) throw new TypeError(`corpus_invalid:${path}.expected`);
    return Object.freeze({
      id,
      category: oneOf(CATEGORIES, raw["category"], `${path}.category`),
      locale: String(raw["locale"]),
      language: Object.freeze({ group: oneOf(LANGUAGE_GROUPS, language["group"], `${path}.language.group`), tags: strings(language["tags"], `${path}.language.tags`), certainty: oneOf(["certain", "uncertain"] as const, language["certainty"], `${path}.language.certainty`) }),
      input: Object.freeze({ ...input }),
      text: textOf(input, path),
      expected: Object.freeze(dims),
      expectedProtection: oneOf(PROTECTION_EXPECTATIONS, raw["expectedProtection"], `${path}.expectedProtection`),
      expectedNeedsReview: needsReview,
      expectedFailure: failure,
      tags: Object.freeze(tags),
      weight,
      goldConfidence: oneOf(["high", "medium"] as const, raw["goldConfidence"], `${path}.goldConfidence`),
    });
  });
  return Object.freeze({ corpusId: String(value["corpusId"]), corpusVersion: CORPUS_VERSION, cases: Object.freeze(cases) });
}
