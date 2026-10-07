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
