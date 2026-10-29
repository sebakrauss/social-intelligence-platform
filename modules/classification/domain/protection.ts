/**
 * Protection Evaluation (Step H7-A1; Model §17 M-07 CONFIRMED; TA §25.3; PD D-34, D-35, C-02; H7-A0 D-H7-5). Pure.
 *
 * Derived from the ACCEPTED interpretation of the intent dimension — never from keyword matches, safety labels or
 * sentiment (none of them is an input, by type). Result: `protected` · `not_protected` · `uncertain`.
 *
 *   protected       a protected meaning is accepted with high confidence (legitimate complaint, product/service
 *                   problem, fraud/scam accusation against the brand, commercial objection incl. price objection)
 *   uncertain       intent missing, abstained or conflicting; understanding failed; a protected meaning present below
 *                   high; or no protected meaning but not every intent value is high — protection can't be excluded
 *   not_protected   every accepted intent value is high and none is a protected meaning
 *
 * A comment can be abusive AND protected: safety labels never erase protection (D-34). Uncertain is a safety veto for
 * automation (M-07); it never prevents a person from moderating individually.
 *
 * Language (D-H7-5): for an unsupported, uncertain or unknown language, machine-made intent values count as at most
 * `medium` here even if a caller forgot to cap them — so such text is never `not_protected` on machine evidence and
 * never `protected` at high either: it is `uncertain` ⇒ Needs review. A human-accepted intent is authoritative.
 */
import { atLeast, capConfidence } from "./confidence";
import { isLanguageValidated, type LanguageSupport } from "./language";
import type { AcceptedInterpretation } from "./precedence";
import { PRECEDENCE_VERSION } from "./precedence";
import { protectedMeaningOf, type ProtectedMeaning } from "./taxonomy";

export const PROTECTION_POLICY_VERSION = "protection.v1" as const;

export const PROTECTION_RESULTS = ["protected", "not_protected", "uncertain"] as const;
export type ProtectionResult = (typeof PROTECTION_RESULTS)[number];

export const PROTECTION_REASONS = [
  "protected_meaning_high",
  "protected_meaning_below_high",
  "intent_missing",
  "intent_abstained",
  "intent_conflict",
  "intent_below_high",
  "language_not_validated",
  "understanding_failed",
  "no_protected_meaning",
] as const;
export type ProtectionReason = (typeof PROTECTION_REASONS)[number];

export interface ProtectionEvaluation {
  readonly result: ProtectionResult;
  /** Protected meanings accepted with high confidence. */
  readonly meanings: readonly ProtectedMeaning[];
  /** Protected meanings present but below high (they make the result uncertain). */
  readonly candidateMeanings: readonly ProtectedMeaning[];
  readonly reasons: readonly ProtectionReason[];
  /** Identity keys of the assessments behind the accepted intent. */
  readonly supporting: readonly string[];
  readonly policyVersion: typeof PROTECTION_POLICY_VERSION;
  readonly precedenceVersion: typeof PRECEDENCE_VERSION;
}

export interface ProtectionInput {
  readonly intent: AcceptedInterpretation;
  readonly language: LanguageSupport;
  /** True when understanding failed or timed out for the current text version (TA §20.3, §23.2). */
  readonly understandingFailed: boolean;
}

const unique = <T>(items: readonly T[]): readonly T[] => Object.freeze([...new Set(items)]);

export function evaluateProtection(input: ProtectionInput): ProtectionEvaluation {
  if (input.intent.dimension !== "intent") throw new TypeError("protection_requires_intent");
  const intent = input.intent;
  const supporting = intent.status === "none" ? [] : intent.supporting;
  const build = (result: ProtectionResult, reasons: readonly ProtectionReason[], meanings: readonly ProtectedMeaning[] = [], candidateMeanings: readonly ProtectedMeaning[] = []): ProtectionEvaluation =>
    Object.freeze({ result, meanings: unique(meanings), candidateMeanings: unique(candidateMeanings), reasons: unique(reasons), supporting: Object.freeze([...supporting]), policyVersion: PROTECTION_POLICY_VERSION, precedenceVersion: PRECEDENCE_VERSION });

  const human = intent.status !== "none" && intent.basis === "human";
  const reasons: ProtectionReason[] = [];
  if (input.understandingFailed && !human) reasons.push("understanding_failed");
  if (!human && !isLanguageValidated(input.language)) reasons.push("language_not_validated");

  if (intent.status === "none") return build("uncertain", [...reasons, "intent_missing"]);
  if (intent.status === "abstained") return build("uncertain", [...reasons, "intent_abstained"]);
  if (intent.conflict) return build("uncertain", [...reasons, "intent_conflict"]);

  const languageCap = !human && !isLanguageValidated(input.language);
  const values = intent.values.map((v) => (languageCap ? { ...v, confidence: capConfidence(v.confidence, "medium") } : v));
  const high: ProtectedMeaning[] = [];
  const below: ProtectedMeaning[] = [];
  for (const value of values) {
    const meaning = protectedMeaningOf(value.key);
    if (meaning === undefined) continue;
    (atLeast(value.confidence.level, "high") ? high : below).push(meaning);
  }
  if (high.length > 0) return build("protected", [...reasons, "protected_meaning_high"], high, below);
  if (below.length > 0) return build("uncertain", [...reasons, "protected_meaning_below_high"], [], below);
  if (reasons.includes("understanding_failed")) return build("uncertain", reasons);
  if (!values.every((v) => atLeast(v.confidence.level, "high"))) return build("uncertain", [...reasons, "intent_below_high"]);
  return build("not_protected", [...reasons, "no_protected_meaning"]);
}
