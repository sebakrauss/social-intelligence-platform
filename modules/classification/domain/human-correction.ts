/**
 * Human corrections (Step H7-A1; Model §15.3, §47; TA §24.2; H7-A0 §18; S13). Pure.
 *
 * A correction is a NEW human assessment of one dimension of one interaction (origin human, attributed to an abstract
 * workspace-member actor, timed). It never edits or deletes a machine assessment; precedence makes it win until a later
 * human correction. "Undo" of a correction is a further human assessment restoring the prior value — history keeps all.
 * Human values are authoritative, so they carry `high` confidence; a person may also record an explicit abstention.
 *
 * Who may correct is decided by the action pipeline (permissions), never here. Feedback that is not a dimension
 * correction — dismiss an alert, mark a suggestion or alert false positive / false negative, "not valuable" — is state
 * of the consuming module (alerts, replies, workflow), never a semantic assessment. Corrections never trigger automation.
 */
import { createAssessment, type AnalysisTarget, type AssessmentViolation, type Assessment, type HumanActor } from "./assessment";
import type { Abstention } from "./confidence";
import type { Dimension } from "./taxonomy";

export interface HumanCorrectionInput {
  readonly ref: string;
  /** The text version the person was looking at. */
  readonly target: AnalysisTarget;
  readonly dimension: Dimension;
  readonly actor: HumanActor;
  readonly correction: { readonly kind: "values"; readonly keys: readonly string[] } | { readonly kind: "abstained"; readonly abstention: Abstention };
  readonly assessedAt: string;
  /** The `ref` of the assessment being corrected (lineage for display), if any. */
  readonly corrects?: string | null;
  readonly topicCatalog?: ReadonlySet<string>;
}

export function createHumanCorrection(input: HumanCorrectionInput): { readonly ok: true; readonly assessment: Assessment } | { readonly ok: false; readonly violations: readonly AssessmentViolation[] } {
  return createAssessment({
    ref: input.ref,
    target: input.target,
    dimension: input.dimension,
    method: { kind: "human", actor: input.actor },
    content: input.correction.kind === "values"
      ? { kind: "values", values: input.correction.keys.map((key) => ({ key, confidence: { level: "high", score: null } })), reasonCodes: [] }
      : { kind: "abstained", abstention: input.correction.abstention },
    assessedAt: input.assessedAt,
    corrects: input.corrects ?? null,
    // A person stating the language is certain of it.
    languageCertainty: input.dimension === "language" && input.correction.kind === "values" ? "certain" : null,
    ...(input.topicCatalog === undefined ? {} : { topicCatalog: input.topicCatalog }),
  });
}
