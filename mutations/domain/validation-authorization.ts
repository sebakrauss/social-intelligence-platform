/**
 * One-time LIVE validation authorization (Step 7B-14F1; db/migrations/0028) — the pure model of an operator's bounded,
 * revocable, expiring, single-use permission to validate ONE operation (meta + instagram + reply_public) on ONE target
 * interaction of ONE connected account, requested by ONE named member. No I/O, no framework.
 *
 *   ISSUED ──bind──▶ BOUND ──consume──▶ CONSUMED
 *     │               │
 *     └───revoke──────┴──▶ REVOKED          (EXPIRED: past expiresAt, nothing binds or consumes)
 *
 * The database is the authority (constraints, unique indexes, row locks and triggers); this module only names the
 * persisted shape and derives its state for readers. Binding happens when an intent is inserted naming the
 * authorization; consumption when that intent is committed EXECUTING — before the provider call (R6). The provider call
 * is outside every transaction, so an uncertain outcome leaves the authorization CONSUMED: it is never re-armed.
 *
 * Step 7B-14F2 hardening (enforced in the database): an authorized intent follows exactly the intent transitions, enters
 * EXECUTING only from PENDING and reaches CONFIRMED / FAILED / OUTCOME_UNKNOWN only once consumed; at most ONE
 * authorization is ever consumed per target and operation (a later validation uses another comment; an expired or
 * revoked authorization that was never consumed does not block re-issuance); issuance runs only under READ COMMITTED.
 *
 * Holding an authorization grants nothing by itself: it is not a capability, not a provider-action grant and not a
 * permission. Whether an executor may honour one is a later gate's decision (not wired here).
 */

/** The only operation an authorization can name. */
export const VALIDATION_AUTHORIZATION_OPERATION = { provider: "meta", platform: "instagram", kind: "reply_public" } as const;

/** Hard ceiling enforced by the database (0028: expires_at <= issued_at + 2 hours); no authorization is open-ended. */
export const VALIDATION_AUTHORIZATION_MAX_LIFETIME_MINUTES = 120;
/** The operational lifetime the operator tooling should use. */
export const VALIDATION_AUTHORIZATION_DEFAULT_LIFETIME_MINUTES = 60;

export const VALIDATION_AUTHORIZATION_ISSUE_REASONS = ["live_validation", "test"] as const;
export type ValidationAuthorizationIssueReason = (typeof VALIDATION_AUTHORIZATION_ISSUE_REASONS)[number];

export const VALIDATION_AUTHORIZATION_REVOCATION_REASONS = ["incident", "rollback", "maintenance", "superseded", "test"] as const;
export type ValidationAuthorizationRevocationReason = (typeof VALIDATION_AUTHORIZATION_REVOCATION_REASONS)[number];

export const VALIDATION_AUTHORIZATION_STATES = ["ISSUED", "BOUND", "CONSUMED", "REVOKED", "EXPIRED"] as const;
export type ValidationAuthorizationState = (typeof VALIDATION_AUTHORIZATION_STATES)[number];

export interface ValidationAuthorization {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  /** Canonical interaction (interactions.interactions id) owned by that account, in this workspace. */
  readonly targetInteractionId: string;
  /** The ONE member who may request the validated intent (the human who presses Send). */
  readonly initiatorUserId: string;
  readonly provider: typeof VALIDATION_AUTHORIZATION_OPERATION.provider;
  readonly platform: typeof VALIDATION_AUTHORIZATION_OPERATION.platform;
  readonly kind: typeof VALIDATION_AUTHORIZATION_OPERATION.kind;
  /** The PREFLIGHT evidence the operator relied on (a run reference: never its content). */
  readonly preflightRunReference: string;
  readonly preflightCompletedAt: Date;
  /** The operator who issued it (an operator identifier, not a product user). */
  readonly issuedBy: string;
  readonly issueReason: ValidationAuthorizationIssueReason;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly revocationReason: ValidationAuthorizationRevocationReason | null;
  /** The ONE intent it is bound to (write-once). */
  readonly intentId: string | null;
  readonly boundAt: Date | null;
  /** Set in the same transaction that committed the intent EXECUTING (write-once; never cleared). */
  readonly consumedAt: Date | null;
}

/**
 * The state a reader should act on at `now`. Precedence: CONSUMED (a call may have left; final), then REVOKED, then
 * EXPIRED, then BOUND (reserved by its intent: never bindable again), then ISSUED.
 */
export function validationAuthorizationState(authorization: ValidationAuthorization, now: Date): ValidationAuthorizationState {
  if (authorization.consumedAt !== null) return "CONSUMED";
  if (authorization.revokedAt !== null) return "REVOKED";
  if (now.getTime() >= authorization.expiresAt.getTime()) return "EXPIRED";
  if (authorization.intentId !== null) return "BOUND";
  return "ISSUED";
}

export function isValidationAuthorizationIssueReason(value: unknown): value is ValidationAuthorizationIssueReason {
  return typeof value === "string" && (VALIDATION_AUTHORIZATION_ISSUE_REASONS as readonly string[]).includes(value);
}
export function isValidationAuthorizationRevocationReason(value: unknown): value is ValidationAuthorizationRevocationReason {
  return typeof value === "string" && (VALIDATION_AUTHORIZATION_REVOCATION_REASONS as readonly string[]).includes(value);
}
