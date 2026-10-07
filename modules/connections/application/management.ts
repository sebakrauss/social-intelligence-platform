/**
 * Connection management in the web (Step 5D): explicit removal and read models. Removal is explicit user intent,
 * so the credential is crypto-shredded definitively (D8): the Connection becomes REMOVED, the active pointer is
 * cleared first (0007 keeps a gone connection credential-free), the envelope is deleted, and any connected
 * accounts are deactivated with history — all in the caller's single transaction. Repeating it is a no-op.
 */
import { AppError } from "@/domain/errors";
import type { Connection, DiscoveredAsset } from "../domain/model";
import type { WorkspaceScope } from "./authorization";
import type { ConnectionStore } from "./ports";

export type RemovalOutput =
  | { readonly changed: false; readonly connectionId: string }
  | { readonly changed: true; readonly connectionId: string; readonly previous: Connection["status"]; readonly shredded: boolean; readonly deactivatedAccounts: number };

export async function removeConnection(
  store: ConnectionStore,
  input: { readonly scope: WorkspaceScope; readonly connectionId: string; readonly now: Date; readonly newId: () => string },
): Promise<RemovalOutput> {
  const connection = await store.connections.get(input.connectionId);
  if (connection === undefined) throw new AppError("NOT_FOUND", {});
  if (connection.status === "REMOVED") return { changed: false, connectionId: connection.id };

  const removed: Connection = { ...connection, status: "REMOVED", activeCredentialId: null, version: connection.version + 1, updatedAt: input.now };
  if (!(await store.connections.update(removed, connection.version))) throw new AppError("CONFLICT", {});
  const shredded = connection.activeCredentialId === null ? false : await store.credentials.delete(connection.activeCredentialId);
  const deactivatedAccounts = await store.connectedAccounts.deactivateForConnection(connection.id, "REMOVED", input.now, input.scope.userId, input.newId);
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

export async function getConnection(store: ConnectionStore, connectionId: string): Promise<ConnectionDetail> {
  const connection = await store.connections.get(connectionId);
  if (connection === undefined) throw new AppError("NOT_FOUND", {});
  const assets = await store.discoveredAssets.list(connection.id);
  return {
    ...summarize(connection),
    discoveredAssets: assets.map(({ platform, providerAssetId, assetClass, displayName, lastSeenAt }) => ({ platform, providerAssetId, assetClass, displayName, lastSeenAt })),
  };
}
