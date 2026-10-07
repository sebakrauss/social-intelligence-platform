/**
 * PostgreSQL implementations of the connections stores, used inside a tenant-scoped transaction (platform/db
 * scope helpers). Every statement runs under forced RLS as the transaction's runtime role, bound to one
 * workspace: the web store as `authenticated` (Owner/Admin writes, creator-only attempts), the worker store as
 * `app_worker`. Each UPDATE sets only the columns its role is granted. Rows are parsed back strictly: a value
 * outside the closed vocabularies is treated as corruption, never passed on. Credentials are reached only
 * through the credential definer functions, as EnvelopeV1 bytes.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { isConnectionStatus } from "@/domain/connections";
import { parseOrganizationId, parseUserId, parseWorkspaceId } from "@/domain/ids";
import type { AuditLog } from "@/modules/audit";
import type { DatabaseTransaction } from "@/platform/db";
import type { ConnectionStore, ConnectionWorkerStore } from "../application/ports";
import {
  ASSET_CLASSES,
  ASSET_PLATFORMS,
  ATTEMPT_STATUSES,
  CONNECTION_PROBLEM_CODES,
  CONNECTION_PROVIDERS,
  EXCHANGE_FAILURE_CODES,
  type ConnectAttempt,
  type Connection,
  type ConnectionEvent,
  type DiscoveredAsset,
} from "../domain/model";
import { connectAttempts, connectedAccountEvents, connectedAccounts, connectionEvents, connectionsTable, discoveredAssets } from "./tables";

function corrupt(table: string): never {
  throw new TypeError(`connections persistence: unexpected value in ${table}`);
}

function closed<T extends string>(values: readonly T[], value: unknown, table: string): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : corrupt(table);
}

function nullableClosed<T extends string>(values: readonly T[], value: unknown, table: string): T | null {
  return value === null ? null : closed(values, value, table);
}

const ids = <T>(value: T | undefined, table: string): T => (value === undefined ? corrupt(table) : value);

function toConnection(row: typeof connectionsTable.$inferSelect): Connection {
  const table = "connections";
  return {
    id: row.id,
    organizationId: ids(parseOrganizationId(row.organizationId), table),
    workspaceId: ids(parseWorkspaceId(row.workspaceId), table),
    provider: closed(CONNECTION_PROVIDERS, row.provider, table),
    status: isConnectionStatus(row.status) ? row.status : corrupt(table),
    activeCredentialId: row.activeCredentialId,
    authorizedBy: ids(parseUserId(row.authorizedBy), table),
    authorizedAt: row.authorizedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastProblemCode: nullableClosed(CONNECTION_PROBLEM_CODES, row.lastProblemCode, table),
    lastProblemAt: row.lastProblemAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAttempt(row: typeof connectAttempts.$inferSelect): ConnectAttempt {
  const table = "connect_attempts";
  return {
    id: row.id,
    organizationId: ids(parseOrganizationId(row.organizationId), table),
    workspaceId: ids(parseWorkspaceId(row.workspaceId), table),
    provider: closed(CONNECTION_PROVIDERS, row.provider, table),
    createdBy: ids(parseUserId(row.createdBy), table),
    stateDigest: row.stateDigest,
    redirectUri: row.redirectUri,
    reconnectConnectionId: row.reconnectConnectionId,
    status: closed(ATTEMPT_STATUSES, row.status, table),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    exchangeStartedAt: row.exchangeStartedAt,
    failureCode: nullableClosed(EXCHANGE_FAILURE_CODES, row.failureCode, table),
  };
}

function toAsset(row: typeof discoveredAssets.$inferSelect): DiscoveredAsset {
  const table = "discovered_assets";
  return {
    id: row.id,
    organizationId: ids(parseOrganizationId(row.organizationId), table),
    workspaceId: ids(parseWorkspaceId(row.workspaceId), table),
    connectionId: row.connectionId,
    platform: closed(ASSET_PLATFORMS, row.platform, table),
    providerAssetId: row.providerAssetId,
    assetClass: closed(ASSET_CLASSES, row.assetClass, table),
    displayName: row.displayName,
    lastSeenAt: row.lastSeenAt,
  };
}

function eventRow(event: ConnectionEvent): typeof connectionEvents.$inferInsert {
  return {
    id: event.id,
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    connectionId: event.connectionId,
    previousStatus: event.previousStatus,
    newStatus: event.newStatus,
    reasonCode: event.reasonCode,
    actorType: event.actor.type,
    actorUserId: event.actor.type === "user" ? event.actor.userId : null,
    occurredAt: event.occurredAt,
  };
}

async function getConnection(tx: DatabaseTransaction, id: string): Promise<Connection | undefined> {
  const rows = await tx.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(2);
  if (rows.length > 1) corrupt("connections");
  const row = rows[0];
  return row === undefined ? undefined : toConnection(row);
}

const versioned = (connection: Connection, expectedVersion: number) =>
  and(eq(connectionsTable.id, connection.id), eq(connectionsTable.version, expectedVersion));

/** Web store (role `authenticated`; writes need Owner/Admin in the bound workspace, enforced by RLS too). */
export function createPostgresConnectionStore(tx: DatabaseTransaction): ConnectionStore {
  const attempt = async (where: ReturnType<typeof eq>): Promise<ConnectAttempt | undefined> => {
    const rows = await tx.select().from(connectAttempts).where(where).limit(2);
    if (rows.length > 1) corrupt("connect_attempts");
    const row = rows[0];
    return row === undefined ? undefined : toAttempt(row);
  };

  return {
    attempts: {
      async insert(a) {
        await tx.insert(connectAttempts).values({
          id: a.id,
          organizationId: a.organizationId,
          workspaceId: a.workspaceId,
          provider: a.provider,
          createdBy: a.createdBy,
          stateDigest: a.stateDigest,
          redirectUri: a.redirectUri,
          reconnectConnectionId: a.reconnectConnectionId,
          status: a.status,
          expiresAt: a.expiresAt,
          createdAt: a.createdAt,
        });
      },
      get: (id) => attempt(eq(connectAttempts.id, id)),
      findByStateDigest: (digest) => attempt(eq(connectAttempts.stateDigest, digest)),
      async claim(id, now) {
        const rows = await tx
          .update(connectAttempts)
          // The durable claim is exchange_started_at; EXCHANGING is not closed (closed_at stays NULL).
          .set({ status: "EXCHANGING", exchangeStartedAt: now })
          .where(and(eq(connectAttempts.id, id), eq(connectAttempts.status, "PENDING"), sql`${connectAttempts.expiresAt} > ${now}`))
          .returning({ id: connectAttempts.id });
        return rows.length === 1;
      },
      async close(id, from, to, now, failureCode) {
        const rows = await tx
          .update(connectAttempts)
          // `from` is always an open state (PENDING or EXCHANGING): the terminal transition records closed_at.
          .set({ status: to, closedAt: now, failureCode: failureCode ?? null })
          .where(and(eq(connectAttempts.id, id), eq(connectAttempts.status, from)))
          .returning({ id: connectAttempts.id });
        return rows.length === 1;
      },
      async recoverStale(now, staleBefore) {
        const expired = await tx
          .update(connectAttempts)
          .set({ status: "EXPIRED", closedAt: now })
          .where(and(eq(connectAttempts.status, "PENDING"), lte(connectAttempts.expiresAt, now)))
          .returning({ id: connectAttempts.id });
        const unknown = await tx
          .update(connectAttempts)
          .set({ status: "OUTCOME_UNKNOWN", closedAt: now })
          .where(and(eq(connectAttempts.status, "EXCHANGING"), lte(connectAttempts.exchangeStartedAt, staleBefore)))
          .returning({ id: connectAttempts.id });
        return { expired: expired.length, outcomeUnknown: unknown.length };
      },
    },
    connections: {
      get: (id) => getConnection(tx, id),
      async list() {
        return (await tx.select().from(connectionsTable).orderBy(asc(connectionsTable.createdAt), asc(connectionsTable.id))).map(toConnection);
      },
      async insert(c) {
        await tx.insert(connectionsTable).values({
          id: c.id,
          organizationId: c.organizationId,
          workspaceId: c.workspaceId,
          provider: c.provider,
          status: c.status,
          activeCredentialId: c.activeCredentialId,
          authorizedBy: c.authorizedBy,
          authorizedAt: c.authorizedAt,
          lastSuccessAt: c.lastSuccessAt,
          lastProblemCode: c.lastProblemCode,
          lastProblemAt: c.lastProblemAt,
          version: c.version,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        });
      },
      async update(c, expectedVersion) {
        const rows = await tx
          .update(connectionsTable)
          .set({
            status: c.status,
            activeCredentialId: c.activeCredentialId,
            authorizedBy: c.authorizedBy,
            authorizedAt: c.authorizedAt,
            lastProblemCode: c.lastProblemCode,
            lastProblemAt: c.lastProblemAt,
            version: c.version,
            updatedAt: c.updatedAt,
          })
          .where(versioned(c, expectedVersion))
          .returning({ id: connectionsTable.id });
        return rows.length === 1;
      },
    },
    events: {
      async append(event) {
        await tx.insert(connectionEvents).values(eventRow(event));
      },
    },
    credentials: {
      async store(input) {
        await tx.execute(sql`select credentials.store_envelope(
          ${input.connectionId}::uuid, ${input.credentialId}::uuid, ${input.credentialVersion}::integer,
          ${Buffer.from(input.envelope.buffer, input.envelope.byteOffset, input.envelope.byteLength)}::bytea, ${input.expiresAt}::timestamptz)`);
      },
      async delete(credentialId) {
        const result = await tx.execute<{ deleted: boolean }>(sql`select credentials.delete_envelope(${credentialId}::uuid) as deleted`);
        return result.rows[0]?.deleted === true;
      },
    },
    connectedAccounts: {
      async deactivateForConnection(connectionId, reason, now, actor, newId) {
        const rows = await tx
          .update(connectedAccounts)
          .set({ status: "INACTIVE", deactivatedAt: now, deactivationReason: reason, updatedAt: now })
          .where(and(eq(connectedAccounts.connectionId, connectionId), eq(connectedAccounts.status, "ACTIVE")))
          .returning({ id: connectedAccounts.id, organizationId: connectedAccounts.organizationId, workspaceId: connectedAccounts.workspaceId });
        for (const row of rows) {
          await tx.insert(connectedAccountEvents).values({
            id: newId(),
            organizationId: row.organizationId,
            workspaceId: row.workspaceId,
            connectedAccountId: row.id,
            eventType: "DEACTIVATED",
            moveId: null,
            reasonCode: reason === "REMOVED" ? "CONNECTION_REMOVED" : "CONNECTION_DISCONNECTED",
            actorType: "user",
            actorUserId: actor,
            occurredAt: now,
          });
        }
        return rows.length;
      },
    },
    discoveredAssets: {
      async list(connectionId) {
        return (
          await tx
            .select()
            .from(discoveredAssets)
            .where(eq(discoveredAssets.connectionId, connectionId))
            .orderBy(asc(discoveredAssets.platform), asc(discoveredAssets.providerAssetId))
        ).map(toAsset);
      },
    },
  };
}

/** Worker store (role `app_worker`, the job's single bound workspace). */
export function createPostgresConnectionWorkerStore(
  tx: DatabaseTransaction,
  extras: { readonly audit: AuditLog; readonly claimEffect: (effectKey: string) => Promise<"claimed" | "already_applied"> },
): ConnectionWorkerStore {
  return {
    connections: {
      get: (id) => getConnection(tx, id),
      async update(c, expectedVersion) {
        const rows = await tx
          .update(connectionsTable)
          .set({
            status: c.status,
            activeCredentialId: c.activeCredentialId,
            lastSuccessAt: c.lastSuccessAt,
            lastProblemCode: c.lastProblemCode,
            lastProblemAt: c.lastProblemAt,
            version: c.version,
            updatedAt: c.updatedAt,
          })
          .where(versioned(c, expectedVersion))
          .returning({ id: connectionsTable.id });
        return rows.length === 1;
      },
    },
    events: {
      async append(event) {
        await tx.insert(connectionEvents).values(eventRow(event));
      },
    },
    credentials: {
      async load(credentialId) {
        const result = await tx.execute<{ connection_id: string; envelope: Buffer }>(
          sql`select connection_id, envelope from credentials.load_envelope(${credentialId}::uuid)`,
        );
        const row = result.rows[0];
        return row === undefined ? undefined : { connectionId: row.connection_id, envelope: new Uint8Array(row.envelope) };
      },
    },
    discoveredAssets: {
      async upsert(asset) {
        await tx
          .insert(discoveredAssets)
          .values({
            id: asset.id,
            organizationId: asset.organizationId,
            workspaceId: asset.workspaceId,
            connectionId: asset.connectionId,
            platform: asset.platform,
            providerAssetId: asset.providerAssetId,
            assetClass: asset.assetClass,
            displayName: asset.displayName,
            lastSeenAt: asset.lastSeenAt,
            createdAt: asset.lastSeenAt,
            updatedAt: asset.lastSeenAt,
          })
          .onConflictDoUpdate({
            target: [discoveredAssets.workspaceId, discoveredAssets.connectionId, discoveredAssets.providerAssetId],
            set: { displayName: asset.displayName, lastSeenAt: asset.lastSeenAt, updatedAt: asset.lastSeenAt },
          });
      },
    },
    audit: extras.audit,
    claimEffect: extras.claimEffect,
  };
}
