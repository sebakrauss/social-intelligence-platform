/**
 * Step H7-D0 — the live bake-off's offline machinery (no network, no credential): the evaluation-only price descriptor,
 * the conservative spend ledger and its hard cap (a denied run makes NO call), cost from reported usage, stability
 * detection and percentiles, and the candidate settings.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSimulatorProvider, simulatorModel } from "@/ai/providers/simulator";
import type { AttemptRecord } from "@/ai/gateway";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { parseEvalCorpus } from "./corpus";
import { evaluateCorpus, type CaseResult } from "./evaluate";
import { goldenScript } from "./golden";
import { CANDIDATES, MAX_OUTPUT_TOKENS, candidateModel } from "./live/candidates";
import { credentialPresence } from "./live/credentials";
import { attemptUsd, createSpendLedger, parsePriceDescriptor, runMaxUsd } from "./live/spend";
import { percentile, stabilityDisagreements } from "./live/stability";

const PRICES = parsePriceDescriptor(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json"), "utf8")));
const CORPUS = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v1.json"), "utf8")));
const attempt = (usage: AttemptRecord["usage"], outcome: AttemptRecord["outcome"] = "accepted"): AttemptRecord => ({ usage, outcome, inputChars: 4_000 } as unknown as AttemptRecord);

describe("price descriptor (evaluation only)", () => {
  it("covers exactly the three candidates, verified, with source metadata", () => {
    expect(Object.keys(PRICES.models).sort()).toEqual(["anthropic/claude-sonnet-5-5", "openai/gpt-6-luna", "openai/gpt-6.1-terra"]);
    expect(PRICES.pricingVersion).toBe("eval-prices.2026-10-29");
    for (const candidate of Object.values(CANDIDATES)) expect(PRICES.models[`${candidate.providerKey}/${candidate.id}`]).toBeDefined();
  });

  it("refuses an unverified or malformed descriptor", () => {
    expect(() => parsePriceDescriptor({ pricingVersion: "x", status: "ESTIMATE", unit: "per_1m_tokens", currency: "USD", models: {} })).toThrow("price_descriptor_invalid");
    expect(() => parsePriceDescriptor({ pricingVersion: "x", status: "VERIFIED_FROM_OFFICIAL_LIST_PRICES", unit: "per_1m_tokens", currency: "USD", models: { m: { input: -1, cachedInput: 0, output: 0, cachedIncludedInInput: true } } })).toThrow();
  });
});

describe("spend ledger", () => {
  const luna = PRICES.models["openai/gpt-6-luna"];
  const sonnet = PRICES.models["anthropic/claude-sonnet-5-5"];
  if (luna === undefined || sonnet === undefined) throw new Error("prices");

  it("a run's maximum covers both attempts at the conservative token bound and the output cap", () => {
    expect(runMaxUsd(luna, 4_000, 2_000)).toBeCloseTo(2 * (2_000 * 0.10 + 2_000 * 0.50) / 1e6 + (200 * 0.10) / 1e6, 10);
  });

  it("actual cost: OpenAI cached tokens are inside input; Anthropic cache reads are separate", () => {
    expect(attemptUsd(luna, attempt({ inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 800 }), 2_000)).toBeCloseTo((200 * 0.10 + 800 * 0.01 + 100 * 0.50) / 1e6, 12);
    expect(attemptUsd(sonnet, attempt({ inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 800 }), 2_000)).toBeCloseTo((1_000 * 2 + 800 * 0.10 + 100 * 10) / 1e6, 12);
    expect(attemptUsd(sonnet, attempt(null), 2_000)).toBeGreaterThan(0);
    expect(attemptUsd(sonnet, attempt(null, "unavailable"), 2_000)).toBe(0);
  });

  it("denies a run whose maximum would cross the cap: AI_BUDGET and NO provider call", async () => {
    const ledger = createSpendLedger(0.000_001);
    const simulator = createSimulatorProvider(goldenScript(CORPUS));
    const report = await evaluateCorpus(CORPUS, { provider: simulator, model: simulatorModel("simulator-golden"), realModel: false, budget: ledger.budgetFor(sonnet, MAX_OUTPUT_TOKENS), include: (c) => c.id === "es-cl-price-question-01" });
    expect(report.cases[0]).toMatchObject({ failureClass: "AI_BUDGET", attempts: [] });
    expect(simulator.calls).toEqual([]);
    expect(ledger.denied()).toBe(1);
  });
});

describe("stability and latency statistics", () => {
  it("flags a case whose labels differ across observations; identical observations are stable", async () => {
    const run = async () => (await evaluateCorpus(CORPUS, { provider: createSimulatorProvider(goldenScript(CORPUS)), model: simulatorModel("simulator-golden"), realModel: false, include: (c) => c.tags.includes("protected_critical") })).cases;
    const [a, b] = [await run(), await run()];
    expect(stabilityDisagreements([a, b])).toEqual([]);
    const changed = b.map((c): CaseResult => (c.id === "es-ar-complaint-01" ? { ...c, protection: { ...c.protection, actual: "not_protected" } } : c));
    expect(stabilityDisagreements([a, changed]).map((f) => f.id)).toEqual(["es-ar-complaint-01"]);
  });

  it("percentiles", () => {
    expect([percentile([5, 1, 3, 2, 4], 50), percentile([5, 1, 3, 2, 4], 90), percentile([], 95)]).toEqual([3, 5, null]);
  });
});

describe("candidates", () => {
  it("exactly the TL's three, with the frozen settings and no per-candidate tuning", () => {
    expect(Object.values(CANDIDATES).map((c) => [c.id, c.settings])).toEqual([
      ["gpt-6-luna", { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: 2_000 }],
      ["gpt-6.1-terra", { model: "gpt-6.1-terra", reasoningEffort: "none", maxOutputTokens: 2_000 }],
      ["claude-sonnet-5-5", { model: "claude-sonnet-5-5", effort: "low", thinking: "between_tools", speed: "omitted", maxTokens: 2_000 }],
    ]);
    for (const candidate of Object.values(CANDIDATES)) expect(candidateModel(candidate)).toMatchObject({ structuredOutput: "native_json_schema", tools: "none" });
  });

  it("credential presence reports only PRESENT / ABSENT", () => {
    expect(["PRESENT", "ABSENT"]).toContain(credentialPresence("OPENAI_API_KEY"));
  });
});
