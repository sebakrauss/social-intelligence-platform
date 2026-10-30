/**
 * Step H7-D0 / H7-D0a — the bake-off orchestration (provider-agnostic, so it is testable with mocked providers):
 * pass 1 = every case once per candidate; pass 2 = the critical cases (protected_critical ∪ safety_critical ∪
 * language_critical — H7-D0v2a, each case once per repetition) STABILITY_EXTRA_RUNS more times, only for qualifying
 * candidates. Guards, in order of precedence:
 *
 *   spend ledger        a run whose maximum would cross the cap is denied (AI_BUDGET, no call) ⇒ the bake-off stops
 *   transport breaker   K = 3 consecutive retryable transport failures (H7-D0a) ⇒ the WHOLE bake-off stops at once —
 *                       no later case, no later candidate, no automatic restart
 *
 * Validity: VALID_FOR_MODEL_COMPARISON only when it ran to completion for every candidate with zero transport and zero
 * other provider failures; anything else is INVALID_FOR_MODEL_COMPARISON (its partial results are never reused).
 * The bake-off never recommends a model (`recommendation: null`): the TL decides from a VALID report.
 */
import type { AttemptRecord, ModelDescriptor, ModelProvider } from "@/ai/gateway";
import type { RequestRejectionDiagnostic, RequestRejectionSink, TransportDiagnostic, TransportDiagnosticCode, TransportDiagnosticSink } from "@/ai/providers/diagnostics";
import type { EvalCase, EvalCorpus } from "../corpus";
import { evaluateCorpus, type CaseResult, type EvaluationReport } from "../evaluate";
import { CONSECUTIVE_TRANSPORT_FAILURE_LIMIT, TRANSPORT_CAUSES, createTransportBreaker } from "./breaker";
import { createSpendLedger, type ModelPrice } from "./spend";
import { percentile, stabilityDisagreements } from "./stability";

export const STABILITY_EXTRA_RUNS = 2;
/** BAR_B qualification (promotion v2): 0 blocking, 0 bypass, 0 effective violation, and the unchanged reliability rule. */
export const DISQUALIFYING_FAILURES: readonly string[] = ["AI_REFUSED", "AI_INVALID_OUTPUT", "AI_UNAVAILABLE", "AI_BUDGET"];
export function qualifiesForStability(blocking: number, bypasses: number, effectiveViolations: number, failureClasses: readonly (string | null)[]): boolean {
  return blocking === 0 && bypasses === 0 && effectiveViolations === 0 && !failureClasses.some((f) => f !== null && DISQUALIFYING_FAILURES.includes(f));
}

/** The stability selection: the deduplicated union of the critical tags (H7-D0v2a adds language_critical). */
export const STABILITY_TAGS = ["protected_critical", "safety_critical", "language_critical"] as const;
export const CRITICAL = (c: { readonly tags: readonly string[] }): boolean => c.tags.some((tag) => (STABILITY_TAGS as readonly string[]).includes(tag));
const OTHER_PROVIDER_CAUSES = ["provider_auth_failed", "provider_request_rejected", "model_mismatch"];

export interface DiagnosticLog {
  readonly sink: TransportDiagnosticSink;
  codeOf(reference: string, attempt: 1 | 2): TransportDiagnosticCode | null;
  /** H7-D0c: the sanitized reason of a rejected request (closed values only; Anthropic adapter). */
  readonly rejectionSink: RequestRejectionSink;
  rejectionOf(reference: string, attempt: 1 | 2): Omit<RequestRejectionDiagnostic, "reference" | "attempt"> | null;
}

/** Per-candidate log of the adapters' sanitized transport codes and rejection reasons (keyed by case id + attempt). */
export function createDiagnosticLog(): DiagnosticLog {
  const codes = new Map<string, TransportDiagnosticCode>();
  const rejections = new Map<string, Omit<RequestRejectionDiagnostic, "reference" | "attempt">>();
  return {
    sink: (diagnostic: TransportDiagnostic) => { codes.set(`${diagnostic.reference}#${String(diagnostic.attempt)}`, diagnostic.code); },
    codeOf: (reference, attempt) => codes.get(`${reference}#${String(attempt)}`) ?? null,
    rejectionSink: ({ reference, attempt, status, errorType, category, field }: RequestRejectionDiagnostic) => { rejections.set(`${reference}#${String(attempt)}`, { status, errorType, category, field }); },
    rejectionOf: (reference, attempt) => rejections.get(`${reference}#${String(attempt)}`) ?? null,
  };
}

export interface BakeoffCandidate {
  readonly id: string;
  readonly requestedModel: string;
  readonly model: ModelDescriptor;
  readonly price: ModelPrice;
  readonly provider: ModelProvider;
  readonly diagnostics: DiagnosticLog;
}

export type BakeoffStatus = "COMPLETE" | "LIVE_EVAL_ABORTED_CONSECUTIVE_TRANSPORT_FAILURES" | "AI_BUDGET";

const attemptsOf = (report: EvaluationReport): readonly AttemptRecord[] => report.cases.flatMap((c) => c.attempts);

function summary(candidate: BakeoffCandidate, report: EvaluationReport, spentUsd: number, cases: number) {
  const attempts = attemptsOf(report);
  const ms = attempts.map((a) => a.completedAt.getTime() - a.startedAt.getTime());
  const count = (cls: string): number => report.cases.filter((c) => c.failureClass === cls).length;
  return {
    candidate: candidate.id,
    modelRequested: candidate.requestedModel,
    modelsReported: [...new Set(attempts.map((a) => a.modelVersion).filter((v): v is string => v !== null))],
    casesPlanned: cases,
    casesEvaluated: report.cases.length,
    casesWithProviderObservation: report.cases.filter((c) => c.attempts.some((a) => a.outcome !== "unavailable" && a.outcome !== "input_too_large")).length,
    criticalFailures: report.criticalFailures,
    protectedMeaningRecall: report.protectedMeaningRecall,
    strictProtectedRecall: report.protectedStrictRecall,
    safetyRecall: report.safetyRecall,
    safetyFalsePositiveRate: report.safetyFalsePositiveRate,
    evaluatorVersion: report.evaluatorVersion,
    // v2 (H7-D0k): raw exceedances are informational; bypasses / over-capping / effective violations are scored.
    rawLanguageCapExceedances: report.rawLanguageCapExceedances,
    languageSupport: report.languageSupport,
    effectiveCapViolations: report.effectiveCapViolations,
    protectedIntentMeaningRecall: report.protectedIntentMeaningRecall,
    protectedIntentStrictRecall: report.protectedIntentStrictRecall,
    // H7-D0v2d (evaluator v3, BAR_B): severity classes; qualification reads `blockingCriticalFailures`.
    severityVersion: report.severityVersion,
    blockingCriticalFailures: report.blockingCriticalFailures,
    reviewableDegradations: report.reviewableDegradations,
    noncriticalAccuracy: report.noncriticalAccuracy.map((f) => f.id),
    schemaFailures: count("AI_INVALID_OUTPUT"),
    refusals: count("AI_REFUSED"),
    reasks: attempts.filter((a) => a.kind === "reask").length,
    transientFailures: report.cases.filter((c) => c.failureCause !== null && TRANSPORT_CAUSES.includes(c.failureCause)).length,
    otherProviderFailures: report.cases.filter((c) => c.failureCause !== null && OTHER_PROVIDER_CAUSES.includes(c.failureCause)).map((c) => `${c.id}:${c.failureCause ?? ""}`),
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

/** Per-case evidence (contract: `SANITIZED_CASE_FIELDS`): evaluator v2's conclusions, copied — never recomputed. */
export const sanitizedCases = (cases: readonly CaseResult[], diagnostics: DiagnosticLog) => cases.map((c) => ({
  id: c.id, pass: c.pass, failureClass: c.failureClass, failureCause: c.failureCause, protection: c.protection, needsReview: c.needsReview, criticalFailures: c.criticalFailures,
  labels: Object.fromEntries(Object.entries(c.dimensions).map(([d, v]) => [d, v.predicted])),
  // H7-D0v2a: informational raw exceedance ≠ effective-cap invariant; protected intent keeps strict and meaning apart.
  rawLanguageCapExceedance: c.rawLanguageCapExceedance, languageSupport: c.languageSupport, effectiveCapViolation: c.effectiveCapViolation, protectedIntent: c.protectedIntent,
  severity: c.severity,
  attempts: c.attempts.map((a) => ({ attempt: a.attemptNumber, kind: a.kind, outcome: a.outcome, modelVersion: a.modelVersion, usage: a.usage, latencyMs: a.completedAt.getTime() - a.startedAt.getTime(),
    issueCodes: a.issueCodes, transportDiagnostic: diagnostics.codeOf(c.id, a.attemptNumber), rejectionDiagnostic: diagnostics.rejectionOf(c.id, a.attemptNumber) })),
}));

export interface BakeoffInput {
  readonly corpus: EvalCorpus;
  readonly candidates: readonly BakeoffCandidate[];
  readonly capUsd: number;
  readonly maxOutputTokens: number;
  readonly now: () => Date;
  readonly breakerLimit?: number;
}

export async function runBakeoff(input: BakeoffInput) {
  const ledger = createSpendLedger(input.capUsd);
  const breaker = createTransportBreaker(input.breakerLimit ?? CONSECUTIVE_TRANSPORT_FAILURE_LIMIT);
  const stopped = (): boolean => breaker.tripped() || ledger.denied() > 0;
  const pass1: Record<string, EvaluationReport> = {};
  const spentBy: Record<string, number> = {};
  const run = async (candidate: BakeoffCandidate, include?: (c: EvalCase) => boolean): Promise<EvaluationReport> => {
    const before = ledger.spentUsd();
    const report = await evaluateCorpus(input.corpus, {
      provider: candidate.provider, model: candidate.model, realModel: true, now: input.now, budget: ledger.budgetFor(candidate.price, input.maxOutputTokens),
      onCase: (result) => { ledger.record(candidate.price, result.attempts, input.maxOutputTokens); breaker.observe(candidate.id, result); },
      shouldContinue: () => !stopped(),
      ...(include === undefined ? {} : { include }),
    });
    spentBy[candidate.id] = (spentBy[candidate.id] ?? 0) + ledger.spentUsd() - before;
    return report;
  };

  for (const candidate of input.candidates) {
    if (stopped()) break;
    pass1[candidate.id] = await run(candidate);
  }
  // The H7-D0 qualification rule, unchanged.
  // H7-D0k: the language condition is the deterministic cap's (no bypass, no effective violation); a raw exceedance
  // no longer disqualifies. H7-D0v2d (promotion v2, BAR_B): zero BLOCKING failures — reviewable degradations and
  // noncritical accuracy do not disqualify; the reliability rule (no refusal / invalid / unavailable / budget) is unchanged.
  const qualifies = (report: EvaluationReport): boolean => qualifiesForStability(report.blockingCriticalFailures.length, report.languageSupport.bypasses, report.effectiveCapViolations, report.cases.map((c) => c.failureClass));
  const stability: Record<string, { casesRun: number; disagreements: ReturnType<typeof stabilityDisagreements>; transientFailures: number }> = {};
  for (const candidate of input.candidates) {
    const first = pass1[candidate.id];
    if (first === undefined || stopped() || !qualifies(first)) continue;
    const runs: (readonly CaseResult[])[] = [first.cases.filter(CRITICAL)];
    for (let i = 0; i < STABILITY_EXTRA_RUNS && !stopped(); i += 1) runs.push((await run(candidate, CRITICAL)).cases);
    const extra = runs.slice(1).flat();
    stability[candidate.id] = { casesRun: extra.length, disagreements: stabilityDisagreements(runs), transientFailures: extra.filter((c) => c.failureCause !== null && TRANSPORT_CAUSES.includes(c.failureCause)).length };
  }

  const status: BakeoffStatus = breaker.tripped() ? "LIVE_EVAL_ABORTED_CONSECUTIVE_TRANSPORT_FAILURES" : ledger.denied() > 0 ? "AI_BUDGET" : "COMPLETE";
  const invalidReasons: string[] = [];
  if (status !== "COMPLETE") invalidReasons.push(status);
  for (const candidate of input.candidates) {
    const report = pass1[candidate.id];
    if (report === undefined) { invalidReasons.push(`${candidate.id}:not_run`); continue; }
    if (report.cases.length < input.corpus.cases.length) invalidReasons.push(`${candidate.id}:incomplete`);
    const transport = report.cases.filter((c) => c.failureCause !== null && TRANSPORT_CAUSES.includes(c.failureCause)).length + (stability[candidate.id]?.transientFailures ?? 0);
    if (transport > 0) invalidReasons.push(`${candidate.id}:transport_failures:${String(transport)}`);
    if (report.cases.some((c) => c.failureCause !== null && OTHER_PROVIDER_CAUSES.includes(c.failureCause))) invalidReasons.push(`${candidate.id}:provider_failures`);
  }
  return {
    status,
    comparison: invalidReasons.length === 0 ? "VALID_FOR_MODEL_COMPARISON" as const : "INVALID_FOR_MODEL_COMPARISON" as const,
    invalidReasons,
    recommendation: null,
    spentUsd: ledger.spentUsd(),
    budgetDenied: ledger.denied(),
    breaker: { limit: input.breakerLimit ?? CONSECUTIVE_TRANSPORT_FAILURE_LIMIT, tripped: breaker.tripped(), consecutive: breaker.consecutive(), streak: breaker.streak() },
    candidates: input.candidates.map((c) => {
      const report = pass1[c.id];
      if (report === undefined) return { candidate: c.id, status: "NOT_RUN" as const };
      return { ...summary(c, report, spentBy[c.id] ?? 0, input.corpus.cases.length), qualifiedForStability: qualifies(report), stability: stability[c.id] ?? null };
    }),
    cases: Object.fromEntries(input.candidates.flatMap((c) => { const report = pass1[c.id]; return report === undefined ? [] : [[c.id, sanitizedCases(report.cases, c.diagnostics)]]; })),
  };
}

export type BakeoffEvidence = Awaited<ReturnType<typeof runBakeoff>>;
