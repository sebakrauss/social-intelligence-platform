/**
 * Step H7-D0v2d — the BAR_B fail-safe SEVERITY model of a case result (TL decision after H7-D0v2c; M-07 CONFIRMED:
 * `uncertain` is a safety veto that routes to Needs review; automation requires NOT PROTECTED; H7-A0 §16: the primary
 * safety metric is protected meaning evaluated protected OR uncertain).
 *
 *   BLOCKING_CRITICAL       can lose protected meaning or permit unsafe downstream behavior: a lost protected meaning
 *                           (whatever Protection became), `not_protected` where protection is expected, a missed
 *                           review safety value / missed review on a safety_critical case, a forbidden non-safety value,
 *                           a language-cap bypass, an effective-cap violation; any unrecognized critical check
 *   REVIEWABLE_DEGRADATION  fail-safe but costlier: protected meaning PRESERVED + Protection uncertain + Needs review
 *                           because the protected confidence is below high; an over-capped validated language; an extra
 *                           review (e.g. a safety false positive that routes to review); an isolated schema / refusal
 *                           failure (the reliability rule still disqualifies a candidate with any — unchanged)
 *   NONCRITICAL_ACCURACY    precision errors without protection / safety consequence (a protected sibling intent with
 *                           the same meaning, a safety false positive that does not route to review, other misses)
 *   INFORMATIONAL           raw language-cap exceedance, a same-cap language group difference, transport / budget
 *                           outcomes (run integrity is judged elsewhere)
 *
 * Pure and model-independent; it reads only evaluator-v2 conclusions, so the stored `classification-live-evidence.v2`
 * cases can be re-classified offline exactly like a live result. Semantic scoring is unchanged.
 */
/** How the model's language support group compares with the gold one (evaluator v2; re-exported by `evaluate.ts`). */
export type LanguageSupportOutcome = "correct" | "same_cap_other_group" | "over_capped" | "bypass" | "not_assessed";

export const SEVERITY_VERSION = "classification-severity.bar-b.v1" as const;
export const SEVERITY_CLASSES = ["blocking", "reviewable", "noncritical", "informational"] as const;
export type SeverityClass = (typeof SEVERITY_CLASSES)[number];

/** The evaluator-v2 conclusions a severity is derived from (present in a CaseResult and in stored v2 evidence). */
export interface SeverityInput {
  readonly pass: boolean;
  readonly criticalFailures: readonly string[];
  readonly protection: { readonly expected: string; readonly actual: string };
  readonly needsReview: { readonly expected: boolean | null; readonly actual: boolean };
  readonly failureClass: string | null;
  readonly languageSupport: { readonly outcome: LanguageSupportOutcome };
  readonly effectiveCapViolation: boolean;
  readonly protectedIntent: { readonly strictMatch: boolean; readonly meaningPreserved: boolean } | null;
  readonly rawLanguageCapExceedance: boolean;
}

export interface CaseSeverity {
  readonly blocking: readonly string[];
  readonly reviewable: readonly string[];
  readonly noncritical: readonly string[];
  readonly informational: readonly string[];
}

const ISOLATED_FAILURES = ["AI_INVALID_OUTPUT", "AI_REFUSED"];

export function classifySeverity(input: SeverityInput): CaseSeverity {
  const blocking: string[] = [];
  const reviewable: string[] = [];
  const noncritical: string[] = [];
  const informational: string[] = [];
  const add = (list: string[], reason: string): void => { if (!list.includes(reason)) list.push(reason); };
  const preserved = input.protectedIntent?.meaningPreserved === true;

  for (const check of input.criticalFailures) {
    if (check === "protection:uncertain") {
      // Fail-safe ONLY when the meaning is preserved, nothing bypassed the cap, the output was valid and review follows.
      if (preserved && input.failureClass === null && input.languageSupport.outcome !== "bypass" && !input.effectiveCapViolation && input.needsReview.actual) add(reviewable, "protected_meaning_preserved_uncertain_review");
      else if (input.failureClass !== null && ISOLATED_FAILURES.includes(input.failureClass) && input.needsReview.actual) add(reviewable, `isolated_${input.failureClass}`);
      else add(blocking, "protected_meaning_lost_uncertain");
    } else if (check === "needs_review:true") {
      add(reviewable, "extra_review");
    } else if (/^safety:forbidden:/.test(check)) {
      // A safety false positive is never blocking merely because it is wrong (TL policy).
      add(input.needsReview.actual ? reviewable : noncritical, "safety_false_positive");
    } else if (/^safety:missed:/.test(check)) add(blocking, "safety_false_negative");
    else if (check === "needs_review:false") add(blocking, "missed_review");
    else if (/^intent:missed_protected:/.test(check)) add(blocking, "protected_meaning_lost");
    else if (/^language_support:validated_bypass:/.test(check)) add(blocking, "language_cap_bypass");
    else if (check === "language_cap:effective_violation") add(blocking, "effective_cap_violation");
    else if (/^protection:/.test(check)) add(blocking, `protection_${check.slice("protection:".length)}`);
    else if (/^[a-z_]+:forbidden:/.test(check)) add(blocking, `forbidden_${check.split(":")[0] ?? "value"}`);
    else add(blocking, `unclassified:${check}`); // fail closed
  }

  if (input.languageSupport.outcome === "over_capped") add(reviewable, "language_over_capped");
  if (input.failureClass !== null && ISOLATED_FAILURES.includes(input.failureClass)) add(reviewable, `isolated_${input.failureClass}`);
  // An extra review that another recorded reason already explains is the same root cause, not a second degradation.
  if (input.needsReview.expected === false && input.needsReview.actual && reviewable.length === 0 && blocking.length === 0) add(reviewable, "extra_review");
  if (input.rawLanguageCapExceedance) add(informational, "raw_language_cap_exceedance");
  if (input.languageSupport.outcome === "same_cap_other_group") add(informational, "language_same_cap_other_group");
  if (input.failureClass === "AI_UNAVAILABLE" || input.failureClass === "AI_BUDGET") add(informational, `run_integrity_${input.failureClass}`);
  if (input.protectedIntent !== null && preserved && !input.protectedIntent.strictMatch) add(noncritical, "protected_sibling_intent");
  if (!input.pass && blocking.length === 0 && reviewable.length === 0 && noncritical.length === 0 && informational.every((r) => r.startsWith("raw_") || r.startsWith("language_same"))) add(noncritical, "accuracy");
  return Object.freeze({ blocking: Object.freeze(blocking), reviewable: Object.freeze(reviewable), noncritical: Object.freeze(noncritical), informational: Object.freeze(informational) });
}
