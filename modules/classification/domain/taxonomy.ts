/**
 * Classification taxonomy v1 (Step H7-A1; Model §14, §17.1; PD §12.2–§12.4, D-35, D-39; H7-A0 §4, D-H7-2). Pure.
 *
 * Classification is a set of independent DIMENSIONS (A–H), never one label or score. Each dimension has stable,
 * language-independent machine keys; display labels and definitions live in i18n catalogs, never here.
 *
 *   A safety         multi    harmful content that may warrant moderation   (never sentiment, S1)
 *   B authenticity   single   is the author likely real
 *   C intent         multi    what the person is trying to do               (protection reads it)
 *   D sentiment      single   polarity                                      (never feeds moderation/automation)
 *   E topics         multi    what it is about — values owned by the `topics` module's catalog (M-10 OPEN)
 *   F risk           single   level, with closed reason codes
 *   G response_need  single
 *   H language       multi    BCP-47 tags (see language.ts), mixed allowed
 *
 * Kept distinct on purpose (never one "toxicity" field): negative sentiment (D) · personal insult, harassment, hate
 * speech, threat (A, four values) · spam, malicious link, scam/fraud CONTENT (A) · fraud ACCUSATION against the brand,
 * complaint, commercial objection (C). Profanity / vulgar register is NOT a safety value (a narrow signal is a later
 * decision, H7-A0 §4.3): a profane complaint is a protected complaint.
 *
 * Price (frozen, H7-A0 §4.2): a price inquiry is topic `price` + intent `purchase_question`; "muy caro" is topic `price`
 * + intent `price_objection` (+ negative sentiment) and is PROTECTED. There is no `expensive_price` category.
 *
 * The single addition to the PD/Model starting set is `safety.hate_speech` (D-H7-2; non-duplication proven in H7-A0
 * §4.3): an attack on a person or group based on a protected characteristic. The final value lists stay open (PD D-21):
 * a change is a new TAXONOMY_VERSION; treatment of history is PD OQ-11.
 */

export const TAXONOMY_VERSION = "taxonomy.v1" as const;
export type TaxonomyVersion = typeof TAXONOMY_VERSION;

export const DIMENSIONS = ["safety", "authenticity", "intent", "sentiment", "topics", "risk", "response_need", "language"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const SAFETY_VALUES = [
  "none",
  "obvious_spam",
  "malicious_link",
  "scam_fraud_content",
  "impersonation",
  "abuse_insult",
  "harassment",
  "hate_speech",
  "threat",
] as const;
export const AUTHENTICITY_VALUES = ["likely_human", "bot_like", "obvious_bot", "unknown"] as const;
export const INTENT_VALUES = [
  "purchase_question",
  "product_question",
  "service_question",
  "complaint",
  "product_service_problem",
  "fraud_accusation_against_brand",
  "price_objection",
  "other_commercial_objection",
  "praise",
  "advocacy",
  "suggestion",
  "neutral_conversation",
] as const;
export const SENTIMENT_VALUES = ["positive", "neutral", "negative", "mixed"] as const;
export const RISK_VALUES = ["low", "medium", "high", "critical"] as const;
export const RESPONSE_NEED_VALUES = ["no_response_needed", "response_recommended", "response_required", "escalation_required"] as const;

export type SafetyValue = (typeof SAFETY_VALUES)[number];
export type AuthenticityValue = (typeof AUTHENTICITY_VALUES)[number];
export type IntentValue = (typeof INTENT_VALUES)[number];
export type SentimentValue = (typeof SENTIMENT_VALUES)[number];
export type RiskValue = (typeof RISK_VALUES)[number];
export type ResponseNeedValue = (typeof RESPONSE_NEED_VALUES)[number];

/** Dimensions whose values are a closed list owned by this taxonomy. */
export const CLOSED_DIMENSIONS = ["safety", "authenticity", "intent", "sentiment", "risk", "response_need"] as const;
export type ClosedDimension = (typeof CLOSED_DIMENSIONS)[number];

export type Cardinality = "single" | "multi";

export interface ClosedDimensionDefinition {
  readonly key: ClosedDimension;
  readonly valueSource: "closed";
  readonly cardinality: Cardinality;
  readonly values: readonly string[];
  /** Values that can't be combined with any other value of the dimension (multi-valued only). */
  readonly exclusive: readonly string[];
  /** Closed reason codes an assessment of this dimension may carry (explanations; localized by i18n). */
  readonly reasonCodes: readonly string[];
}

export interface ExternalDimensionDefinition {
  readonly key: "topics" | "language";
  /** topics: keys from the workspace topic catalog (owned by `topics`); language: BCP-47 tags (language.ts). */
  readonly valueSource: "topic_catalog" | "language_tag";
  readonly cardinality: Cardinality;
}

export type DimensionDefinition = ClosedDimensionDefinition | ExternalDimensionDefinition;

const closed = (key: ClosedDimension, cardinality: Cardinality, values: readonly string[], extra: Partial<Pick<ClosedDimensionDefinition, "exclusive" | "reasonCodes">> = {}): ClosedDimensionDefinition =>
  Object.freeze({ key, valueSource: "closed" as const, cardinality, values, exclusive: Object.freeze(extra.exclusive ?? []), reasonCodes: Object.freeze(extra.reasonCodes ?? []) });

export const TAXONOMY: Readonly<Record<Dimension, DimensionDefinition>> = Object.freeze({
  safety: closed("safety", "multi", SAFETY_VALUES, { exclusive: ["none"] }),
  authenticity: closed("authenticity", "single", AUTHENTICITY_VALUES),
  intent: closed("intent", "multi", INTENT_VALUES),
  sentiment: closed("sentiment", "single", SENTIMENT_VALUES),
  topics: Object.freeze({ key: "topics" as const, valueSource: "topic_catalog" as const, cardinality: "multi" as const }),
  // Reason codes are only those the approved taxonomy names (PD §12.3 "Reputation risk", "Threat / severe risk").
  risk: closed("risk", "single", RISK_VALUES, { reasonCodes: ["reputation_risk", "severe_safety_risk"] }),
  response_need: closed("response_need", "single", RESPONSE_NEED_VALUES),
  language: Object.freeze({ key: "language" as const, valueSource: "language_tag" as const, cardinality: "multi" as const }),
});

/**
 * Protected meanings (PD D-35, C-02; Model §17.1) — fixed, never configurable. The meaning is carried by INTENT values:
 * a keyword, a safety label or a sentiment never establishes or removes one.
 */
export const PROTECTED_MEANINGS = ["legitimate_complaint", "product_service_problem", "fraud_accusation_against_brand", "commercial_objection"] as const;
export type ProtectedMeaning = (typeof PROTECTED_MEANINGS)[number];

export const PROTECTED_INTENTS: Readonly<Partial<Record<IntentValue, ProtectedMeaning>>> = Object.freeze({
  complaint: "legitimate_complaint",
  product_service_problem: "product_service_problem",
  fraud_accusation_against_brand: "fraud_accusation_against_brand",
  price_objection: "commercial_objection",
  other_commercial_objection: "commercial_objection",
});

/**
 * Safety values that always route to human review (PD §12.3: abuse/insult C-01/D-34; harassment, threat,
 * impersonation; scam/fraud content that is not also spam/bot/link; hate speech D-H7-2). None of them is ever an
 * automation category.
 */
export const REVIEW_SAFETY_VALUES: readonly SafetyValue[] = Object.freeze(["scam_fraud_content", "impersonation", "abuse_insult", "harassment", "hate_speech", "threat"]);

/**
 * The only taxonomy values an (opt-in, hide-only) automation policy may ever target (PD D-12, D-42; the fourth policy
 * type, configured patterns, is not a taxonomy value). Informational for later steps: H7 has no automation.
 */
export const AUTOMATION_CATEGORY_VALUES: readonly { readonly dimension: ClosedDimension; readonly value: string }[] = Object.freeze([
  Object.freeze({ dimension: "safety" as const, value: "obvious_spam" }),
  Object.freeze({ dimension: "safety" as const, value: "malicious_link" }),
  Object.freeze({ dimension: "authenticity" as const, value: "obvious_bot" }),
]);

export const isDimension = (value: unknown): value is Dimension => typeof value === "string" && (DIMENSIONS as readonly string[]).includes(value);
export const isClosedDimension = (value: unknown): value is ClosedDimension => typeof value === "string" && (CLOSED_DIMENSIONS as readonly string[]).includes(value);

/** Whether `value` is a key of the closed dimension `dimension` in this taxonomy version. */
export function isTaxonomyValue(dimension: ClosedDimension, value: unknown): boolean {
  const definition = TAXONOMY[dimension] as ClosedDimensionDefinition;
  return typeof value === "string" && definition.values.includes(value);
}

export function isReasonCode(dimension: ClosedDimension, code: unknown): boolean {
  const definition = TAXONOMY[dimension] as ClosedDimensionDefinition;
  return typeof code === "string" && definition.reasonCodes.includes(code);
}

export const protectedMeaningOf = (intent: string): ProtectedMeaning | undefined => PROTECTED_INTENTS[intent as IntentValue];

export const isAutomationCategory = (dimension: Dimension, value: string): boolean =>
  AUTOMATION_CATEGORY_VALUES.some((entry) => entry.dimension === dimension && entry.value === value);
