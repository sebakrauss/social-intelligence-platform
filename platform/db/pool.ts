/**
 * The only place application runtime connection pools are created (TA §9.3). Each pool belongs to one
 * runtime kind and connects as that kind's dedicated login role; pool creation refuses privileged or
 * mismatched credentials. Module and UI code never construct database clients.
 *
 * TLS to a managed endpoint always verifies the server certificate (and host name, Node's default) against the
 * project's CA, which a runtime receives in one of two forms:
 *   DATABASE_SSL_ROOT_CERT_PEM   the PEM certificate CONTENT (deployed workers: an environment secret, never a file)
 *   DATABASE_SSL_ROOT_CERT       a filesystem PATH to the PEM file (local development: the git-ignored .local-certs/)
 * Precedence is deterministic: when the PEM content is set it is used and the path is ignored (not even read).
 * Neither set → no CA → any managed connection is refused (fail closed). The CA content is passed to the driver in
 * memory; it is never logged, written to disk, or included in an error message.
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
    throw new ConnectionConfigError(
      `${SSL_ROOT_CERT_VARIABLES.pem} or ${SSL_ROOT_CERT_VARIABLES.path} must provide the project's CA certificate for managed connections`,
    );
  }
  return { ca: sslRootCert, rejectUnauthorized: true };
}

/** The two ways a runtime receives the managed database's CA certificate (see the header for precedence). */
export const SSL_ROOT_CERT_VARIABLES = { pem: "DATABASE_SSL_ROOT_CERT_PEM", path: "DATABASE_SSL_ROOT_CERT" } as const;

const PEM_MAX_LENGTH = 65_536;
const PEM_MAX_CERTIFICATES = 10;
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\n((?:[A-Za-z0-9+/]{1,76}\n)*[A-Za-z0-9+/]{1,76}={0,2}\n)-----END CERTIFICATE-----$/;

/**
 * Strict PEM CA content: one or more `CERTIFICATE` blocks of base64 lines, nothing else (no keys, no headers, no
 * other text). Real newlines (LF or CRLF) are accepted; so are literal `\n` escapes, but only when the value holds
 * no real newline at all (single-line environment-variable tooling). Returns the normalized bundle; throws a
 * non-sensitive ConnectionConfigError otherwise (the value is never echoed).
 */
export function parseSslRootCertPem(value: string): string {
  const invalid = (): never => {
    throw new ConnectionConfigError(`${SSL_ROOT_CERT_VARIABLES.pem} is not a PEM CA certificate bundle`);
  };
  if (value.length > PEM_MAX_LENGTH) invalid();
  const unescaped = /\r?\n/.test(value) ? value : value.replaceAll("\\n", "\n");
  const text = unescaped.replaceAll("\r\n", "\n").trim();
  const blocks = text.split(/(?<=-----END CERTIFICATE-----)\n*/).filter((block) => block !== "");
  if (blocks.length === 0 || blocks.length > PEM_MAX_CERTIFICATES) invalid();
  for (const block of blocks) {
    if (!PEM_CERTIFICATE.test(block)) invalid();
  }
  return `${blocks.join("\n")}\n`;
}

/**
 * The CA certificate content for this runtime's environment, or undefined when none is configured (a managed
 * connection then fails closed in tlsFor). PEM content wins over a path; an invalid PEM or unreadable path throws.
 */
export function resolveSslRootCert(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const pem = env[SSL_ROOT_CERT_VARIABLES.pem];
  if (pem !== undefined && pem !== "") return parseSslRootCertPem(pem);
  return readSslRootCert(env[SSL_ROOT_CERT_VARIABLES.path]);
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
    sslRootCert: resolveSslRootCert(env),
  });
}

/**
 * Connectivity probe for health checks (TA-11A): one round trip on the runtime's own pool, as its login role,
 * through the same pooler and TLS settings as every query. `select 1` reads no table; the login roles hold no
 * table privileges of their own, so the probe can't see tenant data and doesn't need (or bypass) RLS.
 */
export async function pingDatabase(database: RuntimeDatabase): Promise<void> {
  await database.pool.query("select 1");
}
