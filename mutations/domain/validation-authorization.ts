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

/**
 * Step 7B-14H1 (PRE-LIVE-1) — what the executor read, in ONE short transaction, immediately before the ONE provider call
 * of an AUTHORIZED intent. It runs twice: before the credential is opened ("before_open") and again after the key
 * service handed the credential over and before the request leaves ("after_open", with the opened credential's identity).
 */
export interface FinalSendInput {
  /** What THIS run committed EXECUTING (the intent as admitted). */
  readonly expected: {
    readonly intentId: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly connectedAccountId: string;
    readonly targetInteractionId: string;
    readonly initiatorUserId: string;
    readonly validationAuthorizationId: string;
    readonly attempt: number;
    readonly runReference: string;
    /** The account platform the operational authorization was asked for at admit. */
    readonly accountPlatform: string;
  };
  /** The intent row as locked now; undefined when it is gone. */
  readonly current: { readonly status: string; readonly attempt: number; readonly runReference: string | null; readonly validationAuthorizationId: string | null } | undefined;
  readonly reading: ValidationAuthorizationReading | undefined;
  readonly consumedElsewhere: boolean;
  readonly initiatorRole: string | undefined;
  readonly replyingRoles: ReadonlySet<string>;
  readonly mode: "STANDARD" | "MONITOR_ONLY" | undefined;
  readonly account: { readonly status: string; readonly platform: string; readonly provider: string; readonly providerAssetId: string; readonly connectionStatus: string; readonly credentialId: string | null } | undefined;
  readonly providerAction: "allowed" | "not_enabled" | "paused";
  /** The persisted target as the executor's guards judge it (undefined: gone or invisible). */
  readonly target: { readonly present: boolean; readonly replyable: boolean; readonly connectedAccountId: string; readonly workspaceId: string; readonly platform: string } | undefined;
  readonly capability: { readonly usable: boolean; readonly catalogValidationPending: boolean };
  /**
   * "after_open" only: the identity of the credential the key service opened for THIS call, and the account's credential
   * as it is authorized NOW (the active credential of an ACTIVE connection and account).
   */
  readonly credential?: {
    readonly opened: { readonly credentialId: string | undefined; readonly platform: string; readonly providerAssetId: string };
    readonly active: { readonly credentialId: string; readonly platform: string; readonly providerAssetId: string } | undefined;
  };
}

/** X1: the locked row is still exactly what THIS run committed — EXECUTING, same attempt, run reference and authorization. */
export function isThisRunsExecution(expected: Pick<FinalSendInput["expected"], "attempt" | "runReference" | "validationAuthorizationId">, current: FinalSendInput["current"]): boolean {
  return current !== undefined && current.status === "EXECUTING" && current.attempt === expected.attempt && current.runReference === expected.runReference && current.validationAuthorizationId === expected.validationAuthorizationId;
}

/** The closed BLOCKED codes a final refusal records (existing vocabulary only: nothing new is invented here). */
export type FinalSendRefusal =
  | "VALIDATION_AUTHORIZATION_UNAVAILABLE"
  | "INITIATOR_NOT_MEMBER"
  | "PERMISSION_DENIED"
  | "MODE_NOT_STANDARD"
  | "ACCOUNT_INACTIVE"
  | "PROVIDER_ACTIONS_DISABLED"
  | "CONNECTION_UNAVAILABLE"
  | "TARGET_NOT_PRESENT"
  | "TARGET_NOT_REPLYABLE"
  | "TARGET_ACCOUNT_MISMATCH"
  | "CAPABILITY_UNAVAILABLE"
  | "CREDENTIAL_UNREADABLE";

export type FinalSendDecision = { readonly kind: "send" } | { readonly kind: "not_this_run" } | { readonly kind: "refuse"; readonly code: FinalSendRefusal };

/**
 * Step 7B-14H1 (PRE-LIVE-1) — the last decision before the ONE provider call of an AUTHORIZED intent. Pure, fail-closed.
 *   not_this_run  the row is no longer exactly what this run committed (status EXECUTING, attempt, run reference,
 *                 authorization): another run or a rewrite touched it — nothing is sent, nothing is recorded (the row is
 *                 left to reconciliation; X1);
 *   refuse        a CONFIRMED prohibition read now: the authorization is no longer this intent's consumed, unrevoked,
 *                 unexpired one for exactly this scope; the initiator lost the replying role; the workspace left
 *                 Standard; the account, its connection or the target is no longer eligible; a pause or the emergency
 *                 block applies (never stood in for: only "not_enabled" is); the capability is unusable for any reason
 *                 other than the catalog's pending validation; or (after_open) the opened credential is no longer the
 *                 account's authorized credential (replaced, removed, its connection or account no longer ACTIVE), or
 *                 names another account;
 *   send          nothing above.
 * It decides nothing about an unreadable state: a read that FAILED never reaches this function (the caller fails
 * closed without recording a refusal).
 */
export function decideFinalSend(input: FinalSendInput): FinalSendDecision {
  const refuse = (code: FinalSendRefusal): FinalSendDecision => ({ kind: "refuse", code });
  const { expected } = input;
  if (!isThisRunsExecution(expected, input.current)) return { kind: "not_this_run" };
  // The authorization: this intent's, consumed by THIS EXECUTING commit, never revoked, not expired (database clock),
  // exactly this operation and scope, and its target validated by no other authorization.
  const { provider, platform, kind } = VALIDATION_AUTHORIZATION_OPERATION;
  const reading = input.reading;
  if (reading === undefined) return refuse("VALIDATION_AUTHORIZATION_UNAVAILABLE");
  const a = reading.authorization;
  if (a.id !== expected.validationAuthorizationId || (a.provider as string) !== provider || (a.platform as string) !== platform || (a.kind as string) !== kind) return refuse("VALIDATION_AUTHORIZATION_UNAVAILABLE");
  if (a.workspaceId !== expected.workspaceId || a.organizationId !== expected.organizationId || a.connectedAccountId !== expected.connectedAccountId || a.targetInteractionId !== expected.targetInteractionId || a.initiatorUserId !== expected.initiatorUserId) {
    return refuse("VALIDATION_AUTHORIZATION_UNAVAILABLE");
  }
  if (a.intentId !== expected.intentId || a.boundAt === null || a.consumedAt === null || a.revokedAt !== null || reading.expired || input.consumedElsewhere) return refuse("VALIDATION_AUTHORIZATION_UNAVAILABLE");
  // The initiator, the workspace mode, the account.
  if (input.initiatorRole === undefined) return refuse("INITIATOR_NOT_MEMBER");
  if (!input.replyingRoles.has(input.initiatorRole)) return refuse("PERMISSION_DENIED");
  if (input.mode !== "STANDARD") return refuse("MODE_NOT_STANDARD");
  const account = input.account;
  if (account === undefined || account.status !== "ACTIVE") return refuse("ACCOUNT_INACTIVE");
  if (account.provider !== provider || account.platform !== platform || account.platform !== expected.accountPlatform) return refuse("VALIDATION_AUTHORIZATION_UNAVAILABLE");
  // A pause or the emergency block always vetoes; only a missing grant is stood in for by the authorization.
  if (input.providerAction === "paused") return refuse("PROVIDER_ACTIONS_DISABLED");
  if (account.connectionStatus !== "ACTIVE" || account.credentialId === null) return refuse("CONNECTION_UNAVAILABLE");
  // The target, as persisted now.
  const target = input.target;
  if (target === undefined || !target.present) return refuse("TARGET_NOT_PRESENT");
  if (!target.replyable) return refuse("TARGET_NOT_REPLYABLE");
  if (target.connectedAccountId !== expected.connectedAccountId || target.workspaceId !== expected.workspaceId || target.platform !== platform) return refuse("TARGET_ACCOUNT_MISMATCH");
  if (!input.capability.usable && !input.capability.catalogValidationPending) return refuse("CAPABILITY_UNAVAILABLE");
  // After the key service handed the credential over: it must still be the account's authorized credential.
  if (input.credential !== undefined) {
    const { opened, active } = input.credential;
    if (active === undefined || opened.credentialId === undefined || opened.credentialId !== active.credentialId || opened.credentialId !== account.credentialId) return refuse("CREDENTIAL_UNREADABLE");
    if (opened.platform !== active.platform || opened.providerAssetId !== active.providerAssetId || active.providerAssetId !== account.providerAssetId || active.platform !== account.platform) {
      return refuse("TARGET_ACCOUNT_MISMATCH");
    }
  }
  return { kind: "send" };
}

export function isValidationAuthorizationIssueReason(value: unknown): value is ValidationAuthorizationIssueReason {
  return typeof value === "string" && (VALIDATION_AUTHORIZATION_ISSUE_REASONS as readonly string[]).includes(value);
}
export function isValidationAuthorizationRevocationReason(value: unknown): value is ValidationAuthorizationRevocationReason {
  return typeof value === "string" && (VALIDATION_AUTHORIZATION_REVOCATION_REASONS as readonly string[]).includes(value);
}
