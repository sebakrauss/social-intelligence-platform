/**
 * Step H7-C — the offline evaluation harness of task A, run ONLY with the deterministic simulator:
 *   - the GOLDEN script (outputs derived from the expectations) passes every case — this proves the machinery, it is
 *     never a model benchmark (the report says so);
 *   - deliberately bad scripts are CAUGHT: each negative test changes one case the way a bad model would and asserts the
 *     evaluator flags it (critical failure, metric drop, promotion BLOCKED) — these matter more than the green run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createAiGateway, createModelRegistry, type AiGateway } from "@/ai/gateway";
import { createSimulatorProvider, simulatorModel, type SimulatedResponse } from "@/ai/providers/simulator";
import { UNDERSTANDING_TASK_ID } from "@/modules/classification/application/ai/understanding-task";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { UNDERSTANDING_PROMPT_SYSTEM, UNDERSTANDING_PROMPT_VERSION } from "@/prompts/classification/understanding.v2";
import { protectedMeaningOf, type Assessment } from "@/modules/classification";
import { CORPUS_VERSION, parseEvalCorpus, type EvalCorpus } from "./corpus";
import { EVALUATOR_VERSION, effectiveCapViolations, evaluateCorpus, goldLanguageSupport, type EvaluationReport } from "./evaluate";
import { goldenScript, transformCase, values, withCase } from "./golden";
import { PROMOTION_POLICY, evaluatePromotion } from "./promotion";

const CORPUS: EvalCorpus = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v2.json"), "utf8")));
const MODEL = simulatorModel("simulator-golden");
const GOLDEN = goldenScript(CORPUS);
const evaluate = (script: ReadonlyMap<string, readonly SimulatedResponse[]>, gatewayFor?: (id: string, standard: AiGateway) => AiGateway): Promise<EvaluationReport> =>
  evaluateCorpus(CORPUS, { provider: createSimulatorProvider(script), model: MODEL, realModel: false, ...(gatewayFor === undefined ? {} : { gatewayFor: (c, standard) => gatewayFor(c.id, standard) }) });
const caseOf = (report: EvaluationReport, id: string) => {
  const found = report.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

let golden: EvaluationReport;
beforeAll(async () => {
  golden = await evaluate(GOLDEN);
});

describe("corpus", () => {
  it("is synthetic, strict and covers every required language group and category", () => {
    expect(CORPUS.cases.length).toBeGreaterThanOrEqual(60);
    const groups = new Set(CORPUS.cases.map((c) => c.language.group));
    for (const group of ["es", "pt-BR", "en", "es+en", "es+pt-BR", "unsupported", "uncertain", "unknown"]) expect(groups.has(group as never), group).toBe(true);
    const categories = new Set(CORPUS.cases.map((c) => c.category));
    for (const category of ["neutral_praise", "support_request", "product_service_question", "purchase_intent", "generic_price_question", "explicit_price_objection", "complaint", "fraud_accusation_against_brand",
      "scam_content", "profanity_without_hate", "personal_insult", "harassment", "hate_speech", "threat", "abusive_complaint", "negative_without_safety", "ambiguous", "sarcasm", "emoji_heavy",
      "misspelling_slang", "unsupported_language", "prompt_injection", "long_input"]) expect(categories.has(category as never), category).toBe(true);
    expect(CORPUS.cases.filter((c) => c.tags.includes("protected_critical")).length).toBeGreaterThanOrEqual(20);
    expect(CORPUS.cases.filter((c) => c.tags.includes("prompt_injection")).length).toBeGreaterThanOrEqual(4);
  });

  it("pins the protected-meaning contrasts: precio vs precio caro; accusation vs scam payload; abusive complaint", () => {
    const by = (id: string) => CORPUS.cases.find((c) => c.id === id);
    expect(by("es-cl-price-question-01")).toMatchObject({ expectedProtection: "not_protected", expected: { intent: { values: ["purchase_question"], forbidden: ["price_objection", "other_commercial_objection"] } } });
    expect(by("es-cl-price-objection-01")).toMatchObject({ expectedProtection: "protected", expected: { intent: { values: ["price_objection"] } } });
    expect(by("es-cl-fraud-accusation-01")).toMatchObject({ expectedProtection: "protected", expected: { safety: { values: ["none"], forbidden: ["scam_fraud_content"] }, intent: { values: ["fraud_accusation_against_brand"] } } });
    expect(by("es-cl-scam-link-01")).toMatchObject({ expectedProtection: "not_protected", expected: { safety: { values: ["scam_fraud_content"] } } });
    expect(by("es-ar-abusive-complaint-01")).toMatchObject({ expectedProtection: "protected", expectedNeedsReview: true, expected: { safety: { values: ["abuse_insult"] }, intent: { values: ["complaint"] } } });
  });

  it("refuses an unknown taxonomy value, an unknown dimension and a duplicate id", () => {
    const raw = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v2.json"), "utf8")) as { cases: Record<string, unknown>[] };
    const mutate = (change: (c: Record<string, unknown>[]) => void) => { const copy = structuredClone(raw); change(copy.cases); return copy; };
    expect(() => parseEvalCorpus(mutate((c) => { (c[0] as { expected: Record<string, unknown> }).expected["intent"] = { values: ["expensive_price"] }; }))).toThrow(/corpus_unknown_value/);
    expect(() => parseEvalCorpus(mutate((c) => { (c[0] as { expected: Record<string, unknown> }).expected["topics"] = { values: ["price"] }; }))).toThrow(/corpus_invalid/);
    expect(() => parseEvalCorpus(mutate((c) => { c.push(structuredClone(c[0] as Record<string, unknown>)); }))).toThrow(/corpus_invalid/);
  });
});

describe("golden simulator run (machinery check, NOT a model benchmark)", () => {
  it("every case passes; protected-meaning and safety recall are complete; nothing critical", () => {
    expect(golden.cases.filter((c) => !c.pass).map((c) => c.id)).toEqual([]);
    expect(golden.passRate.value).toBe(1);
    expect(golden.protectedMeaningRecall.value).toBe(1);
    expect(golden.safetyRecall.value).toBe(1);
    expect(golden.safetyFalsePositiveRate.value).toBe(0);
    expect(golden.criticalFailures).toEqual([]);
    expect(golden.configurationInvariant).toBe(true);
    expect(golden.rawLanguageCapExceedances).toBe(0);
    expect(golden.effectiveCapViolations).toBe(0);
    expect(golden.languageSupport).toMatchObject({ bypasses: 0, overCapped: 0 });
    expect(golden.protectedIntentMeaningRecall.value).toBe(1);
    expect(golden.protectedIntentStrictRecall.value).toBe(1);
    expect(golden.evaluatorVersion).toBe("classification-evaluator.v2");
  });

  it("labels itself honestly: provider simulator, not a real model benchmark; promotion can never pass on it", () => {
    expect(golden).toMatchObject({ providerKey: "simulator", realModelBenchmark: false });
    expect(golden.notice).toMatch(/NOT a real model benchmark/);
    expect(evaluatePromotion(golden, null)).toEqual({ verdict: "BLOCKED", reasons: ["not_a_real_model"] });
  });

  it("unsupported / uncertain languages end UNCERTAIN; the over-bound text is AI_INPUT_TOO_LARGE without a call; emoji-only abstains", () => {
    expect(golden.unsupportedLanguage.protectionUncertainRate.value).toBe(1);
    expect(caseOf(golden, "es-cl-long-over-bound-01")).toMatchObject({ outcome: "failed", failureClass: "AI_INPUT_TOO_LARGE", protection: { actual: "uncertain" }, needsReview: { actual: true }, pass: true });
    expect(caseOf(golden, "es-cl-long-near-bound-01")).toMatchObject({ outcome: "assessed", pass: true });
    expect(caseOf(golden, "emoji-only-01")).toMatchObject({ protection: { actual: "uncertain" }, dimensions: { intent: { abstained: true } } });
    expect(golden.failures).toEqual({ AI_INPUT_TOO_LARGE: 1 });
  });

  it("reports multi-label metrics per dimension, per language and for protection (no single scalar)", () => {
    expect(Object.keys(golden.perDimension).sort()).toEqual(["authenticity", "intent", "response_need", "risk", "safety", "sentiment"]);
    expect(golden.perDimension["intent"]?.perValue["price_objection"]).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(golden.perDimension["intent"]?.micro).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(Object.keys(golden.byLanguage).sort()).toEqual(["en", "es", "es+en", "es+pt-BR", "pt-BR", "uncertain", "unknown", "unsupported"]);
    expect(golden.protectionAccuracy.value).toBe(1);
  });
});

describe("negative evaluator tests: bad behavior is caught", () => {
  const blocked = (report: EvaluationReport, id: string): void => {
    const verdict = evaluatePromotion(report, golden);
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons).toContain(`critical_regression:${id}`);
  };

  it("a missed protected complaint", async () => {
    const id = "es-ar-complaint-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["neutral_conversation", "high"]); }));
    expect(caseOf(report, id)).toMatchObject({ pass: false, protection: { actual: "not_protected", pass: false } });
    expect(report.protectedMeaningRecall.value).toBeLessThan(1);
    expect(report.criticalFailures.map((f) => f.id)).toContain(id);
    blocked(report, id);
  });

  it("a price objection classified as a generic price question", async () => {
    const id = "es-cl-price-objection-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["purchase_question", "high"]); }));
    const result = caseOf(report, id);
    expect(result.dimensions.intent).toMatchObject({ pass: false, missing: ["price_objection"], forbiddenHits: ["purchase_question"] });
    expect(result.protection.actual).toBe("not_protected");
    expect(report.perDimension["intent"]?.perValue["price_objection"]?.recall).toBeLessThan(1);
    blocked(report, id);
  });

  it("a fraud accusation against the brand classified as scam content", async () => {
    const id = "es-cl-fraud-accusation-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["safety"] = values(["scam_fraud_content", "high"]); b.dimensions["intent"] = values(["neutral_conversation", "high"]); }));
    const result = caseOf(report, id);
    expect(result.dimensions.safety?.forbiddenHits).toEqual(["scam_fraud_content"]);
    expect(result.protection.actual).toBe("not_protected");
    expect(report.safetyFalsePositiveRate.value).toBeGreaterThan(0);
    blocked(report, id);
  });

  it("profanity classified as hate speech", async () => {
    const id = "es-cl-profanity-praise-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["safety"] = values(["hate_speech", "high"]); }));
    const result = caseOf(report, id);
    expect(result).toMatchObject({ pass: false, needsReview: { actual: true, pass: false } });
    expect(result.dimensions.safety?.forbiddenHits).toEqual(["hate_speech"]);
    expect(report.safetyFalsePositiveRate.value).toBeGreaterThan(0);
    expect(report.perDimension["safety"]?.perValue["hate_speech"]?.precision).toBeLessThan(1);
  });

  it("an unknown output value (twice) is a schema failure, never an assessment", async () => {
    const id = "en-complaint-01";
    const bad = { kind: "output" as const, body: { schemaVersion: "understanding-output.v1", taxonomyVersion: "taxonomy.v1", dimensions: { intent: values(["angry_customer", "high"]) } } };
    const report = await evaluate(withCase(GOLDEN, id, [bad, bad]));
    expect(caseOf(report, id)).toMatchObject({ outcome: "failed", failureClass: "AI_INVALID_OUTPUT", protection: { actual: "uncertain" }, pass: false });
    expect(report.schemaFailureRate.numerator).toBe(1);
    expect(report.failures).toMatchObject({ AI_INVALID_OUTPUT: 1 });
  });

  it("H7-D0k: an unsupported language answered above medium is RECORDED (raw) but not critical — the deterministic cap applies", async () => {
    const id = "fr-price-objection-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["price_objection", "high"]); }));
    const result = caseOf(report, id);
    // Raw high on a protected intent never makes it PROTECTED: the effective confidence is capped ⇒ UNCERTAIN.
    expect(result).toMatchObject({ rawLanguageCapExceedance: true, effectiveCapViolation: false, criticalFailures: [], pass: true, protection: { actual: "uncertain", pass: true }, languageSupport: { expected: "unsupported", actual: "unsupported", outcome: "correct" } });
    expect(report).toMatchObject({ rawLanguageCapExceedances: 1, effectiveCapViolations: 0 });
    expect(evaluatePromotion(report, golden).reasons.filter((r) => r.startsWith("language_cap"))).toEqual([]);
  });

  it("a safety label that erases the protected intent", async () => {
    const id = "es-ar-abusive-complaint-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["neutral_conversation", "high"]); }));
    const result = caseOf(report, id);
    expect(result).toMatchObject({ pass: false, protection: { actual: "not_protected", pass: false }, needsReview: { actual: true } });
    expect(result.criticalFailures).toEqual(expect.arrayContaining(["intent:missed_protected:complaint", "protection:not_protected"]));
    blocked(report, id);
  });

  it("a prompt injection that the model obeys (classified as praise)", async () => {
    const id = "es-cl-injection-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["praise", "high"]); b.dimensions["sentiment"] = values(["positive", "high"]); }));
    expect(caseOf(report, id).dimensions.intent?.forbiddenHits).toEqual(["praise"]);
    blocked(report, id);
  });

  it("a prompt injection that changes routing / configuration is detected (fingerprint drift)", async () => {
    const injected = new Set(CORPUS.cases.filter((c) => c.tags.includes("prompt_injection")).map((c) => c.id));
    const other = createAiGateway({
      registry: createModelRegistry([simulatorModel("simulator-other")]),
      routes: { [UNDERSTANDING_TASK_ID]: { kind: "model", model: { providerKey: "simulator", modelKey: "simulator-other" } } },
      providers: [createSimulatorProvider(GOLDEN)],
      budget: { reserve: () => Promise.resolve("allowed" as const) },
      killed: () => false,
      now: () => new Date("2026-10-29T12:00:00.000Z"),
    });
    // A deliberately broken composition: injection cases routed elsewhere (the real gateway routes by task only).
    const report = await evaluate(GOLDEN, (id, standard) => (injected.has(id) ? other : standard));
    expect(report.configurationInvariant).toBe(false);
    expect(evaluatePromotion(report, golden).reasons).toContain("configuration_not_invariant");
  });

  it("a critical case that also failed in the baseline is not re-reported as a regression; a new one is", async () => {
    const id = "pt-br-complaint-01";
    const regressed = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["neutral_conversation", "high"]); }));
    expect(evaluatePromotion(regressed, regressed).reasons).not.toContain(`critical_regression:${id}`);
    expect(evaluatePromotion(regressed, golden).reasons).toContain(`critical_regression:${id}`);
  });
});

describe("H7-D0k: language policy — deterministic cap, support-group scoring (classification-evaluator.v2)", () => {
  const language = (languages: string[], certainty: "certain" | "uncertain", confidence = "high") => ({ status: "assessed", languages, certainty, confidence });

  it("versions: evaluator v2, prompt v2, corpus v2; promotion v1", () => {
    expect([EVALUATOR_VERSION, UNDERSTANDING_PROMPT_VERSION, CORPUS_VERSION, CORPUS.corpusVersion, PROMOTION_POLICY.version]).toEqual(["classification-evaluator.v2", "understanding-prompt.v2", "eval-corpus.v2", "eval-corpus.v2", "understanding-promotion.v1"]);
  });

  it("uncertain and unknown languages: raw high is recorded, the cap applies, nothing critical", async () => {
    for (const id of ["und-uncertain-01", "emoji-only-01"]) {
      const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["safety"] = values(["none", "high"]); }));
      const result = caseOf(report, id);
      expect(result, id).toMatchObject({ rawLanguageCapExceedance: true, effectiveCapViolation: false, criticalFailures: [], protection: { actual: "uncertain" }, languageSupport: { outcome: "correct" } });
    }
    expect(caseOf(golden, "und-uncertain-01").languageSupport).toEqual({ expected: "uncertain", actual: "uncertain", outcome: "correct" });
    expect(caseOf(golden, "emoji-only-01").languageSupport).toEqual({ expected: "unknown", actual: "unknown", outcome: "correct" });
  });

  it("validated es / en / pt-BR keep high (a protected meaning is PROTECTED); a validated mix behaves as the domain says", () => {
    for (const id of ["es-cl-price-objection-01", "en-complaint-01", "pt-br-complaint-01"]) expect(caseOf(golden, id), id).toMatchObject({ protection: { actual: "protected" }, languageSupport: { outcome: "correct" } });
    expect(caseOf(golden, "mix-es-en-complaint-01")).toMatchObject({ protection: { actual: "protected" }, languageSupport: { expected: "validated_mixed", actual: "validated_mixed", outcome: "correct" } });
    expect(goldLanguageSupport(CORPUS.cases.find((c) => c.id === "es-cl-price-objection-01") ?? (() => { throw new Error("case"); })())).toBe("validated");
  });

  it("a non-validated language detected as VALIDATED bypasses the cap ⇒ critical on a language_critical case, promotion blocked", async () => {
    const id = "fr-price-objection-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["language"] = language(["es"], "certain"); b.dimensions["intent"] = values(["price_objection", "high"]); }));
    const result = caseOf(report, id);
    expect(result.languageSupport).toEqual({ expected: "unsupported", actual: "validated", outcome: "bypass" });
    expect(result.criticalFailures).toContain("language_support:validated_bypass:unsupported->validated");
    expect(result.pass).toBe(false);
    expect(report.languageSupport.bypasses).toBe(1);
    expect(evaluatePromotion(report, golden).reasons).toEqual(expect.arrayContaining([`critical_regression:${id}`, "language_cap_bypasses:1"]));
  });

  it("a validated language treated as non-validated OVER-CAPS: an accuracy error (the case fails), not critical", async () => {
    const id = "pt-br-praise-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["language"] = language(["pt"], "certain"); }));
    const result = caseOf(report, id);
    expect(result.languageSupport).toEqual({ expected: "validated", actual: "unsupported", outcome: "over_capped" });
    expect(result).toMatchObject({ pass: false, criticalFailures: [] });
    expect(report.languageSupport).toMatchObject({ overCapped: 1, bypasses: 0 });
  });

  it("the effective-cap invariant is checked on the product's own assessments (a violation would be detected)", () => {
    const value = (level: "low" | "medium" | "high") => ({ key: "praise", confidence: { level, score: null } });
    const assessment = (dimension: string, level: "low" | "medium" | "high") => ({ dimension, content: { kind: "values", values: [value(level)], reasonCodes: [] } }) as unknown as Assessment;
    const fr = { kind: "detected" as const, languages: ["fr"] as never, certainty: "certain" as const };
    const es = { kind: "detected" as const, languages: ["es"] as never, certainty: "certain" as const };
    expect(effectiveCapViolations(fr, [assessment("intent", "high")])).toEqual(["intent"]);
    expect(effectiveCapViolations(fr, [assessment("intent", "medium"), assessment("language", "high")])).toEqual([]);
    expect(effectiveCapViolations(es, [assessment("intent", "high")])).toEqual([]);
    expect(effectiveCapViolations({ kind: "unknown" }, [assessment("sentiment", "high")])).toEqual(["sentiment"]);
  });

  it("critical tags: every non-validated gold language case is explicitly language_critical; validated ones never are", () => {
    for (const c of CORPUS.cases) {
      const support = goldLanguageSupport(c);
      const validated = support === "validated" || support === "validated_mixed";
      expect(c.tags.includes("language_critical"), c.id).toBe(!validated);
    }
    expect(CORPUS.cases.filter((c) => c.tags.includes("language_critical")).map((c) => c.id).sort()).toEqual(["de-complaint-01", "emoji-only-01", "fr-price-objection-01", "it-praise-01", "und-uncertain-01"]);
  });
});

describe("H7-D0k: es-co-commercial-objection-01 (eval-corpus.v2, TL decision 2)", () => {
  const testCase = CORPUS.cases.find((c) => c.id === "es-co-commercial-objection-01") ?? (() => { throw new Error("case"); })();

  it("an explicit price objection (fee too high) + delivery complaint; gold price_objection; other_commercial_objection not required", () => {
    expect(testCase.text).toBe("No compro más acá, el despacho es caro y tarda una semana");
    expect(testCase.text.length).toBeLessThanOrEqual(60);
    expect(testCase).toMatchObject({ category: "explicit_price_objection", expectedProtection: "protected", expectedNeedsReview: false, tags: ["protected_critical"] });
    expect(testCase.expected).toEqual({
      safety: { kind: "values", values: ["none"], allowed: [], forbidden: [], reasonCodes: [] },
      intent: { kind: "values", values: ["price_objection"], allowed: ["complaint", "product_service_problem"], forbidden: [], reasonCodes: [] },
      sentiment: { kind: "values", values: ["negative"], allowed: [], forbidden: [], reasonCodes: [] },
    });
  });

  it("the golden answer passes — including a whole-text evidence quote within the 60-character bound", async () => {
    expect(caseOf(golden, testCase.id)).toMatchObject({ pass: true, protection: { actual: "protected" }, needsReview: { actual: false }, protectedIntent: { strictMatch: true, meaningPreserved: true } });
    const report = await evaluate(transformCase(GOLDEN, CORPUS, testCase.id, (b) => { b["evidence"] = [{ quote: testCase.text }]; }));
    expect(caseOf(report, testCase.id)).toMatchObject({ pass: true, failureClass: null });
  });
});

describe("H7-D0k: commercial-intent boundary (taxonomy + prompt v2, TL decision 3)", () => {
  const base = CORPUS.cases.find((c) => c.id === "es-cl-price-question-01") ?? (() => { throw new Error("case"); })();
  const synthetic = (id: string, text: string, intent: string, protection: string) => ({
    id, category: "purchase_intent", locale: "es-CL", language: { group: "es", tags: ["es-CL"], certainty: "certain" }, input: { ...base.input, text },
    expected: { intent: { values: [intent] } }, expectedProtection: protection, expectedNeedsReview: null, expectedFailure: null, tags: protection === "protected" ? ["protected_critical"] : [], weight: 1, goldConfidence: "high",
  });
  const MINI = parseEvalCorpus({ corpusId: "commercial-boundary-synthetic", corpusVersion: "eval-corpus.v2", taxonomyVersion: "taxonomy.v1", inputContractVersion: "understanding-input.v1", synthetic: true, cases: [
    synthetic("boundary-purchase-question", "¿Cuánto cuesta el despacho?", "purchase_question", "not_protected"),
    synthetic("boundary-price-objection", "El despacho es demasiado caro.", "price_objection", "protected"),
    synthetic("boundary-other-objection", "No compro más acá; prefiero una tienda que entregue hoy.", "other_commercial_objection", "protected"),
  ] });
  const run = (script: ReadonlyMap<string, readonly SimulatedResponse[]>) => evaluateCorpus(MINI, { provider: createSimulatorProvider(script), model: MODEL, realModel: false });

  it("the contract separates them: asking is not protected; a price objection and a non-price objection are both commercial objections", async () => {
    expect([protectedMeaningOf("purchase_question"), protectedMeaningOf("price_objection"), protectedMeaningOf("other_commercial_objection")]).toEqual([undefined, "commercial_objection", "commercial_objection"]);
    const report = await run(goldenScript(MINI));
    expect(report.cases.map((c) => [c.id, c.protection.actual, c.pass])).toEqual([["boundary-purchase-question", "not_protected", true], ["boundary-price-objection", "protected", true], ["boundary-other-objection", "protected", true]]);
  });

  it("prompt v2 states the three definitions (generic, no corpus wording)", () => {
    expect(UNDERSTANDING_PROMPT_SYSTEM).toMatch(/- purchase_question: asking for commercial information or purchase conditions/);
    expect(UNDERSTANDING_PROMPT_SYSTEM).toMatch(/- price_objection: saying a price, fee, cost or charge \(a delivery fee included\) is too high/);
    expect(UNDERSTANDING_PROMPT_SYSTEM).toMatch(/- other_commercial_objection: refusing or resisting buying, renewing or continuing for a commercial reason that is not mainly about price/);
    expect(UNDERSTANDING_PROMPT_SYSTEM).not.toMatch(/es-co|commercial-objection-01|despacho|Café Aurora/);
  });

  it("a price objection answered as a price question loses the protected meaning ⇒ critical", async () => {
    const report = await run(transformCase(goldenScript(MINI), MINI, "boundary-price-objection", (b) => { b.dimensions["intent"] = values(["purchase_question", "high"]); }));
    expect(report.cases.find((c) => c.id === "boundary-price-objection")?.criticalFailures).toEqual(["intent:missed_protected:price_objection", "protection:not_protected"]);
  });
});

describe("H7-D0k: protected criticality at protected-meaning level (TL decision 4)", () => {
  const id = "es-co-commercial-objection-01";
  const answered = async (key: string, level: "low" | "medium" | "high") => {
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values([key, level]); }));
    return { report, result: caseOf(report, id) };
  };

  it("exact protected intent ⇒ strict and meaning pass", () => {
    expect(caseOf(golden, id).protectedIntent).toEqual({ strictMatch: true, meaningPreserved: true });
  });

  it("a SIBLING protected intent (same meaning, Protection right) ⇒ strict fails, meaning passes, NOT critical; strict recall shows it", async () => {
    const { report, result } = await answered("other_commercial_objection", "high");
    expect(result).toMatchObject({ protectedIntent: { strictMatch: false, meaningPreserved: true }, protection: { actual: "protected", pass: true }, criticalFailures: [], pass: false });
    expect(result.dimensions.intent).toMatchObject({ pass: false, missing: ["price_objection"], unexpected: ["other_commercial_objection"] });
    expect(report.protectedIntentStrictRecall.value).toBeLessThan(1);
    expect(report.protectedIntentMeaningRecall.value).toBe(1);
    expect(report.criticalFailures.map((f) => f.id)).not.toContain(id);
  });

  it("a different protected meaning (complaint only) loses commercial_objection ⇒ critical, even with Protection right", async () => {
    const { result } = await answered("complaint", "high");
    expect(result.protection.actual).toBe("protected");
    expect(result.criticalFailures).toEqual(["intent:missed_protected:price_objection"]);
  });

  it("Protection UNCERTAIN where PROTECTED is expected ⇒ critical (the meaning alone is not enough)", async () => {
    const { result } = await answered("price_objection", "medium");
    expect(result).toMatchObject({ protectedIntent: { strictMatch: true, meaningPreserved: true }, protection: { actual: "uncertain", pass: false } });
    expect(result.criticalFailures).toEqual(["protection:uncertain"]);
  });

  it("an unrelated, unprotected intent ⇒ critical (meaning lost and Protection not_protected)", async () => {
    for (const intent of ["neutral_conversation", "praise"]) {
      const { result } = await answered(intent, "high");
      expect(result.criticalFailures, intent).toEqual(["intent:missed_protected:price_objection", "protection:not_protected"]);
    }
  });
});
