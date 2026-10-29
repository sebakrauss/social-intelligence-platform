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
import { parseEvalCorpus, type EvalCorpus } from "./corpus";
import { evaluateCorpus, type EvaluationReport } from "./evaluate";
import { goldenScript, transformCase, values, withCase } from "./golden";
import { evaluatePromotion } from "./promotion";

const CORPUS: EvalCorpus = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v1.json"), "utf8")));
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
    const raw = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v1.json"), "utf8")) as { cases: Record<string, unknown>[] };
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
    expect(golden.languageCapRawViolations).toBe(0);
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

  it("an unsupported language answered with confidence above medium", async () => {
    const id = "fr-price-objection-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["price_objection", "high"]); }));
    const result = caseOf(report, id);
    expect(result).toMatchObject({ languageCapRawViolation: true, pass: false, protection: { actual: "uncertain" } });
    expect(report.languageCapRawViolations).toBe(1);
    expect(evaluatePromotion(report, golden).reasons).toContain("language_cap_violations:1");
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
