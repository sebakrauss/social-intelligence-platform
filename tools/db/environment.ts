/**
 * Local configuration for database tooling. Reads `.env.local` (git-ignored) into this process only and
 * verifies that every URL points at the same, expected Supabase development project — and NOT at the
 * frozen validation project from the TA-Q-29 spike. Prints names, endpoints and booleans only: never a
 * URL, password, key or full project reference.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import {
  RUNTIME_KINDS,
  RUNTIME_URL_VARIABLES,
  parseDatabaseUrl,
  type ConnectionTarget,
  type RuntimeKind,
} from "../../platform/db/connection.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const EXPECTED_PROJECT_LABEL = "social-intelligence-dev-v2";
export const EXPECTED_REGION = "sa-east-1"; // South America (São Paulo)

/** Variable names this tooling reads. Values are never printed. */
export const VARIABLES = {
  migration: "DATABASE_MIGRATION_URL",
  projectRef: "SUPABASE_PROJECT_REF",
  sslRootCert: "DATABASE_SSL_ROOT_CERT",
  ...RUNTIME_URL_VARIABLES,
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;

/** `.env.local` merged over the process environment (the file wins), without mutating process.env. */
export function loadEnvironment(): Environment {
  const file = path.join(ROOT, ".env.local");
  const local = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  return { ...process.env, ...local };
}

export function readCa(env: Environment): string | undefined {
  const file = env[VARIABLES.sslRootCert];
  if (file === undefined || file === "") return undefined;
  return readFileSync(path.resolve(ROOT, file), "utf8");
}

export interface TargetReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly migration?: ConnectionTarget;
  readonly runtime: Partial<Record<RuntimeKind, ConnectionTarget>>;
}

const mask = (ref: string | undefined): string => (ref === undefined ? "none" : `${ref.slice(0, 4)}…`);

/** The ref of the frozen TA-Q-29 validation project, if its git-ignored spike config is still present. */
function frozenProjectRef(): string | undefined {
  const file = path.join(ROOT, "spikes/ta-q-29-rls/.env.local");
  if (!existsSync(file)) return undefined;
  const value = parseEnv(readFileSync(file, "utf8"))["SUPABASE_PROJECT_REF"];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Verifies the configuration without connecting. `need` selects which URLs must be present.
 * Fails if refs disagree, don't match SUPABASE_PROJECT_REF, match the frozen project, or point at the
 * wrong endpoint class or region.
 */
export function checkTarget(env: Environment, need: { readonly migration: boolean; readonly runtime: readonly RuntimeKind[] }): TargetReport {
  const lines: string[] = [];
  const problems: string[] = [];
  const runtime: Partial<Record<RuntimeKind, ConnectionTarget>> = {};
  let migration: ConnectionTarget | undefined;

  for (const name of Object.values(VARIABLES)) {
    lines.push(`  ${name.padEnd(24)} ${env[name] !== undefined && env[name] !== "" ? "present" : "absent"}`);
  }

  const expected = env[VARIABLES.projectRef];
  if (expected === undefined || !/^[a-z0-9]{20}$/.test(expected)) problems.push(`${VARIABLES.projectRef} must hold the new project's reference`);
  const frozen = frozenProjectRef();
  if (frozen !== undefined && frozen === expected) problems.push("SUPABASE_PROJECT_REF is the FROZEN validation project — refusing");

  const consider = (label: string, value: string | undefined, allowed: readonly string[]): ConnectionTarget | undefined => {
    if (value === undefined || value === "") {
      problems.push(`${label} is absent`);
      return undefined;
    }
    try {
      const target = parseDatabaseUrl(value, label);
      lines.push(`  ${label.padEnd(24)} role=${target.role} endpoint=${target.endpoint} region=${target.region ?? "n/a"} ref=${mask(target.projectRef)}`);
      if (!allowed.includes(target.endpoint)) problems.push(`${label} must use ${allowed.join(" or ")}`);
      if (target.endpoint !== "local") {
        if (target.projectRef !== expected) problems.push(`${label} does not point at SUPABASE_PROJECT_REF`);
        if (frozen !== undefined && target.projectRef === frozen) problems.push(`${label} points at the FROZEN validation project — refusing`);
        if (target.region !== undefined && target.region !== EXPECTED_REGION) problems.push(`${label} is not in ${EXPECTED_REGION}`);
      }
      return target;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${label} is invalid`);
      return undefined;
    }
  };

  if (need.migration) migration = consider(VARIABLES.migration, env[VARIABLES.migration], ["direct", "session_pooler", "local"]);
  for (const kind of need.runtime) {
    const target = consider(RUNTIME_URL_VARIABLES[kind], env[RUNTIME_URL_VARIABLES[kind]], ["transaction_pooler", "local"]);
    if (target !== undefined) runtime[kind] = target;
  }
  const remote = [migration, ...Object.values(runtime)].some((target) => target !== undefined && target.endpoint !== "local");
  if (remote && (env[VARIABLES.sslRootCert] ?? "") === "") problems.push(`${VARIABLES.sslRootCert} must point to the project's CA certificate`);

  const differs = frozen === undefined || expected === undefined ? "n/a" : String(frozen !== expected);
  lines.push(`  frozen validation project config ${frozen === undefined ? "not found (comparison skipped)" : "found"}; new ref differs from frozen: ${differs}`);
  for (const problem of problems) lines.push(`  PROBLEM: ${problem}`);
  return { ok: problems.length === 0, lines, ...(migration === undefined ? {} : { migration }), runtime };
}

/** A privileged client for migrations/provisioning (direct or session pooler only). */
export function privilegedClient(target: ConnectionTarget, ca: string | undefined): pg.Client {
  return new pg.Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: target.endpoint === "local" ? false : { ca, rejectUnauthorized: true },
    application_name: "db-tooling",
  });
}

export function runtimePasswords(env: Environment): Partial<Record<RuntimeKind, string>> {
  const passwords: Partial<Record<RuntimeKind, string>> = {};
  for (const kind of RUNTIME_KINDS) {
    const value = env[RUNTIME_URL_VARIABLES[kind]];
    if (value !== undefined && value !== "") passwords[kind] = parseDatabaseUrl(value, RUNTIME_URL_VARIABLES[kind]).password;
  }
  return passwords;
}
