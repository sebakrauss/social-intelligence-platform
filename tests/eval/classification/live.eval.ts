/**
 * Step H7-D0 — the OPERATOR-ONLY real-model bake-off of task A (`npm run eval:classification:live`; never CI, never
 * `npm test`, never product runtime). Synthetic corpus only (eval-corpus.v2 since H7-D0k; v1 = H7-D0 FINAL); no dev-v2
 * read, no customer or
 * Meta-derived text, nothing persisted but a sanitized local evidence file (ignored `.wrenkind-local/`).
 *
 *   PLAN (default)  the conservative upper-bound cost of pass 1 + pass 2 for the selected candidates; no credential is
 *                   read, no call is made. Over the US$15 cap ⇒ refused.
 *   RUN             requires the exact confirmation phrase AND every selected candidate's credential; pass 1 = all 68
 *                   cases once per candidate (+ only gateway re-asks); pass 2 = the protected_critical ∪ safety_critical
 *                   ∪ language_critical cases twice more (H7-D0v2a), ONLY for candidates with zero critical failures, no
 *                   language-cap bypass or effective violation (H7-D0k: raw exceedances are informational) and no
 *                   systemic schema / refusal / provider issue. The spend ledger denies any run whose maximum would
 *                   cross the cap (AI_BUDGET, no call) and the run then stops. Evidence: `classification-live-evidence.v2`
 *                   (provenance + per-case evaluator-v2 conclusions, live/evidence.ts).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { renderDataBlock } from "@/ai/gateway";
import { buildUnderstandingInput } from "@/modules/classification";
import { understandingData } from "@/modules/classification/application/ai/understanding-task";
import { UNDERSTANDING_PROMPT_SYSTEM } from "@/prompts/classification/understanding.v2";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { CORPUS_FILE, CORPUS_VERSION, parseEvalCorpus, type EvalCase, type EvalCorpus } from "./corpus";
import { CRITICAL, STABILITY_EXTRA_RUNS, createDiagnosticLog, runBakeoff, type BakeoffCandidate } from "./live/bakeoff";
import { CANDIDATES, LIVE_CALL_TIMEOUT_MS, MAX_OUTPUT_TOKENS, candidateModel, candidateProvider, isCandidateId, type Candidate } from "./live/candidates";
import { credentialPresence, readCredential } from "./live/credentials";
import { liveEvidenceProvenance, sha256Hex } from "./live/evidence";
import { parsePriceDescriptor, runMaxUsd, type ModelPrice, type PriceDescriptor } from "./live/spend";

export const LIVE_EVAL_CONFIRMATION = "send-synthetic-corpus-to-real-models-h7-d0";
export const LIVE_EVAL_BUDGET_USD = 15;
const PRICES_FILE = "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json";

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

it("H7-D0 live classification bake-off (operator only)", async () => {
  const { mode, candidates } = settings();
  // The corpus hash in the evidence is the SHA-256 of exactly these bytes (H7-D0v2a).
  const corpusBytes = readFileSync(path.join(REPOSITORY_ROOT, CORPUS_FILE));
  const corpus = parseEvalCorpus(JSON.parse(corpusBytes.toString("utf8")));
  if (corpus.corpusVersion !== CORPUS_VERSION) fail(`corpus ${corpus.corpusVersion} is not the current ${CORPUS_VERSION}`);
  const prices = parsePriceDescriptor(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, PRICES_FILE), "utf8")));
  const plan = plannedUsd(corpus, prices, candidates);
  const credentials = Object.fromEntries(candidates.map((c) => [c.credential, credentialPresence(c.credential)]));
  process.stdout.write(`${JSON.stringify({ mode, pricingVersion: prices.pricingVersion, budgetUsd: LIVE_EVAL_BUDGET_USD, projectedUpperBoundUsd: plan, credentials })}\n`);
  if (plan.total > LIVE_EVAL_BUDGET_USD) fail(`projected upper bound ${plan.total.toFixed(2)} USD exceeds the ${String(LIVE_EVAL_BUDGET_USD)} USD gate budget`);
  if (mode === "plan") return;

  const missing = candidates.filter((c) => readCredential(c.credential) === undefined).map((c) => c.credential);
  if (missing.length > 0) fail(`credential absent: ${[...new Set(missing)].join(", ")}`);
  const bakeoffCandidates: BakeoffCandidate[] = candidates.map((candidate) => {
    const diagnostics = createDiagnosticLog();
    const key = readCredential(candidate.credential) ?? fail(`credential absent: ${candidate.credential}`);
    return { id: candidate.id, requestedModel: candidate.settings.model, model: candidateModel(candidate), price: priceOf(prices, candidate), provider: candidateProvider(candidate, key, diagnostics.sink, diagnostics.rejectionSink), diagnostics };
  });
  const result = await runBakeoff({ corpus, candidates: bakeoffCandidates, capUsd: LIVE_EVAL_BUDGET_USD, maxOutputTokens: MAX_OUTPUT_TOKENS, now: () => new Date() });
  const evidence = { gate: "H7-D0", at: new Date().toISOString(), ...liveEvidenceProvenance(corpus, sha256Hex(corpusBytes)), pricingVersion: prices.pricingVersion, budgetUsd: LIVE_EVAL_BUDGET_USD, callTimeoutMs: LIVE_CALL_TIMEOUT_MS, ...result };
  const dir = path.join(REPOSITORY_ROOT, ".wrenkind-local/evidence/h7-d0");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${evidence.at.replace(/[:.]/g, "")}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 1)}\n`, { flag: "wx" });
  const printable = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "cases"));
  process.stdout.write(`${JSON.stringify({ ...printable, evidenceFile: path.relative(REPOSITORY_ROOT, file) }, null, 1)}\n`);
  expect(result.spentUsd).toBeLessThanOrEqual(LIVE_EVAL_BUDGET_USD);
});
