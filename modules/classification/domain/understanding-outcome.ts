/**
 * The deterministic outcome of ONE understanding run for one text version (Step H7-D1b; H7-A0 §9, §11.3; TA §24.1,
 * §25.3). Pure composition of the canonical A1 functions — nothing is re-implemented and nothing is model output:
 *
 *   AI assessments   `toAiAssessments` (language cap D-H7-5) of a validated output; none when the run failed or never ran
 *   accepted         `acceptInterpretation` per closed dimension over the narrow rule assessments + the AI assessments
 *                    (M-05: a rule wins only its one value; a rule-vs-AI clash is accepted with `conflict` ⇒ uncertain)
 *   Protection       `evaluateProtection` (M-07: missing / abstained / conflicting / failed / below high ⇒ uncertain)
 *   Needs review     `deriveNeedsReview`
 *
 * The model emits none of Protection, Needs review, priority or any action: they exist only here, derived by code. A
 * failed run (any of the five failure classes) yields zero AI assessments and `understandingFailed`, so Protection is
 * UNCERTAIN and Needs review follows — less automation, more review (TA §23.2). Human corrections join this composition
 * when the correction feature lands (H7-A0 §18, deferred); until then only rule-origin candidates are accepted here.
 */
import type { Instant } from "@/domain/instant";
import type { AiMethod, AnalysisTarget, Assessment } from "./assessment";
import { languageSupport, type LanguageSupport } from "./language";
import { deriveNeedsReview, type NeedsReview } from "./needs-review";
import { acceptInterpretation, type AcceptedInterpretation } from "./precedence";
import { evaluateProtection, type ProtectionEvaluation } from "./protection";
import { CLOSED_DIMENSIONS, type ClosedDimension } from "./taxonomy";
import { languageResultOf, toAiAssessments, type UnderstandingDimension, type ValidatedUnderstanding } from "./understanding-output";

export type UnderstandingRun =
  | {
    readonly kind: "assessed";
    readonly output: ValidatedUnderstanding;
    readonly method: AiMethod;
    readonly assessedAt: Instant;
    /** One assessment reference per dimension (assigned by the caller). */
    readonly refs: Readonly<Partial<Record<UnderstandingDimension, string>>>;
  }
  | { readonly kind: "failed" }
  | { readonly kind: "not_run" };

export interface UnderstandingOutcomeInput {
  readonly target: AnalysisTarget;
  /** Narrow deterministic rule assessments of the current text version (origin `rule` only). */
  readonly ruleAssessments: readonly Assessment[];
  readonly run: UnderstandingRun;
}

export interface UnderstandingOutcome {
  readonly aiAssessments: readonly Assessment[];
  readonly accepted: Readonly<Partial<Record<ClosedDimension, AcceptedInterpretation>>>;
  readonly languageSupport: LanguageSupport;
  readonly understandingFailed: boolean;
  readonly protection: ProtectionEvaluation;
  readonly needsReview: NeedsReview;
}

export function deriveUnderstandingOutcome(input: UnderstandingOutcomeInput): UnderstandingOutcome {
  if (input.ruleAssessments.some((a) => a.method.kind !== "rule")) throw new TypeError("outcome_rule_candidates_only");
  const { run, target } = input;
  const aiAssessments = run.kind === "assessed" ? toAiAssessments(run.output, { target, method: run.method, assessedAt: run.assessedAt, refs: run.refs }) : Object.freeze([]);
  const candidates = [...input.ruleAssessments, ...aiAssessments];
  const accepted = Object.freeze(Object.fromEntries(CLOSED_DIMENSIONS.map((d) => [d, acceptInterpretation(d, candidates.filter((a) => a.dimension === d), target)]))) as Readonly<Record<ClosedDimension, AcceptedInterpretation>>;
  const support = languageSupport(run.kind === "assessed" ? languageResultOf(run.output) : { kind: "unknown" });
  const understandingFailed = run.kind === "failed";
  const protection = evaluateProtection({ intent: accepted.intent, language: support, understandingFailed });
  const needsReview = deriveNeedsReview({ protection, accepted: Object.values(accepted) });
  return Object.freeze({ aiAssessments, accepted, languageSupport: support, understandingFailed, protection, needsReview });
}
