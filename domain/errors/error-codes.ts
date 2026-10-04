/**
 * Normalized error taxonomy (TA §44.1). Codes are stable identifiers; never rename them.
 */
import type { MessageKey } from "../i18n/message-keys";

export const ERROR_CODES = [
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "MODE_BLOCKED",
  "CAPABILITY_UNSUPPORTED",
  "CAPABILITY_UNKNOWN",
  "CONNECTION_PROBLEM",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TRANSIENT",
  "PROVIDER_PERMANENT",
  "OUTCOME_UNKNOWN",
  "INVALID_INPUT",
  "CONFLICT",
  "STALE_STATE",
  "PROTECTION_VETO",
  "AI_INVALID_OUTPUT",
  "AI_UNAVAILABLE",
  "AI_REFUSED",
  "AI_BUDGET_EXCEEDED",
  "JOB_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Retry classification, from the "Retryable?" column of TA §44.1.
 * - `not_retryable`: retrying can't change the outcome.
 * - `retryable`: transient; retry with backoff (honor retry-after where given).
 * - `after_recovery`: retry only after the connection is recovered.
 * - `verify_first`: the effect may already have happened; reconcile before any resend (R6).
 * - `user_decides`: the person decides whether to proceed (e.g., a teammate replied).
 * - `limited`: at most one bounded re-attempt (e.g., one AI re-ask).
 * - `redrive`: exhausted retries; manual or automatic re-drive only.
 */
export const RETRY_CLASSES = [
  "not_retryable",
  "retryable",
  "after_recovery",
  "verify_first",
  "user_decides",
  "limited",
  "redrive",
] as const;

export type RetryClass = (typeof RETRY_CLASSES)[number];

export interface ErrorDefinition {
  readonly messageKey: MessageKey;
  readonly retry: RetryClass;
}

export const ERROR_DEFINITIONS = {
  PERMISSION_DENIED: { messageKey: "error.permission_denied", retry: "not_retryable" },
  NOT_FOUND: { messageKey: "error.not_found", retry: "not_retryable" },
  MODE_BLOCKED: { messageKey: "error.mode_blocked", retry: "not_retryable" },
  CAPABILITY_UNSUPPORTED: { messageKey: "error.capability_unsupported", retry: "not_retryable" },
  CAPABILITY_UNKNOWN: { messageKey: "error.capability_unknown", retry: "not_retryable" },
  CONNECTION_PROBLEM: { messageKey: "error.connection_problem", retry: "after_recovery" },
  PROVIDER_RATE_LIMITED: { messageKey: "error.provider_rate_limited", retry: "retryable" },
  PROVIDER_TRANSIENT: { messageKey: "error.provider_transient", retry: "retryable" },
  PROVIDER_PERMANENT: { messageKey: "error.provider_permanent", retry: "not_retryable" },
  OUTCOME_UNKNOWN: { messageKey: "error.outcome_unknown", retry: "verify_first" },
  INVALID_INPUT: { messageKey: "error.invalid_input", retry: "not_retryable" },
  CONFLICT: { messageKey: "error.conflict", retry: "not_retryable" },
  STALE_STATE: { messageKey: "error.stale_state", retry: "user_decides" },
  PROTECTION_VETO: { messageKey: "error.protection_veto", retry: "not_retryable" },
  AI_INVALID_OUTPUT: { messageKey: "error.ai_invalid_output", retry: "limited" },
  AI_UNAVAILABLE: { messageKey: "error.ai_unavailable", retry: "retryable" },
  AI_REFUSED: { messageKey: "error.ai_refused", retry: "not_retryable" },
  AI_BUDGET_EXCEEDED: { messageKey: "error.ai_budget_exceeded", retry: "not_retryable" },
  JOB_FAILED: { messageKey: "error.job_failed", retry: "redrive" },
} as const satisfies Record<ErrorCode, ErrorDefinition>;

const errorCodeSet: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && errorCodeSet.has(value);
}
