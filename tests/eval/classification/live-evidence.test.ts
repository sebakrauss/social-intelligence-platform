/**
 * Step H7-D0v2a — the v2 live evidence contract and the critical stability coverage, offline (simulator only, no
 * network): per-case evaluator-v2 conclusions are serialized (closed values, no text / provider content / reasoning),
 * provenance names exactly the current benchmark stack, a new CaseResult field cannot be silently left out, and the
 * stability selection / comparator cover language_critical cases.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSimulatorProvider, simulatorModel } from "@/ai/providers/simulator";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { CORPUS_FILE, parseEvalCorpus, type EvalCorpus } from "./corpus";
import { evaluateCorpus, type CaseResult } from "./evaluate";
import { goldenScript, transformCase, values } from "./golden";
import { CRITICAL, STABILITY_EXTRA_RUNS, STABILITY_TAGS, createDiagnosticLog, runBakeoff, sanitizedCases } from "./live/bakeoff";
import { LIVE_EVIDENCE_VERSION, SANITIZED_CASE_FIELDS, liveEvidenceProvenance, sha256Hex } from "./live/evidence";
import { parsePriceDescriptor } from "./live/spend";
import { stabilityDisagreements } from "./live/stability";

const BYTES = readFileSync(path.join(REPOSITORY_ROOT, CORPUS_FILE));
const CORPUS: EvalCorpus = parseEvalCorpus(JSON.parse(BYTES.toString("utf8")));
const GOLDEN = goldenScript(CORPUS);
const PRICES = parsePriceDescriptor(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json"), "utf8")));
const PRICE = PRICES.models["openai/gpt-6-luna"] ?? (() => { throw new Error("price"); })();
const evaluate = (script: ReturnType<typeof goldenScript>, include?: (id: string) => boolean) =>
  evaluateCorpus(CORPUS, { provider: createSimulatorProvider(script), model: simulatorModel("simulator-golden"), realModel: false, ...(include === undefined ? {} : { include: (c) => include(c.id) }) });
const caseOf = (cases: readonly CaseResult[], id: string): CaseResult => cases.find((c) => c.id === id) ?? (() => { throw new Error(id); })();

describe("H7-D0v2a: per-case evidence carries evaluator v2's conclusions", () => {
  it("serializes exactly the contracted fields, copied from CaseResult (raw ≠ effective; strict and meaning apart)", async () => {
    const id = "fr-price-objection-01";
    const report = await evaluate(transformCase(GOLDEN, CORPUS, id, (b) => { b.dimensions["intent"] = values(["price_objection", "high"]); }), (c) => c === id || c === "es-co-commercial-objection-01");
    const [fr, esco] = [caseOf(report.cases, id), caseOf(report.cases, "es-co-commercial-objection-01")];
    const evidence = sanitizedCases(report.cases, createDiagnosticLog());
    for (const entry of evidence) expect(Object.keys(entry)).toEqual([...SANITIZED_CASE_FIELDS]);
    const e = evidence.find((x) => x.id === id);
    expect(e).toMatchObject({ rawLanguageCapExceedance: true, effectiveCapViolation: false, languageSupport: { expected: "unsupported", actual: "unsupported", outcome: "correct" }, protectedIntent: fr.protectedIntent, criticalFailures: [] });
    expect(evidence.find((x) => x.id === "es-co-commercial-objection-01")?.protectedIntent).toEqual({ strictMatch: true, meaningPreserved: true });
    expect(esco.protectedIntent).toEqual({ strictMatch: true, meaningPreserved: true });
    // Raw exceedance stays informational even though it is now visible.
    expect(fr.criticalFailures).toEqual([]);
  });

  it("every CaseResult field is either serialized or deliberately summarized / excluded — a new outcome cannot be dropped silently", async () => {
    const report = await evaluate(GOLDEN, (c) => c === "es-cl-praise-01");
    const result = report.cases[0] ?? (() => { throw new Error("case"); })();
    // Summarized: `dimensions` ⇒ `labels`. Excluded on purpose: corpus metadata, the internal outcome / failure-pass
    // flags (pass + failureClass carry them) and the route fingerprint (configuration invariance is reported globally).
    const SUMMARIZED_OR_EXCLUDED = ["group", "tags", "weight", "outcome", "dimensions", "failurePass", "fingerprint"];
    expect(Object.keys(result).filter((key) => !(SANITIZED_CASE_FIELDS as readonly string[]).includes(key) && !SUMMARIZED_OR_EXCLUDED.includes(key))).toEqual([]);
    for (const required of ["rawLanguageCapExceedance", "languageSupport", "effectiveCapViolation", "protectedIntent", "criticalFailures"]) expect(SANITIZED_CASE_FIELDS, required).toContain(required);
  });

  it("adds no input text, provider content, reasoning, request body or provider message", async () => {
    const candidate = { id: "a", requestedModel: "a", model: simulatorModel("a"), price: PRICE, provider: createSimulatorProvider(GOLDEN), diagnostics: createDiagnosticLog() };
    const evidence = await runBakeoff({ corpus: CORPUS, candidates: [candidate], capUsd: 15, maxOutputTokens: 2_000, now: () => new Date("2026-10-30T12:00:00.000Z") });
    const json = JSON.stringify(evidence.cases);
    for (const c of CORPUS.cases.filter((x) => x.text.length >= 12)) expect(json.includes(JSON.stringify(c.text).slice(1, -1)), c.id).toBe(false);
    expect(json).not.toMatch(/"(text|summary|evidence|quote|reasoning|thinking|message|body|request|prompt|system|apiKey)"/);
  });
});

describe("H7-D0v2a: provenance = exactly the current benchmark stack (no v1 fallback)", () => {
  it("evidence identity v3; evaluator v3, prompt v2 + pinned hash, corpus v2 + SHA-256 of the parsed bytes, promotion v3, transport schemas, candidate fingerprints", () => {
    const provenance = liveEvidenceProvenance(CORPUS, sha256Hex(BYTES));
    expect(provenance).toEqual({
      taxonomyVersion: "taxonomy.v1",
      evidenceVersion: "classification-live-evidence.v3",
      evaluatorVersion: "classification-evaluator.v3",
      promptVersion: "understanding-prompt.v2",
      promptHash: "c177c6f36c77337645d2cc9f45628f80bd2fbeddd8f5ac2a418ac97ae2c9b7bf",
      corpusVersion: "eval-corpus.v2",
      corpusSha256: "8dc159ffb74c70acd90a30b00fe35dc9f290ae5502acefb0f0f2c59cd527c989",
      promotionVersion: "understanding-promotion.v3",
      transportSchemas: { openai: "canonical-strict", anthropic: "anthropic-transport-schema.v2" },
      candidateConfig: {},
    });
    expect(LIVE_EVIDENCE_VERSION).toBe("classification-live-evidence.v3");
    expect(sha256Hex(BYTES)).toBe(createHash("sha256").update(BYTES).digest("hex"));
  });
});

describe("H7-D0v2a: critical stability selection includes language_critical (deduplicated union)", () => {
  it("protected / safety / language critical alone ⇒ selected; several tags ⇒ selected once; no critical tag ⇒ not selected", () => {
    expect(STABILITY_TAGS).toEqual(["protected_critical", "safety_critical", "language_critical"]);
    expect([["protected_critical"], ["safety_critical"], ["language_critical"], ["protected_critical", "language_critical", "safety_critical"], ["emoji"], []].map((tags) => CRITICAL({ tags }))).toEqual([true, true, true, true, false, false]);
    const selected = CORPUS.cases.filter(CRITICAL).map((c) => c.id);
    expect(new Set(selected).size).toBe(selected.length);
    expect(selected).toEqual(expect.arrayContaining(["fr-price-objection-01", "de-complaint-01", "it-praise-01", "und-uncertain-01", "emoji-only-01"]));
    expect(CORPUS.cases.filter((c) => !CRITICAL(c)).every((c) => !c.tags.some((t) => t === "protected_critical" || t === "safety_critical" || t === "language_critical"))).toBe(true);
  });

  it("the bake-off repeats each selected case once per repetition (two more times), language_critical included", async () => {
    const provider = createSimulatorProvider(GOLDEN);
    const candidate = { id: "a", requestedModel: "a", model: simulatorModel("a"), price: PRICE, provider, diagnostics: createDiagnosticLog() };
    const evidence = await runBakeoff({ corpus: CORPUS, candidates: [candidate], capUsd: 15, maxOutputTokens: 2_000, now: () => new Date("2026-10-30T12:00:00.000Z") });
    const critical = CORPUS.cases.filter(CRITICAL).filter((c) => c.expectedFailure === null).length;
    expect(evidence.candidates[0]).toMatchObject({ qualifiedForStability: true, stability: { casesRun: STABILITY_EXTRA_RUNS * CORPUS.cases.filter(CRITICAL).length, disagreements: [] } });
    const references = provider.calls.map((call) => call.reference);
    for (const id of ["it-praise-01", "und-uncertain-01", "emoji-only-01", "fr-price-objection-01"]) expect(references.filter((r) => r === id).length, id).toBe(1 + STABILITY_EXTRA_RUNS);
    expect(critical).toBeGreaterThan(0);
  });

  it("a language-support or effective-cap change between repeats is a disagreement; an unchanged language result is not", async () => {
    const run = async () => (await evaluate(GOLDEN, (c) => c === "fr-price-objection-01" || c === "es-ar-complaint-01")).cases;
    const [a, b] = [await run(), await run()];
    expect(stabilityDisagreements([a, b])).toEqual([]);
    const bypass = b.map((c): CaseResult => (c.id === "fr-price-objection-01" ? { ...c, languageSupport: { ...c.languageSupport, actual: "validated", outcome: "bypass" } } : c));
    expect(stabilityDisagreements([a, bypass]).map((f) => f.id)).toEqual(["fr-price-objection-01"]);
    const effective = b.map((c): CaseResult => (c.id === "fr-price-objection-01" ? { ...c, effectiveCapViolation: true } : c));
    expect(stabilityDisagreements([a, effective]).map((f) => f.id)).toEqual(["fr-price-objection-01"]);
    // Protected stability is unchanged: a protection flip is still a disagreement.
    const protection = b.map((c): CaseResult => (c.id === "es-ar-complaint-01" ? { ...c, protection: { ...c.protection, actual: "not_protected" } } : c));
    expect(stabilityDisagreements([a, protection]).map((f) => f.id)).toEqual(["es-ar-complaint-01"]);
  });
});
