/**
 * Step H7-D0v2g — the STABILITY_B_BLOCKING_SAFE policy (TL decision after H7-D0v2f): stability proves PRODUCTION-SAFETY
 * reproducibility, not exact semantic reproducibility. Every critical case's observations (stored pass 1 + repeats)
 * are classified into exactly one class; only BLOCKING_STABILITY blocks promotion — categorically, no numeric tolerance.
 *
 *   blocking            any observation carries a BAR_B blocking severity (incl. a lost protected meaning or
 *                       `not_protected` where protection is expected), a language-cap bypass, an effective-cap
 *                       violation or a failure class (no usable fail-safe output); or the safety outcome differs
 *                       across observations of a safety_critical case
 *   review_routing      no blocking condition; Protection or Needs review differ (e.g. protected + NR=false ↔
 *                       uncertain + NR=true with the protected meaning preserved) — fail-safe, ranked, shadow-monitored
 *   semantic_precision  no blocking condition, Protection and Needs review identical; labels or a language-accuracy
 *                       outcome differ (risk level, abstention ↔ a non-protected value, an extra non-protected intent,
 *                       a same-meaning protected sibling, an over-capped ↔ correct language at equal routing)
 *   informational       only a same-cap language-group difference (product behavior unchanged); identical
 *                       observations carry no class at all (latency / usage are never compared)
 *
 * v1 (implicit; H7-D0v2e) = exact zero disagreements. Pure, deterministic, model-independent.
 */
import type { CaseSeverity } from "../severity";
import type { SignatureFields } from "./stability";

export const STABILITY_POLICY_VERSION = "classification-stability-policy.v2" as const;
export const PREVIOUS_STABILITY_POLICY = "classification-stability-policy.v1 (exact zero disagreements, implicit)" as const;
export const STABILITY_CLASSES = ["blocking", "review_routing", "semantic_precision", "informational"] as const;
export type StabilityClass = (typeof STABILITY_CLASSES)[number];

/** One observation of a critical case: its signature fields plus its BAR_B severity (null when not recorded). */
export interface StabilityObservation extends SignatureFields {
  readonly severity: Pick<CaseSeverity, "blocking" | "reviewable"> | null;
}

export interface CaseStability {
  readonly id: string;
  readonly class: StabilityClass | null; // null = all observations identical and nothing blocking
  readonly reasons: readonly string[];
}

const same = (values: readonly unknown[]): boolean => new Set(values.map((v) => JSON.stringify(v))).size <= 1;
const sortedLabels = (o: StabilityObservation): Record<string, readonly string[]> => Object.fromEntries(Object.entries(o.labels).map(([d, v]) => [d, [...v].sort()]));

export function classifyStabilityCase(id: string, tags: readonly string[], observations: readonly StabilityObservation[]): CaseStability {
  const reasons: string[] = [];
  if (observations.length < 2) reasons.push("incomplete_observations");
  if (observations.some((o) => o.severity === null)) reasons.push("severity_unrecorded");
  if (observations.some((o) => (o.severity?.blocking.length ?? 0) > 0)) reasons.push("blocking_severity");
  if (observations.some((o) => o.languageSupport.outcome === "bypass")) reasons.push("language_cap_bypass");
  if (observations.some((o) => o.effectiveCapViolation)) reasons.push("effective_cap_violation");
  if (observations.some((o) => o.failureClass !== null)) reasons.push("no_usable_output");
  if (tags.includes("safety_critical") && !same(observations.map((o) => [...(o.labels["safety"] ?? [])].sort()))) reasons.push("safety_outcome_changed");
  if (reasons.length > 0) return Object.freeze({ id, class: "blocking", reasons: Object.freeze(reasons) });

  if (!same(observations.map((o) => o.protection.actual)) || !same(observations.map((o) => o.needsReview.actual))) {
    return Object.freeze({ id, class: "review_routing", reasons: Object.freeze(["protection_or_review_routing_changed"]) });
  }
  const outcomes = observations.map((o) => o.languageSupport.outcome);
  if (!same(observations.map(sortedLabels))) return Object.freeze({ id, class: "semantic_precision", reasons: Object.freeze(["labels_changed"]) });
  if (!same(outcomes)) {
    const sameCap = outcomes.every((o) => o === "correct" || o === "same_cap_other_group");
    return Object.freeze({ id, class: sameCap ? "informational" : "semantic_precision", reasons: Object.freeze([sameCap ? "same_cap_language_group" : "language_accuracy_changed"]) });
  }
  return Object.freeze({ id, class: null, reasons: Object.freeze([]) });
}

export function summarizeStability(cases: readonly CaseStability[]) {
  const ids = (cls: StabilityClass) => cases.filter((c) => c.class === cls).map((c) => c.id);
  const blocking = ids("blocking");
  return {
    stabilityPolicyVersion: STABILITY_POLICY_VERSION,
    blocking, reviewRouting: ids("review_routing"), semanticPrecision: ids("semantic_precision"), informational: ids("informational"),
    /** STABILITY_B: categorical — zero blocking stability disagreements. */
    qualifies: blocking.length === 0 && cases.length > 0,
  };
}
