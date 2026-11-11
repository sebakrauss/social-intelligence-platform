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
 * permission. Step 7B-14G1 wires it into the ONE existing request and executor path through decideValidationAdmission
 * below: a bounded exception that may stand in for exactly two initial-validation barriers (design 7B-14B, alternative B)
 * and nothing else —
 *   - mutation.provider_action NOT ENABLED (no grant exists): substituted; PAUSED (a restrictive row, the "*" emergency
 *     block included, or an invalid configuration) is never substituted — it vetoes;
 *   - reply_public UNAVAILABLE only because the catalog has not validated it (the stored profile row is
 *     UNKNOWN_NOT_VALIDATED with exactly CATALOG_NOT_VALIDATED, coherent, current, on an ACTIVE account and connection):
 *     substituted; NOT_AUTHORIZED, UNSUPPORTED, a stale or missing profile, missing or inconsistent account facts, an
 *     unhealthy connection are never substituted.
 * Every other guard of the chain (role, mode, account, connection, target, depth, authority coherence, credential) stays
 * exactly as it is for an ordinary intent.
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

/** An authorization as the database answered a read of it, with the DATABASE's expiry verdict (the triggers' clock). */
export interface ValidationAuthorizationReading {
  readonly authorization: ValidationAuthorization;
  /** clock_timestamp() >= expires_at at read time — never the application clock (no skew between check and trigger). */
  readonly expired: boolean;
}

/** The request (phase "request") or the persisted, locked intent (phase "execution") that names an authorization. */
export interface ValidationSubject {
  /** The intent's id in phase "execution"; null in phase "request" (no intent exists yet). */
  readonly intentId: string | null;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly targetInteractionId: string;
  readonly initiatorUserId: string;
  readonly kind: string;
  /** Execution attempts already recorded (an authorized intent executes as its FIRST attempt only). */
  readonly attempt: number;
}

export interface ValidationAdmissionInput {
  readonly phase: "request" | "execution";
  readonly subject: ValidationSubject;
  /** undefined: absent, of another workspace, or not visible to this transaction (RLS) — all the same answer. */
  readonly reading: ValidationAuthorizationReading | undefined;
  /** The account's connection provider and the account's platform, as the connections module stores them. */
  readonly account: { readonly provider: string; readonly platform: string };
  /** The persisted target's platform. */
  readonly targetPlatform: string;
  /** The exact `<platform>:public_reply` decision (Step 7B-12A). */
  readonly providerAction: "allowed" | "not_enabled" | "paused";
  /** The capability answer: usable as is, or unusable ONLY because the catalog has not validated it. */
  readonly capability: { readonly usable: boolean; readonly catalogValidationPending: boolean };
  /** Whether ANOTHER authorization for the same target and operation was ever consumed (execution only; else false). */
  readonly consumedElsewhere: boolean;
}

export type ValidationRefusal = "authorization" | "provider_action" | "capability";
export type ValidationAdmission = { readonly kind: "admit" } | { readonly kind: "refuse"; readonly reason: ValidationRefusal };

/**
 * Step 7B-14G1 — the ONE place the bounded exception is decided. Pure; fail-closed: every unknown or mismatched input
 * refuses. The UUID alone proves nothing: the authorization must be read (RLS-visible), name exactly this operation,
 * workspace, organization, account, target and initiator, be unrevoked, unexpired (database clock) and unconsumed; at
 * request time it must be unbound, at execution time bound to THIS intent, which has never been attempted; and no other
 * authorization for the same target may ever have been consumed. Then — and only then — it may stand in for a missing
 * provider-action grant and for a catalog that has not validated reply_public. A pause, the emergency block, and every
 * other capability state still refuse.
 */
export function decideValidationAdmission(input: ValidationAdmissionInput): ValidationAdmission {
  const refuse = (reason: ValidationRefusal): ValidationAdmission => ({ kind: "refuse", reason });
  const { provider, platform, kind } = VALIDATION_AUTHORIZATION_OPERATION;
  const { subject, reading } = input;
  if (reading === undefined) return refuse("authorization");
  const authorization = reading.authorization;
  // The exact operation, on both sides: the authorization, the intent, the account, the target.
  // Typed as the literals, but a row is data: compared as plain strings (defence against an incoherent read).
  if ((authorization.provider as string) !== provider || (authorization.platform as string) !== platform || (authorization.kind as string) !== kind) return refuse("authorization");
  if (subject.kind !== kind || input.account.provider !== provider || input.account.platform !== platform || input.targetPlatform !== platform) return refuse("authorization");
  // The exact scope.
  if (authorization.workspaceId !== subject.workspaceId || authorization.organizationId !== subject.organizationId) return refuse("authorization");
  if (authorization.connectedAccountId !== subject.connectedAccountId || authorization.targetInteractionId !== subject.targetInteractionId) return refuse("authorization");
  if (authorization.initiatorUserId !== subject.initiatorUserId) return refuse("authorization");
  // Live: never revoked, never consumed, not expired by the database's clock.
  if (authorization.revokedAt !== null || authorization.consumedAt !== null || reading.expired) return refuse("authorization");
  // Binding: free at request time; bound to exactly this, never-attempted intent at execution time.
  if (input.phase === "request") {
    if (authorization.intentId !== null || authorization.boundAt !== null || subject.intentId !== null) return refuse("authorization");
  } else if (subject.intentId === null || authorization.intentId !== subject.intentId || authorization.boundAt === null || subject.attempt !== 0) {
    return refuse("authorization");
  }
  // One validation per target, for ever (0028 B): a target already validated by another authorization admits nothing.
  if (input.consumedElsewhere) return refuse("authorization");
  // The two barriers it may stand in for — and nothing else.
  if (input.providerAction === "paused") return refuse("provider_action");
  if (!input.capability.usable && !input.capability.catalogValidationPending) return refuse("capability");
  return { kind: "admit" };
}

/**
 * Step 7B-14G1 (F, X2) — after the transition into EXECUTING failed for an authorized intent, decided ONLY on what the
 * database now says (never on the error): true when the authorization no longer admits this intent — gone, revoked,
 * expired (database clock), consumed, bound to anything but this intent, or its target already validated by another
 * consumed authorization. False means it still admits it, so the failure was something else (infrastructure, a lock,
 * a constraint unrelated to the authorization): the caller must NOT record it as a refusal.
 */
export function validationNoLongerAdmits(reading: ValidationAuthorizationReading | undefined, intentId: string, consumedElsewhere: boolean): boolean {
  if (reading === undefined) return true;
  const authorization = reading.authorization;
  return authorization.revokedAt !== null || reading.expired || authorization.consumedAt !== null || authorization.intentId !== intentId || consumedElsewhere;
}

export function isValidationAuthorizationIssueReason(value: unknown): value is ValidationAuthorizationIssueReason {
  return typeof value === "string" && (VALIDATION_AUTHORIZATION_ISSUE_REASONS as readonly string[]).includes(value);
}
export function isValidationAuthorizationRevocationReason(value: unknown): value is ValidationAuthorizationRevocationReason {
  return typeof value === "string" && (VALIDATION_AUTHORIZATION_REVOCATION_REASONS as readonly string[]).includes(value);
}
