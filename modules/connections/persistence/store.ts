/**
 * PostgreSQL implementations of the connections stores, used inside a tenant-scoped transaction (platform/db
 * scope helpers). Every statement runs under forced RLS as the transaction's runtime role, bound to one
 * workspace: the web store as `authenticated` (Owner/Admin writes, creator-only attempts), the worker store as
 * `app_worker`. Each UPDATE sets only the columns its role is granted. Rows are parsed back strictly: a value
 * outside the closed vocabularies is treated as corruption, never passed on. Credentials are reached only
 * through the credential definer functions, as EnvelopeV1 bytes.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { isConnectionStatus } from "@/domain/connections";
import { AppError } from "@/domain/errors";
import { parseOrganizationId, parseUserId, parseWorkspaceId } from "@/domain/ids";
import type { AuditLog } from "@/modules/audit";
import { postgresError, type DatabaseTransaction } from "@/platform/db";
import type { OutboxWriter } from "@/platform/outbox";
import type { AccountActivation, ActivationOutcome, ActiveLink, CapabilityReconcileStore, ConnectionStore, ConnectionWorkerStore } from "../application/ports";
import {
  ASSET_CLASSES,
  ASSET_PLATFORMS,
  ATTEMPT_STATUSES,
  CONNECTION_PROBLEM_CODES,
  CONNECTION_PROVIDERS,
  DEACTIVATION_REASONS,
  EXCHANGE_FAILURE_CODES,
  INCOMING_MOVE_STATUSES,
  MOVE_REASON_CODES,
  OUTGOING_MOVE_STATUSES,
  SINGLE_WORKSPACE_INDEXES,
  type AssetPlatform,
  type ConnectAttempt,
  type ConnectedAccount,
  type ConnectedAccountEvent,
  type Connection,
  type ConnectionEvent,
  type DiscoveredAsset,
  type IncomingMove,
  type OutgoingMove,
  type RouteResult,
} from "../domain/model";
import { assetMoves, connectAttempts, connectedAccountEvents, connectedAccounts, connectionEvents, connectionsTable, discoveredAssets } from "./tables";

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

function toAccount(row: typeof connectedAccounts.$inferSelect): ConnectedAccount {
  const table = "connected_accounts";
  return {
    id: row.id,
    organizationId: ids(parseOrganizationId(row.organizationId), table),
    workspaceId: ids(parseWorkspaceId(row.workspaceId), table),
    connectionId: row.connectionId,
    platform: closed(ASSET_PLATFORMS, row.platform, table),
    providerAssetId: row.providerAssetId,
    assetClass: closed(ASSET_CLASSES, row.assetClass, table),
    status: closed(["ACTIVE", "INACTIVE"] as const, row.status, table),
    activatedAt: row.activatedAt,
    deactivatedAt: row.deactivatedAt,
    deactivationReason: nullableClosed(DEACTIVATION_REASONS, row.deactivationReason, table),
    moveId: row.moveId,
  };
}

async function getConnectedAccount(tx: DatabaseTransaction, id: string, lock = false): Promise<ConnectedAccount | undefined> {
  const query = tx.select().from(connectedAccounts).where(eq(connectedAccounts.id, id)).limit(2);
  const rows = lock ? await query.for("update") : await query;
  if (rows.length > 1) corrupt("connected_accounts");
  const row = rows[0];
  return row === undefined ? undefined : toAccount(row);
}

function toMove(row: typeof assetMoves.$inferSelect): IncomingMove | OutgoingMove {
  const table = "asset_moves";
  const base = {
    organizationId: ids(parseOrganizationId(row.organizationId), table),
    workspaceId: ids(parseWorkspaceId(row.workspaceId), table),
    moveId: row.moveId,
    counterpartWorkspaceId: ids(parseWorkspaceId(row.counterpartWorkspaceId), table),
    platform: closed(ASSET_PLATFORMS, row.platform, table),
    initiatorUserId: ids(parseUserId(row.initiatorUserId), table),
    reasonCode: nullableClosed(MOVE_REASON_CODES, row.reasonCode, table),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.side === "INCOMING") {
    return {
      ...base,
      side: "INCOMING",
      status: closed(INCOMING_MOVE_STATUSES, row.status, table),
      connectionId: row.connectionId ?? corrupt(table),
      providerAssetId: row.providerAssetId ?? corrupt(table),
      connectedAccountId: row.connectedAccountId,
    };
  }
  if (row.side !== "OUTGOING") corrupt(table);
  return { ...base, side: "OUTGOING", status: closed(OUTGOING_MOVE_STATUSES, row.status, table), connectedAccountId: row.connectedAccountId ?? corrupt(table) };
}

async function getMove(tx: DatabaseTransaction, moveId: string, side: "INCOMING" | "OUTGOING", lock: boolean): Promise<IncomingMove | OutgoingMove | undefined> {
  const query = tx.select().from(assetMoves).where(and(eq(assetMoves.moveId, moveId), eq(assetMoves.side, side))).limit(2);
  const rows = lock ? await query.for("update") : await query;
  if (rows.length > 1) corrupt("asset_moves");
  const row = rows[0];
  return row === undefined ? undefined : toMove(row);
}

const incoming = (move: IncomingMove | OutgoingMove | undefined): IncomingMove | undefined => (move?.side === "INCOMING" ? move : undefined);
const outgoing = (move: IncomingMove | OutgoingMove | undefined): OutgoingMove | undefined => (move?.side === "OUTGOING" ? move : undefined);

function moveRow(move: IncomingMove | OutgoingMove): typeof assetMoves.$inferInsert {
  return {
    organizationId: move.organizationId,
    workspaceId: move.workspaceId,
    moveId: move.moveId,
    side: move.side,
    counterpartWorkspaceId: move.counterpartWorkspaceId,
    connectionId: move.side === "INCOMING" ? move.connectionId : null,
    connectedAccountId: move.connectedAccountId,
    platform: move.platform,
    providerAssetId: move.side === "INCOMING" ? move.providerAssetId : null,
    initiatorUserId: move.initiatorUserId,
    status: move.status,
    reasonCode: move.reasonCode,
    createdAt: move.createdAt,
    updatedAt: move.updatedAt,
  };
}

function accountEventRow(event: ConnectedAccountEvent): typeof connectedAccountEvents.$inferInsert {
  return {
    id: event.id,
    organizationId: event.organizationId,
    workspaceId: event.workspaceId,
    connectedAccountId: event.connectedAccountId,
    eventType: event.eventType,
    moveId: event.moveId,
    reasonCode: event.reasonCode,
    actorType: event.actor.type,
    actorUserId: event.actor.type === "user" ? event.actor.userId : null,
    occurredAt: event.occurredAt,
  };
}

/** connections.locate_active_link: (workspace, account) of the organization's active link, or nothing. */
async function locateActive(tx: DatabaseTransaction, discoveredAssetId: string): Promise<ActiveLink | undefined> {
  const result = await tx.execute<{ active_workspace_id: string; active_connected_account_id: string }>(
    sql`select active_workspace_id, active_connected_account_id from connections.locate_active_link(${discoveredAssetId}::uuid)`,
  );
  if (result.rows.length > 1) corrupt("locate_active_link");
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return { workspaceId: ids(parseWorkspaceId(row.active_workspace_id), "locate_active_link"), connectedAccountId: row.active_connected_account_id };
}

/** connections.route_move_step (closed steps; the counterpart is derived from the local row by the definer). */
async function routeMoveStep(tx: DatabaseTransaction, moveId: string, step: string, correlationId: string, now: Date): Promise<RouteResult> {
  const result = await tx.execute<{ routed: boolean; outbox_id: string | null }>(
    sql`select routed, outbox_id from connections.route_move_step(${moveId}::uuid, ${step}, ${correlationId}, ${now}::timestamptz)`,
  );
  const row = result.rows[0];
  return { routed: row?.routed === true, outboxId: row?.outbox_id ?? null };
}

/** Account operations shared by the web and worker stores. Activation runs in a SAVEPOINT (M-01 / TA-Q-02 arbiter). */
function accountLinking(tx: DatabaseTransaction) {
  return {
    get: (id: string) => getConnectedAccount(tx, id),
    async findForAsset(connectionId: string, platform: AssetPlatform, providerAssetId: string): Promise<ConnectedAccount | undefined> {
      const rows = await tx
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.connectionId, connectionId), eq(connectedAccounts.platform, platform), eq(connectedAccounts.providerAssetId, providerAssetId)))
        .orderBy(asc(connectedAccounts.status), desc(connectedAccounts.updatedAt), asc(connectedAccounts.id))
        .limit(1);
      const row = rows[0];
      return row === undefined ? undefined : toAccount(row);
    },
    async activate(input: AccountActivation): Promise<ActivationOutcome> {
      try {
        return await tx.transaction(async (savepoint): Promise<ActivationOutcome> => {
          if (input.reactivateId !== null) {
            const rows = await savepoint
              .update(connectedAccounts)
              .set({ status: "ACTIVE", deactivatedAt: null, deactivationReason: null, moveId: null, updatedAt: input.now })
              .where(
                and(
                  eq(connectedAccounts.id, input.reactivateId),
                  eq(connectedAccounts.status, "INACTIVE"),
                  eq(connectedAccounts.connectionId, input.connectionId),
                  eq(connectedAccounts.platform, input.platform),
                  eq(connectedAccounts.providerAssetId, input.providerAssetId),
                ),
              )
              .returning();
            const row = rows[0];
            if (row !== undefined) return { kind: "activated", account: toAccount(row), reactivated: true };
          }
          const rows = await savepoint
            .insert(connectedAccounts)
            .values({
              id: input.newId,
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              connectionId: input.connectionId,
              platform: input.platform,
              providerAssetId: input.providerAssetId,
              assetClass: input.assetClass,
              status: "ACTIVE",
              activatedAt: input.now,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning();
          return { kind: "activated", account: toAccount(rows[0] ?? corrupt("connected_accounts")), reactivated: false };
        });
      } catch (error) {
        const pgError = postgresError(error);
        const rule = pgError?.code === "23505" && pgError.constraint !== undefined ? SINGLE_WORKSPACE_INDEXES[pgError.constraint] : undefined;
        if (rule !== undefined) return { kind: "conflict", rule };
        throw error;
      }
    },
  };
}

async function getConnection(tx: DatabaseTransaction, id: string, lock?: "update" | "share"): Promise<Connection | undefined> {
  const query = tx.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(2);
  const rows = lock === undefined ? await query : await query.for(lock);
  if (rows.length > 1) corrupt("connections");
  const row = rows[0];
  return row === undefined ? undefined : toConnection(row);
}

/**
 * Fresh-connection serialization (Step 7G-F4, TL decision T1): the longest a fresh path waits for its
 * (workspace, provider) lock. A code-level constant, never configuration: past it the waiting statement fails with
 * SQLSTATE 55P03, the transaction aborts, and the caller sees only CONFLICT.
 */
export const FRESH_CONNECTION_LOCK_TIMEOUT_MS = 5_000;
const FRESH_CONNECTION_LOCK_TIMEOUT = `${String(FRESH_CONNECTION_LOCK_TIMEOUT_MS)}ms`;
const FRESH_CONNECTION_LOCK_NAMESPACE = "connections.fresh_connection:";
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Takes K(workspace, provider) = pg_advisory_xact_lock(hashtextextended('connections.fresh_connection:' || workspace
 * || ':' || provider, 0)) inside the caller's transaction (released only by its COMMIT/ROLLBACK; never a session lock).
 * The wait alone is bounded: the transaction's lock_timeout is read, set transaction-locally to the bound, and
 * restored to exactly that value once K is held, so no later statement runs under it. On 55P03 the transaction is
 * already aborted: nothing more is sent (no restore — the rollback discards transaction-local settings) and the
 * failure leaves only as CONFLICT, without SQLSTATE, SQL text or key. The key input is injective (fixed prefix,
 * canonical UUID text, a closed provider value); a 64-bit hash collision can only add waiting, never admit anything.
 */
async function serializeFreshConnection(tx: DatabaseTransaction, workspaceId: unknown, provider: unknown): Promise<void> {
  const workspace = parseWorkspaceId(workspaceId);
  if (workspace === undefined || typeof provider !== "string" || !(CONNECTION_PROVIDERS as readonly string[]).includes(provider)) {
    throw new TypeError("connections persistence: the fresh-connection lock needs a workspace and a known provider");
  }
  const current = await tx.execute<{ value: string }>(sql`select pg_catalog.current_setting('lock_timeout') as value`);
  const previous = current.rows[0]?.value;
  if (typeof previous !== "string") corrupt("lock_timeout");
  await tx.execute(sql`select pg_catalog.set_config('lock_timeout', ${FRESH_CONNECTION_LOCK_TIMEOUT}::text, true)`);
  try {
    await tx.execute(
      sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${FRESH_CONNECTION_LOCK_NAMESPACE}::text || ${workspace}::uuid::text || ':' || ${provider}::text, 0))`,
    );
  } catch (error) {
    if (postgresError(error)?.code === LOCK_NOT_AVAILABLE) throw new AppError("CONFLICT", {}, { cause: error });
    throw error;
  }
  await tx.execute(sql`select pg_catalog.set_config('lock_timeout', ${previous}::text, true)`);
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
      // The only single-connection provider is Meta (the type admits nothing else); 0012 fixes it inside the definer too.
      async invalidateOpenFresh(_provider, now) {
        await tx.execute(sql`select connections.invalidate_open_fresh_meta_attempts(${now}::timestamptz)`);
      },
      async listOpenFresh(provider) {
        const rows = await tx
          .select()
          .from(connectAttempts)
          .where(and(eq(connectAttempts.provider, provider), isNull(connectAttempts.reconnectConnectionId), inArray(connectAttempts.status, ["PENDING", "EXCHANGING"])))
          .orderBy(asc(connectAttempts.createdAt), asc(connectAttempts.id));
        return rows.map(toAttempt);
      },
    },
    connections: {
      get: (id) => getConnection(tx, id),
      lockForUpdate: (id) => getConnection(tx, id, "update"),
      getForShare: (id) => getConnection(tx, id, "share"),
      async list() {
        return (await tx.select().from(connectionsTable).orderBy(asc(connectionsTable.createdAt), asc(connectionsTable.id))).map(toConnection);
      },
      serializeFresh: (workspaceId, provider) => serializeFreshConnection(tx, workspaceId, provider),
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
      ...accountLinking(tx),
      async list() {
        return (await tx.select().from(connectedAccounts).orderBy(asc(connectedAccounts.platform), asc(connectedAccounts.providerAssetId), asc(connectedAccounts.id))).map(toAccount);
      },
      async unlink(id, now) {
        const rows = await tx
          .update(connectedAccounts)
          .set({ status: "INACTIVE", deactivatedAt: now, deactivationReason: "UNLINKED", updatedAt: now })
          .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.status, "ACTIVE")))
          .returning({ id: connectedAccounts.id });
        return rows.length === 1;
      },
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
    accountEvents: {
      async append(event) {
        await tx.insert(connectedAccountEvents).values(accountEventRow(event));
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
      async get(id) {
        const rows = await tx.select().from(discoveredAssets).where(eq(discoveredAssets.id, id)).limit(2);
        if (rows.length > 1) corrupt("discovered_assets");
        const row = rows[0];
        return row === undefined ? undefined : toAsset(row);
      },
    },
    links: { locateActive: (discoveredAssetId) => locateActive(tx, discoveredAssetId) },
    moves: {
      getIncoming: async (moveId) => incoming(await getMove(tx, moveId, "INCOMING", false)),
      async findRequested(platform, providerAssetId) {
        const rows = await tx
          .select()
          .from(assetMoves)
          .where(and(eq(assetMoves.side, "INCOMING"), eq(assetMoves.status, "REQUESTED"), eq(assetMoves.platform, platform), eq(assetMoves.providerAssetId, providerAssetId)))
          .limit(2);
        if (rows.length > 1) corrupt("asset_moves");
        return incoming(rows[0] === undefined ? undefined : toMove(rows[0]));
      },
      async insertIncoming(move) {
        await tx.insert(assetMoves).values(moveRow(move));
      },
      async retry(moveId, now) {
        const rows = await tx
          .update(assetMoves)
          .set({ status: "REQUESTED", reasonCode: null, updatedAt: now })
          .where(and(eq(assetMoves.moveId, moveId), eq(assetMoves.side, "INCOMING"), eq(assetMoves.status, "ACTIVATION_FAILED")))
          .returning({ moveId: assetMoves.moveId });
        return rows.length === 1;
      },
      routeRelease: (moveId, correlationId, now) => routeMoveStep(tx, moveId, "release_source", correlationId, now),
      routeRetry: (moveId, correlationId, now) => routeMoveStep(tx, moveId, "retry_activation", correlationId, now),
    },
  };
}

/** Worker store (role `app_worker`, the job's single bound workspace). Rows routed by the definer are reported to
 * `extras.outbox.routed` so they get the post-commit relay wake-up (G5). */
export function createPostgresConnectionWorkerStore(
  tx: DatabaseTransaction,
  extras: { readonly audit: AuditLog; readonly outbox: OutboxWriter; readonly claimEffect: (effectKey: string) => Promise<"claimed" | "already_applied"> },
): ConnectionWorkerStore {
  return {
    connections: {
      get: (id) => getConnection(tx, id),
      getForShare: (id) => getConnection(tx, id, "share"),
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
    connectedAccounts: {
      ...accountLinking(tx),
      lock: (id) => getConnectedAccount(tx, id, true),
      async release(id, moveId, now) {
        const rows = await tx
          .update(connectedAccounts)
          .set({ status: "INACTIVE", deactivatedAt: now, deactivationReason: "MOVED", moveId, updatedAt: now })
          .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.status, "ACTIVE")))
          .returning({ id: connectedAccounts.id });
        return rows.length === 1;
      },
    },
    accountEvents: {
      async append(event) {
        await tx.insert(connectedAccountEvents).values(accountEventRow(event));
      },
    },
    links: { locateActive: (discoveredAssetId) => locateActive(tx, discoveredAssetId) },
    moves: {
      lockIncoming: async (moveId) => incoming(await getMove(tx, moveId, "INCOMING", true)),
      lockOutgoing: async (moveId) => outgoing(await getMove(tx, moveId, "OUTGOING", true)),
      async insertOutgoing(move) {
        await tx.insert(assetMoves).values(moveRow(move));
      },
      async setOutgoing(moveId, status, reasonCode, now) {
        await tx
          .update(assetMoves)
          .set({ status, reasonCode, updatedAt: now })
          .where(and(eq(assetMoves.moveId, moveId), eq(assetMoves.side, "OUTGOING")));
      },
      async setIncoming(moveId, status, reasonCode, connectedAccountId, now) {
        await tx
          .update(assetMoves)
          .set({ status, reasonCode, connectedAccountId, updatedAt: now })
          .where(and(eq(assetMoves.moveId, moveId), eq(assetMoves.side, "INCOMING")));
      },
      async initiatorCanManage(moveId) {
        const result = await tx.execute<{ allowed: boolean }>(sql`select connections.move_initiator_can_manage(${moveId}::uuid) as allowed`);
        return result.rows[0]?.allowed === true;
      },
      async recordAudit(moveId, step, correlationId) {
        await tx.execute(sql`select connections.record_move_audit(${moveId}::uuid, ${step}, ${correlationId})`);
      },
      async route(moveId, step, correlationId, now) {
        const result = await routeMoveStep(tx, moveId, step, correlationId, now);
        if (result.outboxId !== null) extras.outbox.routed({ id: result.outboxId, correlationId });
        return result;
      },
    },
    outbox: extras.outbox,
    discoveredAssets: {
      async find(connectionId, platform, providerAssetId) {
        const rows = await tx
          .select()
          .from(discoveredAssets)
          .where(and(eq(discoveredAssets.connectionId, connectionId), eq(discoveredAssets.platform, platform), eq(discoveredAssets.providerAssetId, providerAssetId)))
          .limit(2);
        if (rows.length > 1) corrupt("discovered_assets");
        const row = rows[0];
        return row === undefined ? undefined : toAsset(row);
      },
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

/**
 * Capability reconciliation store (Step 7G-H5.5; role `app_worker`, the job's single bound workspace). Reads ACTIVE
 * accounts with their connection's provider and status, and the latest activation event; appends requests through
 * `extras.requestOnce` (composed with the job's post-commit relay wake-up).
 */
export function createPostgresCapabilityReconcileStore(tx: DatabaseTransaction, extras: Pick<CapabilityReconcileStore, "requestOnce">): CapabilityReconcileStore {
  return {
    async activeAccounts(after, limit) {
      const rows = await tx
        .select({ id: connectedAccounts.id, connectionId: connectedAccounts.connectionId, provider: connectionsTable.provider, connectionStatus: connectionsTable.status })
        .from(connectedAccounts)
        .innerJoin(connectionsTable, and(eq(connectionsTable.workspaceId, connectedAccounts.workspaceId), eq(connectionsTable.id, connectedAccounts.connectionId)))
        .where(after === null ? eq(connectedAccounts.status, "ACTIVE") : and(eq(connectedAccounts.status, "ACTIVE"), gt(connectedAccounts.id, after)))
        .orderBy(asc(connectedAccounts.id))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        connectionId: row.connectionId,
        provider: closed(CONNECTION_PROVIDERS, row.provider, "connections"),
        connectionStatus: isConnectionStatus(row.connectionStatus) ? row.connectionStatus : corrupt("connections"),
      }));
    },
    async latestActivation(connectedAccountId) {
      const rows = await tx
        .select({ id: connectedAccountEvents.id })
        .from(connectedAccountEvents)
        .where(and(eq(connectedAccountEvents.connectedAccountId, connectedAccountId), inArray(connectedAccountEvents.eventType, ["LINKED", "MOVED_IN"])))
        .orderBy(desc(connectedAccountEvents.occurredAt), desc(connectedAccountEvents.id))
        .limit(1);
      return rows[0]?.id;
    },
    requestOnce: extras.requestOnce,
  };
}
