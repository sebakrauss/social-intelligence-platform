/**
 * Needs review — the pure derivation of WHETHER an interaction belongs in human review and why (Step H7-A1; Model §16,
 * §17.3; UX §8.2 "Needs review: low-confidence items, abuse/insults flagged for review (PD D-34), items whose labels
 * conflict"; TA §20.3, §23.2; PD §12.3; H7-A0 §5, D-H7-2). No queue, view, notification or delivery lives here.
 *
 *   protection_uncertain   Protection Evaluation is UNCERTAIN (incl. failed understanding, unvalidated language)
 *   review_safety_label    an accepted safety value that always routes to review (abuse/insult, harassment, hate
 *                          speech, threat, impersonation, scam/fraud content) — never an automation category
 *   low_confidence         any accepted machine value at `low`
 *   interpretation_conflict an accepted interpretation carries a conflict
 * A `medium` value is shown with a caveat and is not, by itself, a review reason (Model §16).
 */
import type { AcceptedInterpretation } from "./precedence";
import type { ProtectionEvaluation } from "./protection";
import { REVIEW_SAFETY_VALUES, type SafetyValue } from "./taxonomy";

export const NEEDS_REVIEW_POLICY_VERSION = "needs-review.v1" as const;

export const NEEDS_REVIEW_REASONS = ["protection_uncertain", "review_safety_label", "low_confidence", "interpretation_conflict"] as const;
export type NeedsReviewReason = (typeof NEEDS_REVIEW_REASONS)[number];

export interface NeedsReview {
  readonly needsReview: boolean;
  readonly reasons: readonly NeedsReviewReason[];
  readonly reviewSafetyValues: readonly SafetyValue[];
  readonly policyVersion: typeof NEEDS_REVIEW_POLICY_VERSION;
}

export function deriveNeedsReview(input: { readonly protection: ProtectionEvaluation; readonly accepted: readonly AcceptedInterpretation[] }): NeedsReview {
  const reasons = new Set<NeedsReviewReason>();
  if (input.protection.result === "uncertain") reasons.add("protection_uncertain");
  const reviewSafetyValues = new Set<SafetyValue>();
  for (const accepted of input.accepted) {
    if (accepted.status !== "accepted") continue;
    if (accepted.conflict) reasons.add("interpretation_conflict");
    for (const value of accepted.values) {
      if (value.provenance !== "human" && value.confidence.level === "low") reasons.add("low_confidence");
      if (accepted.dimension === "safety" && (REVIEW_SAFETY_VALUES as readonly string[]).includes(value.key)) reviewSafetyValues.add(value.key as SafetyValue);
    }
  }
  if (reviewSafetyValues.size > 0) reasons.add("review_safety_label");
  const ordered = (NEEDS_REVIEW_REASONS as readonly NeedsReviewReason[]).filter((reason) => reasons.has(reason));
  return Object.freeze({
    needsReview: ordered.length > 0,
    reasons: Object.freeze(ordered),
    reviewSafetyValues: Object.freeze(REVIEW_SAFETY_VALUES.filter((value) => reviewSafetyValues.has(value))),
    policyVersion: NEEDS_REVIEW_POLICY_VERSION,
  });
}
