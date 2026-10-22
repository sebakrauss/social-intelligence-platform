/**
 * Connection management in the web (Step 5D): explicit removal and read models. Removal is explicit user intent,
 * so the credential is crypto-shredded definitively (D8): the Connection becomes REMOVED, the active pointer is
 * cleared first (0007 keeps a gone connection credential-free), the envelope is deleted, and any connected
 * accounts are deactivated with history — all in the caller's single transaction. Repeating it is a no-op.
 *
 * A single-connection provider (Meta, Step 7G-F4C) is removed under the same K(workspace, provider) as its fresh start
 * and completion, from a FOR UPDATE re-read taken after K, and the removal closes every open fresh attempt of that
 * provider in the workspace, across creators (REMOVE_INVALIDATES_OPEN_FRESH_META_ATTEMPTS): no OAuth flow that began
 * before the removal can complete after it. REMOVED is terminal: nothing reactivates it.
 */
import { AppError } from "@/domain/errors";
import type { CapabilityReadStore } from "@/modules/capability";
import { blocksFreshConnection, isSingleConnectionProvider, type Connection, type ConnectionProvider, type DiscoveredAsset } from "../domain/model";
import type { WorkspaceScope } from "./authorization";
import { capabilityReevaluationView, type CapabilityReevaluationView } from "./capability-reevaluation-view";
import { isManageableAsset } from "./linking";
import type { ConnectionStore } from "./ports";

export type RemovalOutput =
  | { readonly changed: false; readonly connectionId: string }
  | { readonly changed: true; readonly connectionId: string; readonly previous: Connection["status"]; readonly shredded: boolean; readonly deactivatedAccounts: number };

export async function removeConnection(
  store: ConnectionStore,
  input: {
    readonly scope: WorkspaceScope;
    readonly connectionId: string;
    /** A surface that removes one provider's connections only (Connect Meta): another provider is NOT_FOUND. */
    readonly expectedProvider?: ConnectionProvider;
    readonly now: Date;
    readonly newId: () => string;
  },
): Promise<RemovalOutput> {
  const found = await store.connections.get(input.connectionId);
  // The provider column is immutable (no runtime UPDATE grant), so checking it before the lock is final.
  if (found === undefined || (input.expectedProvider !== undefined && found.provider !== input.expectedProvider)) throw new AppError("NOT_FOUND", {});
  const single = isSingleConnectionProvider(found.provider) ? found.provider : undefined;
  let connection = found;
  if (single !== undefined) {
    await store.connections.serializeFresh(input.scope.workspaceId, single);
    const locked = await store.connections.lockForUpdate(found.id);
    if (locked === undefined) throw new AppError("NOT_FOUND", {});
    connection = locked;
  }
  if (connection.status === "REMOVED") return { changed: false, connectionId: connection.id };

  const removed: Connection = { ...connection, status: "REMOVED", activeCredentialId: null, version: connection.version + 1, updatedAt: input.now };
  if (!(await store.connections.update(removed, connection.version))) throw new AppError("CONFLICT", {});
  const shredded = connection.activeCredentialId === null ? false : await store.credentials.delete(connection.activeCredentialId);
  const deactivatedAccounts = await store.connectedAccounts.deactivateForConnection(connection.id, "REMOVED", input.now, input.scope.userId, input.newId);
  if (single !== undefined) await store.attempts.invalidateOpenFresh(single, input.now);
  await store.events.append({
    id: input.newId(),
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    connectionId: connection.id,
    previousStatus: connection.status,
    newStatus: "REMOVED",
    reasonCode: "REMOVED_BY_USER",
    actor: { type: "user", userId: input.scope.userId },
    occurredAt: input.now,
  });
  return { changed: true, connectionId: connection.id, previous: connection.status, shredded, deactivatedAccounts };
}

/** What a member may see about a connection: status and closed problem codes only. Never credentials. */
export interface ConnectionSummary {
  readonly id: string;
  readonly provider: Connection["provider"];
  readonly status: Connection["status"];
  readonly hasCredential: boolean;
  readonly lastProblemCode: Connection["lastProblemCode"];
  readonly lastSuccessAt: Date | null;
  readonly authorizedAt: Date;
}

export interface ConnectionDetail extends ConnectionSummary {
  readonly discoveredAssets: readonly Pick<DiscoveredAsset, "platform" | "providerAssetId" | "assetClass" | "displayName" | "lastSeenAt">[];
}

export function summarize(connection: Connection): ConnectionSummary {
  return {
    id: connection.id,
    provider: connection.provider,
    status: connection.status,
    hasCredential: connection.activeCredentialId !== null,
    lastProblemCode: connection.lastProblemCode,
    lastSuccessAt: connection.lastSuccessAt,
    authorizedAt: connection.authorizedAt,
  };
}

export async function listConnections(store: ConnectionStore): Promise<readonly ConnectionSummary[]> {
  return (await store.connections.list()).map(summarize);
}

/**
 * Workspace Settings › Connections (Step 7G-F4): every Connection's safe summary, plus whether a fresh Meta connect
 * looks open by the current Connection state. UX only — the atomic start decides, under its lock. Read only: no stale
 * recovery, no authorization start.
 */
export interface ConnectionSettings {
  readonly connections: readonly ConnectionSummary[];
  readonly metaConnect: "available" | "existing_connection";
  /**
   * Step 7G-H5: for each ACTIVE Meta connection, the discovered assets the workspace may choose to manage, and whether it
   * manages each one now (an ACTIVE connected account). Persisted discovery only — never a provider call; no provider id.
   */
  readonly manageableAssets: readonly ManageableAsset[];
}

export interface ManageableAsset {
  readonly connectionId: string;
  readonly discoveredAssetId: string;
  readonly platform: DiscoveredAsset["platform"];
  readonly displayName: string;
  readonly managed: boolean;
  /** Step 7G-H5.5-P2-B2: the managed (ACTIVE) Connected Account of this asset; null when it isn't managed. */
  readonly connectedAccountId: string | null;
  /**
   * Step 7G-H5.5-P2-B2: whether to OFFER "Re-check capabilities" for that account (presentation only; the command
   * decides again). Null when the asset isn't managed: there is no account to re-check.
   */
  readonly capabilityReevaluation: CapabilityReevaluationView | null;
}

/**
 * The settings read model. `reevaluation` supplies the read-only capability header store and the server instant the
 * re-check offer is derived with (Step 7G-H5.5-P2-B2); nothing is locked or written.
 */
export async function viewConnectionSettings(
  store: ConnectionStore,
  reevaluation: { readonly capability: CapabilityReadStore; readonly now: Date },
): Promise<ConnectionSettings> {
  const connections = await store.connections.list();
  const accounts = await store.connectedAccounts.list();
  const manageableAssets: ManageableAsset[] = [];
  for (const connection of connections.filter((c) => c.provider === "meta" && c.status === "ACTIVE")) {
    const managed = new Map(accounts.filter((a) => a.connectionId === connection.id && a.status === "ACTIVE").map((a) => [`${a.platform}:${a.providerAssetId}`, a]));
    for (const asset of (await store.discoveredAssets.list(connection.id)).filter(isManageableAsset)) {
      const account = managed.get(`${asset.platform}:${asset.providerAssetId}`);
      manageableAssets.push({
        connectionId: connection.id,
        discoveredAssetId: asset.id,
        platform: asset.platform,
        displayName: asset.displayName,
        managed: account !== undefined,
        connectedAccountId: account?.id ?? null,
        capabilityReevaluation:
          account === undefined
            ? null
            : await capabilityReevaluationView({ accountEvents: store.accountEvents, capability: reevaluation.capability }, { account, connection, now: reevaluation.now }),
      });
    }
  }
  return {
    connections: connections.map(summarize),
    metaConnect: connections.some((connection) => blocksFreshConnection(connection, "meta")) ? "existing_connection" : "available",
    manageableAssets,
  };
}

export async function getConnection(store: ConnectionStore, connectionId: string): Promise<ConnectionDetail> {
  const connection = await store.connections.get(connectionId);
  if (connection === undefined) throw new AppError("NOT_FOUND", {});
  const assets = await store.discoveredAssets.list(connection.id);
  return {
    ...summarize(connection),
    discoveredAssets: assets.map(({ platform, providerAssetId, assetClass, displayName, lastSeenAt }) => ({ platform, providerAssetId, assetClass, displayName, lastSeenAt })),
  };
}
