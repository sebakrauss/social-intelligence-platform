/**
 * RELEASE-TOOLING-01 — the migration runner's bounded lock WAIT, against a recording client (no database): the
 * transaction-local lock_timeout is set after the advisory lock and before every migration statement; a lock timeout
 * (55P03) rolls the migration back and surfaces an actionable, non-sensitive MigrationLockTimeoutError; any other error
 * is rethrown unchanged; the CLI argument is bounded. The real lock contention runs on a disposable cluster in
 * tests/db/local/migration-lock-timeout.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  isValidMigrationLockTimeout,
  MigrationLockTimeoutError,
  parseLockTimeoutArgument,
  type Migration,
} from "@/tools/db/migrations";

/** The runner's own client type (no direct `pg` import outside platform/db, per the boundary rules). */
type RunnerClient = Parameters<typeof applyMigrations>[0];
const migration = (name: string, sql: string): Migration => ({ name, sql, checksum: "a".repeat(64) });
const M1 = migration("0001_first.sql", "create table first_table (id int);");
const M2 = migration("0002_second.sql", "alter table audit_like add constraint c check (true);");

/** A pg.Client stand-in: records every statement; the ledger starts empty; `failOn` makes one statement fail. */
function recordingClient(failOn?: { readonly sql: string; readonly code: string }) {
  const statements: string[] = [];
  const applied: { name: string; checksum: string }[] = [];
  const query = (text: string, values?: readonly unknown[]) => {
    statements.push(values === undefined ? text : `${text} -- ${JSON.stringify(values)}`);
    if (failOn !== undefined && text === failOn.sql) return Promise.reject(Object.assign(new Error("synthetic failure"), { code: failOn.code }));
    if (text.includes("to_regclass('app_migrations.applied')")) return Promise.resolve({ rows: [{ present: true }] });
    if (text.startsWith("select name, checksum from app_migrations.applied")) return Promise.resolve({ rows: [...applied] });
    if (text.startsWith("insert into app_migrations.applied")) applied.push({ name: String(values?.[0]), checksum: String(values?.[1]) });
    return Promise.resolve({ rows: [] });
  };
  return { client: { query } as unknown as RunnerClient, statements, applied };
}

describe("migration runner: bounded lock wait", () => {
  it("sets a transaction-local lock_timeout right after the advisory lock and before each migration's statements", async () => {
    const { client, statements } = recordingClient();
    expect(await applyMigrations(client, [M1, M2], { lockTimeoutMs: 750 })).toEqual([M1.name, M2.name]);
    for (const m of [M1, M2]) {
      const sql = statements.indexOf(m.sql);
      const timeout = statements.lastIndexOf(`select pg_catalog.set_config('lock_timeout', $1, true) -- ["750ms"]`, sql);
      const advisory = statements.lastIndexOf("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_migrations', 0))", timeout);
      const begin = statements.lastIndexOf("begin", advisory);
      expect(begin, m.name).toBeGreaterThanOrEqual(0);
      expect(begin < advisory && advisory < timeout && timeout < sql, m.name).toBe(true);
      // Nothing between the lock_timeout and the migration can end the transaction (the setting is transaction-local).
      expect(statements.slice(timeout, sql).some((s) => /^(commit|rollback|begin)$/.test(s)), m.name).toBe(false);
    }
    expect(statements.filter((s) => s.includes("set_config('lock_timeout'"))).toHaveLength(2);
    // The ledger bootstrap transaction is unchanged (no lock_timeout there).
    expect(statements.slice(0, 4)).toEqual(["begin", "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_migrations', 0))", expect.stringContaining("create schema if not exists app_migrations"), "commit"]);
  });

  it("uses the default bound when none is given", async () => {
    const { client, statements } = recordingClient();
    await applyMigrations(client, [M1]);
    expect(statements).toContain(`select pg_catalog.set_config('lock_timeout', $1, true) -- ["${String(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS)}ms"]`);
    expect(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS).toBe(5000);
  });

  it("a lock timeout (55P03) rolls the migration back, writes no ledger row, and stops with an actionable error naming what was committed", async () => {
    const { client, statements, applied } = recordingClient({ sql: M2.sql, code: "55P03" });
    const error = await applyMigrations(client, [M1, M2], { lockTimeoutMs: 1000 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    const timeout = error as MigrationLockTimeoutError;
    expect(timeout.migration).toBe(M2.name);
    expect(timeout.lockTimeoutMs).toBe(1000);
    expect(timeout.appliedBefore).toEqual([M1.name]);
    expect(timeout.code).toBe("55P03");
    expect(timeout.message).toMatch(/0002_second\.sql waited more than 1000 ms for a lock/);
    expect(timeout.message).toMatch(/nothing of it was applied and no ledger row was written/);
    expect(timeout.message).toMatch(/Applied earlier in this run \(committed\): 0001_first\.sql/);
    expect(timeout.message).toMatch(/pg_stat_activity, pg_locks/);
    expect(timeout.message).toMatch(/bounds only the wait; an acquired lock is held until the migration's transaction ends/);
    expect(statements.at(-1)).toBe("rollback");
    expect(applied.map((row) => row.name)).toEqual([M1.name]);
  });

  it("any other failure is rethrown unchanged (not reported as a lock timeout)", async () => {
    const { client, statements } = recordingClient({ sql: M1.sql, code: "55000" });
    await expect(applyMigrations(client, [M1])).rejects.toMatchObject({ message: "synthetic failure", code: "55000" });
    await expect(applyMigrations(recordingClient({ sql: M1.sql, code: "55000" }).client, [M1])).rejects.not.toBeInstanceOf(MigrationLockTimeoutError);
    expect(statements.at(-1)).toBe("rollback");
  });

  it("the bound is a non-zero integer in range (0 would mean wait forever); invalid values are refused before anything runs", async () => {
    for (const value of [100, 5000, 600_000]) expect(isValidMigrationLockTimeout(value), String(value)).toBe(true);
    for (const value of [0, 99, 600_001, -1, 1.5, Number.NaN]) expect(isValidMigrationLockTimeout(value), String(value)).toBe(false);
    const { client, statements } = recordingClient();
    await expect(applyMigrations(client, [M1], { lockTimeoutMs: 0 })).rejects.toThrow(/lock timeout must be an integer from 100 to 600000 ms/);
    expect(statements).toEqual([]);
  });

  it("db:migrate's --lock-timeout-ms: at most once, digits only, in range; absent → the default", () => {
    expect(parseLockTimeoutArgument(["--target", "development"])).toEqual({ lockTimeoutMs: 5000 });
    expect(parseLockTimeoutArgument(["--target", "development", "--lock-timeout-ms", "2500", "--apply"])).toEqual({ lockTimeoutMs: 2500 });
    for (const args of [["--lock-timeout-ms"], ["--lock-timeout-ms", "0"], ["--lock-timeout-ms", "50"], ["--lock-timeout-ms", "1e4"], ["--lock-timeout-ms", "-5"], ["--lock-timeout-ms", "700000"], ["--lock-timeout-ms", "1000", "--lock-timeout-ms", "2000"], ["--lock-timeout-ms", "--apply"]]) {
      expect("error" in parseLockTimeoutArgument(args), args.join(" ")).toBe(true);
    }
  });
});
