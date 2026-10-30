/**
 * Step H7-D0v2g — STABILITY_B_BLOCKING_SAFE classification, promotion v3 qualification and the offline replay of
 * recorded stability evidence (simulator / synthetic observations only; no network). Model-independent.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSimulatorProvider, simulatorModel } from "@/ai/providers/simulator";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { CORPUS_FILE, parseEvalCorpus, type EvalCorpus } from "./corpus";
import { evaluateCorpus } from "./evaluate";
import { goldenScript, transformCase, values } from "./golden";
import { createDiagnosticLog, sanitizedCases } from "./live/bakeoff";
import { CANDIDATES } from "./live/candidates";
import { liveEvidenceProvenance, sha256Hex } from "./live/evidence";
import { STABILITY_BUDGET_USD, STABILITY_EVIDENCE_VERSION, runStabilityOnly, type ParentCase } from "./live/stability-only";
import { STABILITY_POLICY_VERSION, classifyStabilityCase, summarizeStability, type StabilityObservation } from "./live/stability-policy";
import { replayStability } from "./live/stability-replay";
import { parsePriceDescriptor } from "./live/spend";
import { PROMOTION_POLICY, qualifiesForPromotion } from "./promotion";

const BYTES = readFileSync(path.join(REPOSITORY_ROOT, CORPUS_FILE));
const CORPUS: EvalCorpus = parseEvalCorpus(JSON.parse(BYTES.toString("utf8")));
const GOLDEN = goldenScript(CORPUS);
const PRICES = parsePriceDescriptor(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json"), "utf8")));
const PRICE = PRICES.models["anthropic/claude-sonnet-5-5"] ?? (() => { throw new Error("price"); })();
type Script = ReturnType<typeof goldenScript>;

const obs = (over: Partial<StabilityObservation> = {}): StabilityObservation => ({
  labels: { safety: ["none"], intent: ["complaint"], sentiment: ["negative"] }, protection: { actual: "protected" }, needsReview: { actual: false }, failureClass: null,
  languageSupport: { outcome: "correct" }, effectiveCapViolation: false, severity: { blocking: [], reviewable: [] }, ...over,
});
const cls = (observations: StabilityObservation[], tags: string[] = ["protected_critical"]) => classifyStabilityCase("case", tags, observations).class;

describe("H7-D0v2g: stability classification (classification-stability-policy.v2)", () => {
  it("1 · protected meaning lost in a repeat ⇒ blocking", () => {
    expect(cls([obs(), obs(), obs({ labels: { safety: ["none"], intent: ["neutral_conversation"], sentiment: ["negative"] }, protection: { actual: "not_protected" }, severity: { blocking: ["protected_meaning_lost"], reviewable: [] } })])).toBe("blocking");
  });
  it("2 · protected → not_protected ⇒ blocking", () => {
    expect(cls([obs(), obs({ protection: { actual: "not_protected" }, severity: { blocking: ["protection_not_protected"], reviewable: [] } }), obs()])).toBe("blocking");
  });
  it("3 · a safety-critical false negative appears (or the safety outcome changes on safety-critical content) ⇒ blocking", () => {
    const scam = obs({ labels: { safety: ["scam_fraud_content"], intent: ["neutral_conversation"] }, protection: { actual: "uncertain" }, needsReview: { actual: true } });
    expect(cls([scam, scam, { ...scam, labels: { safety: ["obvious_spam"], intent: ["neutral_conversation"] }, severity: { blocking: ["safety_false_negative"], reviewable: [] } }], ["safety_critical"])).toBe("blocking");
    expect(cls([scam, scam, { ...scam, labels: { safety: ["scam_fraud_content", "obvious_spam"], intent: ["neutral_conversation"] } }], ["safety_critical"])).toBe("blocking");
  });
  it("4 · a language bypass appears ⇒ blocking; 5 · an effective-cap violation appears ⇒ blocking; a failure class ⇒ blocking", () => {
    expect(cls([obs(), obs(), obs({ languageSupport: { outcome: "bypass" } })])).toBe("blocking");
    expect(cls([obs(), obs({ effectiveCapViolation: true }), obs()])).toBe("blocking");
    expect(cls([obs(), obs({ failureClass: "AI_INVALID_OUTPUT" }), obs()])).toBe("blocking");
    expect(cls([obs()])).toBe("blocking"); // incomplete observations fail closed
  });
  it("6 · protected ↔ uncertain + review with the meaning preserved ⇒ review_routing (not blocking)", () => {
    const uncertain = obs({ protection: { actual: "uncertain" }, needsReview: { actual: true }, severity: { blocking: [], reviewable: ["protected_meaning_preserved_uncertain_review"] } });
    expect(cls([obs(), uncertain, uncertain])).toBe("review_routing");
  });
  it("7 · risk-only variance ⇒ semantic_precision; 8 · non-protected intent-only variance (neutral ↔ abstention) ⇒ semantic_precision", () => {
    const harassment = (risk: string) => obs({ labels: { safety: ["abuse_insult", "harassment"], intent: [], risk: [risk] }, protection: { actual: "uncertain" }, needsReview: { actual: true } });
    expect(cls([harassment("medium"), harassment("high"), harassment("medium")], ["safety_critical"])).toBe("semantic_precision");
    const insult = (intent: string[]) => obs({ labels: { safety: ["abuse_insult"], intent, sentiment: ["negative"] }, protection: { actual: "uncertain" }, needsReview: { actual: true } });
    expect(cls([insult(["neutral_conversation"]), insult([]), insult([])], ["safety_critical"])).toBe("semantic_precision");
  });
  it("9 · latency / token variance is never compared (identical observations ⇒ no class); a same-cap language group ⇒ informational", () => {
    expect(cls([obs(), obs(), obs()])).toBeNull();
    expect(cls([obs(), obs({ languageSupport: { outcome: "same_cap_other_group" } }), obs()])).toBe("informational");
    expect(STABILITY_POLICY_VERSION).toBe("classification-stability-policy.v2");
  });
});

describe("H7-D0v2g: model independence", () => {
  it("the stability policy, the replay and promotion name no model, provider or candidate", () => {
    for (const file of ["live/stability-policy.ts", "live/stability-replay.ts", "promotion.ts"]) {
      const source = readFileSync(path.join(REPOSITORY_ROOT, "tests/eval/classification", file), "utf8");
      expect(source, file).not.toMatch(/sonnet|luna|terra|claude|gpt|anthropic|openai/i);
    }
  });
});

describe("H7-D0v2g: promotion v3 qualification", () => {
  const q = (pass1: number, stability: number | null, systemic = 0) => qualifiesForPromotion({ pass1BlockingCriticalFailures: pass1, stabilityBlockingDisagreements: stability, systemicReliabilityFailures: systemic });
  it("10 · 0 pass-1 blocking + 0 stability blocking ⇒ qualifies; 11 · pass-1 blocking ⇒ fails; 12 · stability blocking ⇒ fails; no stability evidence ⇒ fails", () => {
    expect(q(0, 0)).toEqual({ qualified: true, reasons: [] });
    expect(q(1, 0).qualified).toBe(false);
    expect(q(0, 1)).toEqual({ qualified: false, reasons: ["blocking_stability:1"] });
    expect(q(0, null)).toEqual({ qualified: false, reasons: ["stability_not_run"] });
    expect(q(0, 0, 1).qualified).toBe(false);
    expect(PROMOTION_POLICY.version).toBe("understanding-promotion.v3");
    expect(PROMOTION_POLICY.blockingRules).toContain("no_blocking_stability");
  });
  it("13 · review-routing alone does NOT fail; 14 · semantic-precision alone does NOT fail", () => {
    const summary = summarizeStability([{ id: "a", class: "review_routing", reasons: [] }, { id: "b", class: "semantic_precision", reasons: [] }, { id: "c", class: null, reasons: [] }]);
    expect(summary).toMatchObject({ blocking: [], reviewRouting: ["a"], semanticPrecision: ["b"], qualifies: true });
    expect(q(0, summary.blocking.length).qualified).toBe(true);
  });
});

describe("H7-D0v2g: offline replay of recorded stability evidence (fail closed, immutable)", () => {
  const sonnet = CANDIDATES["claude-sonnet-5-5"];
  const provenance = liveEvidenceProvenance(CORPUS, sha256Hex(BYTES), [sonnet]);
  const current = { ...provenance, candidates: [sonnet] };
  const build = async (pass1: Script, repeats: Script) => {
    const report = await evaluateCorpus(CORPUS, { provider: createSimulatorProvider(pass1), model: simulatorModel("sim"), realModel: true });
    const parent = { ...provenance, evidenceVersion: "classification-live-evidence.v3", evaluatorVersion: "classification-evaluator.v3", status: "COMPLETE", comparison: "VALID_FOR_MODEL_COMPARISON",
      candidates: [{ candidate: sonnet.id, modelRequested: sonnet.settings.model, modelsReported: [sonnet.settings.model] }], cases: { [sonnet.id]: sanitizedCases(report.cases, createDiagnosticLog()) } };
    const parentJson = JSON.stringify(parent);
    const run = await runStabilityOnly({ corpus: CORPUS, candidate: { id: sonnet.id, requestedModel: sonnet.settings.model, model: simulatorModel("sim"), price: PRICE, provider: createSimulatorProvider(repeats), diagnostics: createDiagnosticLog() },
      parentCases: parent.cases[sonnet.id] as unknown as ParentCase[], capUsd: STABILITY_BUDGET_USD, maxOutputTokens: 2_000, now: () => new Date("2026-10-30T12:00:00.000Z") });
    const stabilityJson = JSON.stringify({ stabilityEvidenceVersion: STABILITY_EVIDENCE_VERSION, parent: { sha256: sha256Hex(parentJson) }, ...provenance, results: [{ ...run, modelsReported: [sonnet.settings.model] }] });
    return { parentJson, stabilityJson };
  };
  const replay = (parentJson: string, stabilityJson: string, expected: { parent?: string; stability?: string } = {}) => replayStability({ corpus: CORPUS, current,
    parent: { raw: JSON.parse(parentJson), sha256: sha256Hex(parentJson), expectedSha256: expected.parent ?? sha256Hex(parentJson) },
    stability: { raw: JSON.parse(stabilityJson), sha256: sha256Hex(stabilityJson), expectedSha256: expected.stability ?? sha256Hex(stabilityJson) } });

  it("15 / 16 · exact parent and stability hashes ⇒ accepted; the replay names policy v2 / promotion v3 / evaluator v3", async () => {
    const { parentJson, stabilityJson } = await build(GOLDEN, GOLDEN);
    const result = replay(parentJson, stabilityJson);
    expect(result).toMatchObject({ ok: true, replayVersion: "classification-stability-policy-replay.v1", stabilityPolicyVersion: "classification-stability-policy.v2", promotionVersion: "understanding-promotion.v3", evaluatorVersion: "classification-evaluator.v3", qualified: [sonnet.id] });
  });

  it("17 · altered parent ⇒ rejected; 18 · altered stability evidence ⇒ rejected; 19 · incompatible prompt / corpus / model config ⇒ rejected", async () => {
    const { parentJson, stabilityJson } = await build(GOLDEN, GOLDEN);
    expect(replay(parentJson, stabilityJson, { parent: "0".repeat(64) })).toEqual({ ok: false, reasons: ["parent:parent_sha256_mismatch"] });
    expect(replay(parentJson, stabilityJson, { stability: "0".repeat(64) })).toEqual({ ok: false, reasons: ["stability:stability_sha256_mismatch"] });
    const s = JSON.parse(stabilityJson) as Record<string, unknown>;
    for (const [field, value, reason] of [["promptHash", "f".repeat(64), "stability:prompt_changed"], ["corpusSha256", "e".repeat(64), "stability:corpus_changed"], ["candidateConfig", { [sonnet.id]: "d".repeat(64) }, `stability:model_config_changed:${sonnet.id}`]] as const) {
      expect(replay(parentJson, JSON.stringify({ ...s, [field]: value })), field).toEqual({ ok: false, reasons: [reason] });
    }
    expect(replay(parentJson, JSON.stringify({ ...s, parent: { sha256: "a".repeat(64) } }))).toEqual({ ok: false, reasons: ["stability:stability_parent_mismatch"] });
  });

  it("20 · the replay never mutates the recorded evidence", async () => {
    const { parentJson, stabilityJson } = await build(GOLDEN, GOLDEN);
    const p = JSON.parse(parentJson) as unknown;
    const s = JSON.parse(stabilityJson) as unknown;
    replayStability({ corpus: CORPUS, current, parent: { raw: p, sha256: sha256Hex(parentJson), expectedSha256: sha256Hex(parentJson) }, stability: { raw: s, sha256: sha256Hex(stabilityJson), expectedSha256: sha256Hex(stabilityJson) } });
    expect([JSON.stringify(p), JSON.stringify(s)]).toEqual([parentJson, stabilityJson]);
  });

  it("21–24 · routing + precision variance replays to 0 blocking, 1 review-routing, 3 semantic-precision, 0 informational, and qualifies", async () => {
    // pass 1 differs from the golden repeats by generic patterns only: a protected complaint below high (uncertain +
    // review, meaning preserved), two allowed risk levels and a sentiment change, all at identical Protection / Needs review.
    const changes: readonly [string, (b: Parameters<Parameters<typeof transformCase>[3]>[0]) => void][] = [
      ["es-ar-reply-complaint-01", (b) => { b.dimensions["intent"] = values(["complaint", "medium"]); }],
      ["es-ar-harassment-01", (b) => { b.dimensions["risk"] = values(["high", "high"]); }],
      ["es-cl-hate-01", (b) => { b.dimensions["risk"] = values(["critical", "high"]); }],
      ["es-mx-insult-01", (b) => { b.dimensions["sentiment"] = values(["mixed", "high"]); }],
    ];
    const pass1 = changes.reduce<Script>((script, [id, change]) => transformCase(script, CORPUS, id, change), GOLDEN);
    const { parentJson, stabilityJson } = await build(pass1, GOLDEN);
    const result = replay(parentJson, stabilityJson);
    if (!result.ok) throw new Error(result.reasons.join(","));
    const sonnetResult = result.candidates.find((c) => c.candidate === sonnet.id);
    expect(sonnetResult?.pass1Blocking).toEqual([]);
    expect(sonnetResult?.stability).toMatchObject({ blocking: [], reviewRouting: ["es-ar-reply-complaint-01"], informational: [], qualifies: true });
    expect([...(sonnetResult?.stability?.semanticPrecision ?? [])].sort()).toEqual(["es-ar-harassment-01", "es-cl-hate-01", "es-mx-insult-01"]);
    expect(sonnetResult?.qualified).toBe(true);
    expect(result.qualified).toEqual([sonnet.id]);
  });
});

// The recorded H7-D0v2e evidence lives only on the operator machine (ignored `.wrenkind-local/`): replayed there only.
const LOCAL = path.join(REPOSITORY_ROOT, ".wrenkind-local/evidence");
const PARENT = path.join(LOCAL, "h7-d0/2026-10-30T201726111Z.json");
const STABILITY = path.join(LOCAL, "h7-d0-stability/2026-10-30T220752250Z.json");
describe.runIf(existsSync(PARENT) && existsSync(STABILITY))("H7-D0v2g: replay of the recorded H7-D0v2e stability evidence (operator machine only)", () => {
  it("hashes match; 0 blocking stability, 1 review-routing, 3 semantic-precision; qualified; files unchanged", () => {
    const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    const candidates = Object.values(CANDIDATES);
    const prov = liveEvidenceProvenance(CORPUS, sha256Hex(BYTES), candidates);
    const read = (f: string, expected: string) => ({ raw: JSON.parse(readFileSync(f, "utf8")) as unknown, sha256: sha(f), expectedSha256: expected });
    const result = replayStability({ corpus: CORPUS, current: { ...prov, candidates }, parent: read(PARENT, "a27052b4e7c7b6e923194c527245fe63402d2d4782f843636b77b0737be9630d"), stability: read(STABILITY, "e7448e99cd3af3186591bb541ae8c18d86a5c1d5977f330bf06273f71a7d8d90") });
    if (!result.ok) throw new Error(result.reasons.join(","));
    const stability = result.candidates.find((c) => c.stability !== null)?.stability;
    expect([stability?.blocking.length, stability?.reviewRouting.length, stability?.semanticPrecision.length, stability?.informational.length]).toEqual([0, 1, 3, 0]);
    expect(result.qualified.length).toBe(1);
    expect([sha(PARENT), sha(STABILITY)]).toEqual(["a27052b4e7c7b6e923194c527245fe63402d2d4782f843636b77b0737be9630d", "e7448e99cd3af3186591bb541ae8c18d86a5c1d5977f330bf06273f71a7d8d90"]);
  });
});
