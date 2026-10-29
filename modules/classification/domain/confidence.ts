/**
 * Confidence and abstention (Step H7-A1; Model §16; TA §23.1; H7-A0 §4.4). Pure.
 *
 * Confidence is PER VALUE, as a qualitative level. A numeric score may accompany it as optional evidence only: the
 * score → level mapping and every numeric threshold are PD OQ-16 / OQ-28 (OPEN) — none is chosen here, and nothing in
 * this domain reads a score to decide behavior.
 *
 *   high      reliable for operational use
 *   medium    usable with a caveat; never automation-eligible
 *   low       needs review; no automatic action; no automatically prepared suggestion
 *
 * Abstention is explicit and is not a value: `none_fits` (no value of the dimension applies) or
 * `insufficient_evidence` (the text doesn't allow a judgment). A missing assessment is neither — it is "no assessment"
 * (TA §23.2), never a default value.
 */

export const CONFIDENCE_CONTRACT_VERSION = "confidence.v1" as const;

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const ABSTENTIONS = ["none_fits", "insufficient_evidence"] as const;
export type Abstention = (typeof ABSTENTIONS)[number];

export interface ValueConfidence {
  readonly level: ConfidenceLevel;
  /** Optional evidence in [0, 1]; never authoritative (thresholds OPEN). */
  readonly score: number | null;
}

const RANK: Readonly<Record<ConfidenceLevel, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

export const isConfidenceLevel = (value: unknown): value is ConfidenceLevel => typeof value === "string" && (CONFIDENCE_LEVELS as readonly string[]).includes(value);
export const isAbstention = (value: unknown): value is Abstention => typeof value === "string" && (ABSTENTIONS as readonly string[]).includes(value);
export const isConfidenceScore = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export const compareConfidence = (a: ConfidenceLevel, b: ConfidenceLevel): number => RANK[a] - RANK[b];
export const atLeast = (level: ConfidenceLevel, floor: ConfidenceLevel): boolean => RANK[level] >= RANK[floor];

/** The level, never above `max` (the score is kept as evidence; it does not override the cap). */
export function capConfidence(confidence: ValueConfidence, max: ConfidenceLevel): ValueConfidence {
  return RANK[confidence.level] <= RANK[max] ? confidence : Object.freeze({ level: max, score: confidence.score });
}
