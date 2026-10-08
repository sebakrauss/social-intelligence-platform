/**
 * Outbox execution plane (0011; Step 7E.4B.2B). The semantic plane a delivery is bound to is chosen ONLY by the
 * delivery claim and never changes afterwards: producers insert NULL, app_system binds NULL → main | integration inside
 * the claim UPDATE (or, for a relay that predates the column, the guard binds 'main'), nothing else can bind, and a bound
 * plane is immutable. The historical backfill is exercised against the migration's own SQL.
 *
 * Every row a test needs is either created with a far-future created_at (no relay pass in any suite can claim it) or
 * lives inside a transaction that is rolled back, so no other suite sees it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { claimDueRows, markDispatched, markDispatchFailed } from "@/platform/db/outbox-delivery";
import { withSystemScope } from "@/platform/db/system-scope";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";
import { sqlState } from "./helpers";

const MIGRATION = readFileSync(path.resolve(import.meta.dirname, "../../../db/migrations/0011_outbox_execution_plane.sql"), "utf8");
const BACKFILL = /-- backfill:begin\n([\s\S]*?)-- backfill:end/.exec(MIGRATION)?.[1] ?? "";
const TOPIC = "test.execution_plane";
const FUTURE = "2999-01-01T00:00:00Z"; // never due: no relay pass in any suite claims these rows
const ROLLBACK = new Error("rollback");

export function defineExecutionPlaneSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let world: World;

  const q = async <T extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(text, [...values])).rows;
  const plane = async (id: string): Promise<string | null | undefined> =>
    (await q<{ execution_plane: string | null }>("select execution_plane from system.outbox where id = $1", [id]))[0]?.execution_plane;

  /** An unbound PENDING row (as a producer would leave it), seeded by the bootstrap connection. */
  const pending = async (createdAt = FUTURE): Promise<string> => {
    const id = randomUUID();
    await q(
      `insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, created_at)
       values ($1, $2, $3, $4, '{}', 'corr-execution-plane', 'system', $5, $6)`,
      [id, TOPIC, world.orgA, world.A1, `${TOPIC}:${id}`, createdAt]);
    return id;
  };

  /** Runs work as app_system and rolls it back, so nothing leaks to other suites. */
  const asSystemRolledBack = async (work: (tx: DatabaseTransaction) => Promise<void>): Promise<void> => {
    await withSystemScope(system, async (tx) => {
      await work(tx);
      throw ROLLBACK;
    }).catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
  };
  const planeIn = async (tx: DatabaseTransaction, id: string): Promise<string | null | undefined> =>
    (await tx.execute<{ execution_plane: string | null }>(sql`select execution_plane from system.outbox where id = ${id}`)).rows[0]?.execution_plane;
  /** The claim UPDATE a plane-aware relay issues: lease + explicit plane, nothing else. */
  const claimWith = (tx: DatabaseTransaction, id: string, executionPlane: string | null) =>
    tx.execute(sql`update system.outbox set claimed_until = now() + interval '1 minute', execution_plane = coalesce(execution_plane, ${executionPlane}) where id = ${id}`);

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 1);
    worker = runtimeDatabase(target, "worker", 1);
    system = runtimeDatabase(target, "system", 1);
    world = await seedWorld(privileged);
  });
  afterAll(async () => {
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.end();
  });

  describe("producers never choose the execution plane", () => {
    const insertAsWeb = (executionPlane: string | null) => {
      const id = randomUUID();
      return {
        id,
        run: withUserScope(web, { sub: world.users.ownerA, role: "authenticated" }, world.A1, (tx) =>
          tx.execute(sql`insert into system.outbox (id, topic, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, created_at, execution_plane)
            values (${id}, ${TOPIC}, ${world.A1}, '{}'::jsonb, 'corr-execution-plane', 'user', ${world.users.ownerA}, ${`${TOPIC}:${id}`}, ${FUTURE}, ${executionPlane})`)),
      };
    };
    const insertAsWorker = (executionPlane: string | null) => {
      const id = randomUUID();
      return withWorkspaceJobScope(worker, world.A1, (tx) =>
        tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, created_at, execution_plane)
          values (${id}, ${TOPIC}, ${world.orgA}, ${world.A1}, '{}'::jsonb, 'corr-execution-plane', 'system', ${`${TOPIC}:${id}`}, ${FUTURE}, ${executionPlane})`));
    };

    it("an insert that omits the plane (or passes NULL) stores an unbound row", async () => {
      const { id, run } = insertAsWeb(null);
      await run;
      expect(await plane(id)).toBeNull();
      expect(await plane(await pending())).toBeNull();
    });

    it("web and worker producers inserting 'main' or 'integration' are refused", async () => {
      for (const value of ["main", "integration"]) {
        expect((await sqlState(insertAsWeb(value).run)).code, value).toBe("42501");
        expect((await sqlState(insertAsWorker(value))).code, value).toBe("42501");
      }
    });

    it("the guard applies to every role: even the bootstrap connection cannot insert a bound row", async () => {
      const id = randomUUID();
      const insert = q(
        `insert into system.outbox (id, topic, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, created_at, execution_plane)
         values ($1, $2, $3, '{}', 'corr-execution-plane', 'system', $4, $5, 'main')`, [id, TOPIC, world.A1, `${TOPIC}:${id}`, FUTURE]);
      expect((await sqlState(insert)).code).toBe("42501");
    });

    it("web and worker have no UPDATE privilege on the outbox at all (they cannot route existing rows)", async () => {
      const id = await pending();
      const viaWeb = withUserScope(web, { sub: world.users.ownerA, role: "authenticated" }, world.A1, (tx) =>
        tx.execute(sql`update system.outbox set execution_plane = 'main' where id = ${id}`));
      expect((await sqlState(viaWeb)).code).toBe("42501");
      const viaWorker = withWorkspaceJobScope(worker, world.A1, (tx) => tx.execute(sql`update system.outbox set execution_plane = 'main' where id = ${id}`));
      expect((await sqlState(viaWorker)).code).toBe("42501");
      expect(await plane(id)).toBeNull();
    });
  });

  describe("binding happens only inside a delivery claim", () => {
    it("app_system binds NULL → 'main' or 'integration' in the claim UPDATE, and the binding sticks", async () => {
      for (const value of ["main", "integration"]) {
        const id = await pending();
        await asSystemRolledBack(async (tx) => {
          await claimWith(tx, id, value);
          expect(await planeIn(tx, id)).toBe(value);
          // A later claim of the same row (lease renewal after a crash) keeps the bound plane.
          await tx.execute(sql`update system.outbox set claimed_until = claimed_until + interval '1 minute', execution_plane = coalesce(execution_plane, 'main') where id = ${id}`);
          expect(await planeIn(tx, id)).toBe(value);
        });
      }
    });

    it("binding outside a claim is refused: a bare plane update, or a plane update riding on another column", async () => {
      for (const value of ["main", "integration"]) {
        const id = await pending();
        const bare = withSystemScope(system, (tx) => tx.execute(sql`update system.outbox set execution_plane = ${value} where id = ${id}`));
        expect((await sqlState(bare)).code, value).toBe("42501");
        const withSlo = withSystemScope(system, (tx) => tx.execute(sql`update system.outbox set slo_breached_at = now(), execution_plane = ${value} where id = ${id}`));
        expect((await sqlState(withSlo)).code, value).toBe("42501");
        expect(await plane(id)).toBeNull();
      }
    });

    it("a claim-shaped update that also changes another delivery column is not a claim and cannot bind", async () => {
      const id = await pending();
      const notAClaim = withSystemScope(system, (tx) =>
        tx.execute(sql`update system.outbox set claimed_until = now() + interval '1 minute', dispatch_attempts = dispatch_attempts + 1, execution_plane = 'integration' where id = ${id}`));
      expect((await sqlState(notAClaim)).code).toBe("42501");
      expect(await plane(id)).toBeNull();
    });
  });

  describe("a bound plane is immutable", () => {
    it("main → integration, integration → main, main → NULL and integration → NULL are all refused", async () => {
      const transitions: readonly [string, string | null][] = [["main", "integration"], ["integration", "main"], ["main", null], ["integration", null]];
      for (const [from, to] of transitions) {
        const id = await pending();
        await withSystemScope(system, (tx) => claimWith(tx, id, from));
        const change = withSystemScope(system, (tx) => tx.execute(sql`update system.outbox set execution_plane = ${to} where id = ${id}`));
        expect((await sqlState(change)).code, `${from} → ${String(to)}`).toBe("42501");
        // Not even disguised as a new claim.
        const reclaim = withSystemScope(system, (tx) => tx.execute(sql`update system.outbox set claimed_until = claimed_until + interval '1 minute', execution_plane = ${to} where id = ${id}`));
        expect((await sqlState(reclaim)).code, `${from} → ${String(to)} (claim)`).toBe("42501");
        expect(await plane(id)).toBe(from);
      }
    });
  });

  describe("compatibility with relays that predate the column (0011 only)", () => {
    it("the repository's own claim (which knows nothing about planes) binds the claimed row to 'main'", async () => {
      const id = await pending("2000-01-01T00:00:00Z"); // oldest: always inside the claimed batch
      await asSystemRolledBack(async (tx) => {
        const claimed = await claimDueRows(tx, { now: new Date(), minAgeSeconds: 0, leaseSeconds: 60, limit: 1 });
        expect(claimed.map((row) => row.id)).toEqual([id]);
        expect(await planeIn(tx, id)).toBe("main");
        // The rest of the legacy cycle works unchanged: dispatched rows are bound.
        expect(await markDispatched(tx, { outboxId: id, runId: "run_legacy", now: new Date() })).toBe(true);
        expect((await tx.execute<{ status: string; execution_plane: string }>(sql`select status, execution_plane from system.outbox where id = ${id}`)).rows[0])
          .toEqual({ status: "DISPATCHED", execution_plane: "main" });
      });
    });

    it("an unrelated legacy update leaves an unbound row unbound", async () => {
      const id = await pending();
      await asSystemRolledBack(async (tx) => {
        await tx.execute(sql`update system.outbox set slo_breached_at = now() where id = ${id}`);
        expect(await planeIn(tx, id)).toBeNull();
      });
    });

    it("a dispatch attempt recorded on a row that was never claimed fails closed (unbound rows are untouched)", async () => {
      const id = await pending();
      const failed = withSystemScope(system, (tx) => markDispatchFailed(tx, { outboxId: id, failureClass: "enqueue_unavailable", retryAt: new Date() }));
      expect(await sqlState(failed)).toMatchObject({ code: "23514", constraint: "outbox_unbound_untouched" });
      const dispatched = withSystemScope(system, (tx) => markDispatched(tx, { outboxId: id, runId: "run_unclaimed", now: new Date() }));
      expect((await sqlState(dispatched)).code).toBe("23514");
      expect(await plane(id)).toBeNull();
    });
  });

  describe("constraints", () => {
    it("a DISPATCHED row without a plane cannot exist", async () => {
      const id = randomUUID();
      const insert = q(
        `insert into system.outbox (id, topic, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, status, dispatched_at, created_at)
         values ($1, $2, $3, '{}', 'corr-execution-plane', 'system', $4, 'DISPATCHED', now(), $5)`, [id, TOPIC, world.A1, `${TOPIC}:${id}`, FUTURE]);
      expect((await sqlState(insert)).code).toBe("23514");
    });

    it("a DISPATCHED row bound to 'main' or 'integration' is valid", async () => {
      for (const value of ["main", "integration"]) {
        const id = await pending();
        await asSystemRolledBack(async (tx) => {
          await claimWith(tx, id, value);
          expect(await markDispatched(tx, { outboxId: id, runId: `run_${value}`, now: new Date() })).toBe(true);
          expect(await planeIn(tx, id)).toBe(value);
        });
      }
    });

    it("the catalog carries the plane vocabulary, the dispatched and the unbound-untouched constraints", async () => {
      const rows = await q<{ conname: string; definition: string }>(
        "select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'system.outbox'::regclass and conname like 'outbox_%' and conname in ('outbox_execution_plane_known', 'outbox_dispatched_bound', 'outbox_unbound_untouched') order by conname");
      expect(rows.map((row) => row.conname)).toEqual(["outbox_dispatched_bound", "outbox_execution_plane_known", "outbox_unbound_untouched"]);
      const known = rows.find((row) => row.conname === "outbox_execution_plane_known")?.definition ?? "";
      expect(known).toContain("'main'");
      expect(known).toContain("'integration'");
    });
  });

  describe("historical backfill (the migration's own statement)", () => {
    it("binds every row that ever entered delivery to 'main' and leaves never-claimed pending rows unbound", async () => {
      expect(BACKFILL).toMatch(/update system\.outbox o\s+set execution_plane = 'main'/);
      const client = await privileged.connect();
      try {
        await client.query("begin");
        // Recreate the pre-0011 world inside this transaction: no guard, no binding constraints.
        const definitions = (await client.query<{ conname: string; definition: string }>(
          "select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'system.outbox'::regclass and conname in ('outbox_dispatched_bound', 'outbox_unbound_untouched')")).rows;
        expect(definitions).toHaveLength(2);
        await client.query("set local role app_owner");
        await client.query("alter table system.outbox disable trigger outbox_execution_plane_guard");
        await client.query("alter table system.outbox drop constraint outbox_dispatched_bound, drop constraint outbox_unbound_untouched");
        await client.query("reset role");

        const rows: Record<string, { readonly id: string; readonly expected: string | null }> = {};
        const add = async (name: string, expected: string | null, columns: Readonly<Record<string, unknown>> = {}): Promise<string> => {
          const id = randomUUID();
          const base: Record<string, unknown> = {
            id, topic: TOPIC, organization_id: world.orgA, workspace_id: world.A1, subject_ids: "{}", correlation_id: "corr-execution-plane",
            initiator_type: "system", dispatch_key: `${TOPIC}:${id}`, created_at: FUTURE, ...columns,
          };
          const names = Object.keys(base);
          await client.query(`insert into system.outbox (${names.join(", ")}) values (${names.map((_, i) => `$${String(i + 1)}`).join(", ")})`, Object.values(base));
          rows[name] = { id, expected };
          return id;
        };
        const dispatched = { status: "DISPATCHED", dispatched_at: new Date(), dispatch_attempts: 1 };
        await add("untouched pending", null);
        await add("untouched pending past its SLO", null, { slo_breached_at: new Date() });
        await add("claimed, in flight (lease held, no attempt recorded)", "main", { claimed_until: new Date(Date.now() + 60_000) });
        await add("claim crashed (expired lease left behind)", "main", { claimed_until: new Date(Date.now() - 60_000) });
        await add("failed attempt, pending retry", "main", { dispatch_attempts: 1, next_dispatch_at: new Date(), last_failure_class: "enqueue_unavailable" });
        const withRun = await add("dispatched with a run", "main", dispatched);
        await client.query("insert into system.outbox_runs (outbox_id, run_id, dispatch_attempt, recovery_generation, dispatched_at) values ($1, 'run_history', 1, 0, now())", [withRun]);
        const runsOnly = await add("pending row with a recorded run only", "main");
        await client.query("insert into system.outbox_runs (outbox_id, run_id, dispatch_attempt, recovery_generation, dispatched_at) values ($1, 'run_orphan_history', 1, 0, now())", [runsOnly]);
        await add("recovered, pending re-dispatch", "main", { recovery_count: 1, dispatch_attempts: 1, last_failure_class: "run_crashed" });
        for (const outcome of ["COMPLETED", "FAILED", "CANCELED", "RECOVERY_EXHAUSTED"]) {
          await add(`terminal ${outcome}`, "main", { ...dispatched, run_outcome: outcome, run_outcome_at: new Date() });
        }
        await add("observation exhausted", "main", { ...dispatched, run_diagnostic: "OBSERVATION_EXHAUSTED", run_diagnostic_at: new Date() });

        await client.query(BACKFILL);

        // The binding constraints validate every row again (this fails if the backfill missed a processed row).
        await client.query("set local role app_owner");
        for (const { conname, definition } of definitions) await client.query(`alter table system.outbox add constraint ${conname} ${definition}`);
        await client.query("alter table system.outbox enable trigger outbox_execution_plane_guard");
        await client.query("reset role");

        const actual = await client.query<{ id: string; execution_plane: string | null }>(
          "select id, execution_plane from system.outbox where id = any($1::uuid[])", [Object.values(rows).map((row) => row.id)]);
        const byId = new Map(actual.rows.map((row) => [row.id, row.execution_plane]));
        for (const [name, { id, expected }] of Object.entries(rows)) expect(byId.get(id), name).toBe(expected);
      } finally {
        await client.query("rollback");
        client.release();
      }
    });
  });

  describe("introspection", () => {
    it("the guard is an invoker BEFORE row trigger on INSERT and UPDATE OF execution_plane, claimed_until, with an empty search_path", async () => {
      const [trigger] = await q<{ definition: string; enabled: string }>(
        "select pg_get_triggerdef(t.oid) as definition, t.tgenabled::text as enabled from pg_trigger t where t.tgrelid = 'system.outbox'::regclass and t.tgname = 'outbox_execution_plane_guard'");
      expect(trigger?.enabled).toBe("O");
      expect(trigger?.definition).toMatch(/BEFORE INSERT OR UPDATE OF execution_plane, claimed_until ON system\.outbox FOR EACH ROW EXECUTE FUNCTION system\.outbox_execution_plane_guard\(\)/);
      const [fn] = await q<{ definer: boolean; config: string[] | null }>(
        "select p.prosecdef as definer, p.proconfig::text[] as config from pg_proc p where p.oid = 'system.outbox_execution_plane_guard()'::regprocedure");
      expect(fn?.definer).toBe(false);
      expect(fn?.config ?? []).toContain('search_path=""');
    });

    it("only app_system may write the column; no runtime role can update topic; nobody else may update the plane", async () => {
      const privilege = async (role: string, column: string): Promise<boolean> =>
        (await q<{ allowed: boolean }>("select has_column_privilege($1, 'system.outbox', $2, 'UPDATE') as allowed", [role, column]))[0]?.allowed ?? true;
      expect(await privilege("app_system", "execution_plane")).toBe(true);
      for (const role of ["authenticated", "app_worker", "web_login", "worker_login", "anon"]) expect(await privilege(role, "execution_plane"), role).toBe(false);
      for (const role of ["app_system", "authenticated", "app_worker"]) expect(await privilege(role, "topic"), role).toBe(false);
    });

    it("system.outbox_runs is unchanged: no execution_plane column there", async () => {
      const columns = await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'system' and table_name = 'outbox_runs'");
      expect(columns.map((column) => column.column_name)).not.toContain("execution_plane");
    });
  });
}
