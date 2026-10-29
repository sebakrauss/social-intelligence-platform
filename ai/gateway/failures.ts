/**
 * The AI Gateway's typed failures (Step H7-C; TA §22–§23; H7-A0 §11.3). The five classes are exactly the ones H7-A1
 * froze for one understanding attempt (modules/classification `UNDERSTANDING_FAILURE_CLASSES`; a test pins them equal).
 * No class is added: the CAUSE refines a class without changing its meaning, and RETRYABILITY is explicit per cause.
 *
 *   class               cause                              retryable   later runtime behavior (not built here)
 *   AI_UNAVAILABLE      provider_unavailable · timeout ·   yes         bounded transport retry (≤ 3, backoff, honor
 *                       rate_limited                                   retry-after), then AI_FAILED
 *   AI_UNAVAILABLE      task_disabled · kill_switch ·      no          deterministic only until configuration changes
 *                       model_unavailable
 *   AI_INVALID_OUTPUT   invalid_output (after ONE re-ask)  no          no assessment (TA §23.2)
 *   AI_REFUSED          refused                            no          same as invalid (no retry loop)
 *   AI_BUDGET           budget_exhausted                   no          no call until the budget policy allows
 *   AI_INPUT_TOO_LARGE  input_limit · provider_input_limit no          deterministic only (never truncated, never retried)
 *
 * Every failure means less automation and more human review (TA §23.2): no assessment is ever produced from a failure.
 */

export const AI_FAILURE_CLASSES = ["AI_INVALID_OUTPUT", "AI_UNAVAILABLE", "AI_REFUSED", "AI_BUDGET", "AI_INPUT_TOO_LARGE"] as const;
export type AiFailureClass = (typeof AI_FAILURE_CLASSES)[number];

export const AI_FAILURE_CAUSES = [
  "provider_unavailable",
  "timeout",
  "rate_limited",
  "task_disabled",
  "kill_switch",
  "model_unavailable",
  "invalid_output",
  "refused",
  "budget_exhausted",
  "input_limit",
  "provider_input_limit",
] as const;
export type AiFailureCause = (typeof AI_FAILURE_CAUSES)[number];

const CLASS_OF: Readonly<Record<AiFailureCause, AiFailureClass>> = Object.freeze({
  provider_unavailable: "AI_UNAVAILABLE",
  timeout: "AI_UNAVAILABLE",
  rate_limited: "AI_UNAVAILABLE",
  task_disabled: "AI_UNAVAILABLE",
  kill_switch: "AI_UNAVAILABLE",
  model_unavailable: "AI_UNAVAILABLE",
  invalid_output: "AI_INVALID_OUTPUT",
  refused: "AI_REFUSED",
  budget_exhausted: "AI_BUDGET",
  input_limit: "AI_INPUT_TOO_LARGE",
  provider_input_limit: "AI_INPUT_TOO_LARGE",
});

/** Only transient transport causes are retryable — and only by the later runtime, never inside one gateway call. */
const RETRYABLE: readonly AiFailureCause[] = Object.freeze(["provider_unavailable", "timeout", "rate_limited"]);

export interface GatewayFailure {
  readonly class: AiFailureClass;
  readonly cause: AiFailureCause;
  readonly retryable: boolean;
  /** Closed validation issue codes (invalid output only); never model text. */
  readonly issues: readonly string[];
  /** Provider-suggested wait for a rate limit, when given (seconds). */
  readonly retryAfterSeconds: number | null;
}

export function gatewayFailure(cause: AiFailureCause, options: { readonly issues?: readonly string[]; readonly retryAfterSeconds?: number | null } = {}): GatewayFailure {
  return Object.freeze({
    class: CLASS_OF[cause],
    cause,
    retryable: RETRYABLE.includes(cause),
    issues: Object.freeze([...(options.issues ?? [])]),
    retryAfterSeconds: options.retryAfterSeconds ?? null,
  });
}

export const failureClassOf = (cause: AiFailureCause): AiFailureClass => CLASS_OF[cause];
export const isRetryableCause = (cause: AiFailureCause): boolean => RETRYABLE.includes(cause);
