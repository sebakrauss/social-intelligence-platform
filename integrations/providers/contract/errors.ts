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

export const PERMANENT_REJECTION_CODES = ["invalid_request", "invalid_cursor", "content_policy", "duplicate", "limit_exceeded", "unknown"] as const;
export type PermanentRejectionCode = (typeof PERMANENT_REJECTION_CODES)[number];

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

export class TargetNotFoundError extends ProviderError {
  override readonly name = "TargetNotFoundError";
  readonly kind = "target_not_found";
  readonly retry = "never";

  constructor(operation: ProviderOperation) {
    super("target_not_found", operation);
  }

  protected details() {
    return {};
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

  constructor(operation: ProviderOperation, reasonCode: PermanentRejectionCode) {
    super("permanent_rejected", operation);
    this.reasonCode = reasonCode;
  }

  protected details() {
    return { reasonCode: this.reasonCode };
  }
}

/** The request may have taken effect (e.g. a timeout after sending). Distinct from every failure. */
export class OutcomeUnknownError extends ProviderError {
  override readonly name = "OutcomeUnknownError";
  readonly kind = "outcome_unknown";
  readonly retry = "verify_first";

  constructor(operation: ProviderOperation) {
    super("outcome_unknown", operation);
  }

  protected details() {
    return {};
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/** True only when the provider definitely did not apply the request. OutcomeUnknown is never a failure. */
export function isDefiniteFailure(error: ProviderError): boolean {
  return error.kind !== "outcome_unknown";
}
