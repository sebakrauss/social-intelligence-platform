/**
 * The authorization round trip, web side (Step 5D; TA §39; decisions B1–B3). Each function runs inside ONE
 * user-scoped transaction (the action pipeline's unit of work); the provider exchange itself happens between
 * transactions, in the server orchestration, never inside one:
 *
 *   start      own stale attempts recovered → v1 state + digest → derived S256 challenge → attempt PENDING
 *   verify     SHA-256(callback state) → the caller's own attempt in the routed workspace, same provider
 *              denied: PENDING → DENIED   ·   code: PENDING → EXCHANGING (the exactly-once claim)
 *   complete   EXCHANGING → COMPLETED with the sealed credential stored and the Connection created or updated
 *   fail       EXCHANGING → EXCHANGE_FAILED (closed code) | OUTCOME_UNKNOWN
 *
 * Every rejection of a callback (unknown, modified, expired, replayed, closed, other user, other workspace,
 * other provider) is the same NOT_FOUND with no side effect: nothing reveals whether an attempt exists.
 */
import type { ConnectionStatus } from "@/domain/connections";
import { AppError } from "@/domain/errors";
import type { OrganizationId, UserId, WorkspaceId } from "@/domain/ids";
import { parsePkceChallenge, parseRedirectUri, type PkceChallenge, type RedirectUri } from "@/integrations/providers/contract";
import {
  ATTEMPT_TTL_MS,
  EXCHANGE_STALE_AFTER_MS,
  acceptsAuthorization,
  isClaimable,
  statusAfterReauthorization,
  type AuthorizableProvider,
  type Connection,
  type ExchangeFailureCode,
} from "../domain/model";
import type { AuthorizationProviders, ConnectionStore, OAuthSecrets } from "./ports";

export interface WorkspaceScope {
  readonly workspaceId: WorkspaceId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
}

export interface StartedAuthorization {
  readonly attemptId: string;
  /** Raw state: travels only to the authorization URL builder, never stored, logged or returned to a client. */
  readonly state: string;
  readonly pkce: PkceChallenge | null;
  readonly redirectUri: RedirectUri;
  readonly provider: AuthorizableProvider;
}

const notFound = (): never => {
  throw new AppError("NOT_FOUND", {});
};

export async function startAuthorization(
  store: ConnectionStore,
  deps: { readonly secrets: OAuthSecrets; readonly providers: AuthorizationProviders },
  input: {
    readonly scope: WorkspaceScope;
    readonly provider: AuthorizableProvider;
    readonly reconnectConnectionId: string | null;
    readonly now: Date;
    readonly newId: () => string;
  },
): Promise<StartedAuthorization> {
  const port = deps.providers.authorization(input.provider);
  if (port === undefined) throw new AppError("INVALID_INPUT", { field: "provider" });
  const redirectUri = parseRedirectUri(deps.providers.redirectUri(input.provider));
  if (redirectUri === undefined || redirectUri.includes("?")) throw new TypeError("connections: misconfigured redirect URI");

  if (input.reconnectConnectionId !== null) {
    const connection = await store.connections.get(input.reconnectConnectionId);
    if (connection === undefined || !acceptsAuthorization(connection) || connection.provider !== input.provider) notFound();
  }

  // Stale recovery (decision B2 §11): the caller's expired attempts close; a long-running exchange becomes
  // OUTCOME_UNKNOWN, so its late result can never complete it.
  await store.attempts.recoverStale(input.now, new Date(input.now.getTime() - EXCHANGE_STALE_AFTER_MS));

  const state = deps.secrets.newState(input.scope.workspaceId);
  const pkce = port.pkce === "not_supported" ? null : (parsePkceChallenge(deps.secrets.pkceChallenge(state)) ?? null);
  if (port.pkce !== "not_supported" && pkce === null) throw new TypeError("connections: invalid derived challenge");
  const attemptId = input.newId();
  await store.attempts.insert({
    id: attemptId,
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    provider: input.provider,
    createdBy: input.scope.userId,
    stateDigest: deps.secrets.stateDigest(state),
    redirectUri,
    reconnectConnectionId: input.reconnectConnectionId,
    status: "PENDING",
    expiresAt: new Date(input.now.getTime() + ATTEMPT_TTL_MS),
    createdAt: input.now,
    closedAt: null,
    exchangeStartedAt: null,
    failureCode: null,
  });
  return { attemptId, state, pkce, redirectUri, provider: input.provider };
}

export interface ClaimedExchange {
  readonly attemptId: string;
  readonly redirectUri: RedirectUri;
}

/**
 * Verifies a callback against the caller's own pending attempt and applies its outcome. Returns the claim for a
 * code callback (the ONLY path to an exchange) or "denied". Anything else is NOT_FOUND, with no side effect.
 */
export async function verifyCallback(
  store: ConnectionStore,
  input: { readonly scope: WorkspaceScope; readonly provider: AuthorizableProvider; readonly stateDigest: string; readonly kind: "code" | "denied"; readonly now: Date },
): Promise<ClaimedExchange | "denied"> {
  const attempt = await store.attempts.findByStateDigest(input.stateDigest);
  const ok =
    attempt !== undefined &&
    attempt.workspaceId === input.scope.workspaceId &&
    attempt.createdBy === input.scope.userId &&
    attempt.provider === input.provider &&
    isClaimable(attempt, input.now);
  if (!ok) return notFound();
  if (input.kind === "denied") {
    if (!(await store.attempts.close(attempt.id, "PENDING", "DENIED", input.now))) notFound();
    return "denied";
  }
  const redirectUri = parseRedirectUri(attempt.redirectUri);
  if (redirectUri === undefined || !(await store.attempts.claim(attempt.id, input.now))) return notFound();
  return { attemptId: attempt.id, redirectUri };
}

export type CompletionOutput =
  | { readonly kind: "created"; readonly connection: Connection; readonly credentialId: string }
  | { readonly kind: "reauthorized"; readonly connection: Connection; readonly previousStatus: ConnectionStatus; readonly credentialId: string }
  | { readonly kind: "connection_unavailable"; readonly attemptId: string };

/**
 * Stores the sealed credential and completes the attempt, atomically. A late result for an attempt that is no
 * longer EXCHANGING (recovered as OUTCOME_UNKNOWN, or already closed) is refused: nothing is written, so it can
 * never overwrite a newer authorization. Re-authorization swaps the active pointer only after the new envelope is
 * stored, then crypto-shreds the superseded envelope in the same transaction (it is no longer referenced and could
 * not be found again to shred later).
 */
export async function completeExchange(
  store: ConnectionStore,
  input: {
    readonly scope: WorkspaceScope;
    readonly attemptId: string;
    readonly credentialId: string;
    readonly envelope: Uint8Array;
    readonly expiresAt: Date | null;
    readonly now: Date;
    readonly newId: () => string;
  },
): Promise<CompletionOutput> {
  const attempt = await store.attempts.get(input.attemptId);
  if (attempt?.status !== "EXCHANGING" || attempt.createdBy !== input.scope.userId) throw new AppError("CONFLICT", {});
  const actor = { type: "user" as const, userId: input.scope.userId };
  const base = { organizationId: input.scope.organizationId, workspaceId: input.scope.workspaceId };

  if (attempt.reconnectConnectionId === null) {
    const connectionId = input.newId();
    const created: Connection = {
      id: connectionId,
      ...base,
      provider: attempt.provider,
      status: "CONNECTING",
      activeCredentialId: null,
      authorizedBy: input.scope.userId,
      authorizedAt: input.now,
      lastSuccessAt: null,
      lastProblemCode: null,
      lastProblemAt: null,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    };
    await store.connections.insert(created);
    await store.credentials.store({ connectionId, credentialId: input.credentialId, credentialVersion: 1, envelope: input.envelope, expiresAt: input.expiresAt });
    const active: Connection = { ...created, activeCredentialId: input.credentialId, version: 2 };
    if (!(await store.connections.update(active, 1))) throw new AppError("CONFLICT", {});
    if (!(await store.attempts.close(attempt.id, "EXCHANGING", "COMPLETED", input.now))) throw new AppError("CONFLICT", {});
    await store.events.append({ id: input.newId(), ...base, connectionId, previousStatus: null, newStatus: "CONNECTING", reasonCode: "AUTHORIZED", actor, occurredAt: input.now });
    return { kind: "created", connection: active, credentialId: input.credentialId };
  }

  const existing = await store.connections.get(attempt.reconnectConnectionId);
  if (existing === undefined || !acceptsAuthorization(existing) || existing.provider !== attempt.provider) {
    if (!(await store.attempts.close(attempt.id, "EXCHANGING", "EXCHANGE_FAILED", input.now, "CONNECTION_UNAVAILABLE"))) throw new AppError("CONFLICT", {});
    return { kind: "connection_unavailable", attemptId: attempt.id };
  }
  const credentialVersion = existing.version + 1;
  await store.credentials.store({ connectionId: existing.id, credentialId: input.credentialId, credentialVersion, envelope: input.envelope, expiresAt: input.expiresAt });
  const replaced: Connection = {
    ...existing,
    status: statusAfterReauthorization(existing.status),
    activeCredentialId: input.credentialId,
    authorizedBy: input.scope.userId,
    authorizedAt: input.now,
    version: credentialVersion,
    updatedAt: input.now,
  };
  if (!(await store.connections.update(replaced, existing.version))) throw new AppError("CONFLICT", {});
  if (existing.activeCredentialId !== null) await store.credentials.delete(existing.activeCredentialId);
  if (!(await store.attempts.close(attempt.id, "EXCHANGING", "COMPLETED", input.now))) throw new AppError("CONFLICT", {});
  await store.events.append({
    id: input.newId(),
    ...base,
    connectionId: existing.id,
    previousStatus: existing.status,
    newStatus: replaced.status,
    reasonCode: "REAUTHORIZED",
    actor,
    occurredAt: input.now,
  });
  return { kind: "reauthorized", connection: replaced, previousStatus: existing.status, credentialId: input.credentialId };
}

/** Closes a claimed attempt after a failed or ambiguous exchange. A no-op if it is no longer EXCHANGING. */
export async function failExchange(
  store: ConnectionStore,
  input: { readonly attemptId: string; readonly outcome: { readonly kind: "failed"; readonly code: ExchangeFailureCode } | { readonly kind: "outcome_unknown" }; readonly now: Date },
): Promise<boolean> {
  return input.outcome.kind === "failed"
    ? store.attempts.close(input.attemptId, "EXCHANGING", "EXCHANGE_FAILED", input.now, input.outcome.code)
    : store.attempts.close(input.attemptId, "EXCHANGING", "OUTCOME_UNKNOWN", input.now);
}
