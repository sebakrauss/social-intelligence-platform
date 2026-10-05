/**
 * Database connection targets and their guards (TA §9.3, §11.5, §11.6 R1; CLAUDE.md §5).
 *
 * Three access classes exist, and each may only use its own credential:
 *   - migration/provisioning — privileged; local tooling and CI only; never application runtime;
 *   - web / worker / system runtime — a dedicated long-lived login role through the Supavisor
 *     TRANSACTION pooler (or a local test database), never `postgres`, `service_role` or any admin role.
 *
 * URLs are parsed here and only host, port, database, user and password are kept: query parameters
 * (e.g. `options=-c role=…`) can't smuggle session state into a connection. Errors never echo the URL.
 *
 * Imported by Node tooling directly, so this file uses relative imports and Node built-ins only.
 */

export const RUNTIME_KINDS = ["web", "worker", "system"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** R1: one dedicated, long-lived login role per runtime. */
export const RUNTIME_LOGIN_ROLES = { web: "web_login", worker: "worker_login", system: "system_login" } as const satisfies Record<RuntimeKind, string>;

/** R3: the only role each login may switch to (by fixed literal, in the scope helpers). */
export const RUNTIME_TARGET_ROLES = { web: "authenticated", worker: "app_worker", system: "app_system" } as const satisfies Record<RuntimeKind, string>;

/** Environment variable per access class. The migration URL is read only by tools/db. */
export const RUNTIME_URL_VARIABLES = {
  web: "DATABASE_WEB_URL",
  worker: "DATABASE_WORKER_URL",
  system: "DATABASE_SYSTEM_URL",
} as const satisfies Record<RuntimeKind, string>;

/** Roles a runtime connection may never use (they bypass RLS, administer the project, or own objects). */
export const PRIVILEGED_ROLES: readonly string[] = [
  "postgres",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_replication_admin",
  "supabase_read_only_user",
  "supabase_realtime_admin",
  "service_role",
  "authenticator",
  "authenticated",
  "anon",
  "dashboard_user",
  "pgbouncer",
  "app_owner",
  "app_worker",
  "app_system",
];

export type Endpoint = "local" | "direct" | "session_pooler" | "transaction_pooler" | "other";

export interface ConnectionTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Username exactly as sent (pooler usernames are `<role>.<project-ref>`). */
  readonly user: string;
  /** The database role name (the part before `.<project-ref>` on the pooler). */
  readonly role: string;
  readonly password: string;
  readonly endpoint: Endpoint;
  readonly projectRef: string | undefined;
  readonly region: string | undefined;
}

export class ConnectionConfigError extends Error {
  override readonly name = "ConnectionConfigError";
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const POOLER_HOST = /^aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com$/;
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;

/** Parses a PostgreSQL URL into a validated target. Never includes the URL or password in errors. */
export function parseDatabaseUrl(value: unknown, label: string): ConnectionTarget {
  if (typeof value !== "string" || value.trim() === "") throw new ConnectionConfigError(`${label} is not set`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConnectionConfigError(`${label} is not a valid URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new ConnectionConfigError(`${label} must be a postgres:// URL`);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port === "" ? 5432 : Number(url.port);
  const user = decodeURIComponent(url.username);
  // The dashboard template wraps the password placeholder in [ ]; tolerate it in memory only.
  const password = decodeURIComponent(url.password).replace(/^\[(.*)\]$/, "$1");
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  if (host === "" || user === "" || password === "" || !Number.isInteger(port)) {
    throw new ConnectionConfigError(`${label} must include host, user and password`);
  }

  const pooler = POOLER_HOST.exec(host);
  const direct = DIRECT_HOST.exec(host);
  let endpoint: Endpoint = "other";
  let role = user;
  let projectRef: string | undefined;
  if (LOCAL_HOSTS.has(host)) endpoint = "local";
  else if (pooler !== null) {
    endpoint = port === 6543 ? "transaction_pooler" : "session_pooler";
    const dot = user.lastIndexOf(".");
    if (dot > 0 && PROJECT_REF.test(user.slice(dot + 1))) {
      role = user.slice(0, dot);
      projectRef = user.slice(dot + 1);
    }
  } else if (direct !== null) {
    endpoint = "direct";
    projectRef = direct[1];
  }
  return { host, port, database, user, role, password, endpoint, projectRef, region: pooler?.[1] };
}

/**
 * A runtime connection must use exactly its dedicated login role, through the transaction pooler
 * (or a local test database). Anything else — a privileged role, another runtime's login, the session
 * pooler or the direct endpoint — is refused before any connection is attempted.
 */
export function assertRuntimeTarget(kind: RuntimeKind, target: ConnectionTarget): void {
  const expected = RUNTIME_LOGIN_ROLES[kind];
  if (PRIVILEGED_ROLES.includes(target.role)) {
    throw new ConnectionConfigError(`${RUNTIME_URL_VARIABLES[kind]} uses a privileged role; runtime must use ${expected}`);
  }
  if (target.role !== expected) {
    throw new ConnectionConfigError(`${RUNTIME_URL_VARIABLES[kind]} must use the ${expected} login role`);
  }
  if (target.endpoint !== "transaction_pooler" && target.endpoint !== "local") {
    throw new ConnectionConfigError(`${RUNTIME_URL_VARIABLES[kind]} must use the Supavisor transaction pooler (port 6543)`);
  }
}
