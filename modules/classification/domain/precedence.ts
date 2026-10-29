/**
 * Accepted interpretation by interpretive precedence (Step H7-A1; Model §15.2 M-05 CONFIRMED; TA §24.1–§24.2). Pure.
 *
 * Per dimension, from the candidate assessments of ONE interaction:
 *   1. human     the latest human assessment of the dimension wins — whichever text version it was made on (TA §24.2:
 *                a later machine assessment never outranks a human correction). `humanOnEarlierVersion` says when it
 *                was made on an earlier text version (M-09 OPEN: whether a person must revisit it; the UI shows it).
 *   2. rule      a deterministic rule wins ONLY for the one value it establishes (RULE_ESTABLISHES), on the current
 *                text version; it never decides the rest of the dimension.
 *   3. ai        the latest valid AI assessment for the CURRENT text version.
 *   4. hint      the latest platform hint for the current text version, only when there is no AI assessment.
 *
 * The result is DERIVED: nothing is overwritten, every candidate stays history; recomputing with more candidates
 * yields a new result. Outcomes: `accepted` (values) · `abstained` (explicit abstention won) · `none` (no assessment:
 * never a default or negative value). A multi-valued dimension where a rule value displaces an exclusive `none`
 * is accepted with `conflict = true` (protection then treats it as uncertain).
 */
import { compareInstants } from "@/domain/instant";
import { RULE_ESTABLISHES, assessmentIdentityKey, provenanceOf, sameInteraction, type AnalysisTarget, type Assessment, type ProvenanceClass } from "./assessment";
import type { Abstention, ValueConfidence } from "./confidence";
import { TAXONOMY, isClosedDimension, type ClosedDimensionDefinition, type Dimension } from "./taxonomy";

export const PRECEDENCE_VERSION = "precedence.m05.v1" as const;

export interface AcceptedValue {
  readonly key: string;
  readonly confidence: ValueConfidence;
  readonly provenance: ProvenanceClass;
  /** Identity key of the assessment the value comes from. */
  readonly from: string;
}

export type AcceptedInterpretation =
  | {
    readonly status: "accepted";
    readonly dimension: Dimension;
    readonly target: AnalysisTarget;
    readonly values: readonly AcceptedValue[];
    readonly basis: "human" | "machine";
    readonly humanOnEarlierVersion: boolean;
    readonly conflict: boolean;
    readonly supporting: readonly string[];
    readonly precedenceVersion: typeof PRECEDENCE_VERSION;
  }
  | {
    readonly status: "abstained";
    readonly dimension: Dimension;
    readonly target: AnalysisTarget;
    readonly abstention: Abstention;
    readonly basis: "human" | "machine";
    readonly humanOnEarlierVersion: boolean;
    readonly supporting: readonly string[];
    readonly precedenceVersion: typeof PRECEDENCE_VERSION;
  }
  | {
    readonly status: "none";
    readonly dimension: Dimension;
    readonly target: AnalysisTarget;
    readonly precedenceVersion: typeof PRECEDENCE_VERSION;
  };

const latest = (assessments: readonly Assessment[]): Assessment | undefined =>
  [...assessments].sort((a, b) => compareInstants(a.assessedAt, b.assessedAt) || (assessmentIdentityKey(a) < assessmentIdentityKey(b) ? -1 : 1)).at(-1);

const valuesOf = (assessment: Assessment): readonly AcceptedValue[] =>
  assessment.content.kind === "values"
    ? assessment.content.values.map((v) => Object.freeze({ key: v.key, confidence: v.confidence, provenance: provenanceOf(assessment.method), from: assessmentIdentityKey(assessment) }))
    : [];

function fromSingle(dimension: Dimension, current: AnalysisTarget, winner: Assessment, basis: "human" | "machine"): AcceptedInterpretation {
  const humanOnEarlierVersion = basis === "human" && winner.target.sourceTextVersionId !== current.sourceTextVersionId;
  const supporting = Object.freeze([assessmentIdentityKey(winner)]);
  if (winner.content.kind === "abstained") {
    return Object.freeze({ status: "abstained" as const, dimension, target: current, abstention: winner.content.abstention, basis, humanOnEarlierVersion, supporting, precedenceVersion: PRECEDENCE_VERSION });
  }
  return Object.freeze({ status: "accepted" as const, dimension, target: current, values: Object.freeze(valuesOf(winner)), basis, humanOnEarlierVersion, conflict: false, supporting, precedenceVersion: PRECEDENCE_VERSION });
}

/**
 * The accepted interpretation of `dimension` for the interaction's CURRENT text version `current`. Every candidate must
 * belong to the same workspace and interaction and to the dimension (a caller bug otherwise: it throws).
 */
export function acceptInterpretation(dimension: Dimension, candidates: readonly Assessment[], current: AnalysisTarget): AcceptedInterpretation {
  for (const candidate of candidates) {
    if (!sameInteraction(candidate.target, current) || candidate.dimension !== dimension) throw new TypeError("precedence_candidate_out_of_scope");
  }
  const human = latest(candidates.filter((a) => a.method.kind === "human"));
  if (human !== undefined) return fromSingle(dimension, current, human, "human");

  const onCurrent = candidates.filter((a) => a.target.sourceTextVersionId === current.sourceTextVersionId);
  const rules = onCurrent.filter((a) => a.method.kind === "rule" && a.content.kind === "values");
  const ai = latest(onCurrent.filter((a) => a.method.kind === "ai"));
  const hint = ai === undefined ? latest(onCurrent.filter((a) => a.method.kind === "platform_hint")) : undefined;
  const base = ai ?? hint;

  if (rules.length === 0) {
    return base === undefined ? Object.freeze({ status: "none" as const, dimension, target: current, precedenceVersion: PRECEDENCE_VERSION }) : fromSingle(dimension, current, base, "machine");
  }

  // Rule values win for exactly the value each rule establishes; the rest of the dimension comes from AI (or hint).
  const ruleValues = rules.flatMap((rule) => valuesOf(rule).filter((v) => rule.method.kind === "rule" && RULE_ESTABLISHES[rule.method.rule].value === v.key));
  const definition = TAXONOMY[dimension];
  const exclusive = isClosedDimension(dimension) ? (definition as ClosedDimensionDefinition).exclusive : [];
  const baseValues = base === undefined ? [] : valuesOf(base);
  let conflict = false;
  let values: AcceptedValue[];
  const [firstRule] = ruleValues;
  if (firstRule === undefined) {
    return base === undefined ? Object.freeze({ status: "none" as const, dimension, target: current, precedenceVersion: PRECEDENCE_VERSION }) : fromSingle(dimension, current, base, "machine");
  }
  if (definition.cardinality === "single") {
    const [first] = baseValues;
    conflict = first !== undefined && first.key !== firstRule.key;
    values = [firstRule];
  } else {
    const ruled = new Set(ruleValues.map((v) => v.key));
    const kept = baseValues.filter((v) => !ruled.has(v.key) && !exclusive.includes(v.key));
    conflict = baseValues.some((v) => exclusive.includes(v.key));
    values = [...kept, ...ruleValues.filter((v, i, all) => all.findIndex((w) => w.key === v.key) === i)];
  }
  const supporting = Object.freeze([...rules.map(assessmentIdentityKey), ...(base === undefined ? [] : [assessmentIdentityKey(base)])].sort());
  return Object.freeze({ status: "accepted" as const, dimension, target: current, values: Object.freeze(values), basis: "machine" as const, humanOnEarlierVersion: false, conflict, supporting, precedenceVersion: PRECEDENCE_VERSION });
}
