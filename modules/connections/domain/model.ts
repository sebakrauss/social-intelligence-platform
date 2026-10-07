/**
 * Connections domain (TA §8, §39; Model §53-D; Step 5D). Pure: vocabularies, shapes and transition rules for the
 * authorization round trip, the Connection lifecycle and discovered assets. Mirrors the closed values the
 * database enforces (migrations 0007, 0008). Nothing here implies what a platform supports: capability is
 * evaluated elsewhere (TA §16), and simulator behavior is never evidence about real providers.
 */
import type { ConnectionStatus } from "@/domain/connections";
import { parseWorkspaceId, type OrganizationId, type UserId, type WorkspaceId } from "@/domain/ids";

export const CONNECTION_PROVIDERS = ["meta", "tiktok", "simulator"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

/** Providers the authorization flow accepts in Step 5D: the simulator only (real OAuth stays VALIDATE). */
export const AUTHORIZABLE_PROVIDERS = ["simulator"] as const;
export type AuthorizableProvider = (typeof AUTHORIZABLE_PROVIDERS)[number];

export const ATTEMPT_STATUSES = ["PENDING", "EXCHANGING", "COMPLETED", "DENIED", "EXPIRED", "CANCELLED", "EXCHANGE_FAILED", "OUTCOME_UNKNOWN"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Closed reasons for a definite exchange failure (connect_attempts.failure_code). Never provider text. */
export const EXCHANGE_FAILURE_CODES = [
  "CREDENTIAL_INVALID",
  "PERMISSION_MISSING",
  "REQUEST_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "CREDENTIAL_NOT_STORED",
  "CONNECTION_UNAVAILABLE",
] as const;
export type ExchangeFailureCode = (typeof EXCHANGE_FAILURE_CODES)[number];

export const CONNECTION_PROBLEM_CODES = [
  "AUTHORIZATION_DENIED",
  "CREDENTIAL_REVOKED",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_INVALID",
  "CREDENTIAL_UNREADABLE",
  "PERMISSION_MISSING",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "DISCOVERY_FAILED",
] as const;
export type ConnectionProblemCode = (typeof CONNECTION_PROBLEM_CODES)[number];

export const CONNECTION_EVENT_REASONS = [
  "AUTHORIZED",
  "REAUTHORIZED",
  "VALIDATED",
  "RECOVERED",
  "CREDENTIAL_REFRESHED",
  "AUTHORIZATION_DENIED",
  "CREDENTIAL_REVOKED",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_INVALID",
  "CREDENTIAL_UNREADABLE",
  "PERMISSION_MISSING",
  "PROVIDER_UNAVAILABLE",
  "DISCOVERY_FAILED",
  "REMOVED_BY_USER",
] as const;
export type ConnectionEventReason = (typeof CONNECTION_EVENT_REASONS)[number];

/** Attempt lifetime (0007 allows at most 15 minutes). */
export const ATTEMPT_TTL_MS = 10 * 60 * 1000;
/** An EXCHANGING attempt older than this is recovery-required: it is never re-exchanged, only closed. */
export const EXCHANGE_STALE_AFTER_MS = 2 * 60 * 1000;

export interface ConnectAttempt {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly provider: ConnectionProvider;
  readonly createdBy: UserId;
  readonly stateDigest: string;
  readonly redirectUri: string;
  readonly reconnectConnectionId: string | null;
  readonly status: AttemptStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  readonly exchangeStartedAt: Date | null;
  readonly failureCode: ExchangeFailureCode | null;
}

export interface Connection {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly provider: ConnectionProvider;
  readonly status: ConnectionStatus;
  readonly activeCredentialId: string | null;
  readonly authorizedBy: UserId;
  readonly authorizedAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly lastProblemCode: ConnectionProblemCode | null;
  readonly lastProblemAt: Date | null;
  /** Monotonic row version. Credential versions are allocated from it, so they never repeat. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ConnectionEvent {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly connectionId: string;
  readonly previousStatus: ConnectionStatus | null;
  readonly newStatus: ConnectionStatus;
  readonly reasonCode: ConnectionEventReason;
  readonly actor: { readonly type: "user"; readonly userId: UserId } | { readonly type: "system" };
  readonly occurredAt: Date;
}

export const ASSET_PLATFORMS = ["facebook", "instagram", "tiktok"] as const;
export type AssetPlatform = (typeof ASSET_PLATFORMS)[number];
export const ASSET_CLASSES = ["content_bearing", "ad_account"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** A normalized asset a connection exposes (identifiers, class and display name only; no raw payload). */
export interface DiscoveredAsset {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly connectionId: string;
  readonly platform: AssetPlatform;
  readonly providerAssetId: string;
  readonly assetClass: AssetClass;
  readonly displayName: string;
  readonly lastSeenAt: Date;
}

export const DEACTIVATION_REASONS = ["UNLINKED", "MOVED", "DISCONNECTED", "REMOVED"] as const;
export type DeactivationReason = (typeof DEACTIVATION_REASONS)[number];

/** A Social Asset activated in one workspace (Step 5F links, unlinks and moves it). */
export interface ConnectedAccount {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly connectionId: string;
  readonly platform: AssetPlatform;
  readonly providerAssetId: string;
  readonly assetClass: AssetClass;
  readonly status: "ACTIVE" | "INACTIVE";
  /** First activation of this row (0007 grants no update of it; a reactivation is recorded as history). */
  readonly activatedAt: Date;
  readonly deactivatedAt: Date | null;
  readonly deactivationReason: DeactivationReason | null;
  /** The Move that moved this account out (deactivation reason MOVED); null otherwise. */
  readonly moveId: string | null;
}

export const ACCOUNT_EVENT_TYPES = ["LINKED", "UNLINKED", "MOVED_OUT", "MOVED_IN", "DEACTIVATED"] as const;
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];
export const ACCOUNT_EVENT_REASONS = ["USER_LINKED", "USER_UNLINKED", "MOVE", "CONNECTION_DISCONNECTED", "CONNECTION_REMOVED"] as const;
export type AccountEventReason = (typeof ACCOUNT_EVENT_REASONS)[number];

/** Append-only link/move history (connected_account_events). Workers record as `system`; web as the user. */
export interface ConnectedAccountEvent {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
  readonly eventType: AccountEventType;
  /** Required exactly for MOVED_OUT / MOVED_IN. */
  readonly moveId: string | null;
  readonly reasonCode: AccountEventReason;
  readonly actor: { readonly type: "user"; readonly userId: UserId } | { readonly type: "system" };
  readonly occurredAt: Date;
}

// ── M-01 and the TEMPORARY TA-Q-02 restriction ──────────────────────────────────────────────────────────────

/**
 * Which "active in at most one workspace per organization" rule applies to an asset. M-01 (LOCKED, PD D-50) covers
 * content-bearing assets; the ad-account rule is the TEMPORARY TA-Q-02 safety restriction (VALIDATE), kept distinct so
 * relaxing it never touches M-01. Both are enforced by separately named unique indexes (0007): the database decides.
 */
export type SingleWorkspaceRule = "M-01" | "TA-Q-02";

export function singleWorkspaceRule(assetClass: AssetClass): SingleWorkspaceRule {
  return assetClass === "ad_account" ? "TA-Q-02" : "M-01";
}

/** The unique index that refused an activation → its rule (undefined: not one of the two). */
export const SINGLE_WORKSPACE_INDEXES: Readonly<Record<string, SingleWorkspaceRule>> = {
  connected_accounts_m01_active_content_asset: "M-01",
  connected_accounts_taq02_tmp_ad_account_single_workspace: "TA-Q-02",
};

// ── Move saga (decision D4) ─────────────────────────────────────────────────────────────────────────────────

/**
 * Closed Move reasons (asset_moves.reason_code). 0010 adds the TA-Q-02 one (distinct from ASSET_ACTIVE_ELSEWHERE) and
 * SOURCE_RELEASE_REJECTED: the destination's generic outcome when the source refused to release. The precise source
 * reason (AUTHORITY_REVOKED, SOURCE_NOT_ACTIVE) is recorded on the SOURCE side only and never crosses workspaces.
 */
export const MOVE_REASON_CODES = [
  "SOURCE_NOT_ACTIVE",
  "AUTHORITY_REVOKED",
  "DESTINATION_CONNECTION_UNHEALTHY",
  "ASSET_ACTIVE_ELSEWHERE",
  "ASSET_NOT_DISCOVERED",
  "ACTIVATION_RETRIES_EXHAUSTED",
  "AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION",
  "SOURCE_RELEASE_REJECTED",
] as const;
export type MoveReasonCode = (typeof MOVE_REASON_CODES)[number];

/** The closed reason when an asset is already active in another workspace of the organization. */
export function activeElsewhereReason(rule: SingleWorkspaceRule): MoveReasonCode {
  return rule === "TA-Q-02" ? "AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION" : "ASSET_ACTIVE_ELSEWHERE";
}

export const INCOMING_MOVE_STATUSES = ["REQUESTED", "COMPLETED", "ACTIVATION_FAILED", "REJECTED"] as const;
export type IncomingMoveStatus = (typeof INCOMING_MOVE_STATUSES)[number];
export const OUTGOING_MOVE_STATUSES = ["RELEASED", "REJECTED"] as const;
export type OutgoingMoveStatus = (typeof OUTGOING_MOVE_STATUSES)[number];

interface MoveSideBase {
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly moveId: string;
  /** Another workspace of the SAME organization (0007 composite FK). */
  readonly counterpartWorkspaceId: WorkspaceId;
  readonly platform: AssetPlatform;
  readonly initiatorUserId: UserId;
  readonly reasonCode: MoveReasonCode | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Destination side: the request, in the destination workspace, through its own Connection. */
export interface IncomingMove extends MoveSideBase {
  readonly side: "INCOMING";
  readonly status: IncomingMoveStatus;
  readonly connectionId: string;
  readonly providerAssetId: string;
  /** The destination Connected Account once activated. */
  readonly connectedAccountId: string | null;
}

/** Source side: the release (or its refusal), in the source workspace. */
export interface OutgoingMove extends MoveSideBase {
  readonly side: "OUTGOING";
  readonly status: OutgoingMoveStatus;
  readonly connectedAccountId: string;
}

export type AssetMove = IncomingMove | OutgoingMove;

/** The three closed cross-workspace transitions (connections.route_move_step). */
export const MOVE_STEPS = ["release_source", "activate_destination", "reject_destination"] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];
/** The local routing step of a human retry: a NEW durable activation attempt in the destination (topic: activation). */
export const RETRY_ACTIVATION_STEP = "retry_activation";

/**
 * What connections.route_move_step did: routed = the step's row exists (now or from an earlier identical routing);
 * outboxId = the row inserted by THIS call (null for a duplicate), so the caller can wake the relay after commit.
 */
export interface RouteResult {
  readonly routed: boolean;
  readonly outboxId: string | null;
}

/** Outbox topic = task name of each step (the definer derives the same strings). */
export const MOVE_TOPICS: Readonly<Record<MoveStep, string>> = {
  release_source: "connections.move.release_source",
  activate_destination: "connections.move.activate_destination",
  reject_destination: "connections.move.reject_destination",
};

/** Closed audit steps of connections.record_move_audit (the human initiator is the actor, TA §41.1). */
export const MOVE_AUDIT_STEPS = ["moved_out", "moved_in", "move_failed", "move_rejected"] as const;
export type MoveAuditStep = (typeof MOVE_AUDIT_STEPS)[number];

/** Capability evaluation after an activation (link or move-in): connections hands off to the capability module. */
export const CAPABILITY_EVALUATION_TOPIC = "capability.evaluate_account";

/** Only a failed activation can be retried by a human (same move, no source restoration). */
export function isRetryable(move: IncomingMove): boolean {
  return move.status === "ACTIVATION_FAILED";
}

// ── State routing (decision B3) ─────────────────────────────────────────────────────────────────────────

const STATE_FORMAT = /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/;

/**
 * The workspace a callback state routes to, or undefined for anything that isn't a v1 state. ROUTING ONLY: the
 * caller still authenticates the user, binds the workspace, and matches SHA-256(full state) to the user's own
 * pending attempt. A forged prefix finds nothing.
 */
export function stateWorkspace(state: string): WorkspaceId | undefined {
  const match = STATE_FORMAT.exec(state);
  return match === null ? undefined : parseWorkspaceId(match[1]);
}

// ── Transition rules ────────────────────────────────────────────────────────────────────────────────────

/** Only a PENDING attempt inside its lifetime can be claimed for the (single) exchange. */
export function isClaimable(attempt: ConnectAttempt, now: Date): boolean {
  return attempt.status === "PENDING" && attempt.expiresAt.getTime() > now.getTime();
}

/** An EXCHANGING attempt whose exchange began long ago is recovery-required (never replayed). */
export function isStaleExchange(attempt: ConnectAttempt, now: Date): boolean {
  return attempt.status === "EXCHANGING" && attempt.exchangeStartedAt !== null && now.getTime() - attempt.exchangeStartedAt.getTime() >= EXCHANGE_STALE_AFTER_MS;
}

/** A connection that can still receive a (re)authorization. */
export function acceptsAuthorization(connection: Connection): boolean {
  return connection.status !== "REMOVED";
}

/**
 * Status after a re-authorization stored a new credential: a working connection keeps its status (the new
 * credential is validated by discovery next); a failed or disconnected one goes back to CONNECTING.
 */
export function statusAfterReauthorization(current: ConnectionStatus): ConnectionStatus {
  return current === "ACTIVE" || current === "DEGRADED" ? current : "CONNECTING";
}

/**
 * Status after discovery failed definitively: the initial validation of a new connection fails it; a working
 * connection degrades (Step 5D minimum rule; full refresh/revocation semantics are Step 5H).
 */
export function statusAfterDiscoveryFailure(current: ConnectionStatus): ConnectionStatus {
  return current === "ACTIVE" || current === "DEGRADED" ? "DEGRADED" : "FAILED";
}

/** Event reason for a successful validation, by the status it leaves. */
export function validationReason(previous: ConnectionStatus): ConnectionEventReason {
  return previous === "CONNECTING" ? "VALIDATED" : "RECOVERED";
}
