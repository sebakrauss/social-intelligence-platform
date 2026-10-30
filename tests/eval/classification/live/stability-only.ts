/**
 * Step H7-D0v2d — STABILITY-ONLY execution: the critical-case repeatability pass for candidates that clear BAR_B on an
 * already-recorded, complete pass 1 — without re-running the 68-case pass 1. Legitimate only because the model inputs
 * are unchanged; anything that could change a model output fails closed (a full fresh bake-off is then required):
 *
 *   parent       the exact pass-1 evidence file: SHA-256 must equal the one the operator passes AND be a registered
 *                parent (`KNOWN_PARENT_EVIDENCE`) unless the evidence carries its own candidate fingerprints (v3);
 *                version `classification-live-evidence.v2|v3`, status COMPLETE, VALID_FOR_MODEL_COMPARISON
 *   unchanged    prompt version + hash, corpus version + SHA-256 (the current bytes; the corpus also pins the taxonomy
 *                version through the parser), transport schemas, each candidate's configuration fingerprint (provider,
 *                model, settings, output cap, timeout, transport schema, taxonomy) and the served model id
 *   may differ   the evaluator / promotion SEVERITY version (v2 → v3; promotion v1 → v2): this change only classifies
 *                the recorded conclusions, it never re-scores model output — documented exception
 *   eligibility  recomputed offline from the parent's per-case conclusions with the same `classifySeverity` as live
 *   run          only eligible candidates; only the critical set (protected ∪ safety ∪ language critical, deduplicated);
 *                two new observations per case; with the stored pass-1 signature: three; never a majority vote
 */
import type { EvalCase, EvalCorpus } from "../corpus";
import { EVALUATOR_VERSION, evaluateCorpus, severitySummary, type CaseResult } from "../evaluate";
import { PROMOTION_POLICY } from "../promotion";
import { classifySeverity, type SeverityInput } from "../severity";
import { CRITICAL, STABILITY_EXTRA_RUNS, qualifiesForStability, type BakeoffCandidate } from "./bakeoff";
import { CONSECUTIVE_TRANSPORT_FAILURE_LIMIT, createTransportBreaker } from "./breaker";
import { candidateConfigFingerprint } from "./evidence";
import type { Candidate } from "./candidates";
import { createSpendLedger, runMaxUsd, type ModelPrice } from "./spend";
import { caseSignature, signatureOf, type SignatureFields } from "./stability";

export const STABILITY_EVIDENCE_VERSION = "classification-stability-evidence.v1" as const;
export const STABILITY_BUDGET_USD = 5;
export const STABILITY_CONFIRMATION = "send-synthetic-critical-cases-to-real-models-h7-d0-stability";
export const ACCEPTED_PARENT_EVIDENCE_VERSIONS: readonly string[] = ["classification-live-evidence.v2", "classification-live-evidence.v3"];
/** Severity versions a parent may have been scored with (only severity / promotion classification changes). */
export const ACCEPTED_PARENT_EVALUATORS: readonly string[] = ["classification-evaluator.v2", "classification-evaluator.v3"];

/**
 * Registered pass-1 parents (a v2 parent records no candidate configuration). Fingerprints = the candidate settings at
 * the parent's source (b2b99f0; `live/candidates.ts` unchanged since 5e57741) — a test pins them to the current code.
 */
export const KNOWN_PARENT_EVIDENCE: Readonly<Record<string, { readonly id: string; readonly source: string; readonly candidateConfig: Readonly<Record<string, string>> }>> = Object.freeze({
  a27052b4e7c7b6e923194c527245fe63402d2d4782f843636b77b0737be9630d: Object.freeze({
    id: "h7-d0/2026-10-30T201726111Z",
    source: "b2b99f0",
    candidateConfig: Object.freeze({
      "gpt-6-luna": "16b40784d9a281294895b8a8e79df0b08bc8d27b6627f5a6dfb2c786bdc360d2",
      "gpt-6.1-terra": "afaf3a4a47a889a8692b998735566a362c4a401ec21f37f02eae09d1b414c12e",
      "claude-sonnet-5-5": "76e0ca1f5478239fe0cb11df2994071f1a20825c12fc90c3c82e6d53f1d4b53b",
    }),
  }),
});

/** A stored pass-1 case (the v2 evidence fields this module reads). */
export type ParentCase = SeverityInput & SignatureFields & { readonly id: string };

export interface ParentCandidate {
  readonly candidate: string;
  readonly modelRequested: string;
  readonly modelsReported: readonly string[];
}

export interface ParentEvidence {
  readonly evidenceVersion: string;
  readonly evaluatorVersion: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly corpusVersion: string;
  readonly corpusSha256: string;
  readonly transportSchemas: Readonly<Record<string, string>>;
  readonly candidateConfig?: Readonly<Record<string, string>>;
  readonly status: string;
  readonly comparison: string;
  readonly candidates: readonly ParentCandidate[];
  readonly cases: Readonly<Record<string, readonly ParentCase[]>>;
}

export interface CurrentStack {
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly corpusVersion: string;
  readonly corpusSha256: string;
  readonly transportSchemas: Readonly<Record<string, string>>;
  readonly candidates: readonly Candidate[];
}

export type ParentVerification =
  | { readonly ok: true; readonly parent: ParentEvidence; readonly parentSha256: string; readonly parentId: string }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** Fail-closed verification of the referenced pass-1 evidence against the current, unchanged model inputs. */
export function verifyParentEvidence(raw: unknown, actualSha256: string, expectedSha256: string, current: CurrentStack): ParentVerification {
  const reasons: string[] = [];
  if (actualSha256 !== expectedSha256) return { ok: false, reasons: ["parent_sha256_mismatch"] };
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>)["candidates"]) || typeof (raw as Record<string, unknown>)["cases"] !== "object") return { ok: false, reasons: ["parent_malformed"] };
  const parent = raw as ParentEvidence;
  if (!ACCEPTED_PARENT_EVIDENCE_VERSIONS.includes(parent.evidenceVersion)) reasons.push(`parent_evidence_version:${parent.evidenceVersion}`);
  if (!ACCEPTED_PARENT_EVALUATORS.includes(parent.evaluatorVersion)) reasons.push(`parent_evaluator:${parent.evaluatorVersion}`);
  if (parent.status !== "COMPLETE" || parent.comparison !== "VALID_FOR_MODEL_COMPARISON") reasons.push("parent_not_complete_and_valid");
  if (parent.promptVersion !== current.promptVersion || parent.promptHash !== current.promptHash) reasons.push("prompt_changed");
  if (parent.corpusVersion !== current.corpusVersion || parent.corpusSha256 !== current.corpusSha256) reasons.push("corpus_changed");
  if (JSON.stringify(parent.transportSchemas) !== JSON.stringify(current.transportSchemas)) reasons.push("transport_schema_changed");
  const registered = KNOWN_PARENT_EVIDENCE[actualSha256];
  const recordedConfig = parent.candidateConfig !== undefined && Object.keys(parent.candidateConfig).length > 0 ? parent.candidateConfig : registered?.candidateConfig;
  if (recordedConfig === undefined) reasons.push("parent_not_registered");
  for (const candidate of current.candidates) {
    const stored = parent.candidates.find((c) => c.candidate === candidate.id);
    if (stored === undefined) { reasons.push(`candidate_not_in_parent:${candidate.id}`); continue; }
    if (stored.modelRequested !== candidate.settings.model || stored.modelsReported.length !== 1 || stored.modelsReported[0] !== candidate.settings.model) reasons.push(`model_changed:${candidate.id}`);
    if (recordedConfig !== undefined && recordedConfig[candidate.id] !== candidateConfigFingerprint(candidate)) reasons.push(`model_config_changed:${candidate.id}`);
    if (!Array.isArray(parent.cases[candidate.id])) reasons.push(`parent_cases_missing:${candidate.id}`);
  }
  if (reasons.length > 0) return { ok: false, reasons: Object.freeze(reasons) };
  return { ok: true, parent, parentSha256: actualSha256, parentId: registered?.id ?? "self-describing" };
}

/** Evaluator-v3 severity of a parent candidate's pass 1, recomputed offline, and its BAR_B eligibility. */
export function reclassifyParent(cases: readonly ParentCase[]) {
  const results = cases.map((c) => ({ id: c.id, severity: classifySeverity(c) }));
  const summary = severitySummary(results);
  const eligible = qualifiesForStability(summary.blockingCriticalFailures.length, cases.filter((c) => c.languageSupport.outcome === "bypass").length, cases.filter((c) => c.effectiveCapViolation).length, cases.map((c) => c.failureClass));
  return { evaluatorVersion: EVALUATOR_VERSION, promotionVersion: PROMOTION_POLICY.version, ...summary, eligible };
}

/** The critical stability set of the corpus (deduplicated; cases that make a call). */
export const stabilityCases = (corpus: EvalCorpus): readonly EvalCase[] => corpus.cases.filter((c) => CRITICAL(c) && c.expectedFailure === null);

/** Conservative upper bound: eligible candidates × critical cases × STABILITY_EXTRA_RUNS. */
export function plannedStabilityUsd(cases: readonly EvalCase[], eligible: readonly { readonly id: string; readonly price: ModelPrice }[], inputChars: (c: EvalCase) => number, maxOutputTokens: number) {
  const perCandidate = Object.fromEntries(eligible.map((e) => [e.id, cases.reduce((sum, c) => sum + STABILITY_EXTRA_RUNS * runMaxUsd(e.price, inputChars(c), maxOutputTokens), 0)]));
  return { cases: cases.length, repeats: STABILITY_EXTRA_RUNS, calls: cases.length * STABILITY_EXTRA_RUNS * eligible.length, perCandidate, total: Object.values(perCandidate).reduce((a, b) => a + b, 0) };
}

export interface StabilityOnlyInput {
  readonly corpus: EvalCorpus;
  readonly candidate: BakeoffCandidate;
  readonly parentCases: readonly ParentCase[];
  readonly capUsd: number;
  readonly maxOutputTokens: number;
  readonly now: () => Date;
}

/** Two new observations of every critical case for ONE eligible candidate, compared with the stored pass-1 one. */
export async function runStabilityOnly(input: StabilityOnlyInput) {
  const ledger = createSpendLedger(input.capUsd);
  const breaker = createTransportBreaker(CONSECUTIVE_TRANSPORT_FAILURE_LIMIT);
  const ids = new Set(stabilityCases(input.corpus).map((c) => c.id));
  const repeats: CaseResult[][] = [];
  for (let i = 0; i < STABILITY_EXTRA_RUNS && !breaker.tripped() && ledger.denied() === 0; i += 1) {
    const report = await evaluateCorpus(input.corpus, {
      provider: input.candidate.provider, model: input.candidate.model, realModel: true, now: input.now, budget: ledger.budgetFor(input.candidate.price, input.maxOutputTokens),
      include: (c) => ids.has(c.id), onCase: (result) => { ledger.record(input.candidate.price, result.attempts, input.maxOutputTokens); breaker.observe(input.candidate.id, result); },
      shouldContinue: () => !breaker.tripped() && ledger.denied() === 0,
    });
    repeats.push([...report.cases]);
  }
  const stored = new Map(input.parentCases.map((c) => [c.id, c]));
  const cases = [...ids].sort().map((id) => {
    const pass1 = stored.get(id);
    const observed = repeats.map((run) => run.find((r) => r.id === id));
    const signatures = [pass1 === undefined ? null : signatureOf(pass1), ...observed.map((r) => (r === undefined ? null : caseSignature(r)))];
    const complete = signatures.length === 1 + STABILITY_EXTRA_RUNS && signatures.every((s) => s !== null);
    return { id, observations: signatures.filter((s) => s !== null).length, signatures, disagreement: !complete || new Set(signatures).size > 1, severities: observed.map((r) => r?.severity ?? null) };
  });
  const attempts = repeats.flat().flatMap((r) => r.attempts);
  const ms = attempts.map((a) => a.completedAt.getTime() - a.startedAt.getTime());
  const status = breaker.tripped() ? "LIVE_EVAL_ABORTED_CONSECUTIVE_TRANSPORT_FAILURES" as const : ledger.denied() > 0 ? "AI_BUDGET" as const : "COMPLETE" as const;
  const disagreements = cases.filter((c) => c.disagreement).map((c) => c.id);
  return {
    candidate: input.candidate.id,
    status,
    stable: status === "COMPLETE" && disagreements.length === 0,
    casesRun: repeats.flat().length,
    disagreements,
    cases,
    modelsReported: [...new Set(attempts.map((a) => a.modelVersion).filter((v): v is string => v !== null))],
    usage: { inputTokens: attempts.reduce((s, a) => s + (a.usage?.inputTokens ?? 0), 0), outputTokens: attempts.reduce((s, a) => s + (a.usage?.outputTokens ?? 0), 0) },
    costUsd: ledger.spentUsd(),
    latencyMs: { max: ms.length === 0 ? null : Math.max(...ms), samples: ms.length },
  };
}
