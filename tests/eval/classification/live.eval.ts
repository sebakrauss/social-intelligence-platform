/**
 * Step H7-D0 — the OPERATOR-ONLY real-model bake-off of task A (`npm run eval:classification:live`; never CI, never
 * `npm test`, never product runtime). Synthetic corpus only (H7-C eval-corpus.v1); no dev-v2 read, no customer or
 * Meta-derived text, nothing persisted but a sanitized local evidence file (ignored `.wrenkind-local/`).
 *
 *   PLAN (default)  the conservative upper-bound cost of pass 1 + pass 2 for the selected candidates; no credential is
 *                   read, no call is made. Over the US$15 cap ⇒ refused.
 *   RUN             requires the exact confirmation phrase AND every selected candidate's credential; pass 1 = all 68
 *                   cases once per candidate (+ only gateway re-asks); pass 2 = the protected_critical / safety_critical
 *                   cases twice more, ONLY for candidates with zero critical failures, zero language-cap violations and
 *                   no systemic schema / refusal / provider issue. The spend ledger denies any run whose maximum would
 *                   cross the cap (AI_BUDGET, no call) and the run then stops.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { renderDataBlock, type AttemptRecord } from "@/ai/gateway";
import { buildUnderstandingInput } from "@/modules/classification";
import { understandingData } from "@/modules/classification/application/ai/understanding-task";
import { UNDERSTANDING_PROMPT_SYSTEM } from "@/prompts/classification/understanding.v1";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { parseEvalCorpus, type EvalCase, type EvalCorpus } from "./corpus";
import { evaluateCorpus, type CaseResult, type EvaluationReport } from "./evaluate";
import { CANDIDATES, MAX_OUTPUT_TOKENS, candidateModel, candidateProvider, isCandidateId, type Candidate } from "./live/candidates";
import { credentialPresence, readCredential } from "./live/credentials";
import { createSpendLedger, parsePriceDescriptor, runMaxUsd, type ModelPrice, type PriceDescriptor } from "./live/spend";
import { percentile, stabilityDisagreements } from "./live/stability";

export const LIVE_EVAL_CONFIRMATION = "send-synthetic-corpus-to-real-models-h7-d0";
export const LIVE_EVAL_BUDGET_USD = 15;
const PRICES_FILE = "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json";
const CORPUS_FILE = "fixtures/intelligence/classification/understanding-eval.v1.json";
const STABILITY_EXTRA_RUNS = 2;
const CRITICAL = (c: EvalCase): boolean => c.tags.includes("protected_critical") || c.tags.includes("safety_critical");

const fail = (message: string): never => {
  throw new Error(`live eval refused: ${message}`);
};

function settings(): { readonly mode: "plan" | "run"; readonly candidates: readonly Candidate[] } {
  if (process.env["CI"] !== undefined || process.env["GITHUB_ACTIONS"] !== undefined) fail("CI environment");
  const mode = process.env["WRENKIND_LIVE_EVAL_MODE"] ?? "plan";
  if (mode !== "plan" && mode !== "run") fail("mode must be plan or run");
  if (mode === "run" && process.env["WRENKIND_LIVE_EVAL_CONFIRMATION"] !== LIVE_EVAL_CONFIRMATION) fail("run needs the exact confirmation phrase");
  const ids = (process.env["WRENKIND_LIVE_EVAL_CANDIDATES"] ?? "").split(",").filter((id) => id !== "");
  if (ids.length === 0 || new Set(ids).size !== ids.length || !ids.every(isCandidateId)) fail("candidates must be distinct known candidate ids");
  return { mode: mode as "plan" | "run", candidates: ids.map((id) => CANDIDATES[id as keyof typeof CANDIDATES]) };
}

const priceOf = (prices: PriceDescriptor, candidate: Candidate): ModelPrice => prices.models[`${candidate.providerKey}/${candidate.id}`] ?? fail(`no price for ${candidate.id}`);

/** The input chars of one case's request (system + data), rendered exactly as the gateway renders them. */
function inputChars(testCase: EvalCase): number {
  const params = Object.fromEntries(Object.entries(testCase.input).filter(([key, value]) => value !== null && key !== "textRepeat"));
  const built = buildUnderstandingInput({ ...params, interactionKind: params["interactionKind"], platform: params["platform"], source: params["source"], linkPresent: params["linkPresent"], text: testCase.text });
  if (!built.ok) return 0;
  return UNDERSTANDING_PROMPT_SYSTEM.length + renderDataBlock(understandingData(built.input)).length;
}

function plannedUsd(corpus: EvalCorpus, prices: PriceDescriptor, candidates: readonly Candidate[]): { readonly perCandidate: Record<string, number>; readonly total: number } {
  const perCandidate: Record<string, number> = {};
  const calling = corpus.cases.filter((c) => c.expectedFailure === null);
  for (const candidate of candidates) {
    const model = priceOf(prices, candidate);
    const pass1 = calling.reduce((sum, c) => sum + runMaxUsd(model, inputChars(c), MAX_OUTPUT_TOKENS), 0);
    const pass2 = calling.filter(CRITICAL).reduce((sum, c) => sum + STABILITY_EXTRA_RUNS * runMaxUsd(model, inputChars(c), MAX_OUTPUT_TOKENS), 0);
    perCandidate[candidate.id] = pass1 + pass2;
  }
  return { perCandidate, total: Object.values(perCandidate).reduce((a, b) => a + b, 0) };
}

const attemptsOf = (report: EvaluationReport): readonly AttemptRecord[] => report.cases.flatMap((c) => c.attempts);
const latencies = (attempts: readonly AttemptRecord[]): number[] => attempts.map((a) => a.completedAt.getTime() - a.startedAt.getTime());

function summary(candidate: Candidate, report: EvaluationReport, spentUsd: number) {
  const attempts = attemptsOf(report);
  const ms = latencies(attempts);
  const reported = [...new Set(attempts.map((a) => a.modelVersion).filter((v): v is string => v !== null))];
  const count = (cls: string): number => report.cases.filter((c) => c.failureClass === cls).length;
  return {
    candidate: candidate.id,
    modelRequested: candidate.settings.model,
    modelsReported: reported,
    casesCompleted: report.cases.filter((c) => c.attempts.length > 0 || c.failureClass === "AI_INPUT_TOO_LARGE").length,
    criticalFailures: report.criticalFailures,
    protectedMeaningRecall: report.protectedMeaningRecall,
    strictProtectedRecall: report.protectedStrictRecall,
    safetyRecall: report.safetyRecall,
    safetyFalsePositiveRate: report.safetyFalsePositiveRate,
    languageCapViolations: report.languageCapRawViolations,
    schemaFailures: count("AI_INVALID_OUTPUT"),
    refusals: count("AI_REFUSED"),
    reasks: attempts.filter((a) => a.kind === "reask").length,
    transientFailures: report.cases.filter((c) => c.failureCause === "provider_unavailable" || c.failureCause === "timeout" || c.failureCause === "rate_limited").length,
    otherProviderFailures: report.cases.filter((c) => c.failureCause === "provider_auth_failed" || c.failureCause === "provider_request_rejected" || c.failureCause === "model_mismatch").map((c) => `${c.id}:${c.failureCause ?? ""}`),
    budgetDenied: count("AI_BUDGET"),
    inputTokens: attempts.reduce((s, a) => s + (a.usage?.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((s, a) => s + (a.usage?.outputTokens ?? 0), 0),
    cachedTokens: attempts.reduce((s, a) => s + (a.usage?.cachedInputTokens ?? 0), 0),
    estimatedCostUsd: spentUsd,
    latencyMs: { p50: percentile(ms, 50), p90: percentile(ms, 90), p95: percentile(ms, 95), max: ms.length === 0 ? null : Math.max(...ms), samples: ms.length },
    passRate: report.passRate,
    perDimension: Object.fromEntries(Object.entries(report.perDimension).map(([d, m]) => [d, { micro: m.micro, macro: m.macro, exactSetRate: m.exactSetRate }])),
    protectionAccuracy: report.protectionAccuracy,
    byLanguage: report.byLanguage,
    failedCases: report.cases.filter((c) => !c.pass).map((c) => c.id),
  };
}

const sanitizedCases = (cases: readonly CaseResult[]) => cases.map((c) => ({
  id: c.id, pass: c.pass, failureClass: c.failureClass, failureCause: c.failureCause, protection: c.protection, needsReview: c.needsReview, criticalFailures: c.criticalFailures,
  labels: Object.fromEntries(Object.entries(c.dimensions).map(([d, v]) => [d, v.predicted])),
  attempts: c.attempts.map((a) => ({ kind: a.kind, outcome: a.outcome, modelVersion: a.modelVersion, usage: a.usage, latencyMs: a.completedAt.getTime() - a.startedAt.getTime(), issueCodes: a.issueCodes })),
}));

it("H7-D0 live classification bake-off (operator only)", async () => {
  const { mode, candidates } = settings();
  const corpus = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, CORPUS_FILE), "utf8")));
  const prices = parsePriceDescriptor(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, PRICES_FILE), "utf8")));
  const plan = plannedUsd(corpus, prices, candidates);
  const credentials = Object.fromEntries(candidates.map((c) => [c.credential, credentialPresence(c.credential)]));
  process.stdout.write(`${JSON.stringify({ mode, pricingVersion: prices.pricingVersion, budgetUsd: LIVE_EVAL_BUDGET_USD, projectedUpperBoundUsd: plan, credentials })}\n`);
  if (plan.total > LIVE_EVAL_BUDGET_USD) fail(`projected upper bound ${plan.total.toFixed(2)} USD exceeds the ${String(LIVE_EVAL_BUDGET_USD)} USD gate budget`);
  if (mode === "plan") return;

  const missing = candidates.filter((c) => readCredential(c.credential) === undefined).map((c) => c.credential);
  if (missing.length > 0) fail(`credential absent: ${[...new Set(missing)].join(", ")}`);
  const ledger = createSpendLedger(LIVE_EVAL_BUDGET_USD);
  const pass1: Record<string, EvaluationReport> = {};
  const spentBy: Record<string, number> = {};
  const run = async (candidate: Candidate, include?: (c: EvalCase) => boolean): Promise<EvaluationReport> => {
    const model = priceOf(prices, candidate);
    const key = readCredential(candidate.credential) ?? fail(`credential absent: ${candidate.credential}`);
    const before = ledger.spentUsd();
    const report = await evaluateCorpus(corpus, {
      provider: candidateProvider(candidate, key), model: candidateModel(candidate), realModel: true, now: () => new Date(),
      budget: ledger.budgetFor(model, MAX_OUTPUT_TOKENS), onCase: (result) => { ledger.record(model, result.attempts, MAX_OUTPUT_TOKENS); }, ...(include === undefined ? {} : { include }),
    });
    spentBy[candidate.id] = (spentBy[candidate.id] ?? 0) + ledger.spentUsd() - before;
    return report;
  };
  for (const candidate of candidates) {
    pass1[candidate.id] = await run(candidate);
    if (ledger.denied() > 0) break;
  }
  const qualifies = (report: EvaluationReport): boolean => report.criticalFailures.length === 0 && report.languageCapRawViolations === 0
    && !report.cases.some((c) => c.failureClass === "AI_REFUSED" || c.failureClass === "AI_INVALID_OUTPUT" || c.failureClass === "AI_UNAVAILABLE" || c.failureClass === "AI_BUDGET");
  const stability: Record<string, unknown> = {};
  for (const candidate of candidates) {
    const first = pass1[candidate.id];
    if (first === undefined || !qualifies(first) || ledger.denied() > 0) continue;
    const runs: (readonly CaseResult[])[] = [first.cases.filter((c) => c.tags.includes("protected_critical") || c.tags.includes("safety_critical"))];
    for (let i = 0; i < STABILITY_EXTRA_RUNS && ledger.denied() === 0; i += 1) runs.push((await run(candidate, CRITICAL)).cases);
    stability[candidate.id] = { casesRun: runs.slice(1).reduce((s, r) => s + r.length, 0), disagreements: stabilityDisagreements(runs) };
  }
  const evidence = {
    gate: "H7-D0", at: new Date().toISOString(), corpus: corpus.corpusVersion, pricingVersion: prices.pricingVersion, budgetUsd: LIVE_EVAL_BUDGET_USD, spentUsd: ledger.spentUsd(), budgetDenied: ledger.denied(),
    complete: ledger.denied() === 0 && candidates.every((c) => pass1[c.id] !== undefined),
    candidates: candidates.map((c) => (pass1[c.id] === undefined ? { candidate: c.id, status: "NOT_RUN" } : { ...summary(c, pass1[c.id] as EvaluationReport, spentBy[c.id] ?? 0), qualifiedForStability: qualifies(pass1[c.id] as EvaluationReport), stability: stability[c.id] ?? null })),
    cases: Object.fromEntries(candidates.flatMap((c) => (pass1[c.id] === undefined ? [] : [[c.id, sanitizedCases((pass1[c.id] as EvaluationReport).cases)]]))),
  };
  const dir = path.join(REPOSITORY_ROOT, ".wrenkind-local/evidence/h7-d0");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${evidence.at.replace(/[:.]/g, "")}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 1)}\n`, { flag: "wx" });
  const printable = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "cases"));
  process.stdout.write(`${JSON.stringify({ ...printable, evidenceFile: path.relative(REPOSITORY_ROOT, file) }, null, 1)}\n`);
  expect(ledger.spentUsd()).toBeLessThanOrEqual(LIVE_EVAL_BUDGET_USD);
});
