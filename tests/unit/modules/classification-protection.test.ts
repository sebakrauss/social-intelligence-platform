/** Step H7-A1 — Protection Evaluation, Needs review and value inputs over the synthetic corpus (pure derivations). */
import { describe, expect, it } from "vitest";
import {
  acceptInterpretation,
  deriveNeedsReview,
  deriveValueInputs,
  evaluateProtection,
  type AcceptedInterpretation,
  type LanguageSupport,
} from "@/modules/classification";
import { CORPUS, TARGET, assessment, corpusItem, type CorpusItem } from "../../support/classification-corpus";

const HUMAN = { kind: "human" as const, actor: { kind: "workspace_member" as const, ref: "member-1" } };

function accepted(item: CorpusItem, level: "low" | "medium" | "high" = "high") {
  const intent = item.expected.intent === undefined
    ? acceptInterpretation("intent", [assessment({ dimension: "intent", abstain: "insufficient_evidence" })], TARGET)
    : acceptInterpretation("intent", [assessment({ dimension: "intent", values: item.expected.intent, level })], TARGET);
  const safety = item.expected.safety === undefined ? acceptInterpretation("safety", [], TARGET) : acceptInterpretation("safety", [assessment({ dimension: "safety", values: item.expected.safety, level })], TARGET);
  const sentiment = item.expected.sentiment === undefined ? acceptInterpretation("sentiment", [], TARGET) : acceptInterpretation("sentiment", [assessment({ dimension: "sentiment", values: [item.expected.sentiment], level })], TARGET);
  const topics = item.expected.topics === undefined ? acceptInterpretation("topics", [], TARGET) : acceptInterpretation("topics", [assessment({ dimension: "topics", values: item.expected.topics, level })], TARGET);
  return { intent, safety, sentiment, topics };
}

const protectionOf = (intent: AcceptedInterpretation, language: LanguageSupport = "validated", understandingFailed = false) => evaluateProtection({ intent, language, understandingFailed });

describe("protection over the corpus", () => {
  it.each(CORPUS.map((item) => [item.id, item] as const))("%s → its annotated protection", (_id, item) => {
    expect(protectionOf(accepted(item).intent).result).toBe(item.expected.protection);
  });
});

describe("price semantics (frozen, H7-A0 §4.2) — es / pt-BR / en", () => {
  it.each(["es_price_inquiry", "pt_price_inquiry", "en_price_inquiry"])("%s: topic price + purchase_question → not protected", (id) => {
    const a = accepted(corpusItem(id));
    expect(a.topics).toMatchObject({ status: "accepted", values: [{ key: "price" }] });
    expect(a.intent).toMatchObject({ status: "accepted", values: [{ key: "purchase_question" }] });
    expect(protectionOf(a.intent)).toMatchObject({ result: "not_protected", meanings: [] });
  });

  it.each(["es_price_objection", "es_price_excessive", "pt_price_objection", "en_price_objection"])("%s: topic price + price_objection + negative → PROTECTED (commercial objection)", (id) => {
    const a = accepted(corpusItem(id));
    expect(a.topics).toMatchObject({ values: [{ key: "price" }] });
    expect(a.intent).toMatchObject({ values: [{ key: "price_objection" }] });
    expect(a.sentiment).toMatchObject({ values: [{ key: "negative" }] });
    expect(protectionOf(a.intent)).toMatchObject({ result: "protected", meanings: ["commercial_objection"] });
  });
});

describe("fraud distinction (D-39)", () => {
  it("'this website contains a scam link' → scam/fraud CONTENT (safety), not protected; 'your company scammed me' → accusation, PROTECTED", () => {
    const content = accepted(corpusItem("en_scam_content"));
    expect(content.safety).toMatchObject({ values: [{ key: "scam_fraud_content" }, { key: "obvious_spam" }] });
    expect(protectionOf(content.intent).result).toBe("not_protected");
    const accusation = accepted(corpusItem("en_fraud_accusation"));
    expect(accusation.safety).toMatchObject({ values: [{ key: "none" }] });
    expect(protectionOf(accusation.intent)).toMatchObject({ result: "protected", meanings: ["fraud_accusation_against_brand"] });
  });

  it("Spanish accusation with a complaint keeps both protected meanings", () => {
    expect(protectionOf(accepted(corpusItem("es_fraud_accusation")).intent).meanings).toEqual(["fraud_accusation_against_brand", "legitimate_complaint"]);
  });
});

describe("protection invariants", () => {
  it("a comment can be abusive AND protected: safety labels never erase protection (D-34)", () => {
    const a = accepted(corpusItem("es_abusive_complaint"));
    expect(a.safety).toMatchObject({ values: [{ key: "abuse_insult" }] });
    expect(protectionOf(a.intent)).toMatchObject({ result: "protected", meanings: ["legitimate_complaint", "product_service_problem"] });
    expect(deriveNeedsReview({ protection: protectionOf(a.intent), accepted: [a.intent, a.safety] })).toMatchObject({ needsReview: true, reasons: ["review_safety_label"], reviewSafetyValues: ["abuse_insult"] });
  });

  it("profanity inside a complaint: the complaint stays protected and there is no safety label", () => {
    const a = accepted(corpusItem("es_profane_complaint"));
    expect(a.safety).toMatchObject({ values: [{ key: "none" }] });
    expect(protectionOf(a.intent).result).toBe("protected");
  });

  it("uncertain when intent is missing, abstained, conflicting, failed or below high", () => {
    expect(protectionOf(acceptInterpretation("intent", [], TARGET))).toMatchObject({ result: "uncertain", reasons: ["intent_missing"] });
    expect(protectionOf(accepted(corpusItem("ambiguous_ok")).intent)).toMatchObject({ result: "uncertain", reasons: ["intent_abstained"] });
    expect(protectionOf(accepted(corpusItem("es_price_inquiry")).intent, "validated", true)).toMatchObject({ result: "uncertain", reasons: ["understanding_failed"] });
    expect(protectionOf(accepted(corpusItem("es_price_inquiry"), "medium").intent)).toMatchObject({ result: "uncertain", reasons: ["intent_below_high"] });
    expect(protectionOf(accepted(corpusItem("es_price_objection"), "medium").intent)).toMatchObject({ result: "uncertain", reasons: ["protected_meaning_below_high"], candidateMeanings: ["commercial_objection"] });
  });

  it("a mixed protected + unprotected intent is protected (complaint inside praise)", () => {
    expect(protectionOf(accepted(corpusItem("mixed_en_es_complaint")).intent)).toMatchObject({ result: "protected", meanings: ["legitimate_complaint"] });
  });

  it("D-H7-5: unsupported or uncertain language can't be confidently excluded → UNCERTAIN → Needs review", () => {
    const objection = accepted(corpusItem("en_price_objection")).intent;
    const inquiry = accepted(corpusItem("en_price_inquiry")).intent;
    for (const language of ["unsupported", "uncertain", "unknown"] as const) {
      const p1 = protectionOf(objection, language);
      const p2 = protectionOf(inquiry, language);
      expect(p1).toMatchObject({ result: "uncertain", candidateMeanings: ["commercial_objection"] });
      expect(p1.reasons).toContain("language_not_validated");
      expect(p2.result).toBe("uncertain");
      expect(deriveNeedsReview({ protection: p2, accepted: [inquiry] }).reasons).toContain("protection_uncertain");
    }
    expect(protectionOf(inquiry, "validated_mixed").result).toBe("not_protected");
  });

  it("a human-accepted intent is authoritative even for an unsupported language", () => {
    const human = acceptInterpretation("intent", [assessment({ dimension: "intent", values: ["praise"], method: HUMAN })], TARGET);
    expect(protectionOf(human, "unsupported").result).toBe("not_protected");
  });

  it("protection reads intent only — a sentiment interpretation is refused by type and at runtime", () => {
    const sentiment = accepted(corpusItem("en_price_objection")).sentiment;
    expect(() => evaluateProtection({ intent: sentiment, language: "validated", understandingFailed: false })).toThrow("protection_requires_intent");
  });

  it("records its policy and precedence versions and the supporting assessments", () => {
    const p = protectionOf(accepted(corpusItem("en_fraud_accusation")).intent);
    expect(p).toMatchObject({ policyVersion: "protection.v1", precedenceVersion: "precedence.m05.v1" });
    expect(p.supporting).toHaveLength(1);
  });
});

describe("needs review", () => {
  it.each(["en_personal_insult", "en_harassment", "es_hate_speech", "en_threat", "en_scam_content"])("%s: a review-only safety label routes to review", (id) => {
    const a = accepted(corpusItem(id));
    const review = deriveNeedsReview({ protection: protectionOf(a.intent), accepted: [a.intent, a.safety, a.sentiment] });
    expect(review).toMatchObject({ needsReview: true, reasons: ["review_safety_label"], policyVersion: "needs-review.v1" });
  });

  it("low confidence routes to review; medium alone does not; a plain price inquiry does not", () => {
    const low = accepted(corpusItem("es_price_inquiry"), "low");
    expect(deriveNeedsReview({ protection: protectionOf(low.intent), accepted: [low.intent, low.safety] }).reasons).toEqual(["protection_uncertain", "low_confidence"]);
    const sentimentMedium = acceptInterpretation("sentiment", [assessment({ dimension: "sentiment", values: ["neutral"], level: "medium" })], TARGET);
    const clean = accepted(corpusItem("es_price_inquiry"));
    expect(deriveNeedsReview({ protection: protectionOf(clean.intent), accepted: [clean.intent, clean.safety, sentimentMedium] })).toMatchObject({ needsReview: false, reasons: [] });
  });

  it("a conflicting interpretation routes to review", () => {
    const rule = assessment({ dimension: "safety", values: ["malicious_link"], method: { kind: "rule", rule: "link_reputation_malicious", ruleVersion: "v1" } });
    const conflict = acceptInterpretation("safety", [assessment({ dimension: "safety", values: ["none"] }), rule], TARGET);
    const clean = accepted(corpusItem("en_price_inquiry"));
    expect(deriveNeedsReview({ protection: protectionOf(clean.intent), accepted: [clean.intent, conflict] }).reasons).toEqual(["interpretation_conflict"]);
  });
});

describe("valuable-comment inputs (no score, no watch terms)", () => {
  it("projects purchase intent, response need, risk and protection without weighting", () => {
    const a = accepted(corpusItem("es_price_inquiry"));
    const responseNeed = acceptInterpretation("response_need", [assessment({ dimension: "response_need", values: ["response_required"] })], TARGET);
    const risk = acceptInterpretation("risk", [assessment({ dimension: "risk", values: ["low"] })], TARGET);
    const inputs = deriveValueInputs({ intent: a.intent, responseNeed, risk, protection: protectionOf(a.intent), context: { source: "paid", activeAd: true, providerCreatedAt: null } });
    expect(inputs).toEqual({
      purchaseQuestion: { present: true, confidence: "high" },
      productOrServiceQuestion: { present: false, confidence: null },
      responseNeed: "response_required",
      escalationRequired: false,
      riskLevel: "low",
      protection: "not_protected",
      protectedMeanings: [],
      source: "paid",
      activeAd: true,
      providerCreatedAt: null,
      inputsVersion: "value-inputs.v1",
    });
    expect(Object.keys(inputs).filter((key) => /score|weight|priority|watch|author|follower|influence|sentiment/i.test(key))).toEqual([]);
  });

  it("missing interpretations stay absent (null / not present), never defaulted", () => {
    const none = acceptInterpretation("intent", [], TARGET);
    const inputs = deriveValueInputs({ intent: none, responseNeed: acceptInterpretation("response_need", [], TARGET), risk: acceptInterpretation("risk", [], TARGET), protection: protectionOf(none), context: { source: "unknown", activeAd: null, providerCreatedAt: null } });
    expect(inputs).toMatchObject({ purchaseQuestion: { present: false, confidence: null }, responseNeed: null, riskLevel: null, protection: "uncertain" });
  });
});
