/**
 * Migration runner (TA §65). Applies db/migrations/NNNN_name.sql in order, each in its own transaction
 * under a transaction-scoped advisory lock, and records name + SHA-256 in app_migrations.applied.
 * Applied migrations are immutable: a changed checksum stops the run. Runs only from tooling/CI with the
 * migration credential — never from application runtime.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../db/migrations");
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export function readMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  const names = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  return names.map((name) => {
    if (!MIGRATION_NAME.test(name)) throw new Error(`migration file name not allowed: ${name}`);
    const sql = readFileSync(path.join(dir, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") };
  });
}

const LEDGER_SQL = `
  create schema if not exists app_migrations;
  revoke all on schema app_migrations from public;
  create table if not exists app_migrations.applied (
    name       text primary key,
    checksum   text not null check (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz not null default pg_catalog.now()
  );
  alter table app_migrations.applied enable row level security;
  alter table app_migrations.applied force row level security;
`;

const LOCK = "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_migrations', 0))";

export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly Migration[];
}

/** Read-only: which migrations are applied and which are pending. Verifies applied checksums. */
export async function migrationStatus(client: pg.Client, migrations: readonly Migration[]): Promise<MigrationStatus> {
  const exists = await client.query<{ present: boolean }>(`select to_regclass('app_migrations.applied') is not null as present`);
  const applied = exists.rows[0]?.present === true
    ? (await client.query<{ name: string; checksum: string }>("select name, checksum from app_migrations.applied order by name")).rows
    : [];
  const known = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
  for (const row of applied) {
    const checksum = known.get(row.name);
    if (checksum === undefined) throw new Error(`applied migration missing from the repository: ${row.name}`);
    if (checksum !== row.checksum) throw new Error(`applied migration was modified: ${row.name}`);
  }
  const appliedNames = new Set(applied.map((row) => row.name));
  return { applied: [...appliedNames], pending: migrations.filter((migration) => !appliedNames.has(migration.name)) };
}

/** Applies every pending migration in order. Returns the names applied by this call. */
export async function applyMigrations(client: pg.Client, migrations: readonly Migration[]): Promise<readonly string[]> {
  await client.query("begin");
  try {
    await client.query(LOCK);
    await client.query(LEDGER_SQL);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  const applied: string[] = [];
  for (const migration of migrations) {
    await client.query("begin");
    try {
      await client.query(LOCK);
      const status = await migrationStatus(client, migrations);
      if (status.pending.some((pending) => pending.name === migration.name)) {
        await client.query(migration.sql);
        await client.query("insert into app_migrations.applied (name, checksum) values ($1, $2)", [migration.name, migration.checksum]);
        applied.push(migration.name);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  return applied;
}
