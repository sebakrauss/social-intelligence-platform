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
 *                   (provenance + per-case evaluator conclusions + severity, live/evidence.ts).
 *   STABILITY-ONLY  (H7-D0v2d) `stability-plan` / `stability-run`: verify a recorded pass-1 parent (path + SHA-256 +
 *                   unchanged model inputs, live/stability-only.ts), re-classify it offline under BAR_B, and for the
 *                   eligible candidates only plan / run two observations of each critical case (US$5 cap; its own
 *                   confirmation phrase). Evidence: `classification-stability-evidence.v1`.
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
import { STABILITY_BUDGET_USD, STABILITY_CONFIRMATION, STABILITY_EVIDENCE_VERSION, plannedStabilityUsd, reclassifyParent, runStabilityOnly, stabilityCases, verifyParentEvidence } from "./live/stability-only";
import { parsePriceDescriptor, runMaxUsd, type ModelPrice, type PriceDescriptor } from "./live/spend";

export const LIVE_EVAL_CONFIRMATION = "send-synthetic-corpus-to-real-models-h7-d0";
export const LIVE_EVAL_BUDGET_USD = 15;
const PRICES_FILE = "fixtures/intelligence/evaluation/model-prices.eval-2026-10-29.json";

const fail = (message: string): never => {
  throw new Error(`live eval refused: ${message}`);
};

type Mode = "plan" | "run" | "stability-plan" | "stability-run";
function settings(): { readonly mode: Mode; readonly candidates: readonly Candidate[] } {
  if (process.env["CI"] !== undefined || process.env["GITHUB_ACTIONS"] !== undefined) fail("CI environment");
  const mode = process.env["WRENKIND_LIVE_EVAL_MODE"] ?? "plan";
  if (mode !== "plan" && mode !== "run" && mode !== "stability-plan" && mode !== "stability-run") fail("mode must be plan, run, stability-plan or stability-run");
  if (mode === "run" && process.env["WRENKIND_LIVE_EVAL_CONFIRMATION"] !== LIVE_EVAL_CONFIRMATION) fail("run needs the exact confirmation phrase");
  if (mode === "stability-run" && process.env["WRENKIND_LIVE_EVAL_CONFIRMATION"] !== STABILITY_CONFIRMATION) fail("stability-run needs the exact stability confirmation phrase");
  const ids = (process.env["WRENKIND_LIVE_EVAL_CANDIDATES"] ?? "").split(",").filter((id) => id !== "");
  if (ids.length === 0 || new Set(ids).size !== ids.length || !ids.every(isCandidateId)) fail("candidates must be distinct known candidate ids");
  return { mode: mode as Mode, candidates: ids.map((id) => CANDIDATES[id as keyof typeof CANDIDATES]) };
}

/** H7-D0v2d: stability-only — never re-runs pass 1; fails closed unless the parent's model inputs are unchanged. */
async function stabilityOnly(mode: "stability-plan" | "stability-run", candidates: readonly Candidate[], corpus: EvalCorpus, corpusSha256: string, prices: PriceDescriptor): Promise<void> {
  const parentPath = process.env["WRENKIND_LIVE_EVAL_PARENT"] ?? "";
  const expectedSha = process.env["WRENKIND_LIVE_EVAL_PARENT_SHA256"] ?? "";
  if (parentPath === "" || !/^[0-9a-f]{64}$/.test(expectedSha)) fail("stability-only needs a parent evidence path and its SHA-256");
  const parentBytes = readFileSync(path.resolve(REPOSITORY_ROOT, parentPath));
  const provenance = liveEvidenceProvenance(corpus, corpusSha256, candidates);
  const verified = verifyParentEvidence(JSON.parse(parentBytes.toString("utf8")), sha256Hex(parentBytes), expectedSha, { ...provenance, candidates });
  if (!verified.ok) fail(`parent evidence rejected: ${verified.reasons.join(", ")}`);
  if (!verified.ok) return;
  const reclassification = Object.fromEntries(candidates.map((c) => [c.id, reclassifyParent(verified.parent.cases[c.id] ?? [])]));
  const eligible = candidates.filter((c) => reclassification[c.id]?.eligible === true);
  const cases = stabilityCases(corpus);
  const plan = plannedStabilityUsd(cases, eligible.map((c) => ({ id: c.id, price: priceOf(prices, c) })), inputChars, MAX_OUTPUT_TOKENS);
  const summary = Object.fromEntries(Object.entries(reclassification).map(([id, r]) => [id, { eligible: r.eligible, blocking: r.blockingCriticalFailures.map((f) => f.id), reviewable: r.reviewableDegradations.length, noncritical: r.noncriticalAccuracy.length }]));
  process.stdout.write(`${JSON.stringify({ mode, parent: { id: verified.parentId, sha256: verified.parentSha256 }, evaluatorVersion: provenance.evaluatorVersion, promotionVersion: provenance.promotionVersion, reclassification: summary, eligible: eligible.map((c) => c.id), plan, budgetUsd: STABILITY_BUDGET_USD })}\n`);
  if (plan.total > STABILITY_BUDGET_USD) fail(`projected stability upper bound ${plan.total.toFixed(2)} USD exceeds the ${String(STABILITY_BUDGET_USD)} USD stability budget`);
  if (mode === "stability-plan" || eligible.length === 0) return;
  const missing = eligible.filter((c) => readCredential(c.credential) === undefined).map((c) => c.credential);
  if (missing.length > 0) fail(`credential absent: ${[...new Set(missing)].join(", ")}`);
  const results = [];
  for (const candidate of eligible) {
    const diagnostics = createDiagnosticLog();
    const key = readCredential(candidate.credential) ?? fail(`credential absent: ${candidate.credential}`);
    const bakeoffCandidate = { id: candidate.id, requestedModel: candidate.settings.model, model: candidateModel(candidate), price: priceOf(prices, candidate), provider: candidateProvider(candidate, key, diagnostics.sink, diagnostics.rejectionSink), diagnostics };
    results.push(await runStabilityOnly({ corpus, candidate: bakeoffCandidate, parentCases: verified.parent.cases[candidate.id] ?? [], capUsd: STABILITY_BUDGET_USD, maxOutputTokens: MAX_OUTPUT_TOKENS, now: () => new Date() }));
  }
  const evidence = { gate: "H7-D0-stability", stabilityEvidenceVersion: STABILITY_EVIDENCE_VERSION, at: new Date().toISOString(), parent: { id: verified.parentId, sha256: verified.parentSha256, evidenceVersion: verified.parent.evidenceVersion, evaluatorVersion: verified.parent.evaluatorVersion }, ...provenance, budgetUsd: STABILITY_BUDGET_USD, reclassification: summary, results };
  const dir = path.join(REPOSITORY_ROOT, ".wrenkind-local/evidence/h7-d0-stability");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${evidence.at.replace(/[:.]/g, "")}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 1)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ results: results.map((r) => ({ candidate: r.candidate, status: r.status, stable: r.stable, casesRun: r.casesRun, disagreements: r.disagreements, costUsd: r.costUsd })), evidenceFile: path.relative(REPOSITORY_ROOT, file) }, null, 1)}\n`);
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
  if (mode === "stability-plan" || mode === "stability-run") {
    await stabilityOnly(mode, candidates, corpus, sha256Hex(corpusBytes), prices);
    return;
  }
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
  const evidence = { gate: "H7-D0", at: new Date().toISOString(), ...liveEvidenceProvenance(corpus, sha256Hex(corpusBytes), candidates), pricingVersion: prices.pricingVersion, budgetUsd: LIVE_EVAL_BUDGET_USD, callTimeoutMs: LIVE_CALL_TIMEOUT_MS, ...result };
  const dir = path.join(REPOSITORY_ROOT, ".wrenkind-local/evidence/h7-d0");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${evidence.at.replace(/[:.]/g, "")}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 1)}\n`, { flag: "wx" });
  const printable = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "cases"));
  process.stdout.write(`${JSON.stringify({ ...printable, evidenceFile: path.relative(REPOSITORY_ROOT, file) }, null, 1)}\n`);
  expect(result.spentUsd).toBeLessThanOrEqual(LIVE_EVAL_BUDGET_USD);
});
