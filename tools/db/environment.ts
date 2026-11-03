/**
 * Local configuration for database tooling. Reads the SELECTED target's git-ignored configuration into this process
 * only and verifies that every URL points at that target's one expected Supabase project — and NOT at the frozen
 * validation project from the TA-Q-29 spike. Prints names, endpoints and booleans only: never a URL, password, key or
 * full project reference.
 *
 * Targets (Step H7-production-data-plane-guard) — each has its OWN file and its own identity authority; there is no
 * fallback from one to the other:
 *   development  `.env.local` (merged over the process environment, as before) — pinned to social-intelligence-dev-v2
 *                by the SHA-256 of its project reference (platform/db/identity.ts) and its region sa-east-1
 *   production   `.env.database-production.local` ONLY (the process environment and `.env.local` are never read) — it
 *                must declare DATABASE_ENVIRONMENT_CLASS=production, DATABASE_EXPECTED_PROJECT_REF and
 *                DATABASE_EXPECTED_REGION; a missing file or value, or the development project, fails closed
 * The production file is deliberately NOT named `.env.production.local`: Next.js loads that file into every
 * `next build` / `next start`, which would hand production database credentials to a local web build.
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
import {
  DATABASE_IDENTITY_VARIABLES,
  DEVELOPMENT_PROJECT_REF_SHA256,
  DEVELOPMENT_REGION,
  projectRefSha256,
  type DatabaseEnvironmentClass,
} from "../../platform/db/identity.ts";
import { parseSslRootCertPem } from "../../platform/db/tls.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const EXPECTED_PROJECT_LABEL = "social-intelligence-dev-v2";
export const EXPECTED_REGION = DEVELOPMENT_REGION; // South America (São Paulo) — the development target's region

export const DATABASE_TARGETS = ["development", "production"] as const;
export type DatabaseTarget = (typeof DATABASE_TARGETS)[number];
/** Each target's own git-ignored configuration file (relative to the repository root). */
export const TARGET_CONFIG_FILES = { development: ".env.local", production: ".env.database-production.local" } as const satisfies Record<DatabaseTarget, string>;
/** The only role a migration / provisioning connection may use (Supabase's project owner login). */
export const MIGRATION_ROLES: readonly string[] = Object.freeze(["postgres"]);

/** Variable names this tooling reads. Values are never printed. */
export const VARIABLES = {
  migration: "DATABASE_MIGRATION_URL",
  projectRef: "SUPABASE_PROJECT_REF",
  sslRootCert: "DATABASE_SSL_ROOT_CERT",
  ...RUNTIME_URL_VARIABLES,
} as const;

export type Environment = Readonly<Record<string, string | undefined>>;

/** `.env.local` merged over the process environment (the file wins), without mutating process.env. Development only. */
export function loadEnvironment(): Environment {
  return loadTargetEnvironment("development").env;
}

export interface TargetEnvironment {
  readonly target: DatabaseTarget;
  /** The configuration file name (relative), for messages. */
  readonly source: string;
  readonly found: boolean;
  readonly env: Environment;
}

/**
 * The selected target's configuration. Development: `.env.local` over the process environment. Production: its own
 * file and NOTHING else — never the process environment, never `.env.local` — so no development credential can stand
 * in for a missing production one.
 */
export function loadTargetEnvironment(
  target: DatabaseTarget,
  options: { readonly root?: string; readonly processEnv?: Environment } = {},
): TargetEnvironment {
  const source = TARGET_CONFIG_FILES[target];
  const file = path.join(options.root ?? ROOT, source);
  const found = existsSync(file);
  const values: Environment = found ? parseEnv(readFileSync(file, "utf8")) : {};
  const env = target === "development" ? { ...(options.processEnv ?? process.env), ...values } : { ...values };
  return { target, source, found, env };
}

/** Exactly one `--target development|production` among the arguments (any other argument is the caller's). */
export function parseTargetArgument(args: readonly string[]): { readonly target: DatabaseTarget } | { readonly error: string } {
  const required = `--target ${DATABASE_TARGETS.join("|")} is required`;
  const positions = args.flatMap((arg, index) => (arg === "--target" || arg.startsWith("--target=") ? [index] : []));
  if (positions.length === 0) return { error: required };
  if (positions.length > 1) return { error: "--target was given more than once" };
  const index = positions[0] ?? 0;
  const arg = args[index] ?? "";
  const raw = arg === "--target" ? args[index + 1] : arg.slice("--target=".length);
  if (raw === undefined || raw === "" || raw.startsWith("--")) return { error: required };
  if (!(DATABASE_TARGETS as readonly string[]).includes(raw)) return { error: `--target must be one of ${DATABASE_TARGETS.join(", ")}` };
  return { target: raw as DatabaseTarget };
}

/** The identity a target's configuration must prove before anything connects. */
export interface TargetAuthority {
  readonly target: DatabaseTarget;
  readonly label: string;
  readonly environmentClass: DatabaseEnvironmentClass;
  readonly expectedProjectRef: string | undefined;
  readonly expectedRegion: string | undefined;
  /** Why the authority itself is incomplete or unsafe (empty = complete). */
  readonly problems: readonly string[];
}

const PROJECT_REF_FORMAT = /^[a-z0-9]{20}$/;
const REGION_FORMAT = /^[a-z]{2}-[a-z]+-\d$/;
const configured = (env: Environment, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
};

/**
 * The selected target's authority. Development: the configured SUPABASE_PROJECT_REF, which must be the PINNED
 * social-intelligence-dev-v2 project, in sa-east-1. Production: DATABASE_ENVIRONMENT_CLASS=production plus an explicit
 * DATABASE_EXPECTED_PROJECT_REF and DATABASE_EXPECTED_REGION, never the development or frozen validation project.
 */
export function resolveTargetAuthority(target: DatabaseTarget, env: Environment, developmentPin: string = DEVELOPMENT_PROJECT_REF_SHA256): TargetAuthority {
  const names = DATABASE_IDENTITY_VARIABLES;
  const problems: string[] = [];
  const declaredClass = configured(env, names.environmentClass);
  const frozen = frozenProjectRef();
  if (target === "development") {
    const ref = configured(env, VARIABLES.projectRef);
    if (ref === undefined || !PROJECT_REF_FORMAT.test(ref)) problems.push(`${VARIABLES.projectRef} must hold the development project's reference`);
    else if (projectRefSha256(ref) !== developmentPin) problems.push(`${VARIABLES.projectRef} is not the pinned ${EXPECTED_PROJECT_LABEL} project`);
    if (declaredClass !== undefined && declaredClass !== "development") problems.push(`${names.environmentClass} is not development in the development configuration`);
    const declaredRef = configured(env, names.expectedProjectRef);
    if (declaredRef !== undefined && declaredRef !== ref) problems.push(`${names.expectedProjectRef} disagrees with ${VARIABLES.projectRef}`);
    const declaredRegion = configured(env, names.expectedRegion);
    if (declaredRegion !== undefined && declaredRegion !== DEVELOPMENT_REGION) problems.push(`${names.expectedRegion} is not the development region`);
    return { target, label: EXPECTED_PROJECT_LABEL, environmentClass: "development", expectedProjectRef: ref, expectedRegion: DEVELOPMENT_REGION, problems };
  }
  if (declaredClass !== "production") problems.push(`${names.environmentClass} must be production in ${TARGET_CONFIG_FILES.production}`);
  const ref = configured(env, names.expectedProjectRef);
  if (ref === undefined) problems.push(`${names.expectedProjectRef} is not configured`);
  else if (!PROJECT_REF_FORMAT.test(ref)) problems.push(`${names.expectedProjectRef} is not a project reference`);
  else {
    if (projectRefSha256(ref) === developmentPin) problems.push(`${names.expectedProjectRef} names the development project — refusing`);
    if (frozen !== undefined && ref === frozen) problems.push(`${names.expectedProjectRef} names the FROZEN validation project — refusing`);
  }
  const region = configured(env, names.expectedRegion);
  if (region === undefined) problems.push(`${names.expectedRegion} is not configured (the production region is an operator decision)`);
  else if (!REGION_FORMAT.test(region)) problems.push(`${names.expectedRegion} is not a region identifier`);
  const toolingRef = configured(env, VARIABLES.projectRef);
  if (toolingRef !== undefined && toolingRef !== ref) problems.push(`${VARIABLES.projectRef} disagrees with ${names.expectedProjectRef}`);
  return {
    target,
    label: "production",
    environmentClass: "production",
    expectedProjectRef: ref !== undefined && PROJECT_REF_FORMAT.test(ref) ? ref : undefined,
    expectedRegion: region !== undefined && REGION_FORMAT.test(region) ? region : undefined,
    problems,
  };
}

export function readCa(env: Environment, root: string = ROOT): string | undefined {
  const file = env[VARIABLES.sslRootCert];
  if (file === undefined || file === "") return undefined;
  return readFileSync(path.resolve(root, file), "utf8");
}

/** The configured CA bundle, validated by the runtime's strict PEM parser; a non-sensitive problem otherwise. */
export function checkCa(env: Environment, root: string = ROOT): { readonly ca: string } | { readonly problem: string } {
  let content: string | undefined;
  try {
    content = readCa(env, root);
  } catch {
    return { problem: `${VARIABLES.sslRootCert} can't be read` };
  }
  if (content === undefined) return { problem: `${VARIABLES.sslRootCert} must point to the project's CA certificate` };
  try {
    return { ca: parseSslRootCertPem(content) };
  } catch {
    return { problem: `${VARIABLES.sslRootCert} is not a PEM CA certificate bundle` };
  }
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
 * Verifies the configuration without connecting. `need` selects which URLs must be present; `authority` is the
 * selected target's (development by default, for the development-only tools). Fails if the authority is incomplete,
 * if any URL is not on the authority's expected project or region, if the migration URL doesn't use the migration
 * role, if a URL matches the frozen project, or if a URL uses the wrong endpoint class. Production additionally
 * refuses local databases and any URL whose region can't be verified (the migration URL must use the session pooler).
 */
export function checkTarget(
  env: Environment,
  need: { readonly migration: boolean; readonly runtime: readonly RuntimeKind[] },
  authority: TargetAuthority = resolveTargetAuthority("development", env),
  developmentPin: string = DEVELOPMENT_PROJECT_REF_SHA256,
): TargetReport {
  const lines: string[] = [];
  const problems: string[] = [...authority.problems];
  const runtime: Partial<Record<RuntimeKind, ConnectionTarget>> = {};
  let migration: ConnectionTarget | undefined;
  const production = authority.target === "production";

  for (const name of [...Object.values(VARIABLES), ...Object.values(DATABASE_IDENTITY_VARIABLES)]) {
    lines.push(`  ${name.padEnd(24)} ${env[name] !== undefined && env[name] !== "" ? "present" : "absent"}`);
  }
  lines.push(`  target                   ${authority.target} (${authority.label}) class=${authority.environmentClass} region=${authority.expectedRegion ?? "unset"} ref=${mask(authority.expectedProjectRef)}`);

  const expected = authority.expectedProjectRef;
  const frozen = frozenProjectRef();
  if (frozen !== undefined && frozen === expected) problems.push("the expected project is the FROZEN validation project — refusing");

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
        if (expected === undefined || target.projectRef !== expected) problems.push(`${label} does not point at the expected ${authority.environmentClass} project`);
        if (frozen !== undefined && target.projectRef === frozen) problems.push(`${label} points at the FROZEN validation project — refusing`);
        if (production && target.projectRef !== undefined && projectRefSha256(target.projectRef) === developmentPin) problems.push(`${label} points at the development project — refusing`);
        if (target.region === undefined) {
          if (production) problems.push(`${label} carries no verifiable region`);
        } else if (authority.expectedRegion === undefined || target.region !== authority.expectedRegion) {
          problems.push(`${label} is not in ${authority.expectedRegion ?? "the expected region (unset)"}`);
        }
      }
      return target;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${label} is invalid`);
      return undefined;
    }
  };

  if (need.migration) {
    migration = consider(VARIABLES.migration, env[VARIABLES.migration], production ? ["session_pooler"] : ["direct", "session_pooler", "local"]);
    if (migration !== undefined && !MIGRATION_ROLES.includes(migration.role)) problems.push(`${VARIABLES.migration} must use the migration role (${MIGRATION_ROLES.join(", ")})`);
  }
  for (const kind of need.runtime) {
    const target = consider(RUNTIME_URL_VARIABLES[kind], env[RUNTIME_URL_VARIABLES[kind]], production ? ["transaction_pooler"] : ["transaction_pooler", "local"]);
    if (target !== undefined) runtime[kind] = target;
  }
  const remote = [migration, ...Object.values(runtime)].some((target) => target !== undefined && target.endpoint !== "local");
  if (remote && (env[VARIABLES.sslRootCert] ?? "") === "") problems.push(`${VARIABLES.sslRootCert} must point to the project's CA certificate`);

  const differs = frozen === undefined || expected === undefined ? "n/a" : String(frozen !== expected);
  lines.push(`  frozen validation project config ${frozen === undefined ? "not found (comparison skipped)" : "found"}; expected ref differs from frozen: ${differs}`);
  for (const problem of problems) lines.push(`  PROBLEM: ${problem}`);
  return { ok: problems.length === 0, lines, ...(migration === undefined ? {} : { migration }), runtime };
}

export interface TargetFence {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly target?: DatabaseTarget;
  readonly env: Environment;
  readonly report?: TargetReport;
  /** The validated CA bundle (when every check passed and a managed endpoint is configured). */
  readonly ca?: string;
}

/**
 * The fence every target-aware tool (migrate, provision-roles, preflight) passes BEFORE it creates any client:
 * explicit `--target`, that target's own configuration file, a complete identity authority, every URL on the expected
 * project and region with the right endpoint and role, and a CA the runtime's strict parser accepts. Nothing here
 * connects; TLS is then verified (rejectUnauthorized) by the connection itself.
 */
export function prepareTarget(
  args: readonly string[],
  need: { readonly migration: boolean; readonly runtime: readonly RuntimeKind[] | "configured" },
  options: { readonly root?: string; readonly processEnv?: Environment; readonly developmentPin?: string } = {},
): TargetFence {
  const parsed = parseTargetArgument(args);
  if ("error" in parsed) return { ok: false, lines: [`  PROBLEM: ${parsed.error}`], env: {} };
  const loaded = loadTargetEnvironment(parsed.target, options);
  const lines: string[] = [`  configuration            ${loaded.source} ${loaded.found ? "found" : "NOT FOUND"}`];
  if (!loaded.found && parsed.target === "production") {
    lines.push(`  PROBLEM: ${loaded.source} is missing (production never falls back to the development configuration)`);
    return { ok: false, lines, target: parsed.target, env: loaded.env };
  }
  const runtime = need.runtime === "configured" ? RUNTIME_KINDS.filter((kind) => (loaded.env[RUNTIME_URL_VARIABLES[kind]] ?? "") !== "") : need.runtime;
  const pin = options.developmentPin ?? DEVELOPMENT_PROJECT_REF_SHA256;
  const report = checkTarget(loaded.env, { migration: need.migration, runtime }, resolveTargetAuthority(parsed.target, loaded.env, pin), pin);
  lines.push(...report.lines);
  if (!report.ok) return { ok: false, lines, target: parsed.target, env: loaded.env, report };
  const managed = [report.migration, ...Object.values(report.runtime)].some((target) => target !== undefined && target.endpoint !== "local");
  if (!managed) return { ok: true, lines, target: parsed.target, env: loaded.env, report };
  const ca = checkCa(loaded.env, options.root ?? ROOT);
  if ("problem" in ca) {
    lines.push(`  PROBLEM: ${ca.problem}`);
    return { ok: false, lines, target: parsed.target, env: loaded.env, report };
  }
  lines.push(`  ${VARIABLES.sslRootCert.padEnd(24)} PEM bundle valid (runtime parser)`);
  return { ok: true, lines, target: parsed.target, env: loaded.env, report, ca: ca.ca };
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
