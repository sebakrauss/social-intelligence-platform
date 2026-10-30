/**
 * Step H7-D0v2d — BAR_B fail-safe severity (evaluator v3), promotion v2, pass-1 evidence reuse and stability-only
 * execution, offline (simulator only, no network). Model-independent: every case is generic corpus behavior.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSimulatorProvider, simulatorModel } from "@/ai/providers/simulator";
import { UNDERSTANDING_PROMPT_HASH, UNDERSTANDING_PROMPT_VERSION } from "@/prompts/classification/understanding.v2";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { CORPUS_FILE, parseEvalCorpus, type EvalCorpus } from "./corpus";
import { evaluateCorpus, type CaseResult, type EvaluationReport } from "./evaluate";
import { goldenScript, transformCase, values } from "./golden";
import { CRITICAL, STABILITY_EXTRA_RUNS, createDiagnosticLog, runBakeoff, sanitizedCases } from "./live/bakeoff";
import { CANDIDATES } from "./live/candidates";
import { candidateConfigFingerprint, liveEvidenceProvenance, sha256Hex } from "./live/evidence";
import { KNOWN_PARENT_EVIDENCE, STABILITY_BUDGET_USD, plannedStabilityUsd, reclassifyParent, runStabilityOnly, stabilityCases, verifyParentEvidence, type ParentCase } from "./live/stability-only";
import { parsePriceDescriptor } from "./live/spend";
import { PROMOTION_POLICY, compareCandidates, evaluatePromotion, type RankingFacts } from "./promotion";
import { classifySeverity, type SeverityInput } from "./severity";

const BYTES = readFileSync(path.join(REPOSITORY_ROOT, CORPUS_FILE));
const CORPUS: EvalCorpus = parseEvalCorpus(JSON.parse(BYTES.toString("utf8")));
const GOLDEN = goldenScript(CORPUS);
const PRICES = parsePriceDescriptor(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json"), "utf8")));
const SONNET_PRICE = PRICES.models["anthropic/claude-sonnet-5-5"] ?? (() => { throw new Error("price"); })();
type Script = ReturnType<typeof goldenScript>;
const evaluate = (script: Script, opts: { realModel?: boolean; only?: (id: string) => boolean } = {}) =>
  evaluateCorpus(CORPUS, { provider: createSimulatorProvider(script), model: simulatorModel("simulator-golden"), realModel: opts.realModel ?? false, ...(opts.only === undefined ? {} : { include: (c) => (opts.only as (id: string) => boolean)(c.id) }) });
const one = async (script: Script, id: string): Promise<CaseResult> => (await evaluate(script, { only: (c) => c === id })).cases[0] ?? (() => { throw new Error(id); })();
const intent = (id: string, key: string, level: "low" | "medium" | "high") => transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values([key, level]); });
const base: SeverityInput = { pass: true, criticalFailures: [], protection: { expected: "protected", actual: "protected" }, needsReview: { expected: false, actual: false }, failureClass: null, languageSupport: { outcome: "correct" }, effectiveCapViolation: false, protectedIntent: null, rawLanguageCapExceedance: false };

describe("H7-D0v2d: evaluator v3 severity (BAR_B)", () => {
  it("1 · protected meaning lost + not_protected ⇒ blocking", async () => {
    const r = await one(intent("es-ar-complaint-01", "neutral_conversation", "high"), "es-ar-complaint-01");
    expect(r.protection.actual).toBe("not_protected");
    expect(r.severity.blocking).toEqual(expect.arrayContaining(["protected_meaning_lost", "protection_not_protected"]));
  });

  it("2 · protected meaning lost + uncertain ⇒ blocking (the semantic signal itself was lost)", async () => {
    const r = await one(intent("es-ar-complaint-01", "neutral_conversation", "medium"), "es-ar-complaint-01");
    expect(r.protection.actual).toBe("uncertain");
    expect(r.severity.blocking).toEqual(expect.arrayContaining(["protected_meaning_lost", "protected_meaning_lost_uncertain"]));
  });

  it("3 · meaning preserved + uncertain + review because confidence < high (validated language) ⇒ REVIEWABLE, not blocking", async () => {
    const r = await one(transformCase(GOLDEN, CORPUS, "en-injection-02", (b) => { b.dimensions["intent"] = values(["complaint", "medium"], ["product_service_problem", "medium"]); }), "en-injection-02");
    expect(r).toMatchObject({ protection: { actual: "uncertain" }, needsReview: { actual: true }, protectedIntent: { strictMatch: true, meaningPreserved: true }, languageSupport: { outcome: "correct" }, failureClass: null });
    expect(r.criticalFailures).toEqual(["protection:uncertain"]); // the v2 diagnostic is unchanged
    expect(r.severity).toMatchObject({ blocking: [], reviewable: ["protected_meaning_preserved_uncertain_review"] });
  });

  it("4 · meaning preserved + protected ⇒ no severity at all", async () => {
    const r = await one(GOLDEN, "en-injection-02");
    expect(r.severity).toEqual({ blocking: [], reviewable: [], noncritical: [], informational: [] });
  });

  it("5 · a protected sibling intent with the same meaning ⇒ noncritical accuracy only", async () => {
    const r = await one(intent("es-co-commercial-objection-01", "other_commercial_objection", "high"), "es-co-commercial-objection-01");
    expect(r.severity).toMatchObject({ blocking: [], reviewable: [], noncritical: ["protected_sibling_intent"] });
  });

  it("6 · a safety false negative on a safety_critical case ⇒ blocking", async () => {
    const r = await one(transformCase(GOLDEN, CORPUS, "es-cl-scam-link-01", (b) => { b.dimensions["safety"] = values(["obvious_spam", "high"]); }), "es-cl-scam-link-01");
    expect(r.severity.blocking).toContain("safety_false_negative");
  });

  it("7 · a safety false positive is never blocking: reviewable when it routes to review, noncritical otherwise", async () => {
    const r = await one(transformCase(GOLDEN, CORPUS, "es-cl-profanity-praise-01", (b) => { b.dimensions["safety"] = values(["hate_speech", "high"]); }), "es-cl-profanity-praise-01");
    expect(r.needsReview.actual).toBe(true);
    expect(r.severity.blocking).toEqual([]);
    expect(r.severity.reviewable).toContain("safety_false_positive");
    expect(classifySeverity({ ...base, pass: false, criticalFailures: ["safety:forbidden:obvious_spam"] })).toMatchObject({ blocking: [], reviewable: [], noncritical: ["safety_false_positive"] });
  });

  it("8 · a language-cap bypass ⇒ blocking; 9 · an over-capped validated language ⇒ reviewable; raw exceedance ⇒ informational", async () => {
    const bypass = await one(transformCase(GOLDEN, CORPUS, "fr-price-objection-01", (b) => { b.dimensions["language"] = { status: "assessed", languages: ["es"], certainty: "certain", confidence: "high" }; }), "fr-price-objection-01");
    expect(bypass.severity.blocking).toContain("language_cap_bypass");
    const over = await one(transformCase(GOLDEN, CORPUS, "pt-br-praise-01", (b) => { b.dimensions["language"] = { status: "assessed", languages: ["pt"], certainty: "certain", confidence: "high" }; }), "pt-br-praise-01");
    expect(over.severity.blocking).toEqual([]);
    expect(over.severity.reviewable).toContain("language_over_capped");
    const raw = await one(intent("fr-price-objection-01", "price_objection", "high"), "fr-price-objection-01");
    expect(raw.severity).toMatchObject({ blocking: [], reviewable: [], informational: ["raw_language_cap_exceedance"] });
  });

  it("10 · an effective-cap violation ⇒ blocking; an unrecognized critical check fails closed (blocking)", () => {
    expect(classifySeverity({ ...base, pass: false, criticalFailures: ["language_cap:effective_violation"] }).blocking).toEqual(["effective_cap_violation"]);
    expect(classifySeverity({ ...base, pass: false, criticalFailures: ["something:new"] }).blocking).toEqual(["unclassified:something:new"]);
  });

  it("isolated schema failure on a protected case ⇒ reviewable (the reliability rule still disqualifies — see promotion)", () => {
    const s = classifySeverity({ ...base, pass: false, failureClass: "AI_INVALID_OUTPUT", criticalFailures: ["protection:uncertain"], protection: { expected: "protected", actual: "uncertain" }, needsReview: { expected: false, actual: true } });
    expect(s.blocking).toEqual([]);
    expect(s.reviewable).toEqual(expect.arrayContaining(["isolated_AI_INVALID_OUTPUT"]));
  });
});

describe("H7-D0v2d: promotion v2 and bake-off qualification", () => {
  const reviewableScript = transformCase(GOLDEN, CORPUS, "en-injection-02", (b) => { b.dimensions["intent"] = values(["complaint", "medium"]); });
  const blockingScript = intent("es-ar-complaint-01", "neutral_conversation", "high");

  it("11 · 0 blocking + reviewables > 0 ⇒ not blocked; 13 · the reviewable count stays visible", async () => {
    const report: EvaluationReport = await evaluate(reviewableScript, { realModel: true });
    expect(report.blockingCriticalFailures).toEqual([]);
    expect(report.reviewableDegradations.map((r) => r.id)).toContain("en-injection-02");
    const verdict = evaluatePromotion(report, null);
    expect(verdict.verdict).toBe("THRESHOLDS_OPEN");
    expect(verdict.secondary.reviewableDegradations).toBe(report.reviewableDegradations.length);
    expect(PROMOTION_POLICY.version).toBe("understanding-promotion.v3");
  });

  it("12 · blocking > 0 ⇒ blocked", async () => {
    const verdict = evaluatePromotion(await evaluate(blockingScript, { realModel: true }), null);
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons).toContain("blocking_regression:es-ar-complaint-01");
  });

  it("the bake-off qualifies a candidate with reviewables only, not one with a blocking failure", async () => {
    const candidate = (id: string, script: Script) => ({ id, requestedModel: id, model: simulatorModel(id), price: SONNET_PRICE, provider: createSimulatorProvider(script), diagnostics: createDiagnosticLog() });
    const evidence = await runBakeoff({ corpus: CORPUS, candidates: [candidate("r", reviewableScript), candidate("b", blockingScript)], capUsd: 15, maxOutputTokens: 2_000, now: () => new Date("2026-10-30T12:00:00.000Z") });
    const [r, b] = evidence.candidates as { qualifiedForStability: boolean }[];
    expect([r?.qualifiedForStability, b?.qualifiedForStability]).toEqual([true, false]);
  });

  it("ranking: strictly lexicographic — a lower cost never outranks more reviewable degradations or any blocking", () => {
    const facts = (candidate: string, over: Partial<RankingFacts>): RankingFacts => ({ candidate, blocking: 0, blockingStability: 0, languageInvariant: 0, protectedMeaningMisses: 0, safetyFalseNegatives: 0, reliabilityFailures: 0, reviewRoutingInstability: 0, reviewableDegradations: 0, semanticPrecisionInstability: 0, precisionMisses: 0, latencyP50Ms: 3000, costUsd: 1, ...over });
    const ordered = [facts("cheap-blocking", { blocking: 1, costUsd: 0.01 }), facts("cheap-unstable", { blockingStability: 1, costUsd: 0.01 }), facts("cheap-routing", { reviewRoutingInstability: 1, costUsd: 0.01 }), facts("cheap-reviewable", { reviewableDegradations: 5, costUsd: 0.01 }), facts("cheap-precision", { semanticPrecisionInstability: 3, costUsd: 0.01 }), facts("costly-clean", { costUsd: 1 })].sort(compareCandidates).map((f) => f.candidate);
    expect(ordered).toEqual(["costly-clean", "cheap-precision", "cheap-reviewable", "cheap-routing", "cheap-unstable", "cheap-blocking"]);
  });
});

describe("H7-D0v2d: pass-1 evidence reuse (fail closed)", () => {
  const sonnet = CANDIDATES["claude-sonnet-5-5"];
  const parentFor = async (script: Script, over: Record<string, unknown> = {}) => {
    const report = await evaluate(script, { realModel: true });
    const provenance = liveEvidenceProvenance(CORPUS, sha256Hex(BYTES), [sonnet]);
    return {
      ...provenance, evidenceVersion: "classification-live-evidence.v2", evaluatorVersion: "classification-evaluator.v2", promotionVersion: "understanding-promotion.v1",
      status: "COMPLETE", comparison: "VALID_FOR_MODEL_COMPARISON",
      candidates: [{ candidate: sonnet.id, modelRequested: sonnet.settings.model, modelsReported: [sonnet.settings.model] }],
      cases: { [sonnet.id]: sanitizedCases(report.cases, createDiagnosticLog()) },
      ...over,
    };
  };
  const current = { ...liveEvidenceProvenance(CORPUS, sha256Hex(BYTES), [sonnet]), candidates: [sonnet] };
  const check = (raw: unknown, expected?: string) => { const bytes = JSON.stringify(raw); return verifyParentEvidence(JSON.parse(bytes), sha256Hex(bytes), expected ?? sha256Hex(bytes), current); };

  it("14 · the exact hash is accepted; 19 · a v2 → v3 severity-version difference is the documented exception", async () => {
    const result = check(await parentFor(GOLDEN));
    expect(result.ok).toBe(true);
    expect(current.evaluatorVersion).toBe("classification-evaluator.v3");
  });

  it("15 · an altered hash ⇒ rejected; 16 · a different prompt ⇒ rejected; 17 · a different corpus ⇒ rejected; 18 · a different model config ⇒ rejected", async () => {
    const parent = await parentFor(GOLDEN);
    expect(check(parent, "0".repeat(64))).toEqual({ ok: false, reasons: ["parent_sha256_mismatch"] });
    expect(check({ ...parent, promptHash: "f".repeat(64) })).toMatchObject({ ok: false, reasons: ["prompt_changed"] });
    expect(check({ ...parent, corpusSha256: "e".repeat(64) })).toMatchObject({ ok: false, reasons: ["corpus_changed"] });
    expect(check({ ...parent, candidateConfig: { [sonnet.id]: "d".repeat(64) } })).toMatchObject({ ok: false, reasons: [`model_config_changed:${sonnet.id}`] });
    expect(check({ ...parent, candidates: [{ candidate: sonnet.id, modelRequested: sonnet.settings.model, modelsReported: ["claude-other"] }] })).toMatchObject({ ok: false, reasons: [`model_changed:${sonnet.id}`] });
    expect(check({ ...parent, transportSchemas: { openai: "canonical-strict", anthropic: "anthropic-transport-schema.v1" } })).toMatchObject({ ok: false, reasons: ["transport_schema_changed"] });
    expect(check({ ...parent, evaluatorVersion: "classification-evaluator.v1" })).toMatchObject({ ok: false });
    expect(check({ ...parent, comparison: "INVALID_FOR_MODEL_COMPARISON" })).toMatchObject({ ok: false, reasons: ["parent_not_complete_and_valid"] });
    // A v2 parent records no candidate configuration: it must be registered.
    expect(check({ ...parent, candidateConfig: {} })).toMatchObject({ ok: false, reasons: ["parent_not_registered"] });
  });

  it("the registered H7-D0 v2 FINAL parent pins exactly the current candidate configurations", () => {
    const entry = KNOWN_PARENT_EVIDENCE["a27052b4e7c7b6e923194c527245fe63402d2d4782f843636b77b0737be9630d"];
    expect(entry?.id).toBe("h7-d0/2026-10-30T201726111Z");
    for (const candidate of Object.values(CANDIDATES)) expect(entry?.candidateConfig[candidate.id], candidate.id).toBe(candidateConfigFingerprint(candidate));
    expect([UNDERSTANDING_PROMPT_VERSION, UNDERSTANDING_PROMPT_HASH]).toEqual(["understanding-prompt.v2", "c177c6f36c77337645d2cc9f45628f80bd2fbeddd8f5ac2a418ac97ae2c9b7bf"]);
  });

  it("20 · eligibility is recomputed from the stored conclusions: reviewable-only qualifies, blocking does not", async () => {
    const reviewable = (await parentFor(transformCase(GOLDEN, CORPUS, "en-injection-02", (b) => { b.dimensions["intent"] = values(["complaint", "medium"]); }))).cases[sonnet.id] as unknown as ParentCase[];
    const blocking = (await parentFor(intent("es-ar-complaint-01", "neutral_conversation", "high"))).cases[sonnet.id] as unknown as ParentCase[];
    expect(reclassifyParent(reviewable)).toMatchObject({ eligible: true, blockingCriticalFailures: [], evaluatorVersion: "classification-evaluator.v3", promotionVersion: "understanding-promotion.v3" });
    expect(reclassifyParent(blocking)).toMatchObject({ eligible: false });
  });
});

describe("H7-D0v2d: stability-only execution", () => {
  const sonnet = CANDIDATES["claude-sonnet-5-5"];
  const parentCases = async (script: Script) => sanitizedCases((await evaluate(script, { realModel: true })).cases, createDiagnosticLog()) as unknown as ParentCase[];
  const run = async (pass1: Script, repeats: Script) => {
    const provider = createSimulatorProvider(repeats);
    const result = await runStabilityOnly({ corpus: CORPUS, candidate: { id: sonnet.id, requestedModel: sonnet.settings.model, model: simulatorModel("sim"), price: SONNET_PRICE, provider, diagnostics: createDiagnosticLog() }, parentCases: await parentCases(pass1), capUsd: STABILITY_BUDGET_USD, maxOutputTokens: 2_000, now: () => new Date("2026-10-30T12:00:00.000Z") });
    return { result, provider };
  };

  it("21–24 · only the critical set, deduplicated, two calls each, no pass-1 rerun; identical observations are stable", async () => {
    const { result, provider } = await run(GOLDEN, GOLDEN);
    const critical = stabilityCases(CORPUS).map((c) => c.id);
    expect(new Set(critical).size).toBe(critical.length);
    expect(CORPUS.cases.filter((c) => !CRITICAL(c)).some((c) => provider.calls.some((call) => call.reference === c.id))).toBe(false);
    for (const id of critical) expect(provider.calls.filter((call) => call.reference === id).length, id).toBe(STABILITY_EXTRA_RUNS);
    expect(provider.calls.length).toBe(critical.length * STABILITY_EXTRA_RUNS);
    expect(result).toMatchObject({ status: "COMPLETE", stable: true, disagreements: [], casesRun: critical.length * STABILITY_EXTRA_RUNS });
    expect(result.cases.every((c) => c.observations === 1 + STABILITY_EXTRA_RUNS)).toBe(true);
  });

  it("25 · a language-support change vs pass 1 is a disagreement", async () => {
    const pass1 = transformCase(GOLDEN, CORPUS, "fr-price-objection-01", (b) => { b.dimensions["language"] = { status: "assessed", languages: ["es"], certainty: "certain", confidence: "high" }; });
    const { result } = await run(pass1, GOLDEN);
    expect(result.disagreements).toEqual(["fr-price-objection-01"]);
    expect(result.stable).toBe(false);
  });

  it("26 / 27 · a Protection change — protected ↔ uncertain/review — is a disagreement even though both are non-blocking; 28 · no majority vote", async () => {
    const pass1 = transformCase(GOLDEN, CORPUS, "en-injection-02", (b) => { b.dimensions["intent"] = values(["complaint", "medium"]); });
    const { result } = await run(pass1, GOLDEN); // pass 1 uncertain, both repeats protected: 2 of 3 agree — still a disagreement
    expect(result.disagreements).toEqual(["en-injection-02"]);
    const c = result.cases.find((x) => x.id === "en-injection-02");
    expect(new Set(c?.signatures).size).toBe(2);
  });

  it("PLAN: eligible candidates × critical cases × 2, within the US$5 stability budget", () => {
    const cases = stabilityCases(CORPUS);
    const plan = plannedStabilityUsd(cases, [{ id: sonnet.id, price: SONNET_PRICE }], () => 4_000, 2_000);
    expect(plan).toMatchObject({ cases: cases.length, repeats: 2, calls: cases.length * 2 });
    expect(plannedStabilityUsd(cases, [], () => 4_000, 2_000)).toMatchObject({ calls: 0, total: 0 });
    expect(STABILITY_BUDGET_USD).toBe(5);
  });
});
