/**
 * A database the isolation and persistence suites run against: the local disposable cluster or the managed
 * Supabase development project. Suites use runtime pools exactly as production does (the platform/db pool
 * factory, login roles, transaction pooler) and a separate privileged connection only for test bootstrap:
 * seeding synthetic rows, oracle reads, catalog introspection and row cleanup. Never role teardown (R8).
 */
import pg from "pg";
import { parseDatabaseUrl, type RuntimeKind } from "@/platform/db";
import { createRuntimeDatabase, type RuntimeDatabase } from "@/platform/db/pool";
import { tlsFor } from "@/platform/db/pool";

export interface DbTarget {
  readonly name: "local" | "managed";
  /** Migration-role URL: test bootstrap only, never handed to runtime pools. */
  readonly privilegedUrl: string;
  readonly runtimeUrls: Readonly<Record<RuntimeKind, string>>;
  readonly sslRootCert?: string | undefined;
}

export function privilegedPool(target: DbTarget, max = 2): pg.Pool {
  const parsed = parseDatabaseUrl(target.privilegedUrl, "privileged URL");
  const pool = new pg.Pool({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    ssl: tlsFor(parsed, target.sslRootCert),
    max,
    application_name: "test-bootstrap",
  });
  pool.on("error", () => undefined);
  return pool;
}

export function runtimeDatabase<K extends RuntimeKind>(target: DbTarget, kind: K, max = 1): RuntimeDatabase<K> {
  return createRuntimeDatabase(kind, target.runtimeUrls[kind], { max, sslRootCert: target.sslRootCert });
}
