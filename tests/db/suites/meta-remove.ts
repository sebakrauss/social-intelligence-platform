/**
 * Step 7G-F4C — Remove Meta is terminal, on the real database. A LOCAL removal: Wrenkind deletes its stored credential,
 * clears the pointer, deactivates the connection's accounts and closes every open fresh Meta attempt of the workspace,
 * across creators (0012, REMOVE_INVALIDATES_OPEN_FRESH_META_ATTEMPTS), all under the same K(workspace, meta) as the
 * fresh start and completion. Account activation (link, Move) reads its Connection FOR SHARE, so ACTIVE-under-REMOVED
 * can't be committed. Nothing here calls Meta: the authorization adapter's token transport and the read port are
 * in-process doubles.
 *
 * Concurrency is real: a privileged session holds K (or a runtime transaction holds a row lock), and pg_locks shows the
 * other transactions waiting. PostgreSQL grants queued lock waiters in arrival order, which fixes each interleaving.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import {
  BUDGET_NOT_REPORTED,
  SecretValue,
  providerObjectRef,
  rawReference,
  type CallbackQuery,
  type ProviderAuthorizationPort,
  type ProviderReadPort,
} from "@/integrations/providers/contract";
import { createMetaAuthorizationPort } from "@/integrations/providers/meta/authorization";
import type { MetaTokenTransport } from "@/integrations/providers/meta/oauth-transport";
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import { activateDestination, linkAccount, removeConnection, type CredentialSealing, type ProviderCredentialAccess } from "@/modules/connections";
import { createPostgresConnectionStore, createPostgresConnectionWorkerStore } from "@/modules/connections/persistence";
import { createLocalKeyring, type LocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { createPkceDeriver, type PkceDeriver } from "@/platform/crypto/oauth";
import { claimEffect, createPostgresOutbox, withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { runTenantStepJob } from "@/platform/jobs";
import { createLogger, type Logger } from "@/platform/observability";
import { connectionRemoveCommand, createConnectionCommands } from "@/server/commands/connections";
import { completeConnectionAuthorization, startConnectionAuthorization, type ConnectionAuthorizationDependencies } from "@/server/connections/authorization";
import { authorizationProviders, createCredentialSealing, createOAuthSecrets } from "@/server/connections/runtime";
import { REMOVE_ACKNOWLEDGEMENT, removeMeta, resolveConnectionSettings } from "@/server/connections/settings";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { createCredentialAccess, runDiscoverAssets } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { scalar, sqlState } from "./helpers";

const APP = "https://app.example.test";
const CODE_MARKER = "synthetic-meta-auth-code-marker";
const TOKEN_MARKER = "synthetic-meta-access-token-marker";
const KEY_SQL = "pg_catalog.hashtextextended('connections.fresh_connection:'::text || $1::uuid::text || ':' || 'meta'::text, 0)";
const ACTIVATE = "connections.move.activate_destination";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly admin: string;
  readonly manager: string;
}

interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly subject_ids: Record<string, string>;
  readonly correlation_id: string;
  readonly initiator_user_id: string;
}

export function defineMetaRemoveSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let keyring: LocalKeyring;
  let deriver: PkceDeriver;
  let logger: Logger;
  let base: Omit<ConnectionAuthorizationDependencies, "pipeline">;
  const organizations: string[] = [];
  let clockMs = Date.now();
  const clock = (): Date => new Date((clockMs += 1));

  let exchanges = 0;
  let providerReads = 0;
  let credentialOpens = 0;
  /** When set, the next discovery provider call waits here (the envelope is already loaded and opened). */
  let readGate: Promise<void> | undefined;
  let readStarted: () => void = () => undefined;

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const countOf = async (query: string, values: readonly unknown[]): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const user = (id: string) => {
    const parsed = parseUserId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const ws = (id: string): WorkspaceId => {
    const parsed = parseWorkspaceId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const pipelineFor = (id: string, emailVerified = true): ActionPipeline =>
    createActionPipeline({
      identity: new FakeIdentity(emailVerified ? verifiedUser(user(id)) : { id: user(id), emailVerified: false }),
      unitOfWork: createPostgresUnitOfWork(web),
      clock,
      newId: randomUUID,
      logger,
    });
  const depsFor = (id: string): ConnectionAuthorizationDependencies => ({ ...base, pipeline: pipelineFor(id) });
  const callbackOf = (url: string): CallbackQuery => {
    const state = new URL(url).searchParams.get("state");
    if (state === null) throw new Error("no state");
    return [["code", CODE_MARKER], ["state", state]];
  };
  const begin = async (id: string, workspace: string, reconnectConnectionId?: string): Promise<CallbackQuery> => {
    const started = await startConnectionAuthorization(depsFor(id), { workspaceId: workspace, provider: "meta", ...(reconnectConnectionId === undefined ? {} : { reconnectConnectionId }) });
    if (started.status !== "ok") throw new Error(`start failed: ${JSON.stringify(started)}`);
    return callbackOf(started.authorizationUrl);
  };
  const callback = (id: string, query: CallbackQuery) => completeConnectionAuthorization(depsFor(id), { provider: "meta", query });
  /** A real fresh Meta Connection (CONNECTING, sealed credential, discover_assets row) created by `id`. */
  const connectMeta = async (id: string, workspace: string): Promise<string> => {
    const result = await callback(id, await begin(id, workspace));
    if (result.status !== "connected") throw new Error(`connect failed: ${JSON.stringify(result)}`);
    return result.connectionId;
  };
  const remove = (id: string, workspaceId: string, connectionId: unknown, acknowledgement: unknown = REMOVE_ACKNOWLEDGEMENT, pipeline = pipelineFor(id)) =>
    removeMeta(pipeline, { workspaceId, connectionId, acknowledgement });

  // ── Synthetic tenants and rows (privileged bootstrap) ────────────────────────────────────────────────────────
  const tenant = async (): Promise<Tenant> => {
    const t: Tenant = { organizationId: randomUUID(), workspaceId: randomUUID(), owner: randomUUID(), admin: randomUUID(), manager: randomUUID() };
    organizations.push(t.organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Remove', now())", [t.organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [t.workspaceId, t.organizationId]);
    for (const [member, orgRole, role] of [[t.owner, "OWNER", "OWNER"], [t.admin, "MEMBER", "ADMIN"], [t.manager, "MEMBER", "MANAGER"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [t.organizationId, member, orgRole]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [t.organizationId, t.workspaceId, member, role]);
    }
    return t;
  };
  const sibling = async (t: Tenant): Promise<string> => {
    const workspace = randomUUID();
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W2', 'STANDARD', now())", [workspace, t.organizationId]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [t.organizationId, workspace, t.owner]);
    return workspace;
  };
  /** A Connection in an exact status; non-DISCONNECTED ones get a (synthetic, never opened) envelope as the active credential. */
  const seedConnection = async (t: Tenant, status: string, provider = "meta", workspace = t.workspaceId): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, null, $6, now(), 1, now(), now())`,
      [id, t.organizationId, workspace, provider, status, t.owner],
    );
    if (status !== "DISCONNECTED" && status !== "REMOVED") {
      const credential = randomUUID();
      await privileged.query(
        "insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, expires_at, created_at) values ($1, $2, $3, $4, 1, $5, null, now())",
        [credential, t.organizationId, workspace, id, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])],
      );
      await privileged.query("update connections.connections set active_credential_id = $1, version = 2 where id = $2", [credential, id]);
    }
    return id;
  };
  /** A discovered asset of `connection`, optionally already ACTIVE as a connected account. */
  const seedAsset = async (t: Tenant, connection: string, active: boolean, workspace = t.workspaceId): Promise<{ readonly assetId: string; readonly providerAssetId: string; readonly accountId: string | null }> => {
    const assetId = randomUUID();
    const providerAssetId = `page-${randomUUID().slice(0, 12)}`;
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic Page', now(), now(), now())`,
      [assetId, t.organizationId, workspace, connection, providerAssetId],
    );
    if (!active) return { assetId, providerAssetId, accountId: null };
    const accountId = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'ACTIVE', now(), now(), now())`,
      [accountId, t.organizationId, workspace, connection, providerAssetId],
    );
    return { assetId, providerAssetId, accountId };
  };
  const seedAttempt = async (t: Tenant, creator: string, shape: { readonly status: string; readonly provider?: string; readonly reconnect?: string; readonly workspace?: string; readonly failureCode?: string }): Promise<string> => {
    const id = randomUUID();
    const created = new Date(clockMs - 60_000);
    const exchanged = ["EXCHANGING", "COMPLETED", "EXCHANGE_FAILED", "OUTCOME_UNKNOWN"].includes(shape.status) ? new Date(clockMs - 30_000) : null;
    const open = shape.status === "PENDING" || shape.status === "EXCHANGING";
    await privileged.query(
      `insert into connections.connect_attempts
         (id, organization_id, workspace_id, provider, created_by, state_digest, redirect_uri, reconnect_connection_id, status, expires_at, created_at, closed_at, exchange_started_at, failure_code)
       values ($1, $2, $3, $4, $5, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, t.organizationId, shape.workspace ?? t.workspaceId, shape.provider ?? "meta", creator, `${APP}/api/oauth/meta/callback`, shape.reconnect ?? null, shape.status,
        new Date(created.getTime() + 10 * 60 * 1000), created, open ? null : new Date(clockMs), exchanged, shape.failureCode ?? null],
    );
    return id;
  };

  // ── Oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  const connectionRow = async (id: string) =>
    (await oracle<{ status: string; active_credential_id: string | null; version: number }>("select status, active_credential_id, version from connections.connections where id = $1", [id]))[0];
  const attemptRow = async (id: string) =>
    (await oracle<{ status: string; failure_code: string | null; closed_at: Date | null; exchange_started_at: Date | null }>("select status, failure_code, closed_at, exchange_started_at from connections.connect_attempts where id = $1", [id]))[0];
  const liveMeta = (workspace: string) => countOf("select count(*)::int as n from connections.connections where workspace_id = $1 and provider = 'meta' and status <> 'REMOVED'", [workspace]);
  const allMeta = (workspace: string) => countOf("select count(*)::int as n from connections.connections where workspace_id = $1 and provider = 'meta'", [workspace]);
  const credentials = (connection: string) => countOf("select count(*)::int as n from credentials.provider_credentials where connection_id = $1", [connection]);
  const removalEvents = (connection: string) => countOf("select count(*)::int as n from connections.connection_events where connection_id = $1 and reason_code = 'REMOVED_BY_USER'", [connection]);
  const removalAudits = (connection: string) => countOf("select count(*)::int as n from audit.audit_events where target_id = $1 and action = 'connection.removed'", [connection]);
  const discoveries = (connection: string) => countOf("select count(*)::int as n from system.outbox where topic = 'connections.discover_assets' and subject_ids->>'connection_id' = $1", [connection]);
  const accountRow = async (id: string) =>
    (await oracle<{ status: string; deactivation_reason: string | null }>("select status, deactivation_reason from connections.connected_accounts where id = $1", [id]))[0];
  const activeUnderRemoved = (workspace: string) =>
    countOf(
      `select count(*)::int as n from connections.connected_accounts a join connections.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
        where a.workspace_id = $1 and a.status = 'ACTIVE' and c.status = 'REMOVED'`,
      [workspace],
    );

  // ── Locks ────────────────────────────────────────────────────────────────────────────────────────────────────
  const openHolders = new Set<pg.PoolClient>();
  const holdK = async (workspace: string): Promise<() => Promise<void>> => {
    const client = await privileged.connect();
    openHolders.add(client);
    await client.query("begin");
    await client.query(`select pg_catalog.pg_advisory_xact_lock(${KEY_SQL})`, [workspace]);
    return async () => {
      openHolders.delete(client);
      await client.query("commit");
      client.release();
    };
  };
  const waiting = async (): Promise<number> => (await oracle<{ n: number }>("select count(*)::int as n from pg_locks where not granted"))[0]?.n ?? -1;
  const waitForWaiters = async (n: number): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if ((await waiting()) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`expected ${String(n)} waiting transaction(s)`);
  };
  /** Runs `first` in a web transaction held open until `second` is waiting on a lock, then commits it. */
  const holdWhile = async <T>(as: string, workspace: string, first: (tx: DatabaseTransaction) => Promise<unknown>, second: () => Promise<T>): Promise<T> => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let done: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => (done = resolve));
    const held = withUserScope(web, { sub: as, role: "authenticated" }, workspace, async (tx) => {
      await first(tx);
      done();
      await gate;
    });
    await firstDone;
    const racing = second();
    racing.catch(() => undefined);
    await waitForWaiters(1);
    release();
    await held;
    return racing;
  };
  const scopeOf = (t: Tenant, id: string) => ({ workspaceId: ws(t.workspaceId), organizationId: t.organizationId as never, userId: user(id) });

  // ── Discovery job (real wrapper, worker login) with a gated in-process read port ─────────────────────────────
  const readPort = {
    async discoverAssets() {
      providerReads += 1;
      readStarted();
      if (readGate !== undefined) await readGate;
      return {
        data: [{ ref: providerObjectRef("facebook", "asset", "page-remove-0001"), assetClass: "content_bearing", displayName: "Synthetic Page", relatedAssets: [], rawReference: rawReference("meta", "v25.0", "facebook:page:page-remove-0001") }],
        budget: BUDGET_NOT_REPORTED,
      };
    },
  } as unknown as ProviderReadPort;
  let access: ProviderCredentialAccess;
  const latestDiscovery = async (connection: string): Promise<OutboxRow> => {
    const row = (await oracle<OutboxRow>(
      "select id, workspace_id, subject_ids, correlation_id, initiator_user_id from system.outbox where topic = 'connections.discover_assets' and subject_ids->>'connection_id' = $1 order by created_at desc, id limit 1",
      [connection],
    ))[0];
    if (row === undefined) throw new Error("no discovery outbox row");
    return row;
  };
  const discover = (row: OutboxRow) =>
    runTenantStepJob(
      { registry: PRODUCTION_TASKS, worker, logger },
      "connections.discover_assets",
      { v: 1, scope: "workspace", task: "connections.discover_assets", workspaceId: row.workspace_id, outboxId: row.id, subjectIds: row.subject_ids, correlationId: row.correlation_id, initiator: { type: "user", userId: row.initiator_user_id } },
      { runId: `run_${randomUUID()}`, attempt: 1 },
      (context) => runDiscoverAssets(context, { access, providers: { read: (provider: string) => (provider === "meta" ? readPort : undefined) } }),
    );

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target, 4);
    web = runtimeDatabase(target, "web", 4);
    worker = runtimeDatabase(target, "worker", 2);
    keyring = createLocalKeyring(randomBytes(32), { NODE_ENV: "test" });
    deriver = createPkceDeriver(randomBytes(32));
    logger = createLogger({ sink: () => undefined, now: clock });
    const opened = createCredentialAccess(createCredentialOpener(keyring.unwrapper), "test");
    access = {
      withCredential(input, use) {
        credentialOpens += 1;
        return opened.withCredential(input, use);
      },
    };
    const transport: MetaTokenTransport = {
      exchange() {
        exchanges += 1;
        return Promise.resolve({ kind: "token", accessToken: new SecretValue(TOKEN_MARKER), expiresInSeconds: 3600 });
      },
    };
    const meta: ProviderAuthorizationPort = createMetaAuthorizationPort(
      { clientId: "synthetic-meta-app-id", configId: "synthetic-meta-config-id", clientSecret: new SecretValue("synthetic-meta-app-secret-marker") },
      { transport },
    );
    const sealing: CredentialSealing = createCredentialSealing(createCredentialSealer(keyring.generator), "test");
    const secrets = createOAuthSecrets(deriver);
    const providers = authorizationProviders({ meta }, APP);
    base = { commands: createConnectionCommands({ secrets, providers }), providers, secrets, sealing, newId: randomUUID, logger };
  });

  beforeEach(() => {
    clockMs = Date.now();
    exchanges = 0;
    providerReads = 0;
    credentialOpens = 0;
    readGate = undefined;
  });

  afterEach(async () => {
    for (const client of openHolders) {
      openHolders.delete(client);
      await client.query("rollback");
      client.release();
    }
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await privileged.query("delete from idempotency.effect_keys where workspace_id in (select id from tenancy.workspaces where organization_id = any($1::uuid[]))", [organizations]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
    keyring.destroy();
    deriver.destroy();
  });

  describe("access: the Remove Meta surface (removeMeta)", () => {
    it("signed-out and unverified callers can't remove; a Manager is not allowed; nothing changes", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const signedOut = createActionPipeline({ identity: new FakeIdentity(), unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger });
      expect(await remove(t.owner, t.workspaceId, connection, REMOVE_ACKNOWLEDGEMENT, signedOut)).toEqual({ kind: "signed_out" });
      expect(await remove(t.owner, t.workspaceId, connection, REMOVE_ACKNOWLEDGEMENT, pipelineFor(t.owner, false))).toEqual({ kind: "verification_required" });
      expect(await remove(t.manager, t.workspaceId, connection)).toEqual({ kind: "status", status: "not_allowed" });
      expect((await connectionRow(connection))?.status).toBe("ACTIVE");
      expect(await credentials(connection)).toBe(1);
    });

    it("Owner and Admin remove; foreign, nonexistent, malformed and non-Meta connections are the same connection_not_found", async () => {
      const t = await tenant();
      const other = await tenant();
      const mine = await seedConnection(t, "ACTIVE");
      const theirs = await seedConnection(other, "ACTIVE");
      const simulator = await seedConnection(t, "ACTIVE", "simulator");
      const notFound = { kind: "status", status: "connection_not_found" };
      expect(await remove(t.owner, t.workspaceId, theirs)).toEqual(notFound); // another workspace's id in mine
      expect(await remove(other.owner, t.workspaceId, mine)).toEqual(notFound); // not a member of this workspace
      expect(await remove(t.owner, t.workspaceId, randomUUID())).toEqual(notFound);
      for (const malformed of ["", "not-a-uuid", mine.toUpperCase(), null, undefined]) expect(await remove(t.owner, t.workspaceId, malformed)).toEqual(notFound);
      expect(await remove(t.owner, t.workspaceId, simulator)).toEqual(notFound);
      expect((await connectionRow(simulator))?.status).toBe("ACTIVE");
      expect((await connectionRow(theirs))?.status).toBe("ACTIVE");
      expect(await remove(t.admin, t.workspaceId, mine)).toEqual({ kind: "status", status: "removed" });
      const second = await seedConnection(other, "FAILED");
      expect(await remove(other.owner, other.workspaceId, second)).toEqual({ kind: "status", status: "removed" });
    });

    it("without the exact acknowledgement nothing runs: remove_not_confirmed, zero mutation", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      // removeMeta directly: the helper's default acknowledgement would replace an explicit `undefined`.
      for (const acknowledgement of [undefined, null, "", "on", "true", `${REMOVE_ACKNOWLEDGEMENT} `, REMOVE_ACKNOWLEDGEMENT.toUpperCase()]) {
        expect(await removeMeta(pipelineFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection, acknowledgement })).toEqual({ kind: "status", status: "remove_not_confirmed" });
      }
      expect(await connectionRow(connection)).toMatchObject({ status: "ACTIVE", version: 2 });
      expect(await removalAudits(connection)).toBe(0);
    });
  });

  describe("removal effects (existing domain semantics, Meta-serialized)", () => {
    for (const status of ["CONNECTING", "ACTIVE", "DEGRADED", "FAILED", "DISCONNECTED"] as const) {
      it(`a ${status} Meta connection is removed: REMOVED, no pointer, no credential, accounts deactivated, one event and one audit; history kept`, async () => {
        const t = await tenant();
        const connection = await seedConnection(t, status);
        const { assetId, accountId } = await seedAsset(t, connection, status !== "DISCONNECTED");
        expect(await remove(t.owner, t.workspaceId, connection)).toEqual({ kind: "status", status: "removed" });
        expect(await connectionRow(connection)).toMatchObject({ status: "REMOVED", active_credential_id: null });
        expect(await credentials(connection)).toBe(0);
        if (accountId !== null) expect(await accountRow(accountId)).toEqual({ status: "INACTIVE", deactivation_reason: "REMOVED" });
        expect(await removalEvents(connection)).toBe(1);
        expect(await removalAudits(connection)).toBe(1);
        expect(await discoveries(connection)).toBe(0);
        expect(await countOf("select count(*)::int as n from connections.discovered_assets where id = $1", [assetId])).toBe(1);
        // Repeating it is a no-op: still "removed", no second event, audit or shred.
        expect(await remove(t.admin, t.workspaceId, connection)).toEqual({ kind: "status", status: "removed" });
        expect([await removalEvents(connection), await removalAudits(connection)]).toEqual([1, 1]);
      });
    }

    it("after removing a real Meta connection, a fresh start proceeds and the page offers Connect Meta again", async () => {
      const t = await tenant();
      const connection = await connectMeta(t.owner, t.workspaceId);
      expect(await resolveConnectionSettings(pipelineFor(t.owner), t.workspaceId)).toMatchObject({ kind: "ready", metaConnect: "existing_connection" });
      expect(await remove(t.owner, t.workspaceId, connection)).toEqual({ kind: "status", status: "removed" });
      expect(await credentials(connection)).toBe(0);
      expect(await resolveConnectionSettings(pipelineFor(t.owner), t.workspaceId)).toMatchObject({ kind: "ready", metaConnect: "available" });
      expect((await startConnectionAuthorization(depsFor(t.admin), { workspaceId: t.workspaceId, provider: "meta" })).status).toBe("ok");
    });

    it("the existing generic remove (no expected provider) keeps removing other providers", async () => {
      const t = await tenant();
      const simulator = await seedConnection(t, "ACTIVE", "simulator");
      const result = await pipelineFor(t.owner).run(connectionRemoveCommand, { workspaceId: t.workspaceId, input: { connectionId: simulator } });
      expect(result).toMatchObject({ status: "ok", value: { changed: true } });
      expect((await connectionRow(simulator))?.status).toBe("REMOVED");
    });
  });

  describe("0012: write-only, cross-creator invalidation of open fresh Meta attempts", () => {
    it("a removal closes every creator's open fresh Meta attempt with the exact transitions, and touches nothing else", async () => {
      const t = await tenant();
      const elsewhere = await sibling(t);
      const connection = await seedConnection(t, "ACTIVE");
      const target = await seedConnection(t, "ACTIVE", "meta", t.workspaceId); // a reconnect target that stays
      const ownerPending = await seedAttempt(t, t.owner, { status: "PENDING" });
      const adminPending = await seedAttempt(t, t.admin, { status: "PENDING" });
      const adminExchanging = await seedAttempt(t, t.admin, { status: "EXCHANGING" });
      const reconnect = await seedAttempt(t, t.owner, { status: "PENDING", reconnect: target });
      const simulator = await seedAttempt(t, t.owner, { status: "PENDING", provider: "simulator" });
      const otherWorkspace = await seedAttempt(t, t.owner, { status: "PENDING", workspace: elsewhere });
      const terminal = {
        COMPLETED: await seedAttempt(t, t.admin, { status: "COMPLETED" }),
        DENIED: await seedAttempt(t, t.admin, { status: "DENIED" }),
        EXPIRED: await seedAttempt(t, t.admin, { status: "EXPIRED" }),
        CANCELLED: await seedAttempt(t, t.admin, { status: "CANCELLED" }),
        EXCHANGE_FAILED: await seedAttempt(t, t.admin, { status: "EXCHANGE_FAILED", failureCode: "CREDENTIAL_INVALID" }),
        OUTCOME_UNKNOWN: await seedAttempt(t, t.admin, { status: "OUTCOME_UNKNOWN" }),
      };
      expect(await remove(t.owner, t.workspaceId, connection)).toEqual({ kind: "status", status: "removed" });

      for (const id of [ownerPending, adminPending]) {
        expect(await attemptRow(id)).toMatchObject({ status: "CANCELLED", failure_code: null, exchange_started_at: null });
        expect((await attemptRow(id))?.closed_at).not.toBeNull();
      }
      expect(await attemptRow(adminExchanging)).toMatchObject({ status: "EXCHANGE_FAILED", failure_code: "CONNECTION_UNAVAILABLE" });
      expect((await attemptRow(adminExchanging))?.closed_at).not.toBeNull();
      for (const id of [reconnect, simulator, otherWorkspace]) expect((await attemptRow(id))?.status).toBe("PENDING");
      for (const [status, id] of Object.entries(terminal)) expect((await attemptRow(id))?.status, status).toBe(status);
    });

    it("returns nothing; creator-only attempt RLS is unchanged; Managers, workers and unbound callers can't invoke it", async () => {
      const t = await tenant();
      const other = await tenant();
      await seedAttempt(t, t.owner, { status: "PENDING" });
      const adminAttempt = await seedAttempt(t, t.admin, { status: "PENDING" });
      const call = sql`select connections.invalidate_open_fresh_meta_attempts(now())::text as value`;
      // Void: an empty result value, never rows, counts or creators.
      const value = await withUserScope(web, { sub: t.admin, role: "authenticated" }, t.workspaceId, (tx) => scalar<string>(tx, call));
      expect(value).toBe("");
      expect((await attemptRow(adminAttempt))?.status).toBe("CANCELLED");
      // Ordinary reads stay creator-only after 0012.
      const visible = await withUserScope(web, { sub: t.admin, role: "authenticated" }, t.workspaceId, async (tx) =>
        (await tx.execute<{ created_by: string }>(sql`select created_by::text from connections.connect_attempts`)).rows.map((row) => row.created_by));
      expect(new Set(visible)).toEqual(new Set([t.admin]));
      // Refusals: a Manager, an outsider bound to this workspace, no workspace context, the worker role.
      const refused = async (sub: string, workspace: string | undefined) =>
        sqlState(withUserScope(web, { sub, role: "authenticated" }, workspace, (tx) => tx.execute(call)));
      expect((await refused(t.manager, t.workspaceId)).code).toBe("42501");
      expect((await refused(other.owner, t.workspaceId)).code).toBe("42501");
      expect((await refused(t.owner, undefined)).code).toBe("42501");
      expect((await sqlState(withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(call)))).code).toBe("42501");
    });

    it("catalog: app_owner-owned SECURITY DEFINER, empty search_path, returns void, EXECUTE for authenticated only (no PUBLIC)", async () => {
      const [row] = await oracle<{ owner: string; definer: boolean; config: string[] | null; returns: string; grantees: string[] | null; public_default: boolean }>(
        `select pg_get_userbyid(p.proowner)::text as owner, p.prosecdef as definer, p.proconfig::text[] as config, p.prorettype::regtype::text as returns,
                (select array_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end order by 1) from aclexplode(p.proacl) a where a.grantee <> p.proowner) as grantees,
                p.proacl is null as public_default
           from pg_proc p where p.oid = 'connections.invalidate_open_fresh_meta_attempts(timestamptz)'::regprocedure`,
      );
      expect(row).toEqual({ owner: "app_owner", definer: true, config: ['search_path=""'], returns: "void", grantees: ["authenticated"], public_default: false });
      const can = async (role: string) =>
        (await oracle<{ ok: boolean }>("select has_function_privilege($1, 'connections.invalidate_open_fresh_meta_attempts(timestamptz)', 'execute') as ok", [role]))[0]?.ok;
      expect(await can("authenticated")).toBe(true);
      for (const role of ["anon", "app_worker", "app_system", "web_login", "worker_login"]) expect(await can(role), role).toBe(false);
    });
  });

  describe("concurrency on K(workspace, meta)", () => {
    it("fresh start queued before the removal → existing_connection; the removal then proceeds", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const release = await holdK(t.workspaceId);
      const start = startConnectionAuthorization(depsFor(t.admin), { workspaceId: t.workspaceId, provider: "meta" });
      await waitForWaiters(1);
      const removal = remove(t.owner, t.workspaceId, connection);
      await waitForWaiters(2);
      await release();
      expect(await start).toEqual({ status: "existing_connection" });
      expect(await removal).toEqual({ kind: "status", status: "removed" });
      expect(await countOf("select count(*)::int as n from connections.connect_attempts where workspace_id = $1", [t.workspaceId])).toBe(0);
    });

    it("removal queued before the fresh start → removed, then started; the old attempts were invalidated first", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const old = await seedAttempt(t, t.admin, { status: "PENDING" });
      const release = await holdK(t.workspaceId);
      const removal = remove(t.owner, t.workspaceId, connection);
      await waitForWaiters(1);
      const start = startConnectionAuthorization(depsFor(t.admin), { workspaceId: t.workspaceId, provider: "meta" });
      await waitForWaiters(2);
      await release();
      expect(await removal).toEqual({ kind: "status", status: "removed" });
      expect((await start).status).toBe("ok");
      expect((await attemptRow(old))?.status).toBe("CANCELLED");
      expect(await liveMeta(t.workspaceId)).toBe(0);
    });

    it("an old fresh completion queued BEFORE the removal: refused by the existing Connection; the removal then proceeds; no C2", async () => {
      const t = await tenant();
      const bQuery = await begin(t.admin, t.workspaceId); // B starts first (no connection yet) …
      const c1 = await connectMeta(t.owner, t.workspaceId); // … then A creates C1: B's attempt is now "old"
      const release = await holdK(t.workspaceId);
      const late = callback(t.admin, bQuery);
      await waitForWaiters(1); // B claimed, exchanged and sealed; waiting on K to complete
      const removal = remove(t.owner, t.workspaceId, c1);
      await waitForWaiters(2);
      await release();
      expect(await late).toEqual({ status: "restart_required", reason: "connection_unavailable" });
      expect(await removal).toEqual({ kind: "status", status: "removed" });
      expect([await liveMeta(t.workspaceId), await allMeta(t.workspaceId)]).toEqual([0, 1]);
      expect(await countOf("select count(*)::int as n from credentials.provider_credentials where workspace_id = $1", [t.workspaceId])).toBe(0);
    });

    it("the removal queued BEFORE an old EXCHANGING completion: the completion re-reads its attempt after K and is refused; no C2", async () => {
      const t = await tenant();
      const bQuery = await begin(t.admin, t.workspaceId);
      const c1 = await connectMeta(t.owner, t.workspaceId);
      const release = await holdK(t.workspaceId);
      const removal = remove(t.owner, t.workspaceId, c1);
      await waitForWaiters(1);
      const late = callback(t.admin, bQuery); // claims (EXCHANGING), exchanges, seals, then waits on K behind the removal
      await waitForWaiters(2);
      await release();
      expect(await removal).toEqual({ kind: "status", status: "removed" });
      expect(await late).toEqual({ status: "restart_required", reason: "connection_unavailable" });
      expect(exchanges).toBe(2); // A and B: B's token was exchanged and sealed, then discarded unstored
      expect([await liveMeta(t.workspaceId), await allMeta(t.workspaceId)]).toEqual([0, 1]);
      const bAttempt = (await oracle<{ status: string; failure_code: string | null }>(
        "select status, failure_code from connections.connect_attempts where workspace_id = $1 and created_by = $2", [t.workspaceId, t.admin]))[0];
      expect(bAttempt).toEqual({ status: "EXCHANGE_FAILED", failure_code: "CONNECTION_UNAVAILABLE" });
      expect(await countOf("select count(*)::int as n from credentials.provider_credentials where workspace_id = $1", [t.workspaceId])).toBe(0);
      expect(await countOf("select count(*)::int as n from audit.audit_events where workspace_id = $1 and action = 'connection.created'", [t.workspaceId])).toBe(1);
    });

    it("another admin's PENDING callback arriving after the removal creates nothing (the attempt was cancelled; no exchange)", async () => {
      const t = await tenant();
      const bQuery = await begin(t.admin, t.workspaceId); // B starts first (no connection yet)
      const c1 = await connectMeta(t.owner, t.workspaceId); // A completes and creates C1
      expect(await remove(t.owner, t.workspaceId, c1)).toEqual({ kind: "status", status: "removed" });
      const before = exchanges;
      expect(await callback(t.admin, bQuery)).toEqual({ status: "restart_required", reason: "not_found" });
      expect(exchanges).toBe(before);
      expect([await liveMeta(t.workspaceId), await allMeta(t.workspaceId)]).toEqual([0, 1]);
      expect(await countOf("select count(*)::int as n from system.outbox where workspace_id = $1 and topic = 'connections.discover_assets'", [t.workspaceId])).toBe(1);
      expect(await countOf("select count(*)::int as n from audit.audit_events where workspace_id = $1 and action = 'connection.created'", [t.workspaceId])).toBe(1);
    });

    it("a concurrent double removal: one change, one event, one audit", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const release = await holdK(t.workspaceId);
      const first = pipelineFor(t.owner).run(connectionRemoveCommand, { workspaceId: t.workspaceId, input: { connectionId: connection, expectedProvider: "meta" } });
      await waitForWaiters(1);
      const second = pipelineFor(t.admin).run(connectionRemoveCommand, { workspaceId: t.workspaceId, input: { connectionId: connection, expectedProvider: "meta" } });
      await waitForWaiters(2);
      await release();
      const results = await Promise.all([first, second]);
      expect(results.map((r) => (r.status === "ok" ? r.value.changed : r.status)).sort()).toEqual([false, true]);
      expect([await removalEvents(connection), await removalAudits(connection), await credentials(connection)]).toEqual([1, 1, 0]);
    });

    it("K held past the 5 s bound → unavailable, and the Connection is untouched", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const account = await seedAsset(t, connection, true);
      const old = await seedAttempt(t, t.admin, { status: "PENDING" });
      const release = await holdK(t.workspaceId);
      let outcome;
      try {
        outcome = await remove(t.owner, t.workspaceId, connection);
      } finally {
        await release();
      }
      expect(outcome).toEqual({ kind: "status", status: "unavailable" });
      expect(await connectionRow(connection)).toMatchObject({ status: "ACTIVE", version: 2 });
      expect(await credentials(connection)).toBe(1);
      expect((await accountRow(account.accountId ?? ""))?.status).toBe("ACTIVE");
      expect((await attemptRow(old))?.status).toBe("PENDING");
      expect([await removalEvents(connection), await removalAudits(connection)]).toEqual([0, 0]);
    });
  });

  describe("terminal accounts: activation reads its Connection FOR SHARE", () => {
    it("link commits first → the queued removal deactivates the new account", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const { assetId } = await seedAsset(t, connection, false);
      let accountId = "";
      const result = await holdWhile(
        t.owner,
        t.workspaceId,
        async (tx) => {
          const linked = await linkAccount(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.owner), discoveredAssetId: assetId, now: clock(), newId: randomUUID });
          if (linked.kind !== "linked") throw new Error("not linked");
          accountId = linked.account.id;
        },
        () => remove(t.admin, t.workspaceId, connection),
      );
      expect(result).toEqual({ kind: "status", status: "removed" });
      expect(await accountRow(accountId)).toEqual({ status: "INACTIVE", deactivation_reason: "REMOVED" });
      expect(await activeUnderRemoved(t.workspaceId)).toBe(0);
    });

    it("removal commits first → the queued link sees REMOVED and refuses", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const { assetId } = await seedAsset(t, connection, false);
      const linking = await holdWhile(
        t.owner,
        t.workspaceId,
        (tx) => removeConnection(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.owner), connectionId: connection, expectedProvider: "meta", now: clock(), newId: randomUUID }),
        () =>
          withUserScope(web, { sub: t.admin, role: "authenticated" }, t.workspaceId, (tx) =>
            linkAccount(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.admin), discoveredAssetId: assetId, now: clock(), newId: randomUUID }),
          ).then(
            () => "linked",
            (error: unknown) => (error as { code?: string }).code ?? "error",
          ),
      );
      expect(linking).toBe("CONNECTION_PROBLEM");
      expect(await countOf("select count(*)::int as n from connections.connected_accounts where workspace_id = $1", [t.workspaceId])).toBe(0);
      expect(await activeUnderRemoved(t.workspaceId)).toBe(0);
    });

    const seedIncomingMove = async (t: Tenant, connection: string, providerAssetId: string): Promise<string> => {
      const counterpart = await sibling(t);
      const moveId = randomUUID();
      await privileged.query(
        `insert into connections.asset_moves (organization_id, workspace_id, move_id, side, counterpart_workspace_id, connection_id, connected_account_id, platform, provider_asset_id, initiator_user_id, status, reason_code, created_at, updated_at)
         values ($1, $2, $3, 'INCOMING', $4, $5, null, 'facebook', $6, $7, 'REQUESTED', null, now(), now())`,
        [t.organizationId, t.workspaceId, moveId, counterpart, connection, providerAssetId, t.owner],
      );
      return moveId;
    };
    const activate = (t: Tenant, moveId: string) =>
      withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
        activateDestination(
          createPostgresConnectionWorkerStore(tx, {
            audit: createPostgresAuditLog(tx),
            outbox: createPostgresOutbox(tx),
            capabilityRequests: { requestOnce: () => Promise.reject(new Error("unused by the Move saga")) },
            claimEffect: (key) => claimEffect(tx, { workspaceId: ws(t.workspaceId), effectKey: key, task: ACTIVATE }),
          }),
          { workspaceId: ws(t.workspaceId), moveId, outboxId: randomUUID(), correlationId: "corr-f4c-activate-01" as never, now: clock(), newId: randomUUID },
        ),
      );

    it("Move activation commits first → the queued removal deactivates the moved-in account", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const { providerAssetId } = await seedAsset(t, connection, false);
      const moveId = await seedIncomingMove(t, connection, providerAssetId);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let activated: () => void = () => undefined;
      const done = new Promise<void>((resolve) => (activated = resolve));
      let outcome: unknown;
      const held = withWorkspaceJobScope(worker, t.workspaceId, async (tx) => {
        outcome = await activateDestination(
          createPostgresConnectionWorkerStore(tx, {
            audit: createPostgresAuditLog(tx),
            outbox: createPostgresOutbox(tx),
            capabilityRequests: { requestOnce: () => Promise.reject(new Error("unused by the Move saga")) },
            claimEffect: (key) => claimEffect(tx, { workspaceId: ws(t.workspaceId), effectKey: key, task: ACTIVATE }),
          }),
          { workspaceId: ws(t.workspaceId), moveId, outboxId: randomUUID(), correlationId: "corr-f4c-activate-02" as never, now: clock(), newId: randomUUID },
        );
        activated();
        await gate;
      });
      await done;
      const removal = remove(t.owner, t.workspaceId, connection);
      await waitForWaiters(1);
      release();
      await held;
      expect(outcome).toMatchObject({ kind: "completed" });
      expect(await removal).toEqual({ kind: "status", status: "removed" });
      const accounts = await oracle<{ status: string; deactivation_reason: string | null }>("select status, deactivation_reason from connections.connected_accounts where workspace_id = $1", [t.workspaceId]);
      expect(accounts).toEqual([{ status: "INACTIVE", deactivation_reason: "REMOVED" }]);
      expect(await activeUnderRemoved(t.workspaceId)).toBe(0);
    });

    it("removal commits first → the queued Move activation sees REMOVED and fails, activating nothing", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const { providerAssetId } = await seedAsset(t, connection, false);
      const moveId = await seedIncomingMove(t, connection, providerAssetId);
      const outcome = await holdWhile(
        t.owner,
        t.workspaceId,
        (tx) => removeConnection(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.owner), connectionId: connection, expectedProvider: "meta", now: clock(), newId: randomUUID }),
        () => activate(t, moveId),
      );
      expect(outcome).toEqual({ kind: "failed", reason: "DESTINATION_CONNECTION_UNHEALTHY" });
      expect(await countOf("select count(*)::int as n from connections.connected_accounts where workspace_id = $1", [t.workspaceId])).toBe(0);
      expect(await activeUnderRemoved(t.workspaceId)).toBe(0);
    });
  });

  describe("discovery and reconnect after removal (unchanged behavior)", () => {
    it("an in-flight discovery finishing after the removal writes nothing; a retry skips before opening the credential", async () => {
      const t = await tenant();
      const connection = await connectMeta(t.owner, t.workspaceId);
      const row = await latestDiscovery(connection);
      let release: () => void = () => undefined;
      readGate = new Promise<void>((resolve) => (release = resolve));
      const reading = new Promise<void>((resolve) => (readStarted = resolve));
      const run = discover(row);
      await reading; // the envelope was loaded and opened; the provider call is "in flight"
      expect(await remove(t.owner, t.workspaceId, connection)).toEqual({ kind: "status", status: "removed" });
      release();
      expect(await run).toMatchObject({ kind: "skipped", reason: "obsolete" });
      expect([providerReads, credentialOpens]).toEqual([1, 1]); // wasted provider work, not resurrection
      expect(await countOf("select count(*)::int as n from connections.discovered_assets where connection_id = $1", [connection])).toBe(0);
      expect(await connectionRow(connection)).toMatchObject({ status: "REMOVED", active_credential_id: null });
      // A later run (retry / redelivery): skipped before any Decrypt or provider call.
      readGate = undefined;
      expect(await discover({ ...row, id: randomUUID() })).toMatchObject({ kind: "skipped", reason: "not_found" });
      expect([providerReads, credentialOpens]).toEqual([1, 1]);
      expect((await connectionRow(connection))?.status).toBe("REMOVED");
    });

    it("a reconnect started before the removal is refused at completion; nothing is resurrected", async () => {
      const t = await tenant();
      const connection = await connectMeta(t.owner, t.workspaceId);
      const reconnect = await begin(t.owner, t.workspaceId, connection);
      expect(await remove(t.admin, t.workspaceId, connection)).toEqual({ kind: "status", status: "removed" });
      expect(await callback(t.owner, reconnect)).toEqual({ status: "restart_required", reason: "connection_unavailable" });
      expect(await connectionRow(connection)).toMatchObject({ status: "REMOVED", active_credential_id: null });
      expect(await credentials(connection)).toBe(0);
      expect(await liveMeta(t.workspaceId)).toBe(0);
    });
  });
}
