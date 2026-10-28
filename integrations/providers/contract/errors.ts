/**
 * Normalized provider errors (TA §15.2, §44). Adapters translate every provider failure into exactly one of
 * these; provider SDK errors, HTTP responses and raw bodies never cross the boundary.
 *
 * Rules:
 *   - an error's message is its stable kind code, never provider prose or a response body;
 *   - fields are closed vocabularies, numbers and identifiers: never credentials, tokens or content;
 *   - retry metadata is explicit (`retry`, `retryAfterSeconds`);
 *   - OutcomeUnknown is NOT a failure: the effect may have happened. It must stay ambiguous until
 *     reconciliation decides (R6; TA §18.3). A timeout after sending is OutcomeUnknown, never Transient.
 *
 * Mapping these to the product's error codes, capability profiles and connection health is the consumers'
 * job (Steps 5, 6, 9); nothing here decides product behavior.
 */

export const READ_OPERATIONS = [
  "discoverAssets",
  "describeAccount",
  "listContent",
  "listInteractions",
  "getInteraction",
  "getContent",
  "getCurrentState",
  "retrievePaidContext",
  "parseWebhook",
  "subscribe",
  "unsubscribe",
  "refreshCredential",
] as const;

export const MUTATION_OPERATIONS = ["replyPublicly", "replyPrivately", "hide", "unhide", "delete", "block"] as const;

/** Authorization-code grant operations (./authorization-port). */
export const AUTHORIZATION_OPERATIONS = ["authorizationRequest", "parseCallback", "exchangeCode"] as const;

export type ReadOperation = (typeof READ_OPERATIONS)[number];
export type MutationOperation = (typeof MUTATION_OPERATIONS)[number];
export type AuthorizationOperation = (typeof AUTHORIZATION_OPERATIONS)[number];
export type ProviderOperation = ReadOperation | MutationOperation | AuthorizationOperation;

/** What a missing permission blocks, in normalized terms (never a provider scope name). */
export const PERMISSION_CAPABILITIES = [
  "discover_assets",
  "read_account",
  "read_content",
  "read_interactions",
  "read_paid_context",
  "manage_webhooks",
  "reply_public",
  "reply_private",
  "hide",
  "delete",
  "block",
] as const;
export type PermissionCapability = (typeof PERMISSION_CAPABILITIES)[number];

export const TRANSIENT_REASONS = ["timeout_before_send", "network", "provider_unavailable", "server_error", "unknown"] as const;
export type TransientReason = (typeof TRANSIENT_REASONS)[number];

export const NOT_ELIGIBLE_REASONS = ["unsupported_for_target", "target_state", "wrong_target_kind"] as const;
export type NotEligibleReason = (typeof NOT_ELIGIBLE_REASONS)[number];

export const CREDENTIAL_INVALID_REASONS = ["expired", "revoked", "malformed", "unknown"] as const;
export type CredentialInvalidReason = (typeof CREDENTIAL_INVALID_REASONS)[number];

/**
 * Why an outcome is unknown, when the adapter can tell (Step 7G-H5.5-P12-C0-R5A). Diagnostic only: every reason is the
 * same OutcomeUnknownError (verify before any resend). Each names a transport branch or the token-response check that
 * failed, never a value: no body, token, code or field content is carried. `null` when the adapter doesn't classify.
 * An absent token expiry is NOT an outcome-unknown condition (Step 7G-H5.5-P12-C0-R5F: expiry unknown, accepted).
 */
export const OUTCOME_UNKNOWN_REASONS = [
  "network_error",
  "timeout",
  "unexpected_redirect",
  "response_too_large",
  "response_not_utf8",
  "unrecognized_4xx_response",
  "unrecognized_5xx_response",
  "unrecognized_status_response",
  "token_response_not_object",
  "token_response_access_token_missing",
  "token_response_access_token_invalid",
  "token_response_token_type_invalid",
  "token_response_expires_in_invalid",
] as const;
export type OutcomeUnknownReason = (typeof OUTCOME_UNKNOWN_REASONS)[number];

export const PERMANENT_REJECTION_CODES = ["invalid_request", "invalid_cursor", "content_policy", "duplicate", "limit_exceeded", "unknown"] as const;
export type PermanentRejectionCode = (typeof PERMANENT_REJECTION_CODES)[number];

/**
 * Why an interaction node read was refused, when the adapter can tell (Step 7G-H5.5-P12-C6). Diagnostic only: every value
 * is the same PermanentRejectedError (same code, retry and handling). Each names how the node's content authority failed
 * (or that the node was otherwise unreadable) — never an id, a value or a body fragment. `null` when unclassified.
 */
export const PERMANENT_REJECTION_DIAGNOSTICS = [
  "interaction_content_missing",
  "interaction_content_malformed",
  "interaction_content_id_missing",
  "interaction_content_equals_interaction",
  "interaction_content_equals_parent",
  "interaction_node_unreadable",
  // Step 7G-H5.5-P12-C9: a node's reported content or parent contradicts the provenance it was listed under.
  "interaction_content_conflicts",
  "interaction_parent_mismatch",
] as const;
export type PermanentRejectionDiagnostic = (typeof PERMANENT_REJECTION_DIAGNOSTICS)[number];

export const PROVIDER_ERROR_KINDS = [
  "rate_limited",
  "transient",
  "permission_missing",
  "target_not_found",
  "target_not_eligible",
  "credential_invalid",
  "permanent_rejected",
  "outcome_unknown",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/**
 * - `after_delay`: retry after `retryAfterSeconds` (or backoff when the provider gave none)
 * - `with_backoff`: transient; retry with exponential backoff
 * - `after_recovery`: retry only after the credential is fixed (re-authorization)
 * - `never`: retrying can't change the outcome
 * - `verify_first`: the effect may already exist; reconcile before any resend
 */
export type ProviderRetry = "after_delay" | "with_backoff" | "after_recovery" | "never" | "verify_first";

export interface SerializedProviderError {
  readonly kind: ProviderErrorKind;
  readonly operation: ProviderOperation;
  readonly retry: ProviderRetry;
  readonly details: Readonly<Record<string, string | number | null>>;
}

export abstract class ProviderError extends Error {
  abstract readonly kind: ProviderErrorKind;
  abstract readonly retry: ProviderRetry;
  readonly operation: ProviderOperation;

  constructor(kind: ProviderErrorKind, operation: ProviderOperation) {
    super(`provider_${kind}`);
    this.operation = operation;
  }

  /** Safe, closed-vocabulary details only. */
  protected abstract details(): Readonly<Record<string, string | number | null>>;

  toJSON(): SerializedProviderError {
    return { kind: this.kind, operation: this.operation, retry: this.retry, details: this.details() };
  }
}

export class RateLimitedError extends ProviderError {
  override readonly name = "RateLimitedError";
  readonly kind = "rate_limited";
  readonly retry = "after_delay";
  /** Seconds the provider asked us to wait; `null` when it didn't say (use backoff). */
  readonly retryAfterSeconds: number | null;

  constructor(operation: ProviderOperation, retryAfterSeconds: number | null) {
    super("rate_limited", operation);
    if (retryAfterSeconds !== null && (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 0)) {
      throw new TypeError("retryAfterSeconds must be a non-negative integer");
    }
    this.retryAfterSeconds = retryAfterSeconds;
  }

  protected details() {
    return { retryAfterSeconds: this.retryAfterSeconds };
  }
}

/**
 * A temporary failure where the request definitely did not take effect (rejected before processing, or failed
 * before sending). If a mutation may have been sent, the adapter must raise OutcomeUnknownError instead.
 */
export class TransientError extends ProviderError {
  override readonly name = "TransientError";
  readonly kind = "transient";
  readonly retry = "with_backoff";
  readonly reason: TransientReason;

  constructor(operation: ProviderOperation, reason: TransientReason) {
    super("transient", operation);
    this.reason = reason;
  }

  protected details() {
    return { reason: this.reason };
  }
}

export class PermissionMissingError extends ProviderError {
  override readonly name = "PermissionMissingError";
  readonly kind = "permission_missing";
  readonly retry = "never";
  readonly capability: PermissionCapability;

  constructor(operation: ProviderOperation, capability: PermissionCapability) {
    super("permission_missing", operation);
    this.capability = capability;
  }

  protected details() {
    return { capability: this.capability };
  }
}

/**
 * How much a "not found" says (Step H6-E). `authoritative`: the provider's answer for THIS object, on a platform whose
 * not-found is VALIDATED to mean "gone" — a removal may rest on it. `unconfirmed`: anything else (the default) — e.g.
 * Meta's code 100 / subcode 33 ("does not exist, cannot be loaded due to missing permissions, or does not support this
 * operation") is ambiguous by Meta's own definition, so it never confirms a removal until a LIVE validation says so.
 */
export const NOT_FOUND_AUTHORITIES = ["authoritative", "unconfirmed"] as const;
export type NotFoundAuthority = (typeof NOT_FOUND_AUTHORITIES)[number];

export class TargetNotFoundError extends ProviderError {
  override readonly name = "TargetNotFoundError";
  readonly kind = "target_not_found";
  readonly retry = "never";
  readonly authority: NotFoundAuthority;

  constructor(operation: ProviderOperation, authority: NotFoundAuthority = "unconfirmed") {
    super("target_not_found", operation);
    this.authority = authority;
  }

  protected details() {
    return { authority: this.authority };
  }
}

/** Safety net: the operation isn't possible for this target (TA §15.3). Never a promise about availability. */
export class TargetNotEligibleError extends ProviderError {
  override readonly name = "TargetNotEligibleError";
  readonly kind = "target_not_eligible";
  readonly retry = "never";
  readonly reason: NotEligibleReason;

  constructor(operation: ProviderOperation, reason: NotEligibleReason) {
    super("target_not_eligible", operation);
    this.reason = reason;
  }

  protected details() {
    return { reason: this.reason };
  }
}

export class CredentialInvalidError extends ProviderError {
  override readonly name = "CredentialInvalidError";
  readonly kind = "credential_invalid";
  readonly retry = "after_recovery";
  readonly reason: CredentialInvalidReason;

  constructor(operation: ProviderOperation, reason: CredentialInvalidReason) {
    super("credential_invalid", operation);
    this.reason = reason;
  }

  protected details() {
    return { reason: this.reason };
  }
}

export class PermanentRejectedError extends ProviderError {
  override readonly name = "PermanentRejectedError";
  readonly kind = "permanent_rejected";
  readonly retry = "never";
  readonly reasonCode: PermanentRejectionCode;
  /** A closed diagnostic sub-reason, or null (unclassified). Never changes kind, code, retry or handling. */
  readonly diagnostic: PermanentRejectionDiagnostic | null;

  constructor(operation: ProviderOperation, reasonCode: PermanentRejectionCode, diagnostic: PermanentRejectionDiagnostic | null = null) {
    super("permanent_rejected", operation);
    this.reasonCode = reasonCode;
    this.diagnostic = diagnostic;
  }

  protected details() {
    return this.diagnostic === null ? { reasonCode: this.reasonCode } : { reasonCode: this.reasonCode, diagnostic: this.diagnostic };
  }
}

/** The request may have taken effect (e.g. a timeout after sending). Distinct from every failure. */
export class OutcomeUnknownError extends ProviderError {
  override readonly name = "OutcomeUnknownError";
  readonly kind = "outcome_unknown";
  readonly retry = "verify_first";
  /** A closed diagnostic sub-reason, or null (unclassified). Never changes kind, retry or handling. */
  readonly reason: OutcomeUnknownReason | null;

  constructor(operation: ProviderOperation, reason: OutcomeUnknownReason | null = null) {
    super("outcome_unknown", operation);
    this.reason = reason;
  }

  protected details() {
    return this.reason === null ? {} : { reason: this.reason };
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/** True only when the provider definitely did not apply the request. OutcomeUnknown is never a failure. */
export function isDefiniteFailure(error: ProviderError): boolean {
  return error.kind !== "outcome_unknown";
}
