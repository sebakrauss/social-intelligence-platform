import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { postgresError, type DatabaseTransaction } from "@/platform/db";

/** Awaits a rejection and returns its SQLSTATE (and constraint), failing the test if it resolved. */
export async function sqlState(promise: Promise<unknown>): Promise<{ code: string; constraint: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    const pgError = postgresError(error);
    if (pgError === undefined) throw error;
    return pgError;
  }
  expect.unreachable("expected the statement to be refused");
}

export async function count(tx: DatabaseTransaction, table: string, where = sql`true`): Promise<number> {
  const result = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(table)} where ${where}`);
  return result.rows[0]?.n ?? -1;
}

export async function scalar<T>(tx: DatabaseTransaction, query: ReturnType<typeof sql>): Promise<T> {
  const result = await tx.execute<{ value: T }>(query);
  return result.rows[0]?.value as T;
}

export const backendPid = (tx: DatabaseTransaction): Promise<number> => scalar<number>(tx, sql`select pg_backend_pid() as value`);

/** Settings that must be empty at the start of every transaction (context never survives). */
export async function leftoverContext(tx: DatabaseTransaction): Promise<{ workspace: string | null; claims: string | null; role: string }> {
  const result = await tx.execute<{ workspace: string | null; claims: string | null; role: string }>(sql`select
    nullif(current_setting('app.workspace_id', true), '') as workspace,
    nullif(current_setting('request.jwt.claims', true), '') as claims,
    current_user::text as role`);
  const row = result.rows[0];
  if (row === undefined) throw new Error("no row");
  return row;
}
