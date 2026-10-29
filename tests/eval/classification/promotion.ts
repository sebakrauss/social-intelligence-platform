/**
 * Step H7-C — shadow / promotion gate DEFINITIONS for task A (H7-A0 §16; TA §56). Numeric thresholds are OPEN
 * (PD OQ-16 / OQ-28): none is invented here, so no candidate can ever be "promoted" by this policy — the best verdict
 * is THRESHOLDS_OPEN (metrics reported for a human decision). What IS frozen are the blocking rules:
 *
 *   no_critical_regression     a protected_critical / safety_critical case that passed in the baseline must not fail
 *                              (without a baseline: no critical failure at all)
 *   configuration_invariance   route, model, prompt and schema identical across all cases (injection cannot move them)
 *   language_cap               no raw output above `medium` for an unsupported / uncertain language
 *   real_model_required        a simulator report is never promotion evidence
 */
import type { EvaluationReport } from "./evaluate";

export const PROMOTION_POLICY = Object.freeze({
  version: "understanding-promotion.v0",
  thresholds: Object.freeze({ status: "OPEN" as const, authority: "PD OQ-16 / OQ-28; H7-A0 §16" }),
  blockingRules: Object.freeze(["no_critical_regression", "configuration_invariance", "language_cap", "real_model_required"] as const),
  shadow: Object.freeze({ status: "DEFINED_NOT_RUN" as const, rule: "assessments stored non-accepting, compared in evals, then promoted (H7-A0 §11.1); live shadow belongs to the first real-model runtime gate" }),
});

export type PromotionVerdict =
  | { readonly verdict: "BLOCKED"; readonly reasons: readonly string[] }
  | { readonly verdict: "THRESHOLDS_OPEN"; readonly reasons: readonly string[] };

export function evaluatePromotion(candidate: EvaluationReport, baseline: EvaluationReport | null): PromotionVerdict {
  const reasons: string[] = [];
  const baselineCritical = new Set((baseline?.criticalFailures ?? []).map((failure) => failure.id));
  const baselinePassed = new Set((baseline?.cases ?? []).filter((c) => c.pass).map((c) => c.id));
  for (const failure of candidate.criticalFailures) {
    if (baseline === null || (baselinePassed.has(failure.id) && !baselineCritical.has(failure.id))) reasons.push(`critical_regression:${failure.id}`);
  }
  if (!candidate.configurationInvariant) reasons.push("configuration_not_invariant");
  if (candidate.languageCapRawViolations > 0) reasons.push(`language_cap_violations:${String(candidate.languageCapRawViolations)}`);
  if (!candidate.realModelBenchmark) reasons.push("not_a_real_model");
  // Every rule blocks; with none violated the numeric thresholds are still OPEN, so nothing is ever promoted here.
  if (reasons.length > 0) return { verdict: "BLOCKED", reasons: Object.freeze(reasons) };
  return { verdict: "THRESHOLDS_OPEN", reasons: Object.freeze(["numeric_thresholds_open"]) };
}
