/**
 * The only place application runtime connection pools are created (TA §9.3). Each pool belongs to one
 * runtime kind and connects as that kind's dedicated login role; pool creation refuses privileged or
 * mismatched credentials. Module and UI code never construct database clients.
 */
import { readFileSync } from "node:fs";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { assertRuntimeTarget, ConnectionConfigError, parseDatabaseUrl, RUNTIME_URL_VARIABLES, type ConnectionTarget, type RuntimeKind } from "./connection";

export interface RuntimeDatabase<K extends RuntimeKind = RuntimeKind> {
  readonly kind: K;
  readonly db: NodePgDatabase;
  /** Exposed for diagnostics and tests (backend reuse); application code uses scope helpers only. */
  readonly pool: pg.Pool;
  end(): Promise<void>;
}

export interface RuntimePoolOptions {
  /** Maximum pooled connections. Serverless web instances keep this small. */
  readonly max?: number | undefined;
  /** PEM CA bundle for the managed endpoint; required for any non-local host. */
  readonly sslRootCert?: string | undefined;
}

/** TLS for managed endpoints always verifies the server certificate against the configured CA. */
export function tlsFor(target: ConnectionTarget, sslRootCert: string | undefined): pg.ClientConfig["ssl"] {
  if (target.endpoint === "local") return false;
  if (sslRootCert === undefined || sslRootCert === "") {
    throw new ConnectionConfigError("DATABASE_SSL_ROOT_CERT must point to the project's CA certificate for managed connections");
  }
  return { ca: sslRootCert, rejectUnauthorized: true };
}

export function readSslRootCert(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ConnectionConfigError("DATABASE_SSL_ROOT_CERT can't be read");
  }
}

/** Creates the pool for one runtime from its URL. Throws (without echoing secrets) on any guard failure. */
export function createRuntimeDatabase<K extends RuntimeKind>(kind: K, url: string | undefined, options: RuntimePoolOptions = {}): RuntimeDatabase<K> {
  const target = parseDatabaseUrl(url, RUNTIME_URL_VARIABLES[kind]);
  assertRuntimeTarget(kind, target);
  const pool = new pg.Pool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: tlsFor(target, options.sslRootCert),
    max: options.max ?? 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: `app-${kind}`,
  });
  // A broken idle connection must not crash the process; the next checkout simply reconnects.
  pool.on("error", () => undefined);
  return { kind, db: drizzle(pool), pool, end: () => pool.end() };
}

/** Runtime configuration comes only from the runtime's own variable; never the migration URL. */
export function createRuntimeDatabaseFromEnv<K extends RuntimeKind>(
  kind: K,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Omit<RuntimePoolOptions, "sslRootCert"> = {},
): RuntimeDatabase<K> {
  return createRuntimeDatabase(kind, env[RUNTIME_URL_VARIABLES[kind]], {
    ...options,
    sslRootCert: readSslRootCert(env["DATABASE_SSL_ROOT_CERT"]),
  });
}
