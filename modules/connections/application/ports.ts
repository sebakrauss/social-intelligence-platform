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
import type { UserId, WorkspaceId } from "@/domain/ids";
import type { AuditLog } from "@/modules/audit";
import type { ProviderAuthorizationPort, ProviderCredential, ProviderReadPort } from "@/integrations/providers/contract";
import type {
  AttemptStatus,
  AuthorizableProvider,
  ConnectAttempt,
  Connection,
  ConnectionEvent,
  DiscoveredAsset,
  ExchangeFailureCode,
} from "../domain/model";

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
  readonly connectedAccounts: {
    /** Deactivates every ACTIVE connected account of a connection (with history). Returns how many. */
    deactivateForConnection(connectionId: string, reason: "DISCONNECTED" | "REMOVED", now: Date, actor: UserId, newId: () => string): Promise<number>;
  };
  readonly discoveredAssets: { list(connectionId: string): Promise<readonly DiscoveredAsset[]> };
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
  readonly discoveredAssets: {
    /** Insert, or refresh display name and last-seen of the same (connection, provider asset id). Idempotent. */
    upsert(asset: DiscoveredAsset): Promise<void>;
  };
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
