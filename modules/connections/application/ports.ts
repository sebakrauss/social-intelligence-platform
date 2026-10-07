/**
 * Connections ports (Step 5D). The application layer works only through these; PostgreSQL implementations live
 * in ../persistence and are composed by server/ (web transactions) and, for the job side, by server/persistence
 * on behalf of jobs/. Every store runs inside ONE tenant-scoped transaction bound to one workspace, under forced
 * RLS: a row the caller may not see is simply absent.
 *
 * Secrets never cross these ports in readable form: the state is passed as its digest, the PKCE verifier is
 * derived (never stored), and credentials are stored and loaded only as sealed EnvelopeV1 bytes.
 */
import type { ConnectionStatus } from "@/domain/connections";
import type { OrganizationId, UserId, WorkspaceId } from "@/domain/ids";
import type { AuditLog } from "@/modules/audit";
import type { ProviderAuthorizationPort, ProviderCredential, ProviderReadPort } from "@/integrations/providers/contract";
import type { OutboxWriter } from "@/platform/outbox";
import type {
  AssetClass,
  AssetPlatform,
  AttemptStatus,
  AuthorizableProvider,
  ConnectAttempt,
  ConnectedAccount,
  ConnectedAccountEvent,
  Connection,
  ConnectionEvent,
  DiscoveredAsset,
  ExchangeFailureCode,
  IncomingMove,
  MoveAuditStep,
  MoveReasonCode,
  OutgoingMove,
  RouteResult,
  SingleWorkspaceRule,
} from "../domain/model";

/**
 * Where an asset is active in the bound workspace's organization (connections.locate_active_link): at most the
 * workspace and the account id. Absent = not active anywhere in this organization (another organization is
 * indistinguishable from nowhere).
 */
export interface ActiveLink {
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
}

/** Insert a new ACTIVE row, or reactivate this workspace's INACTIVE row for the same discovered asset. */
export interface AccountActivation {
  readonly newId: string;
  /** The bound workspace's INACTIVE row to reactivate, when one exists. */
  readonly reactivateId: string | null;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly connectionId: string;
  readonly platform: AssetPlatform;
  readonly providerAssetId: string;
  readonly assetClass: AssetClass;
  readonly now: Date;
}

/** The database is the final arbiter of M-01 / TA-Q-02: a refused activation names the rule, never another workspace. */
export type ActivationOutcome =
  | { readonly kind: "activated"; readonly account: ConnectedAccount; readonly reactivated: boolean }
  | { readonly kind: "conflict"; readonly rule: SingleWorkspaceRule };

/** Link/unlink/activation operations shared by the web and job stores (bound workspace, forced RLS). */
interface AccountLinking {
  get(id: string): Promise<ConnectedAccount | undefined>;
  /** This workspace's row for a connection's asset: the ACTIVE one, else the most recently updated INACTIVE one. */
  findForAsset(connectionId: string, platform: AssetPlatform, providerAssetId: string): Promise<ConnectedAccount | undefined>;
  /** Activation inside a savepoint: a unique-index refusal (M-01 / TA-Q-02) is an outcome, not a failed transaction. */
  activate(input: AccountActivation): Promise<ActivationOutcome>;
}

/** Web side (user scope: authenticated + claims + the bound workspace). */
export interface ConnectionStore {
  readonly attempts: {
    insert(attempt: ConnectAttempt): Promise<void>;
    /** The caller's own attempt by id (RLS: creator only, bound workspace). */
    get(id: string): Promise<ConnectAttempt | undefined>;
    /** The caller's own attempt in the bound workspace with this state digest (RLS: creator only). */
    findByStateDigest(digest: string): Promise<ConnectAttempt | undefined>;
    /** PENDING → EXCHANGING (sets exchange_started_at, NOT closed_at) iff still PENDING and unexpired. True only for the single winner. */
    claim(id: string, now: Date): Promise<boolean>;
    /** Conditional terminal transition from an open state (sets closed_at). Returns whether this call performed it. */
    close(id: string, from: "PENDING" | "EXCHANGING", to: Exclude<AttemptStatus, "PENDING" | "EXCHANGING">, now: Date, failureCode?: ExchangeFailureCode): Promise<boolean>;
    /** Housekeeping of the caller's own attempts: expired PENDING → EXPIRED, stale EXCHANGING → OUTCOME_UNKNOWN (both get closed_at). */
    recoverStale(now: Date, staleBefore: Date): Promise<{ readonly expired: number; readonly outcomeUnknown: number }>;
  };
  readonly connections: {
    get(id: string): Promise<Connection | undefined>;
    list(): Promise<readonly Connection[]>;
    insert(connection: Connection): Promise<void>;
    /** Optimistic update: applies only if the stored version is `expectedVersion`. */
    update(connection: Connection, expectedVersion: number): Promise<boolean>;
  };
  readonly events: { append(event: ConnectionEvent): Promise<void> };
  /** The credential definer API (TA §39): envelope bytes only; no table privilege exists. */
  readonly credentials: {
    store(input: { readonly connectionId: string; readonly credentialId: string; readonly credentialVersion: number; readonly envelope: Uint8Array; readonly expiresAt: Date | null }): Promise<void>;
    delete(credentialId: string): Promise<boolean>;
  };
  readonly connectedAccounts: AccountLinking & {
    list(): Promise<readonly ConnectedAccount[]>;
    /** ACTIVE → INACTIVE (UNLINKED) iff still ACTIVE. True only for the single winner. */
    unlink(id: string, now: Date): Promise<boolean>;
    /** Deactivates every ACTIVE connected account of a connection (with history). Returns how many. */
    deactivateForConnection(connectionId: string, reason: "DISCONNECTED" | "REMOVED", now: Date, actor: UserId, newId: () => string): Promise<number>;
  };
  readonly accountEvents: { append(event: ConnectedAccountEvent): Promise<void> };
  readonly discoveredAssets: {
    list(connectionId: string): Promise<readonly DiscoveredAsset[]>;
    get(id: string): Promise<DiscoveredAsset | undefined>;
  };
  /** connections.locate_active_link (Owner/Admin of the bound workspace only). */
  readonly links: { locateActive(discoveredAssetId: string): Promise<ActiveLink | undefined> };
  readonly moves: {
    getIncoming(moveId: string): Promise<IncomingMove | undefined>;
    /** The REQUESTED incoming move for this asset, if any (0007: at most one per workspace and asset). */
    findRequested(platform: AssetPlatform, providerAssetId: string): Promise<IncomingMove | undefined>;
    insertIncoming(move: IncomingMove): Promise<void>;
    /** ACTIVATION_FAILED → REQUESTED (reason cleared). True only for the single winner. */
    retry(moveId: string, now: Date): Promise<boolean>;
    /** connections.route_move_step(…, 'release_source', …): routed now or before (same dispatch key). */
    routeRelease(moveId: string, correlationId: string, now: Date): Promise<RouteResult>;
    /** connections.route_move_step(…, 'retry_activation', …): a NEW local activation attempt (move still ACTIVATION_FAILED). */
    routeRetry(moveId: string, correlationId: string, now: Date): Promise<RouteResult>;
  };
}

/** Job side (workspace job scope: app_worker + the job's single bound workspace). */
export interface ConnectionWorkerStore {
  readonly connections: {
    get(id: string): Promise<Connection | undefined>;
    update(connection: Connection, expectedVersion: number): Promise<boolean>;
  };
  readonly events: { append(event: ConnectionEvent): Promise<void> };
  readonly credentials: {
    load(credentialId: string): Promise<{ readonly connectionId: string; readonly envelope: Uint8Array } | undefined>;
  };
  readonly connectedAccounts: AccountLinking & {
    /** Row-locked read (FOR UPDATE): concurrent saga steps on one account serialize here. */
    lock(id: string): Promise<ConnectedAccount | undefined>;
    /** ACTIVE → INACTIVE (MOVED, with the move id) iff still ACTIVE. */
    release(id: string, moveId: string, now: Date): Promise<boolean>;
  };
  readonly accountEvents: { append(event: ConnectedAccountEvent): Promise<void> };
  readonly discoveredAssets: {
    /** Insert, or refresh display name and last-seen of the same (connection, provider asset id). Idempotent. */
    upsert(asset: DiscoveredAsset): Promise<void>;
    find(connectionId: string, platform: AssetPlatform, providerAssetId: string): Promise<DiscoveredAsset | undefined>;
  };
  /** connections.locate_active_link. */
  readonly links: { locateActive(discoveredAssetId: string): Promise<ActiveLink | undefined> };
  /** The saga's LOCAL move rows and its reviewed definer functions (0010). */
  readonly moves: {
    /** Row-locked read of this workspace's side of a move. */
    lockIncoming(moveId: string): Promise<IncomingMove | undefined>;
    lockOutgoing(moveId: string): Promise<OutgoingMove | undefined>;
    insertOutgoing(move: OutgoingMove): Promise<void>;
    setOutgoing(moveId: string, status: OutgoingMove["status"], reasonCode: MoveReasonCode | null, now: Date): Promise<void>;
    setIncoming(moveId: string, status: IncomingMove["status"], reasonCode: MoveReasonCode | null, connectedAccountId: string | null, now: Date): Promise<void>;
    /** connections.move_initiator_can_manage: the stored initiator's LIVE Owner/Admin authority here. */
    initiatorCanManage(moveId: string): Promise<boolean>;
    /** connections.record_move_audit: audit attributed to the stored human initiator. */
    recordAudit(moveId: string, step: MoveAuditStep, correlationId: string): Promise<void>;
    /** connections.route_move_step for the worker steps (a newly routed row is reported for the post-commit wake-up). */
    route(moveId: string, step: "activate_destination" | "reject_destination", correlationId: string, now: Date): Promise<RouteResult>;
  };
  readonly outbox: OutboxWriter;
  readonly audit: AuditLog;
  /** R6: claims a domain effect in THIS transaction. */
  claimEffect(effectKey: string): Promise<"claimed" | "already_applied">;
}

/** Web-only OAuth secrets (decisions B1/B3): never persisted, never logged, never given to adapters. */
export interface OAuthSecrets {
  newState(workspaceId: WorkspaceId): string;
  stateDigest(state: string): string;
  pkceVerifier(state: string): string;
  pkceChallenge(state: string): string;
}

/** Seals provider-credential plaintext (web: seal only). Returns encoded EnvelopeV1 bytes. */
export interface CredentialSealing {
  seal(plaintext: Uint8Array, binding: { readonly workspaceId: WorkspaceId; readonly credentialId: string }): Promise<Uint8Array>;
}

/**
 * The single credential-access function (TA §39), job runtime only: opens the envelope bound to exactly this
 * workspace and credential, lends the normalized credential to `use` for one provider call, then forgets it.
 */
export interface ProviderCredentialAccess {
  withCredential<T>(
    input: { readonly workspaceId: WorkspaceId; readonly credentialId: string; readonly envelope: Uint8Array },
    use: (credential: ProviderCredential) => Promise<T>,
  ): Promise<T>;
}

/** Provider ports by provider key (composition decides which exist; Step 5D: the simulator only). */
export interface AuthorizationProviders {
  authorization(provider: AuthorizableProvider): ProviderAuthorizationPort | undefined;
  /** The exact, query-free callback URL registered for this provider (0007 persists that shape). */
  redirectUri(provider: AuthorizableProvider): string;
}

export interface DiscoveryProviders {
  read(provider: Connection["provider"]): ProviderReadPort | undefined;
}

export type { ConnectionStatus };

/**
 * Raised by the credential-access function when an envelope can't be opened or decoded for its exact binding
 * (tampered, wrong workspace/credential, malformed plaintext). Fixed message; never carries material. A keyring
 * outage is NOT this error: it propagates as an infrastructure failure and the job retries.
 */
export class CredentialUnreadableError extends Error {
  override readonly name = "CredentialUnreadableError";
  constructor() {
    super("connections_credential_unreadable");
  }
}
