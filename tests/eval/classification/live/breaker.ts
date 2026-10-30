/**
 * Step H7-D0a — the live bake-off's consecutive TRANSPORT-failure circuit breaker (evaluation only; the product gateway
 * and runtime never use it). Frozen threshold K = 3.
 *
 *   counts      a case whose gateway failure cause is a retryable transport cause (provider_unavailable · timeout ·
 *               rate_limited)
 *   resets      any provider response (an attempt that was accepted, invalid or refused — the network worked)
 *   neither     a case that never reached a provider (input too large, budget denial)
 *   semantic    wrong answers, schema failures, refusals and language-cap violations never count
 *
 * When it trips, the whole bake-off stops (no later case, no later candidate): the environment is no longer trustworthy
 * for a comparison, and the run is INVALID_FOR_MODEL_COMPARISON.
 */
import type { CaseResult } from "../evaluate";

export const CONSECUTIVE_TRANSPORT_FAILURE_LIMIT = 3;
export const TRANSPORT_CAUSES: readonly string[] = Object.freeze(["provider_unavailable", "timeout", "rate_limited"]);
const PROVIDER_RESPONDED = ["accepted", "invalid_output", "refused"];

export interface TransportBreaker {
  observe(candidate: string, result: CaseResult): void;
  tripped(): boolean;
  consecutive(): number;
  /** The failures of the tripping streak (candidate + case ids), for the evidence. */
  streak(): readonly { readonly candidate: string; readonly caseId: string }[];
}

export function createTransportBreaker(limit = CONSECUTIVE_TRANSPORT_FAILURE_LIMIT): TransportBreaker {
  let streak: { candidate: string; caseId: string }[] = [];
  let tripped = false;
  return {
    observe(candidate, result) {
      if (tripped) return;
      if (result.attempts.some((attempt) => PROVIDER_RESPONDED.includes(attempt.outcome))) {
        streak = [];
        return;
      }
      if (result.failureCause !== null && TRANSPORT_CAUSES.includes(result.failureCause)) {
        streak = [...streak, { candidate, caseId: result.id }];
        if (streak.length >= limit) tripped = true;
      }
    },
    tripped: () => tripped,
    consecutive: () => streak.length,
    streak: () => Object.freeze([...streak]),
  };
}
