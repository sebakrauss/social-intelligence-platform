/**
 * Step 7G-F4 — the Meta fresh-connection policy on the real database (TEMPORARY PRODUCT POLICY, not a schema rule):
 * a workspace holds at most ONE Meta Connection that isn't REMOVED, enforced under K(workspace, meta) — a
 * transaction-scoped advisory lock with a 5 s bounded wait — at fresh start AND at fresh completion.
 *
 * Real pieces only: the action pipeline and PostgreSQL unit of work (web login → authenticated + claims + sealed
 * workspace), the real orchestration, the real Meta authorization adapter (its token transport is an in-process double:
 * nothing leaves the process), and the local keyring sealer. Concurrency is real: a privileged session holds K, and
 * pg_locks shows the runtime transactions waiting on it. Synthetic data only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isAppError } from "@/domain/errors";
import { parseUserId } from "@/domain/ids";
import { SecretValue, type CallbackQuery, type ProviderAuthorizationPort } from "@/integrations/providers/contract";
import { createMetaAuthorizationPort } from "@/integrations/providers/meta/authorization";
import { META_DIALOG_URL } from "@/integrations/providers/meta/endpoints";
import type { MetaTokenTransport } from "@/integrations/providers/meta/oauth-transport";
import { SimulatorWorld } from "@/integrations/providers/simulator";
import type { CredentialSealing } from "@/modules/connections";
import { FRESH_CONNECTION_LOCK_TIMEOUT_MS, createPostgresConnectionStore } from "@/modules/connections/persistence";
import { createLocalKeyring, type LocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { createPkceDeriver, type PkceDeriver } from "@/platform/crypto/oauth";
import { postgresError, withUserScope, type RuntimeDatabase } from "@/platform/db";
import { createLogger, type Logger } from "@/platform/observability";
import { createConnectionCommands } from "@/server/commands/connections";
import { completeConnectionAuthorization, startConnectionAuthorization, type ConnectionAuthorizationDependencies } from "@/server/connections/authorization";
import { authorizationProviders, createCredentialSealing, createOAuthSecrets } from "@/server/connections/runtime";
import { connectMeta, resolveConnectionSettings } from "@/server/connections/settings";
import { createLocalSimulator, type LocalSimulator } from "@/server/connections/simulator";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { loadScenario } from "../../providers/support/fixtures";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { backendPid, scalar } from "./helpers";

const APP = "https://app.example.test";
const CODE_MARKER = "synthetic-meta-auth-code-marker";
const TOKEN_MARKER = "synthetic-meta-access-token-marker";
const SECRET_MARKER = "synthetic-meta-app-secret-marker";
const sha256 = (value: string): string => createHash("sha256").update(value, "ascii").digest("hex");
const KEY_SQL = "pg_catalog.hashtextextended('connections.fresh_connection:'::text || $1::uuid::text || ':' || $2::text, 0)";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly admin: string;
  readonly manager: string;
}

export function defineMetaFreshConnectionSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  /** A one-connection pool: the next transaction provably reuses the same backend (lock_timeout leak check). */
  let single: RuntimeDatabase<"web">;
  let keyring: LocalKeyring;
  let deriver: PkceDeriver;
  let sim: LocalSimulator;
  let logger: Logger;
  let base: Omit<ConnectionAuthorizationDependencies, "pipeline">;
  const organizations: string[] = [];
  const logLines: string[] = [];
  let clockMs = Date.now();
  const clock = (): Date => new Date((clockMs += 1));

  // Observations of the provider boundary: how often it ran and which advisory locks were held at that moment.
  let authorizationRequests = 0;
  let exchanges = 0;
  let seals = 0;
  const heldAt: { readonly point: string; readonly held: number }[] = [];
  const committedAtRequest: (string | undefined)[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const heldAdvisoryLocks = async (): Promise<number> =>
    (await oracle<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and granted"))[0]?.n ?? -1;
  const probe = async (point: string): Promise<void> => {
    heldAt.push({ point, held: await heldAdvisoryLocks() });
  };

  const user = (id: string) => {
    const parsed = parseUserId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const pipelineFor = (id: string): ActionPipeline =>
    createActionPipeline({ identity: new FakeIdentity(verifiedUser(user(id))), unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger });
  const depsFor = (id: string): ConnectionAuthorizationDependencies => ({ ...base, pipeline: pipelineFor(id) });
  const startMeta = (id: string, workspace: string) => startConnectionAuthorization(depsFor(id), { workspaceId: workspace, provider: "meta" });
  const callbackOf = (url: string): CallbackQuery => {
    const state = new URL(url).searchParams.get("state");
    if (state === null) throw new Error("no state");
    return [["code", CODE_MARKER], ["state", state]];
  };
  const callback = (id: string, query: CallbackQuery) => completeConnectionAuthorization(depsFor(id), { provider: "meta", query });
  const begin = async (id: string, workspace: string): Promise<{ readonly url: string; readonly query: CallbackQuery }> => {
    const started = await startMeta(id, workspace);
    if (started.status !== "ok") throw new Error(`start failed: ${JSON.stringify(started)}`);
    return { url: started.authorizationUrl, query: callbackOf(started.authorizationUrl) };
  };

  // ── Synthetic tenants (privileged bootstrap) ─────────────────────────────────────────────────────────────────
  const tenant = async (): Promise<Tenant> => {
    const t: Tenant = { organizationId: randomUUID(), workspaceId: randomUUID(), owner: randomUUID(), admin: randomUUID(), manager: randomUUID() };
    organizations.push(t.organizationId);
    const client = await privileged.connect();
    try {
      await client.query("begin");
      await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Fresh', now())", [t.organizationId]);
      await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [t.workspaceId, t.organizationId]);
      for (const [member, orgRole, role] of [[t.owner, "OWNER", "OWNER"], [t.admin, "MEMBER", "ADMIN"], [t.manager, "MEMBER", "MANAGER"]] as const) {
        await client.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [t.organizationId, member, orgRole]);
        await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [t.organizationId, t.workspaceId, member, role]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return t;
  };
  /** A second workspace of the same organization, the tenant's owner as its OWNER. */
  const sibling = async (t: Tenant): Promise<string> => {
    const workspace = randomUUID();
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W2', 'STANDARD', now())", [workspace, t.organizationId]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [t.organizationId, workspace, t.owner]);
    return workspace;
  };
  const seedConnection = async (t: Tenant, provider: string, status: string, workspace = t.workspaceId): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, null, $6, now(), 1, now(), now())`,
      [id, t.organizationId, workspace, provider, status, t.owner],
    );
    return id;
  };
  /** An attempt row in an exact state (privileged bootstrap; the times are relative to the suite clock). */
  const seedAttempt = async (
    t: Tenant,
    creator: string,
    shape: { readonly status: string; readonly createdAgoMs: number; readonly exchangeAgoMs?: number; readonly reconnect?: string; readonly provider?: string; readonly failureCode?: string },
  ): Promise<string> => {
    const id = randomUUID();
    const now = clockMs;
    const created = new Date(now - shape.createdAgoMs);
    const expires = new Date(created.getTime() + 10 * 60 * 1000);
    const exchange = shape.exchangeAgoMs === undefined ? null : new Date(now - shape.exchangeAgoMs);
    const open = shape.status === "PENDING" || shape.status === "EXCHANGING";
    await privileged.query(
      `insert into connections.connect_attempts
         (id, organization_id, workspace_id, provider, created_by, state_digest, redirect_uri, reconnect_connection_id, status, expires_at, created_at, closed_at, exchange_started_at, failure_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, t.organizationId, t.workspaceId, shape.provider ?? "meta", creator, sha256(randomUUID()), `${APP}/api/oauth/meta/callback`, shape.reconnect ?? null,
        shape.status, expires, created, open ? null : new Date(now), exchange, shape.failureCode ?? null],
    );
    return id;
  };

  // ── Oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  const countOf = async (query: string, values: readonly unknown[]): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const attempts = (workspace: string) => countOf("select count(*)::int as n from connections.connect_attempts where workspace_id = $1", [workspace]);
  const attemptStatus = async (id: string) => (await oracle<{ status: string; failure_code: string | null }>("select status, failure_code from connections.connect_attempts where id = $1", [id]))[0];
  const metaConnections = (workspace: string) =>
    oracle<{ id: string; status: string; active_credential_id: string | null }>("select id, status, active_credential_id from connections.connections where workspace_id = $1 and provider = 'meta' order by created_at", [workspace]);
  const credentials = (workspace: string) => oracle<{ id: string; connection_id: string }>("select id, connection_id from credentials.provider_credentials where workspace_id = $1", [workspace]);
  const discoveries = (workspace: string) => countOf("select count(*)::int as n from system.outbox where workspace_id = $1 and topic = 'connections.discover_assets'", [workspace]);
  const createdAudits = (workspace: string) => countOf("select count(*)::int as n from audit.audit_events where workspace_id = $1 and action = 'connection.created'", [workspace]);
  const authorizedEvents = (workspace: string) => countOf("select count(*)::int as n from connections.connection_events where workspace_id = $1 and reason_code = 'AUTHORIZED'", [workspace]);
  const attemptsByStatus = (workspace: string) =>
    oracle<{ status: string; failure_code: string | null; created_by: string }>("select status, failure_code, created_by from connections.connect_attempts where workspace_id = $1 order by status", [workspace]);

  // ── K held by another session (privileged; same key expression as the store) ───────────────────────────────
  /** Holders still open when a test ends (a failed assertion) are rolled back, so K never leaks into the next test. */
  const openHolders = new Set<pg.PoolClient>();
  const holdK = async (workspace: string, provider = "meta"): Promise<{ readonly client: pg.PoolClient; release(): Promise<void> }> => {
    const client = await privileged.connect();
    openHolders.add(client);
    await client.query("begin");
    await client.query(`select pg_catalog.pg_advisory_xact_lock(${KEY_SQL})`, [workspace, provider]);
    return {
      client,
      async release() {
        openHolders.delete(client);
        await client.query("commit");
        client.release();
      },
    };
  };
  const waiters = async (): Promise<number> =>
    (await oracle<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted"))[0]?.n ?? -1;
  const waitForWaiters = async (n: number): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await waiters()) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`expected ${String(n)} transaction(s) waiting on K`);
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target, 4);
    web = runtimeDatabase(target, "web", 4);
    single = runtimeDatabase(target, "web", 1);
    keyring = createLocalKeyring(randomBytes(32), { NODE_ENV: "test" });
    deriver = createPkceDeriver(randomBytes(32));
    sim = createLocalSimulator(new SimulatorWorld(loadScenario("baseline")));
    logger = createLogger({ sink: (line) => logLines.push(line), now: clock });

    const transport: MetaTokenTransport = {
      async exchange() {
        exchanges += 1;
        await probe("exchange");
        return { kind: "token", accessToken: new SecretValue(TOKEN_MARKER), expiresInSeconds: 3600 };
      },
    };
    const meta = createMetaAuthorizationPort({ clientId: "synthetic-meta-app-id", configId: "synthetic-meta-config-id", clientSecret: new SecretValue(SECRET_MARKER) }, { transport });
    const spiedMeta: ProviderAuthorizationPort = {
      ...meta,
      async authorizationRequest(input) {
        authorizationRequests += 1;
        await probe("authorization_request");
        // The attempt must already be committed (visible to another session) when the URL is built.
        committedAtRequest.push((await oracle<{ status: string }>("select status from connections.connect_attempts where state_digest = $1", [sha256(input.state)]))[0]?.status);
        return meta.authorizationRequest(input);
      },
    };
    const sealer = createCredentialSealing(createCredentialSealer(keyring.generator), "test");
    const sealing: CredentialSealing = {
      async seal(plaintext, binding) {
        seals += 1;
        await probe("seal");
        return sealer.seal(plaintext, binding);
      },
    };
    const secrets = createOAuthSecrets(deriver);
    const providers = authorizationProviders({ meta: spiedMeta, simulator: sim.authorization }, APP);
    base = { commands: createConnectionCommands({ secrets, providers }), providers, secrets, sealing, newId: randomUUID, logger };
  });

  beforeEach(() => {
    sim.world.reset();
    clockMs = Date.now();
    authorizationRequests = 0;
    exchanges = 0;
    seals = 0;
    heldAt.length = 0;
    committedAtRequest.length = 0;
  });

  afterEach(async () => {
    for (const client of openHolders) {
      openHolders.delete(client);
      await client.query("rollback");
      client.release();
    }
  });

  afterAll(async () => {
    await Promise.all([web.end(), single.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
    keyring.destroy();
    deriver.destroy();
  });

  describe("access: the fixed-provider surface (connectMeta)", () => {
    it("Owner and Admin start a Meta authorization at Meta's exact dialog endpoint; the start commits before the URL is built", async () => {
      const t = await tenant();
      for (const who of [t.owner, t.admin]) {
        const outcome = await connectMeta(depsFor(who), t.workspaceId);
        expect(outcome.kind).toBe("authorize");
        if (outcome.kind !== "authorize") return;
        const url = new URL(outcome.url);
        expect(`${url.origin}${url.pathname}`).toBe(META_DIALOG_URL);
      }
      expect(await attempts(t.workspaceId)).toBe(2);
      expect(committedAtRequest).toEqual(["PENDING", "PENDING"]);
      expect(heldAt.filter((p) => p.point === "authorization_request").map((p) => p.held)).toEqual([0, 0]);
    });

    it("a Manager is not allowed; a foreign, a nonexistent and a malformed workspace are the same workspace_not_found — nothing written", async () => {
      const t = await tenant();
      const other = await tenant();
      expect(await connectMeta(depsFor(t.manager), t.workspaceId)).toEqual({ kind: "status", status: "not_allowed" });
      const foreign = await connectMeta(depsFor(other.owner), t.workspaceId);
      const missing = await connectMeta(depsFor(t.owner), randomUUID());
      const malformed = await connectMeta(depsFor(t.owner), "not-a-workspace");
      expect(foreign).toEqual({ kind: "status", status: "workspace_not_found" });
      expect(missing).toEqual(foreign);
      expect(malformed).toEqual(foreign);
      expect(await attempts(t.workspaceId)).toBe(0);
      expect(authorizationRequests).toBe(0);
    });
  });

  describe("existing-connection rule (Meta only; REMOVED never blocks)", () => {
    for (const status of ["CONNECTING", "ACTIVE", "DEGRADED", "FAILED", "DISCONNECTED"] as const) {
      it(`a ${status} Meta connection blocks a fresh start: existing_connection, no attempt, no provider request`, async () => {
        const t = await tenant();
        await seedConnection(t, "meta", status);
        expect(await startMeta(t.owner, t.workspaceId)).toEqual({ status: "existing_connection" });
        expect(await connectMeta(depsFor(t.admin), t.workspaceId)).toEqual({ kind: "status", status: "existing_connection" });
        expect(await attempts(t.workspaceId)).toBe(0);
        expect(authorizationRequests).toBe(0);
      });
    }

    it("a REMOVED Meta connection permits a fresh start", async () => {
      const t = await tenant();
      await seedConnection(t, "meta", "REMOVED");
      expect((await startMeta(t.owner, t.workspaceId)).status).toBe("ok");
    });

    it("simulator and TikTok connections don't block Meta, and a Meta connection elsewhere doesn't block this workspace", async () => {
      const t = await tenant();
      await seedConnection(t, "simulator", "ACTIVE");
      await seedConnection(t, "tiktok", "ACTIVE");
      const elsewhere = await sibling(t);
      await seedConnection(t, "meta", "ACTIVE", elsewhere);
      expect((await startMeta(t.owner, t.workspaceId)).status).toBe("ok");
    });

    it("the simulator keeps its multiplicity: fresh simulator starts beside an existing Meta connection and each other all start", async () => {
      const t = await tenant();
      await seedConnection(t, "meta", "ACTIVE");
      await seedConnection(t, "simulator", "ACTIVE");
      const deps = depsFor(t.owner);
      for (let n = 0; n < 3; n += 1) expect((await startConnectionAuthorization(deps, { workspaceId: t.workspaceId, provider: "simulator" })).status).toBe("ok");
      expect(await attempts(t.workspaceId)).toBe(3);
    });
  });

  describe("live attempts (the caller's own, per creator)", () => {
    it("an own live PENDING attempt → authorization_in_progress; nothing new inserted, nothing cancelled", async () => {
      const t = await tenant();
      const live = await seedAttempt(t, t.owner, { status: "PENDING", createdAgoMs: 60_000 });
      expect(await startMeta(t.owner, t.workspaceId)).toEqual({ status: "authorization_in_progress" });
      expect(await attempts(t.workspaceId)).toBe(1);
      expect((await attemptStatus(live))?.status).toBe("PENDING");
      expect(authorizationRequests).toBe(0);
    });

    it("an own non-stale EXCHANGING attempt → authorization_in_progress", async () => {
      const t = await tenant();
      await seedAttempt(t, t.owner, { status: "EXCHANGING", createdAgoMs: 90_000, exchangeAgoMs: 60_000 });
      expect(await startMeta(t.owner, t.workspaceId)).toEqual({ status: "authorization_in_progress" });
    });

    it("an own expired PENDING attempt is recovered (EXPIRED) and a new start proceeds", async () => {
      const t = await tenant();
      const expired = await seedAttempt(t, t.owner, { status: "PENDING", createdAgoMs: 10 * 60 * 1000 });
      expect((await startMeta(t.owner, t.workspaceId)).status).toBe("ok");
      expect((await attemptStatus(expired))?.status).toBe("EXPIRED");
    });

    it("an own EXCHANGING attempt at the 2-minute stale threshold is recovered (OUTCOME_UNKNOWN) and a new start proceeds", async () => {
      const t = await tenant();
      const stale = await seedAttempt(t, t.owner, { status: "EXCHANGING", createdAgoMs: 3 * 60 * 1000, exchangeAgoMs: 2 * 60 * 1000 });
      expect((await startMeta(t.owner, t.workspaceId)).status).toBe("ok");
      expect((await attemptStatus(stale))?.status).toBe("OUTCOME_UNKNOWN");
    });

    it("terminal attempts never block", async () => {
      const t = await tenant();
      await seedAttempt(t, t.owner, { status: "COMPLETED", createdAgoMs: 60_000, exchangeAgoMs: 30_000 });
      await seedAttempt(t, t.owner, { status: "DENIED", createdAgoMs: 60_000 });
      await seedAttempt(t, t.owner, { status: "EXPIRED", createdAgoMs: 60_000 });
      await seedAttempt(t, t.owner, { status: "CANCELLED", createdAgoMs: 60_000 });
      await seedAttempt(t, t.owner, { status: "EXCHANGE_FAILED", createdAgoMs: 60_000, exchangeAgoMs: 30_000, failureCode: "CREDENTIAL_INVALID" });
      await seedAttempt(t, t.owner, { status: "OUTCOME_UNKNOWN", createdAgoMs: 60_000, exchangeAgoMs: 30_000 });
      expect((await startMeta(t.owner, t.workspaceId)).status).toBe("ok");
    });

    it("a live reconnect attempt, a live simulator attempt and another admin's live attempt don't block a fresh Meta start", async () => {
      const t = await tenant();
      const removed = await seedConnection(t, "meta", "REMOVED");
      await seedAttempt(t, t.owner, { status: "PENDING", createdAgoMs: 60_000, reconnect: removed });
      await seedAttempt(t, t.owner, { status: "PENDING", createdAgoMs: 60_000, provider: "simulator" });
      await seedAttempt(t, t.admin, { status: "PENDING", createdAgoMs: 60_000 });
      expect((await startMeta(t.owner, t.workspaceId)).status).toBe("ok");
    });
  });

  describe("same creator, concurrent starts: K serializes, the re-check decides", () => {
    it("two concurrent starts wait on K, then exactly one attempt; the second gets authorization_in_progress and no URL", async () => {
      const t = await tenant();
      const holder = await holdK(t.workspaceId);
      const first = startMeta(t.owner, t.workspaceId);
      await waitForWaiters(1);
      const second = startMeta(t.owner, t.workspaceId);
      await waitForWaiters(2);
      expect(await attempts(t.workspaceId)).toBe(0);
      await holder.release();
      const results = await Promise.all([first, second]);
      expect(results.map((r) => r.status).sort()).toEqual(["authorization_in_progress", "ok"]);
      expect(results.find((r) => r.status === "authorization_in_progress")).toEqual({ status: "authorization_in_progress" });
      expect(await attempts(t.workspaceId)).toBe(1);
      expect(authorizationRequests).toBe(1);
    });

    it("the waiter re-checks after K is released: a Connection committed by the holder → existing_connection", async () => {
      const t = await tenant();
      const holder = await holdK(t.workspaceId);
      await holder.client.query(
        `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
         values ($1, $2, $3, 'meta', 'CONNECTING', null, $4, now(), 1, now(), now())`,
        [randomUUID(), t.organizationId, t.workspaceId, t.admin],
      );
      const start = startMeta(t.owner, t.workspaceId);
      await waitForWaiters(1);
      await holder.release();
      expect(await start).toEqual({ status: "existing_connection" });
      expect(await attempts(t.workspaceId)).toBe(0);
    });

    it("K is per workspace and per provider: another workspace's Meta start and this workspace's simulator start never wait", async () => {
      const t = await tenant();
      const elsewhere = await sibling(t);
      const holder = await holdK(t.workspaceId);
      try {
        expect((await startMeta(t.owner, elsewhere)).status).toBe("ok");
        expect((await startConnectionAuthorization(depsFor(t.owner), { workspaceId: t.workspaceId, provider: "simulator" })).status).toBe("ok");
        expect(await waiters()).toBe(0);
      } finally {
        await holder.release();
      }
    });

    it("the lock fails closed without a workspace or with an unknown provider: no NULL key, no lock taken", async () => {
      const t = await tenant();
      await withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, async (tx) => {
        const store = createPostgresConnectionStore(tx);
        for (const workspace of [undefined, null, "", "not-a-uuid"]) {
          await expect(store.connections.serializeFresh(workspace as never, "meta")).rejects.toThrow(TypeError);
        }
        await expect(store.connections.serializeFresh(t.workspaceId as never, "facebook" as never)).rejects.toThrow(TypeError);
        expect(await scalar<number>(tx, sql`select count(*)::int as value from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`)).toBe(0);
      });
    });
  });

  describe("two admins: the fresh completion guard", () => {
    const expectSingleConnection = async (workspace: string): Promise<string> => {
      const connections = await metaConnections(workspace);
      expect(connections).toHaveLength(1);
      const [connection] = connections;
      if (connection === undefined) throw new Error("no connection");
      const stored = await credentials(workspace);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.connection_id).toBe(connection.id);
      expect(connection.active_credential_id).toBe(stored[0]?.id);
      expect(await discoveries(workspace)).toBe(1);
      expect(await createdAudits(workspace)).toBe(1);
      expect(await authorizedEvents(workspace)).toBe(1);
      return connection.id;
    };

    it("both attempts exist; both codes are exchanged and sealed; completions serialize on K; exactly one Connection", async () => {
      const t = await tenant();
      const a = await begin(t.owner, t.workspaceId);
      const b = await begin(t.admin, t.workspaceId);
      expect(await attempts(t.workspaceId)).toBe(2);

      const holder = await holdK(t.workspaceId);
      const first = callback(t.owner, a.query);
      const second = callback(t.admin, b.query);
      await waitForWaiters(2);
      // Both losers-to-be already exchanged and sealed (outside any lock) before the guard decides.
      expect([exchanges, seals]).toEqual([2, 2]);
      await holder.release();
      const results = await Promise.all([first, second]);

      expect(results.map((r) => r.status).sort()).toEqual(["connected", "restart_required"]);
      expect(results.find((r) => r.status === "restart_required")).toEqual({ status: "restart_required", reason: "connection_unavailable" });
      await expectSingleConnection(t.workspaceId);
      expect((await attemptsByStatus(t.workspaceId)).map((row) => [row.status, row.failure_code])).toEqual([
        ["COMPLETED", null],
        ["EXCHANGE_FAILED", "CONNECTION_UNAVAILABLE"],
      ]);
    });

    for (const order of ["admin first", "owner first"] as const) {
      it(`sequential completions (${order}): the first creates the Connection, the second creates nothing`, async () => {
        const t = await tenant();
        const owner = await begin(t.owner, t.workspaceId);
        const admin = await begin(t.admin, t.workspaceId);
        const [winner, loser] = order === "admin first" ? ([[t.admin, admin], [t.owner, owner]] as const) : ([[t.owner, owner], [t.admin, admin]] as const);
        expect((await callback(winner[0], winner[1].query)).status).toBe("connected");
        expect(await callback(loser[0], loser[1].query)).toEqual({ status: "restart_required", reason: "connection_unavailable" });
        expect([exchanges, seals]).toEqual([2, 2]);
        await expectSingleConnection(t.workspaceId);
        const rows = await attemptsByStatus(t.workspaceId);
        expect(rows.find((row) => row.created_by === loser[0])).toMatchObject({ status: "EXCHANGE_FAILED", failure_code: "CONNECTION_UNAVAILABLE" });
        expect(rows.find((row) => row.created_by === winner[0])).toMatchObject({ status: "COMPLETED", failure_code: null });
        const everything = JSON.stringify(await oracle("select * from connections.connect_attempts where workspace_id = $1", [t.workspaceId])) + logLines.join("\n");
        for (const secret of [TOKEN_MARKER, CODE_MARKER, SECRET_MARKER]) expect(everything).not.toContain(secret);
      });
    }

    it("no advisory lock is held during the token exchange, the seal or the authorization request", async () => {
      const t = await tenant();
      const { query } = await begin(t.owner, t.workspaceId);
      expect((await callback(t.owner, query)).status).toBe("connected");
      expect(heldAt.map((p) => p.point)).toEqual(["authorization_request", "exchange", "seal"]);
      expect(heldAt.every((p) => p.held === 0)).toBe(true);
    });
  });

  describe("bounded wait (lock_timeout 5 s, acquisition only)", () => {
    it("the prior lock_timeout is restored once K is held, so later statements don't run under the bound", async () => {
      const t = await tenant();
      await withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, async (tx) => {
        const before = await scalar<string>(tx, sql`select pg_catalog.current_setting('lock_timeout') as value`);
        await createPostgresConnectionStore(tx).connections.serializeFresh(t.workspaceId as never, "meta");
        expect(await scalar<string>(tx, sql`select pg_catalog.current_setting('lock_timeout') as value`)).toBe(before);
      });
      await withUserScope(web, { sub: t.owner, role: "authenticated" }, t.workspaceId, async (tx) => {
        await tx.execute(sql`select pg_catalog.set_config('lock_timeout', '1234ms', true)`);
        await createPostgresConnectionStore(tx).connections.serializeFresh(t.workspaceId as never, "meta");
        expect(await scalar<string>(tx, sql`select pg_catalog.current_setting('lock_timeout') as value`)).toBe("1234ms");
      });
    });

    it("a holder past the bound: the waiter gets SQLSTATE 55P03 internally (CONFLICT outward), and nothing leaks into the next transaction on that connection", async () => {
      const t = await tenant();
      const original = await withUserScope(single, { sub: t.owner, role: "authenticated" }, t.workspaceId, async (tx) => ({
        pid: await backendPid(tx),
        timeout: await scalar<string>(tx, sql`select pg_catalog.current_setting('lock_timeout') as value`),
      }));
      const holder = await holdK(t.workspaceId);
      const startedAt = Date.now();
      let failure: unknown;
      try {
        await withUserScope(single, { sub: t.owner, role: "authenticated" }, t.workspaceId, (tx) => createPostgresConnectionStore(tx).connections.serializeFresh(t.workspaceId as never, "meta"));
      } catch (error) {
        failure = error;
      } finally {
        await holder.release();
      }
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FRESH_CONNECTION_LOCK_TIMEOUT_MS - 50);
      expect(isAppError(failure) && failure.code).toBe("CONFLICT");
      expect(postgresError((failure as Error).cause)?.code).toBe("55P03");
      // The same pooled backend, the next transaction: the 5 s setting died with the rollback.
      const after = await withUserScope(single, { sub: t.owner, role: "authenticated" }, t.workspaceId, async (tx) => ({
        pid: await backendPid(tx),
        timeout: await scalar<string>(tx, sql`select pg_catalog.current_setting('lock_timeout') as value`),
      }));
      expect(after).toEqual(original);
    });

    it("start past the bound → unavailable: no attempt, no authorization request, no URL, nothing internal outward", async () => {
      const t = await tenant();
      const holder = await holdK(t.workspaceId);
      let outcome;
      try {
        outcome = await connectMeta(depsFor(t.owner), t.workspaceId);
      } finally {
        await holder.release();
      }
      expect(outcome).toEqual({ kind: "status", status: "unavailable" });
      expect(await attempts(t.workspaceId)).toBe(0);
      expect(authorizationRequests).toBe(0);
      const outward = JSON.stringify(outcome) + logLines.join("\n");
      for (const internal of ["55P03", "lock_timeout", "lock_not_available", "fresh_connection", "hashtext", "advisory"]) expect(outward).not.toContain(internal);
    });

    it("completion past the bound → credential not stored, restart required: nothing persisted, attempt closed through the existing path", async () => {
      const t = await tenant();
      const { query } = await begin(t.owner, t.workspaceId);
      const holder = await holdK(t.workspaceId);
      let result;
      try {
        result = await callback(t.owner, query);
      } finally {
        await holder.release();
      }
      expect(result).toEqual({ status: "restart_required", reason: "not_stored" });
      expect([exchanges, seals]).toEqual([1, 1]);
      expect(await metaConnections(t.workspaceId)).toEqual([]);
      expect(await credentials(t.workspaceId)).toEqual([]);
      expect(await discoveries(t.workspaceId)).toBe(0);
      expect(await createdAudits(t.workspaceId)).toBe(0);
      expect(await authorizedEvents(t.workspaceId)).toBe(0);
      expect((await attemptsByStatus(t.workspaceId)).map((row) => [row.status, row.failure_code])).toEqual([["EXCHANGE_FAILED", "CREDENTIAL_NOT_STORED"]]);
      const outward = JSON.stringify(result) + logLines.join("\n");
      for (const internal of ["55P03", "lock_timeout", "lock_not_available", "fresh_connection", "hashtext", TOKEN_MARKER, CODE_MARKER]) expect(outward).not.toContain(internal);
    });
  });

  describe("Settings › Connections read model (connections.settings.view)", () => {
    it("Owner/Admin read statuses and the UX hint; a Manager is not allowed; a foreign workspace is not found", async () => {
      const t = await tenant();
      const other = await tenant();
      await seedConnection(t, "meta", "FAILED");
      for (const who of [t.owner, t.admin]) {
        const state = await resolveConnectionSettings(pipelineFor(who), t.workspaceId);
        expect(state).toMatchObject({ kind: "ready", workspaceId: t.workspaceId, metaConnect: "existing_connection" });
        if (state.kind === "ready") expect(state.connections.map((c) => [c.provider, c.status])).toEqual([["meta", "FAILED"]]);
      }
      expect(await resolveConnectionSettings(pipelineFor(t.manager), t.workspaceId)).toEqual({ kind: "not_allowed" });
      expect(await resolveConnectionSettings(pipelineFor(other.owner), t.workspaceId)).toEqual({ kind: "workspace_not_found" });
      expect(await resolveConnectionSettings(pipelineFor(t.owner), "not-a-workspace")).toEqual({ kind: "workspace_not_found" });
      const empty = await tenant();
      expect(await resolveConnectionSettings(pipelineFor(empty.owner), empty.workspaceId)).toEqual({ kind: "ready", workspaceId: empty.workspaceId, connections: [], metaConnect: "available", manageableAssets: [] });
    });

    it("reading mutates nothing: no stale-attempt recovery, no start, no row written anywhere", async () => {
      const t = await tenant();
      const expired = await seedAttempt(t, t.owner, { status: "PENDING", createdAgoMs: 11 * 60 * 1000 });
      const snapshot = async () =>
        JSON.stringify(
          await oracle(
            `select (select json_agg(a order by a.id) from connections.connect_attempts a where a.workspace_id = $1) as attempts,
                    (select count(*) from connections.connections where workspace_id = $1) as connections,
                    (select count(*) from audit.audit_events where workspace_id = $1) as audit,
                    (select count(*) from system.outbox where workspace_id = $1) as outbox`,
            [t.workspaceId],
          ),
        );
      const before = await snapshot();
      await resolveConnectionSettings(pipelineFor(t.owner), t.workspaceId);
      expect(await snapshot()).toBe(before);
      expect((await attemptStatus(expired))?.status).toBe("PENDING");
      expect(authorizationRequests).toBe(0);
    });
  });
}
