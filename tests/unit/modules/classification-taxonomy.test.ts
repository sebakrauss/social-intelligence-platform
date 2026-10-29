/** Step H7-A1 — taxonomy v1: the approved A–H dimensions, the one addition (hate_speech), kept distinctions, protection. */
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_CATEGORY_VALUES,
  CLASSIFICATION_DOMAIN_VERSIONS,
  DIMENSIONS,
  INTENT_VALUES,
  PROTECTED_INTENTS,
  PROTECTED_MEANINGS,
  REVIEW_SAFETY_VALUES,
  SAFETY_VALUES,
  TAXONOMY,
  TAXONOMY_VERSION,
  isAutomationCategory,
  isTaxonomyValue,
  protectedMeaningOf,
} from "@/modules/classification";

/** Model §14 dimension A / PD §12.2, before H7 (the approved starting set). */
const APPROVED_SAFETY = ["none", "obvious_spam", "malicious_link", "scam_fraud_content", "impersonation", "abuse_insult", "harassment", "threat"];

describe("taxonomy v1 — dimensions and values", () => {
  it("implements exactly the approved A–H dimensions with their cardinality", () => {
    expect(DIMENSIONS).toEqual(["safety", "authenticity", "intent", "sentiment", "topics", "risk", "response_need", "language"]);
    expect(Object.fromEntries(DIMENSIONS.map((d) => [d, TAXONOMY[d].cardinality]))).toEqual({
      safety: "multi", authenticity: "single", intent: "multi", sentiment: "single", topics: "multi", risk: "single", response_need: "single", language: "multi",
    });
    expect(TAXONOMY.topics.valueSource).toBe("topic_catalog");
    expect(TAXONOMY.language.valueSource).toBe("language_tag");
    expect(TAXONOMY_VERSION).toBe("taxonomy.v1");
  });

  it("adds exactly one safety value to the approved set: hate_speech (D-H7-2), never automation-eligible", () => {
    expect(SAFETY_VALUES.filter((v) => !APPROVED_SAFETY.includes(v))).toEqual(["hate_speech"]);
    expect(APPROVED_SAFETY.every((v) => (SAFETY_VALUES as readonly string[]).includes(v))).toBe(true);
    expect(isAutomationCategory("safety", "hate_speech")).toBe(false);
    expect(REVIEW_SAFETY_VALUES).toContain("hate_speech");
  });

  it("keeps insult, harassment, hate speech and threat as four distinct safety values; profanity is not a safety value", () => {
    for (const value of ["abuse_insult", "harassment", "hate_speech", "threat"]) expect(isTaxonomyValue("safety", value)).toBe(true);
    for (const value of ["profanity", "toxicity", "toxic", "negative", "vulgar"]) expect(isTaxonomyValue("safety", value)).toBe(false);
    expect(isTaxonomyValue("sentiment", "negative")).toBe(true);
  });

  it("scam CONTENT (safety) and fraud ACCUSATION against the brand (intent) are separate meanings in separate dimensions (D-39)", () => {
    expect(isTaxonomyValue("safety", "scam_fraud_content")).toBe(true);
    expect(isTaxonomyValue("intent", "scam_fraud_content")).toBe(false);
    expect(isTaxonomyValue("intent", "fraud_accusation_against_brand")).toBe(true);
    expect(isTaxonomyValue("safety", "fraud_accusation_against_brand")).toBe(false);
  });

  it("price is a topic + an intent: no expensive_price mega-category anywhere", () => {
    expect(isTaxonomyValue("intent", "purchase_question")).toBe(true);
    expect(isTaxonomyValue("intent", "price_objection")).toBe(true);
    const everyKey = DIMENSIONS.flatMap((d) => ("values" in TAXONOMY[d] ? [...(TAXONOMY[d] as { values: readonly string[] }).values] : []));
    expect(everyKey.filter((key) => /expensive|caro|price_complaint/.test(key))).toEqual([]);
  });

  it("valuable / priority is not a taxonomy value", () => {
    const everyKey = DIMENSIONS.flatMap((d) => ("values" in TAXONOMY[d] ? [...(TAXONOMY[d] as { values: readonly string[] }).values] : []));
    expect(everyKey.filter((key) => /valuable|priority|lead|score/.test(key))).toEqual([]);
  });
});

describe("taxonomy v1 — protected meanings and review routing", () => {
  it("protected meanings are exactly PD D-35 and are carried by intent values only", () => {
    expect(PROTECTED_MEANINGS).toEqual(["legitimate_complaint", "product_service_problem", "fraud_accusation_against_brand", "commercial_objection"]);
    expect(PROTECTED_INTENTS).toEqual({
      complaint: "legitimate_complaint",
      product_service_problem: "product_service_problem",
      fraud_accusation_against_brand: "fraud_accusation_against_brand",
      price_objection: "commercial_objection",
      other_commercial_objection: "commercial_objection",
    });
    for (const intent of INTENT_VALUES) {
      const meaning = protectedMeaningOf(intent);
      if (meaning !== undefined) expect(PROTECTED_MEANINGS).toContain(meaning);
    }
    expect(protectedMeaningOf("purchase_question")).toBeUndefined();
    expect(protectedMeaningOf("abuse_insult")).toBeUndefined();
  });

  it("the only automation categories are obvious spam, malicious link and obvious bot (PD D-12/D-42); abuse never", () => {
    expect(AUTOMATION_CATEGORY_VALUES.map((e) => `${e.dimension}.${e.value}`)).toEqual(["safety.obvious_spam", "safety.malicious_link", "authenticity.obvious_bot"]);
    for (const value of REVIEW_SAFETY_VALUES) expect(isAutomationCategory("safety", value)).toBe(false);
    expect(REVIEW_SAFETY_VALUES).toEqual(["scam_fraud_content", "impersonation", "abuse_insult", "harassment", "hate_speech", "threat"]);
  });
});

describe("independent versions", () => {
  it("every pure policy and contract exposes its own stable version", () => {
    expect(CLASSIFICATION_DOMAIN_VERSIONS).toEqual({
      taxonomy: "taxonomy.v1",
      confidence: "confidence.v1",
      languagePolicy: "language-policy.v1",
      precedence: "precedence.m05.v1",
      protection: "protection.v1",
      needsReview: "needs-review.v1",
      signals: "signals.v1",
      watchTermMatcher: "watch-term-matcher.v1",
      understandingInput: "understanding-input.v1",
      understandingOutput: "understanding-output.v1",
      valueInputs: "value-inputs.v1",
    });
    expect(new Set(Object.values(CLASSIFICATION_DOMAIN_VERSIONS)).size).toBe(Object.keys(CLASSIFICATION_DOMAIN_VERSIONS).length);
  });
});
