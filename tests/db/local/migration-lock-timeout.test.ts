/**
 * RELEASE-TOOLING-01 — the migration runner's bounded lock WAIT against real lock contention, on a disposable local
 * cluster migrated through 0033 by the real runner (no managed database):
 *
 *   - another session holds a lock on audit.audit_events (any mode conflicts with the ACCESS EXCLUSIVE 0034 needs to
 *     drop and re-add its check constraints), so 0034 waits at most the bound, fails with MigrationLockTimeoutError and
 *     rolls back COMPLETELY: still 33 applied, no `workflow` schema, the audit constraints unchanged, no ledger row;
 *     the holding session is unaffected;
 *   - the setting is transaction-local: nothing of it survives on the runner's session;
 *   - once the holder ends, a retry applies exactly 0034; a further run is a no-op.
 *
 * `lock_timeout` bounds only the wait. It does not limit how long an acquired lock is held (see tools/db/migrations.ts).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "@/platform/db";
import { applyMigrations, MigrationLockTimeoutError, migrationStatus, readMigrations } from "@/tools/db/migrations";
import { spawnLocalCluster, type SpawnedCluster } from "../support/spawn-cluster";

const THROUGH = "0033_mutation_intent_state_transition_guard.sql";
const M0034 = "0034_workflow_core.sql";

describe("migration runner: a lock held elsewhere bounds 0034's wait, rolls it back, and a retry applies it", () => {
  let cluster: SpawnedCluster;
  let runner: pg.Client;
  let holder: pg.Client;
  const connect = async (): Promise<pg.Client> => {
    const url = parseDatabaseUrl(cluster.target.privilegedUrl, "privileged URL");
    const client = new pg.Client({ host: url.host, port: url.port, database: url.database, user: url.user, password: url.password, application_name: "lock-timeout-test" });
    await client.connect();
    return client;
  };
  const one = async <T extends pg.QueryResultRow>(text: string): Promise<T | undefined> => (await runner.query<T>(text)).rows[0];
  const workflowSchemas = async () => (await one<{ n: number }>("select count(*)::int as n from pg_namespace where nspname = 'workflow'"))?.n;
  const auditActionCheck = async () => (await one<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'audit_events_action_check'"))?.def ?? "";

  beforeAll(async () => {
    cluster = await spawnLocalCluster({ migrateThrough: THROUGH });
    runner = await connect();
    holder = await connect();
  });
  afterAll(async () => {
    await holder.end();
    await runner.end();
    await cluster.stop();
  });

  it("starts at 33 applied, 0034 pending, no workflow schema", async () => {
    const status = await migrationStatus(runner, readMigrations());
    expect(status.applied).toHaveLength(33);
    expect(status.pending.map((m) => m.name)).toEqual([M0034]);
    expect(await workflowSchemas()).toBe(0);
    expect(await auditActionCheck()).not.toMatch(/work_item\.state_changed/);
  });

  it("while another session holds a lock on audit.audit_events, 0034 waits at most the bound, then rolls back completely", async () => {
    await holder.query("begin");
    await holder.query("lock table audit.audit_events in access share mode");
    const started = Date.now();
    const error = await applyMigrations(runner, readMigrations(), { lockTimeoutMs: 400 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const waited = Date.now() - started;

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    expect((error as MigrationLockTimeoutError).migration).toBe(M0034);
    expect((error as MigrationLockTimeoutError).appliedBefore).toEqual([]);
    expect(waited).toBeGreaterThanOrEqual(400);
    expect(waited).toBeLessThan(10_000); // bounded: without the timeout this would wait for the holder indefinitely

    // Nothing of 0034 remains: ledger, schema, audit vocabulary.
    const status = await migrationStatus(runner, readMigrations());
    expect(status.applied).toHaveLength(33);
    expect(status.pending.map((m) => m.name)).toEqual([M0034]);
    expect(await workflowSchemas()).toBe(0);
    expect(await auditActionCheck()).not.toMatch(/work_item\.state_changed/);
    // The runner's session is clean (no open transaction, no lingering setting) and the holder was not disturbed.
    expect((await one<{ s: string }>("select current_setting('lock_timeout') as s"))?.s).toBe("0");
    // No transaction left open: outside one, each statement is its own transaction, so now() = statement_timestamp().
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await one<{ fresh: boolean }>("select now() = statement_timestamp() as fresh"))?.fresh).toBe(true);
    expect((await holder.query<{ n: number }>("select count(*)::int as n from audit.audit_events")).rows).toHaveLength(1);
  });

  it("once the holder ends, a retry applies exactly 0034; a further run is a no-op", async () => {
    await holder.query("commit");
    expect(await applyMigrations(runner, readMigrations(), { lockTimeoutMs: 400 })).toEqual([M0034]);
    const status = await migrationStatus(runner, readMigrations());
    expect(status.applied).toHaveLength(34);
    expect(status.pending).toEqual([]);
    expect(await workflowSchemas()).toBe(1);
    expect(await auditActionCheck()).toMatch(/work_item\.state_changed/);
    expect(await applyMigrations(runner, readMigrations())).toEqual([]);
    expect((await one<{ s: string }>("select current_setting('lock_timeout') as s"))?.s).toBe("0");
  });
});
