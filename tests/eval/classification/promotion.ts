/**
 * Step H7-C — shadow / promotion gate DEFINITIONS for task A (H7-A0 §16; TA §56). Numeric thresholds are OPEN
 * (PD OQ-16 / OQ-28): none is invented here, so no candidate can ever be "promoted" by this policy — the best verdict
 * is THRESHOLDS_OPEN (metrics reported for a human decision). What IS frozen are the blocking rules:
 *
 *   no_blocking_regression     v2 (H7-D0v2d, BAR_B_FAIL_SAFE): a case with a BLOCKING_CRITICAL severity that passed in
 *                              the baseline is a regression (without a baseline: no blocking failure at all).
 *                              Reviewable degradations and noncritical accuracy never block; they rank (below)
 *   no_blocking_stability      v3 (H7-D0v2g, STABILITY_B_BLOCKING_SAFE): zero BLOCKING stability disagreements over the
 *                              critical-case repeats (`live/stability-policy.ts`); review-routing and semantic-precision
 *                              instability are ranked, never blocking — categorical, no numeric tolerance
 *   configuration_invariance   route, model, prompt and schema identical across all cases (injection cannot move them)
 *   language_cap               v1 (H7-D0k): the deterministic cap holds — no EFFECTIVE semantic confidence above
 *                              `medium` for a non-validated language, and no non-validated language detected as
 *                              validated (a cap bypass); a RAW model confidence above it is reported, never blocking
 *   real_model_required        a simulator report is never promotion evidence
 */
import type { EvaluationReport } from "./evaluate";

export const PROMOTION_POLICY = Object.freeze({
  version: "understanding-promotion.v3",
  thresholds: Object.freeze({ status: "OPEN" as const, authority: "PD OQ-16 / OQ-28; H7-A0 §16" }),
  blockingRules: Object.freeze(["no_blocking_regression", "no_blocking_stability", "configuration_invariance", "language_cap", "real_model_required"] as const),
  shadow: Object.freeze({ status: "DEFINED_NOT_RUN" as const, rule: "assessments stored non-accepting, compared in evals, then promoted (H7-A0 §11.1); live shadow belongs to the first real-model runtime gate" }),
});

/** Ranking-visible quality that does not block (BAR_B): reviewable degradations and noncritical accuracy. */
export interface PromotionSecondary {
  readonly reviewableDegradations: number;
  readonly noncriticalAccuracy: number;
}

export type PromotionVerdict =
  | { readonly verdict: "BLOCKED"; readonly reasons: readonly string[]; readonly secondary: PromotionSecondary }
  | { readonly verdict: "THRESHOLDS_OPEN"; readonly reasons: readonly string[]; readonly secondary: PromotionSecondary };

export function evaluatePromotion(candidate: EvaluationReport, baseline: EvaluationReport | null): PromotionVerdict {
  const reasons: string[] = [];
  const baselineBlocking = new Set((baseline?.blockingCriticalFailures ?? []).map((failure) => failure.id));
  const baselinePassed = new Set((baseline?.cases ?? []).filter((c) => c.pass).map((c) => c.id));
  for (const failure of candidate.blockingCriticalFailures) {
    if (baseline === null || (baselinePassed.has(failure.id) && !baselineBlocking.has(failure.id))) reasons.push(`blocking_regression:${failure.id}`);
  }
  if (!candidate.configurationInvariant) reasons.push("configuration_not_invariant");
  if (candidate.effectiveCapViolations > 0) reasons.push(`language_cap_effective_violations:${String(candidate.effectiveCapViolations)}`);
  if (candidate.languageSupport.bypasses > 0) reasons.push(`language_cap_bypasses:${String(candidate.languageSupport.bypasses)}`);
  if (!candidate.realModelBenchmark) reasons.push("not_a_real_model");
  const secondary = Object.freeze({ reviewableDegradations: candidate.reviewableDegradations.length, noncriticalAccuracy: candidate.noncriticalAccuracy.length });
  // Every rule blocks; with none violated the numeric thresholds are still OPEN, so nothing is ever promoted here.
  if (reasons.length > 0) return { verdict: "BLOCKED", reasons: Object.freeze(reasons), secondary };
  return { verdict: "THRESHOLDS_OPEN", reasons: Object.freeze(["numeric_thresholds_open"]), secondary };
}

/** Promotion v3 qualification (BAR_B + STABILITY_B): all three conditions, and the stability evidence must exist. */
export interface PromotionQualificationInput {
  readonly pass1BlockingCriticalFailures: number;
  readonly stabilityBlockingDisagreements: number | null; // null = no stability evidence
  readonly systemicReliabilityFailures: number;
}
export function qualifiesForPromotion(input: PromotionQualificationInput): { readonly qualified: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (input.pass1BlockingCriticalFailures > 0) reasons.push(`pass1_blocking_critical:${String(input.pass1BlockingCriticalFailures)}`);
  if (input.stabilityBlockingDisagreements === null) reasons.push("stability_not_run");
  else if (input.stabilityBlockingDisagreements > 0) reasons.push(`blocking_stability:${String(input.stabilityBlockingDisagreements)}`);
  if (input.systemicReliabilityFailures > 0) reasons.push(`systemic_reliability:${String(input.systemicReliabilityFailures)}`);
  return Object.freeze({ qualified: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** The candidate facts the frozen comparison hierarchy reads (from a bake-off summary + its stability result). */
export interface RankingFacts {
  readonly candidate: string;
  readonly blocking: number;
  readonly blockingStability: number | null; // null = stability not run (ranks after any measured value)
  readonly languageInvariant: number; // cap bypasses + effective-cap violations
  readonly protectedMeaningMisses: number;
  readonly safetyFalseNegatives: number;
  readonly reliabilityFailures: number; // schema + refusal + transient + other provider failures
  readonly reviewRoutingInstability: number | null;
  readonly reviewableDegradations: number;
  readonly semanticPrecisionInstability: number | null;
  readonly precisionMisses: number; // failed cases (exact semantic precision)
  readonly latencyP50Ms: number | null;
  readonly costUsd: number;
}

/**
 * The frozen hierarchy (H7-D0v2d BAR_B + H7-D0v2g STABILITY_B): 1 blocking critical · 2 blocking stability · 3 language
 * invariant · 4 protected meaning · 5 safety false negatives · 6 systemic reliability · 7 review-routing instability ·
 * 8 reviewable degradations · 9 semantic-precision instability · 10 exact precision · 11 latency · 12 cost.
 * Strictly lexicographic, so a lower cost can never outrank worse fail-safe quality. An ORDERING, never a selection.
 */
export function compareCandidates(a: RankingFacts, b: RankingFacts): number {
  const nullable = (x: number | null): number => (x === null ? Number.POSITIVE_INFINITY : x);
  const keys: ((f: RankingFacts) => number)[] = [
    (f) => f.blocking, (f) => nullable(f.blockingStability), (f) => f.languageInvariant, (f) => f.protectedMeaningMisses, (f) => f.safetyFalseNegatives,
    (f) => f.reliabilityFailures, (f) => nullable(f.reviewRoutingInstability), (f) => f.reviewableDegradations, (f) => nullable(f.semanticPrecisionInstability),
    (f) => f.precisionMisses, (f) => nullable(f.latencyP50Ms), (f) => f.costUsd,
  ];
  for (const key of keys) {
    const d = key(a) - key(b);
    if (d !== 0 && !Number.isNaN(d)) return d;
  }
  return a.candidate.localeCompare(b.candidate);
}
