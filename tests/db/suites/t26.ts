/**
 * T-26 — permanent tenant-isolation regression suite (TA §55, §11.6; TA-Q-29 adversarial cases), plus the
 * foundation exit criteria T-01 (workspace A can't read workspace B) and T-11 (a job can't query all
 * workspaces). Runs unchanged against the local disposable cluster and the managed Supabase project
 * (Supavisor transaction pooler). Every case is numbered as in the Step 2 brief.
 *
 * Runtime traffic uses only the production pool factory and scope helpers, connecting as web_login,
 * worker_login and system_login. The privileged connection is test bootstrap only (seed, oracle, cleanup).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConnectionConfigError,
  RUNTIME_LOGIN_ROLES,
  ScopeError,
  createRuntimeDatabase,
  withUserScope,
  withWorkspaceJobScope,
  type DatabaseTransaction,
  type RuntimeDatabase,
} from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { APPLICATION_SCHEMAS } from "@/db/schema/classification";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";
import { backendPid, count, leftoverContext, scalar, sqlState } from "./helpers";

const CONVERSATIONS = "t26_fixture.conversations";
const INTERACTIONS = "t26_fixture.interactions";
const GUEST = "t26_fixture.guest_projections";

export function defineT26Suite(getTarget: () => DbTarget): void {
  let target: DbTarget;
  let privileged: pg.Pool;
  let world: World;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let roleOids: Map<string, number>;

  const asUser = <T>(user: string, workspace: string | undefined, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> =>
    withUserScope(web, { sub: user, role: "authenticated" }, workspace, work);
  const asWorker = <T>(workspace: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => withWorkspaceJobScope(worker, workspace, work);
  const oracleCount = async (table: string, workspace: string): Promise<number> =>
    (await privileged.query<{ n: number }>(`select count(*)::int as n from ${table} where workspace_id = $1`, [workspace])).rows[0]?.n ?? -1;
  const foundationRoleOids = async (): Promise<Map<string, number>> => {
    const rows = (await privileged.query<{ rolname: string; oid: number }>(
      "select rolname, oid::int as oid from pg_roles where rolname = any($1::text[])",
      [[...Object.values(RUNTIME_LOGIN_ROLES), "app_owner", "app_worker", "app_system", "authenticated"]],
    )).rows;
    return new Map(rows.map((row) => [row.rolname, row.oid]));
  };

  beforeAll(async () => {
    target = getTarget();
    privileged = privilegedPool(target);
    roleOids = await foundationRoleOids();
    world = await seedWorld(privileged);
    web = runtimeDatabase(target, "web", 1);
    worker = runtimeDatabase(target, "worker", 1);
    system = runtimeDatabase(target, "system", 1);
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
  });

  describe("T-26 · identity and transaction-local context (R2, R3)", () => {
    it("1 · a validated web identity maps to auth.uid() under the fixed role; forged identities never reach the database", async () => {
      const seen = await asUser(world.users.a1, world.A1, async (tx) =>
        (await tx.execute<{ uid: string; current: string; session: string }>(sql`select auth.uid()::text as uid, current_user::text as current, session_user::text as session`)).rows[0]);
      expect(seen).toEqual({ uid: world.users.a1, current: "authenticated", session: RUNTIME_LOGIN_ROLES.web });

      const fresh = runtimeDatabase(target, "web", 1);
      try {
        for (const forged of [
          { sub: world.users.a1, role: "service_role" },
          { sub: world.users.a1, role: "postgres" },
          { sub: "not-a-uuid", role: "authenticated" },
          { role: "authenticated" },
          undefined,
        ]) {
          await expect(withUserScope(fresh, forged, world.A1, () => Promise.resolve())).rejects.toBeInstanceOf(ScopeError);
        }
        await expect(withUserScope(fresh, { sub: world.users.a1 }, "A1'; drop table x; --", () => Promise.resolve())).rejects.toBeInstanceOf(ScopeError);
        // Rejected before any query: the pool never opened a connection.
        expect(fresh.pool.totalCount).toBe(0);
      } finally {
        await fresh.end();
      }
    });

    it("2 · workspace and actor context are transaction-local and sealed", async () => {
      const inside = await asUser(world.users.a1, world.A1, async (tx) =>
        (await tx.execute<{ bound: string; raw: string; local: boolean }>(sql`select app.current_workspace()::text as bound,
          current_setting('app.workspace_id', true) as raw,
          current_setting('app.workspace_seal', true) <> '' as local`)).rows[0]);
      expect(inside).toEqual({ bound: world.A1, raw: world.A1, local: true });
    });

    it("3 · context disappears after COMMIT on the same backend", async () => {
      const pid = await asUser(world.users.a1, world.A1, backendPid);
      const after = await web.db.transaction(async (tx) => ({ pid: await backendPid(tx), ...(await leftoverContext(tx)) }));
      if (target.name === "local") expect(after.pid).toBe(pid);
      expect(after).toMatchObject({ workspace: null, claims: null, role: RUNTIME_LOGIN_ROLES.web });
    });

    it("4 · context disappears after ROLLBACK on the same backend", async () => {
      let pid = 0;
      await expect(
        asUser(world.users.a1, world.A1, async (tx) => {
          pid = await backendPid(tx);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const after = await web.db.transaction(async (tx) => ({ pid: await backendPid(tx), ...(await leftoverContext(tx)) }));
      if (target.name === "local") expect(after.pid).toBe(pid);
      expect(after).toMatchObject({ workspace: null, claims: null, role: RUNTIME_LOGIN_ROLES.web });
    });

    it("5 · a reused pooled backend never leaks the previous tenant (A1 → B1 → none, repeated)", async () => {
      const servedBy = new Map<number, Set<string>>();
      for (let round = 0; round < 5; round += 1) {
        for (const [user, workspace, expected] of [
          [world.users.a1, world.A1, 3],
          [world.users.b1, world.B1, 3],
          [world.users.a1, undefined, 0],
        ] as const) {
          const seen = await asUser(user, workspace, async (tx) => ({
            pid: await backendPid(tx),
            rows: (await tx.execute<{ workspace_id: string }>(sql`select workspace_id::text from t26_fixture.conversations`)).rows,
          }));
          expect(seen.rows).toHaveLength(expected);
          for (const row of seen.rows) expect(row.workspace_id).toBe(workspace);
          const tenants = servedBy.get(seen.pid) ?? new Set<string>();
          tenants.add(workspace ?? "none");
          servedBy.set(seen.pid, tenants);
        }
      }
      // Evidence of reuse: at least one backend served several tenants in turn.
      expect(Math.max(...[...servedBy.values()].map((tenants) => tenants.size))).toBeGreaterThanOrEqual(2);
    });
  });

  describe("T-26 · missing, wrong and fabricated context fail closed (T-01)", () => {
    it("6 · no workspace context: zero tenant rows and writes denied (user and worker)", async () => {
      await asUser(world.users.a1, undefined, async (tx) => {
        expect(await count(tx, CONVERSATIONS)).toBe(0);
        expect(await count(tx, INTERACTIONS)).toBe(0);
        expect(await count(tx, GUEST)).toBe(0);
      });
      const insert = asUser(world.users.a1, undefined, (tx) =>
        tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${world.A1}, 'x')`));
      expect((await sqlState(insert)).code).toBe("42501");

      // A worker transaction that never binds sees nothing and can't write.
      await worker.db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_worker`);
        expect(await count(tx, CONVERSATIONS)).toBe(0);
      });
      const workerInsert = worker.db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_worker`);
        await tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${world.A1}, 'x')`);
      });
      expect((await sqlState(workerInsert)).code).toBe("42501");
      const bindNull = worker.db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_worker`);
        await tx.execute(sql`select app.bind_workspace(null)`);
      });
      expect((await sqlState(bindNull)).code).toBe("42501");
    });

    it("7 · wrong workspace context: zero rows and writes denied", async () => {
      for (const workspace of [world.B1, world.A2]) {
        await asUser(world.users.a1, workspace, async (tx) => {
          expect(await count(tx, CONVERSATIONS)).toBe(0);
          expect(await count(tx, INTERACTIONS)).toBe(0);
        });
        const insert = asUser(world.users.a1, workspace, (tx) =>
          tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${workspace}, 'x')`));
        expect((await sqlState(insert)).code).toBe("42501");
      }
    });

    it("8 · a user in A can't read B, by filter or by ID (T-01)", async () => {
      await asUser(world.users.a1, world.A1, async (tx) => {
        expect(await count(tx, CONVERSATIONS)).toBe(3);
        expect(await count(tx, CONVERSATIONS, sql`workspace_id = ${world.B1}`)).toBe(0);
        const ids = world.conversations[world.B1] ?? [];
        expect(await count(tx, CONVERSATIONS, sql`id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`)).toBe(0);
        expect(await count(tx, "tenancy.workspaces", sql`id = ${world.B1}`)).toBe(0);
        expect(await count(tx, "tenancy.workspace_memberships", sql`workspace_id = ${world.B1}`)).toBe(0);
      });
    });

    it("9 · a user in A can't update or delete B's rows", async () => {
      const before = await oracleCount(CONVERSATIONS, world.B1);
      await asUser(world.users.a1, world.A1, async (tx) => {
        const updated = await tx.execute(sql`update t26_fixture.conversations set title = 'hijacked' where workspace_id = ${world.B1}`);
        const deleted = await tx.execute(sql`delete from t26_fixture.interactions where workspace_id = ${world.B1}`);
        expect(updated.rowCount).toBe(0);
        expect(deleted.rowCount).toBe(0);
      });
      expect(await oracleCount(CONVERSATIONS, world.B1)).toBe(before);
      expect(await oracleCount(INTERACTIONS, world.B1)).toBe(3);
      const titles = (await privileged.query<{ title: string }>("select title from t26_fixture.conversations where workspace_id = $1", [world.B1])).rows;
      expect(titles.every((row) => row.title !== "hijacked")).toBe(true);
    });

    it("10 · a user or worker in A can't insert into B or move rows into B", async () => {
      const userInsert = asUser(world.users.a1, world.A1, (tx) =>
        tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${world.B1}, 'x')`));
      expect((await sqlState(userInsert)).code).toBe("42501");
      const userMove = asUser(world.users.a1, world.A1, (tx) =>
        tx.execute(sql`update t26_fixture.conversations set workspace_id = ${world.B1} where workspace_id = ${world.A1}`));
      expect((await sqlState(userMove)).code).toBe("42501");
      const workerInsert = asWorker(world.A1, (tx) =>
        tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${world.B1}, 'x')`));
      expect((await sqlState(workerInsert)).code).toBe("42501");
      const workerMove = asWorker(world.A1, (tx) =>
        tx.execute(sql`update t26_fixture.conversations set workspace_id = ${world.B1} where workspace_id = ${world.A1}`));
      expect((await sqlState(workerMove)).code).toBe("42501");
      expect(await oracleCount(CONVERSATIONS, world.B1)).toBe(3);
      expect(await oracleCount(CONVERSATIONS, world.A1)).toBe(3);
    });
  });

  describe("T-26 · workers stay inside their workspace (T-11)", () => {
    it("11 · a worker bound to A sees exactly A's rows and nothing of B", async () => {
      await asWorker(world.A1, async (tx) => {
        expect(await count(tx, CONVERSATIONS)).toBe(3);
        expect(await count(tx, CONVERSATIONS, sql`workspace_id = ${world.B1}`)).toBe(0);
        expect(await count(tx, "tenancy.workspaces")).toBe(1);
      });
      // The oracle confirms the table holds every workspace's rows: the worker saw only its own.
      expect(await oracleCount(CONVERSATIONS, world.A2) + (await oracleCount(CONVERSATIONS, world.B1))).toBe(6);
    });

    it("12 · a worker (or user) can't rebind within a transaction", async () => {
      const workerRebind = asWorker(world.A1, (tx) => tx.execute(sql`select app.bind_workspace(${world.B1}::uuid)`));
      expect(await sqlState(workerRebind)).toMatchObject({ code: "42501" });
      const userRebind = asUser(world.users.a12, world.A1, (tx) => tx.execute(sql`select app.bind_workspace(${world.A2}::uuid)`));
      expect(await sqlState(userRebind)).toMatchObject({ code: "42501" });
    });

    it("13 · raw set_config tampering invalidates the context instead of moving it", async () => {
      await asWorker(world.A1, async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', ${world.B1}, true)`);
        expect(await scalar(tx, sql`select app.current_workspace() as value`)).toBeNull();
        expect(await count(tx, CONVERSATIONS)).toBe(0);
      });
      await asUser(world.users.a1, world.A1, async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', ${world.A2}, true)`);
        expect(await count(tx, CONVERSATIONS)).toBe(0);
      });
    });

    it("14 · a seal replayed from another transaction grants nothing", async () => {
      const captured = await asWorker(world.B1, (tx) => scalar<string>(tx, sql`select current_setting('app.workspace_seal') as value`));
      await worker.db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_worker`);
        await tx.execute(sql`select set_config('app.workspace_id', ${world.B1}, true), set_config('app.workspace_seal', ${captured}, true)`);
        expect(await scalar(tx, sql`select app.current_workspace() as value`)).toBeNull();
        expect(await count(tx, CONVERSATIONS)).toBe(0);
      });
    });

    it("15 · a fabricated workspace ID, or a user without memberships, sees nothing", async () => {
      await asUser(world.users.a1, randomUUID(), async (tx) => {
        expect(await count(tx, CONVERSATIONS)).toBe(0);
      });
      await asUser(world.users.none, world.A1, async (tx) => {
        expect(await count(tx, CONVERSATIONS)).toBe(0);
        expect(await count(tx, "tenancy.workspaces")).toBe(0);
        expect(await count(tx, "tenancy.organizations")).toBe(0);
      });
      await asWorker(randomUUID(), async (tx) => {
        expect(await count(tx, CONVERSATIONS)).toBe(0);
      });
    });

    it("16 · a user with memberships in A1 and A2, bound to A1, sees only A1", async () => {
      await asUser(world.users.a12, world.A1, async (tx) => {
        const rows = (await tx.execute<{ workspace_id: string }>(sql`select workspace_id::text from t26_fixture.conversations`)).rows;
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((row) => row.workspace_id))).toEqual(new Set([world.A1]));
      });
    });

    it("17 · an organization A user can't infer organization B", async () => {
      await asUser(world.users.a1, undefined, async (tx) => {
        expect(await count(tx, "tenancy.organizations")).toBe(1);
        expect(await count(tx, "tenancy.organizations", sql`id = ${world.orgB}`)).toBe(0);
        expect(await count(tx, "tenancy.workspaces")).toBe(1);
        expect(await count(tx, "tenancy.organization_memberships", sql`organization_id = ${world.orgB}`)).toBe(0);
        expect(await count(tx, "tenancy.invitations")).toBe(0);
      });
      // Organization membership alone never reveals workspaces; even the Owner of A sees nothing of B.
      await asUser(world.users.orgOnly, undefined, async (tx) => {
        expect(await count(tx, "tenancy.organizations")).toBe(1);
        expect(await count(tx, "tenancy.workspaces")).toBe(0);
      });
      await asUser(world.users.ownerA, undefined, async (tx) => {
        expect(await count(tx, "tenancy.workspaces")).toBe(2);
        expect(await count(tx, "tenancy.workspaces", sql`id = ${world.B1}`)).toBe(0);
        expect(await count(tx, "tenancy.workspace_memberships", sql`workspace_id = ${world.B1}`)).toBe(0);
      });
      // Client guests read guest projections only, never workspace content.
      await asUser(world.users.guest, world.A1, async (tx) => {
        expect(await count(tx, CONVERSATIONS)).toBe(0);
        expect(await count(tx, INTERACTIONS)).toBe(0);
        expect(await count(tx, GUEST)).toBe(1);
        expect(await count(tx, "tenancy.workspace_memberships")).toBe(1);
      });
    });
  });

  describe("T-26 · roles, credentials and privileges (R1, R4)", () => {
    it("18 · direct Drizzle queries without a scope helper can't bypass RLS", async () => {
      for (const database of [web, worker, system] as const) {
        const direct = database.db.execute(sql`select count(*) from t26_fixture.conversations`);
        expect((await sqlState(direct)).code).toBe("42501");
        const tenancy = database.db.execute(sql`select count(*) from tenancy.workspaces`);
        expect((await sqlState(tenancy)).code).toBe("42501");
      }
      // A session-form role switch by buggy code (no claims, no sealed context) yields no rows. It is reset
      // inside the same transaction so nothing lingers on a shared pooled backend afterwards.
      const rows = await web.db.transaction(async (tx) => {
        await tx.execute(sql`set role authenticated`);
        const seen = await count(tx, CONVERSATIONS);
        await tx.execute(sql`reset role`);
        return seen;
      });
      expect(rows).toBe(0);
    });

    it("19 · no runtime login can SET ROLE beyond its single fixed target", async () => {
      const forbidden = ["service_role", "postgres", "app_owner", "authenticator", "supabase_admin", "anon", "authenticated", "app_worker", "app_system", ...Object.values(RUNTIME_LOGIN_ROLES)];
      const allowed = { web: "authenticated", worker: "app_worker", system: "app_system" } as const;
      for (const [kind, database] of [["web", web], ["worker", worker], ["system", system]] as const) {
        for (const role of forbidden.filter((name) => name !== allowed[kind] && name !== RUNTIME_LOGIN_ROLES[kind])) {
          const attempt = database.db.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
            await tx.execute(sql.raw(`set local role ${role}`));
          });
          const failure = await sqlState(attempt);
          expect(["42501", "22023"]).toContain(failure.code);
        }
        await database.db.transaction((tx) => tx.execute(sql.raw(`set local role ${allowed[kind]}`)));
      }
    });

    it("20 · the system role reaches system metadata only, never tenant content", async () => {
      for (const table of [CONVERSATIONS, "tenancy.workspaces", "tenancy.workspace_memberships", "tenancy.organizations", "audit.audit_events"]) {
        const attempt = withSystemScope(system, (tx) => tx.execute(sql.raw(`select count(*) from ${table}`)));
        expect((await sqlState(attempt)).code).toBe("42501");
      }
      const context = withSystemScope(system, (tx) => tx.execute(sql`select app.current_workspace()`));
      expect((await sqlState(context)).code).toBe("42501");
      const outboxRows = await withSystemScope(system, (tx) => count(tx, "system.outbox"));
      expect(outboxRows).toBeGreaterThanOrEqual(0);
    });

    it("21 · runtime pools never accept a privileged credential; no service-role key is configured", () => {
      expect(process.env["SUPABASE_SERVICE_ROLE_KEY"]).toBeUndefined();
      for (const kind of ["web", "worker", "system"] as const) {
        expect(() => createRuntimeDatabase(kind, target.privilegedUrl, { sslRootCert: target.sslRootCert })).toThrow(ConnectionConfigError);
      }
      expect(() => createRuntimeDatabase("web", target.runtimeUrls.worker, { sslRootCert: target.sslRootCert })).toThrow(ConnectionConfigError);
    });

    it("22 · every runtime login is LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT and reaches no privileged role", async () => {
      const result = await web.db.transaction((tx) =>
        tx.execute<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; privileged: boolean }>(sql`
          select r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit,
                 exists (
                   select 1 from unnest(array['service_role', 'postgres', 'app_owner', 'anon', 'authenticator', 'supabase_admin']) p(name)
                   join pg_roles pr on pr.rolname = p.name
                   where pg_has_role(r.oid, pr.oid, 'MEMBER')
                 ) as privileged
          from pg_roles r where r.rolname in ('web_login', 'worker_login', 'system_login') order by r.rolname`));
      expect(result.rows).toHaveLength(3);
      for (const row of result.rows) {
        expect(row).toMatchObject({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolinherit: false, privileged: false });
      }
      const targets = await web.db.transaction((tx) =>
        tx.execute<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
          sql`select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname in ('authenticated', 'app_worker', 'app_system', 'app_owner')`));
      for (const row of targets.rows) expect(row).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    });

    it("23 · every application table has RLS enabled AND forced", async () => {
      const tables = await web.db.transaction((tx) =>
        tx.execute<{ name: string; enabled: boolean; forced: boolean }>(sql`
          select n.nspname || '.' || c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and n.nspname in (select jsonb_array_elements_text(${JSON.stringify(APPLICATION_SCHEMAS)}::jsonb))`));
      expect(tables.rows.length).toBeGreaterThanOrEqual(12);
      for (const table of tables.rows) expect(table, table.name).toMatchObject({ enabled: true, forced: true });
    });

    it("24 · a composite workspace reference to another workspace fails exactly like a non-existent one (R5)", async () => {
      const foreignConversation = world.conversations[world.B1]?.[0] ?? "";
      const attempt = (conversation: string) =>
        asUser(world.users.a1, world.A1, (tx) =>
          tx.execute(sql`insert into t26_fixture.interactions (id, workspace_id, conversation_id, body) values (${randomUUID()}, ${world.A1}, ${conversation}, 'x')`));
      const foreign = await sqlState(attempt(foreignConversation));
      const missing = await sqlState(attempt(randomUUID()));
      expect(foreign.code).toBe("23503");
      expect(foreign).toEqual(missing);
    });
  });

  describe("T-26 · pooled connections under load and leftover session state", () => {
    it("25 · concurrent transactions across workspaces on shared pooled backends never see a foreign row", async () => {
      const webPool = runtimeDatabase(target, "web", 4);
      const workerPool = runtimeDatabase(target, "worker", 4);
      const contexts = [
        { kind: "user", user: world.users.a1, workspace: world.A1 },
        { kind: "user", user: world.users.b1, workspace: world.B1 },
        { kind: "user", user: world.users.a12, workspace: world.A2 },
        { kind: "worker", user: "", workspace: world.B1 },
        { kind: "worker", user: "", workspace: world.A2 },
      ] as const;
      const servedBy = new Map<string, Set<string>>();
      // 150 transactions interleaved across 5 tenant contexts, with in-flight work capped at the pools'
      // capacity (4 web + 4 worker) so no request waits on the client-side checkout queue (a scoped
      // transaction to the managed pooler takes ~0.4 s over the WAN).
      const TRANSACTIONS = 150;
      const LANES = 8;
      let next = 0;
      const lane = async (): Promise<void> => {
        while (next < TRANSACTIONS) await transaction(next++);
      };
      let completed = 0;
      const transaction = async (index: number): Promise<void> => {
        const context = contexts[index % contexts.length];
        if (context === undefined) return;
        const read = async (tx: DatabaseTransaction) => ({
          pid: await backendPid(tx),
          rows: (await tx.execute<{ workspace_id: string }>(sql`select workspace_id::text from t26_fixture.conversations`)).rows,
        });
        const seen = context.kind === "user"
          ? await withUserScope(webPool, { sub: context.user }, context.workspace, read)
          : await withWorkspaceJobScope(workerPool, context.workspace, read);
        expect(seen.rows).toHaveLength(3);
        for (const row of seen.rows) expect(row.workspace_id).toBe(context.workspace);
        const key = `${context.kind}:${String(seen.pid)}`;
        const tenants = servedBy.get(key) ?? new Set<string>();
        tenants.add(context.workspace);
        servedBy.set(key, tenants);
        completed += 1;
      };
      try {
        await Promise.all(Array.from({ length: LANES }, lane));
        expect(completed).toBe(TRANSACTIONS);
      } finally {
        await Promise.all([webPool.end(), workerPool.end()]);
      }
      expect([...servedBy.values()].some((tenants) => tenants.size >= 2)).toBe(true);
    });

    it("26 · buggy session-level workspace state never becomes authoritative", async () => {
      // Capture a real seal, then plant it (and B1) at SESSION level, as buggy code might.
      const seal = await asWorker(world.B1, (tx) => scalar<string>(tx, sql`select current_setting('app.workspace_seal') as value`));
      const client = await worker.pool.connect();
      try {
        await client.query("select set_config('app.workspace_id', $1, false), set_config('app.workspace_seal', $2, false)", [world.B1, seal]);
      } finally {
        client.release();
      }
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await worker.db.transaction(async (tx) => {
          await tx.execute(sql`set local role app_worker`);
          expect(await scalar(tx, sql`select app.current_workspace() as value`)).toBeNull();
          expect(await count(tx, CONVERSATIONS)).toBe(0);
        });
        // A properly bound transaction on the same backend is unaffected by the leftover.
        await asWorker(world.A1, async (tx) => {
          expect(await count(tx, CONVERSATIONS)).toBe(3);
          expect(await count(tx, CONVERSATIONS, sql`workspace_id = ${world.B1}`)).toBe(0);
        });
      }
      const cleanup = await worker.pool.connect();
      try {
        await cleanup.query("reset app.workspace_id");
        await cleanup.query("reset app.workspace_seal");
      } finally {
        cleanup.release();
      }
    });

    it("27 · long-lived roles are never dropped or recreated by the suite (R8)", async () => {
      expect(roleOids.size).toBe(7);
      expect(await foundationRoleOids()).toEqual(roleOids);
    });
  });

  describe("T-26 · append-only audit (R4)", () => {
    it("29 · runtime roles can append audit events but never read, update or delete them", async () => {
      const id = randomUUID();
      await asUser(world.users.a1, world.A1, (tx) =>
        tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id, target_type, target_id, correlation_id, outcome)
          values (${id}, now(), 'workspace.mode_changed', 'user', ${world.users.a1}, ${world.orgA}, ${world.A1}, 'workspace', ${world.A1}, 'corr-t26-append-only', 'succeeded')`));
      for (const statement of [
        sql`update audit.audit_events set outcome = 'failed' where id = ${id}`,
        sql`delete from audit.audit_events where id = ${id}`,
        sql`select count(*) from audit.audit_events`,
      ]) {
        expect((await sqlState(asUser(world.users.a1, world.A1, (tx) => tx.execute(statement)))).code).toBe("42501");
        expect((await sqlState(asWorker(world.A1, (tx) => tx.execute(statement)))).code).toBe("42501");
      }
      // Forged attribution is refused: users append only events attributed to themselves.
      const forged = asUser(world.users.a1, world.A1, (tx) =>
        tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, target_type, target_id, correlation_id, outcome)
          values (${randomUUID()}, now(), 'workspace.mode_changed', 'user', ${world.users.b1}, 'workspace', ${world.B1}, 'corr-t26-forged', 'succeeded')`));
      expect((await sqlState(forged)).code).toBe("42501");
      const row = await privileged.query<{ outcome: string }>("select outcome from audit.audit_events where id = $1", [id]);
      expect(row.rows).toEqual([{ outcome: "succeeded" }]);
    });
  });
}
