/**
 * Valuable-comment / priority INPUTS (Step H7-A1; Model §30; H7-A0 §17, D-H7-4). Pure.
 *
 * This is only the derived input projection a future versioned value/priority policy (owned by `workflow`, TA §7.1)
 * will read — never a score: the weighting is OPEN (Model §30 "no fixed formula", "no opaque scores"). It is computed
 * by code from the ACCEPTED interpretation and Protection Evaluation, plus context facts the caller supplies.
 *
 * Not inputs, by construction: watch-term matches (D-H7-3), sentiment, author identity, influence or follower data,
 * demographic, protected or sensitive traits (Model §12: not a CRM). "Lead likelihood" is expressed only through intent.
 */
import type { Instant } from "@/domain/instant";
import type { ConfidenceLevel } from "./confidence";
import type { AcceptedInterpretation } from "./precedence";
import type { ProtectionEvaluation } from "./protection";
import type { ContentSource } from "./understanding-input";

export const VALUE_INPUTS_VERSION = "value-inputs.v1" as const;

export interface AcceptedFlag {
  readonly present: boolean;
  /** The confidence of the value when present; null when absent or not assessed. */
  readonly confidence: ConfidenceLevel | null;
}

export interface ValueInputs {
  readonly purchaseQuestion: AcceptedFlag;
  readonly productOrServiceQuestion: AcceptedFlag;
  readonly responseNeed: string | null;
  readonly escalationRequired: boolean;
  readonly riskLevel: string | null;
  readonly protection: ProtectionEvaluation["result"];
  readonly protectedMeanings: ProtectionEvaluation["meanings"];
  readonly source: ContentSource;
  readonly activeAd: boolean | null;
  readonly providerCreatedAt: Instant | null;
  readonly inputsVersion: typeof VALUE_INPUTS_VERSION;
}

const flag = (accepted: AcceptedInterpretation, keys: readonly string[]): AcceptedFlag => {
  if (accepted.status !== "accepted") return Object.freeze({ present: false, confidence: null });
  const hits = accepted.values.filter((v) => keys.includes(v.key));
  if (hits.length === 0) return Object.freeze({ present: false, confidence: null });
  const levels = hits.map((v) => v.confidence.level);
  return Object.freeze({ present: true, confidence: levels.includes("high") ? "high" : levels.includes("medium") ? "medium" : "low" });
};

const single = (accepted: AcceptedInterpretation): string | null => (accepted.status === "accepted" ? (accepted.values[0]?.key ?? null) : null);

export function deriveValueInputs(input: {
  readonly intent: AcceptedInterpretation;
  readonly responseNeed: AcceptedInterpretation;
  readonly risk: AcceptedInterpretation;
  readonly protection: ProtectionEvaluation;
  readonly context: { readonly source: ContentSource; readonly activeAd: boolean | null; readonly providerCreatedAt: Instant | null };
}): ValueInputs {
  if (input.intent.dimension !== "intent" || input.responseNeed.dimension !== "response_need" || input.risk.dimension !== "risk") throw new TypeError("value_inputs_dimension_mismatch");
  const responseNeed = single(input.responseNeed);
  return Object.freeze({
    purchaseQuestion: flag(input.intent, ["purchase_question"]),
    productOrServiceQuestion: flag(input.intent, ["product_question", "service_question"]),
    responseNeed,
    escalationRequired: responseNeed === "escalation_required",
    riskLevel: single(input.risk),
    protection: input.protection.result,
    protectedMeanings: input.protection.meanings,
    source: input.context.source,
    activeAd: input.context.activeAd,
    providerCreatedAt: input.context.providerCreatedAt,
    inputsVersion: VALUE_INPUTS_VERSION,
  });
}
