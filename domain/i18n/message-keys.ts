/**
 * Stable, language-independent message keys (PD §16.7; TA §3.1, §44.2).
 *
 * Code refers to user-facing text only through these keys; the text itself lives in
 * locale catalogs (`platform/i18n`). Keys are lowercase dotted identifiers and are never
 * renamed once shipped.
 */
export const MESSAGE_KEYS = [
  "error.permission_denied",
  "error.not_found",
  "error.mode_blocked",
  "error.capability_unsupported",
  "error.capability_unknown",
  "error.connection_problem",
  "error.provider_rate_limited",
  "error.provider_transient",
  "error.provider_permanent",
  "error.outcome_unknown",
  "error.invalid_input",
  "error.conflict",
  "error.stale_state",
  "error.protection_veto",
  "error.ai_invalid_output",
  "error.ai_unavailable",
  "error.ai_refused",
  "error.ai_budget_exceeded",
  "error.job_failed",
  "auth.sign_in.heading",
  "auth.sign_in.submit",
  "auth.sign_in.link",
  "auth.sign_in_link.heading",
  "auth.sign_in_link.submit",
  "auth.sign_out.submit",
  "auth.field.email",
  "auth.field.password",
  "auth.status.signed_in",
  "auth.status.signed_out",
  "auth.status.invalid_credentials",
  "auth.status.verification_required",
  "auth.status.link_sent",
  "auth.status.invalid_link",
  "auth.status.rate_limited",
  "auth.status.invalid_input",
  "auth.status.unavailable",
  "auth.sign_up.heading",
  "auth.sign_up.submit",
  "auth.sign_up.link",
  "auth.status.sign_up_check_email",
  "auth.status.weak_password",
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

export const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const messageKeySet: ReadonlySet<string> = new Set(MESSAGE_KEYS);

export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === "string" && messageKeySet.has(value);
}
