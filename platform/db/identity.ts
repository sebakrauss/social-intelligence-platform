/**
 * Database-environment identity (Step H7-production-data-plane-guard). A runtime must prove that every database
 * connection it is handed belongs to the ONE Supabase project its deployment environment is authorized for — so a
 * production plane can never silently run against the development project (or the other way round), and one process
 * can never mix projects (MAIN: worker → one project, system → another).
 *
 * The stable identity is the Supabase project reference carried by the Supavisor username (`<role>.<project-ref>`,
 * see connection.ts) — not the host name, project name, region or NODE_ENV. The authority is explicit:
 *
 *   DATABASE_ENVIRONMENT_CLASS     closed: `development` | `production` (nothing else is accepted)
 *   DATABASE_EXPECTED_PROJECT_REF  the 20-character project reference every connection must carry
 *   DATABASE_EXPECTED_REGION       optional at runtime (the project ref is the identity); when set, every pooler
 *                                  connection's region must equal it
 *
 * Two-step rollout (no deployed plane holds these variables yet): when NONE of the three is set, the runtime is in
 * the LEGACY DEVELOPMENT mode and is pinned to social-intelligence-dev-v2 by the SHA-256 of its project reference
 * (the same committed digest as tools/db/dev-fixture-guard.ts) and its region — a remote connection to any other
 * project fails closed. Local test databases (no project identity) are accepted only in that mode. Any partial or
 * invalid authority fails closed; `production` naming the development project fails closed.
 *
 * Errors name variables only — never a URL, password, host or project reference.
 *
 * Imported by Node tooling directly, so this file uses relative imports and Node built-ins only.
 */
import { createHash } from "node:crypto";
import { ConnectionConfigError, parseDatabaseUrl, RUNTIME_KINDS, RUNTIME_URL_VARIABLES, type ConnectionTarget, type RuntimeKind } from "./connection.ts";

export const DATABASE_IDENTITY_VARIABLES = {
  environmentClass: "DATABASE_ENVIRONMENT_CLASS",
  expectedProjectRef: "DATABASE_EXPECTED_PROJECT_REF",
  expectedRegion: "DATABASE_EXPECTED_REGION",
} as const;

export const DATABASE_ENVIRONMENT_CLASSES = ["development", "production"] as const;
export type DatabaseEnvironmentClass = (typeof DATABASE_ENVIRONMENT_CLASSES)[number];

/** SHA-256 (UTF-8, lower-case hex) of the social-intelligence-dev-v2 project reference (pins it without committing it). */
export const DEVELOPMENT_PROJECT_REF_SHA256 = "ac912c45edafd1e4e2d517996e8825cccfe588d6eeee83183b95625ad5d14351";
/** The development project's region (South America / São Paulo). */
export const DEVELOPMENT_REGION = "sa-east-1";

const PROJECT_REF = /^[a-z0-9]{20}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;

export type DatabaseAuthority =
  | {
      readonly mode: "explicit";
      readonly environmentClass: DatabaseEnvironmentClass;
      readonly expectedProjectRef: string;
      readonly expectedRegion: string | undefined;
    }
  | {
      readonly mode: "legacy_development";
      readonly environmentClass: "development";
      readonly expectedProjectRefSha256: string;
      readonly expectedRegion: string;
    };

type Environment = Readonly<Record<string, string | undefined>>;

export const projectRefSha256 = (ref: string): string => createHash("sha256").update(ref, "utf8").digest("hex");
const value = (env: Environment, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
};

export function isDatabaseEnvironmentClass(raw: string): raw is DatabaseEnvironmentClass {
  return (DATABASE_ENVIRONMENT_CLASSES as readonly string[]).includes(raw);
}

/** The runtime's database authority from its environment. Throws ConnectionConfigError on a partial or invalid one. */
/** `developmentPin` is the committed digest; tests inject a synthetic project's digest (no real ref is ever committed). */
export function resolveDatabaseAuthority(env: Environment, developmentPin: string = DEVELOPMENT_PROJECT_REF_SHA256): DatabaseAuthority {
  const names = DATABASE_IDENTITY_VARIABLES;
  const environmentClass = value(env, names.environmentClass);
  const expectedProjectRef = value(env, names.expectedProjectRef);
  const expectedRegion = value(env, names.expectedRegion);
  if (environmentClass === undefined && expectedProjectRef === undefined && expectedRegion === undefined) {
    return { mode: "legacy_development", environmentClass: "development", expectedProjectRefSha256: developmentPin, expectedRegion: DEVELOPMENT_REGION };
  }
  if (environmentClass === undefined) throw new ConnectionConfigError(`${names.environmentClass} must be set when any database identity variable is set`);
  if (!isDatabaseEnvironmentClass(environmentClass)) throw new ConnectionConfigError(`${names.environmentClass} must be one of ${DATABASE_ENVIRONMENT_CLASSES.join(", ")}`);
  if (expectedProjectRef === undefined) throw new ConnectionConfigError(`${names.expectedProjectRef} is required for the ${environmentClass} database environment`);
  if (!PROJECT_REF.test(expectedProjectRef)) throw new ConnectionConfigError(`${names.expectedProjectRef} is not a project reference`);
  if (expectedRegion !== undefined && !REGION.test(expectedRegion)) throw new ConnectionConfigError(`${names.expectedRegion} is not a region identifier`);
  if (environmentClass === "production" && projectRefSha256(expectedProjectRef) === developmentPin) {
    throw new ConnectionConfigError(`${names.expectedProjectRef} names the development project in the production database environment`);
  }
  return { mode: "explicit", environmentClass, expectedProjectRef, expectedRegion };
}

/** Every reason `target` (read from `label`) does not belong to `authority` (empty = proven). */
export function databaseIdentityProblems(
  authority: DatabaseAuthority,
  target: ConnectionTarget,
  label: string,
  developmentPin: string = DEVELOPMENT_PROJECT_REF_SHA256,
): readonly string[] {
  if (target.endpoint === "local") {
    return authority.mode === "legacy_development" ? [] : [`${label} is a local database, which has no project identity (${authority.environmentClass} requires one)`];
  }
  if (target.projectRef === undefined || !PROJECT_REF.test(target.projectRef)) return [`${label} carries no recognizable project identity`];
  const problems: string[] = [];
  const projectMatches =
    authority.mode === "explicit" ? target.projectRef === authority.expectedProjectRef : projectRefSha256(target.projectRef) === authority.expectedProjectRefSha256;
  if (!projectMatches) problems.push(`${label} does not belong to the expected ${authority.environmentClass} database project`);
  if (authority.mode === "explicit" && authority.environmentClass === "production" && projectRefSha256(target.projectRef) === developmentPin) {
    problems.push(`${label} belongs to the development project`);
  }
  if (authority.expectedRegion !== undefined) {
    if (target.region === undefined) {
      if (target.endpoint !== "direct") problems.push(`${label} carries no region`);
    } else if (target.region !== authority.expectedRegion) problems.push(`${label} is not in the expected region`);
  }
  return problems;
}

/**
 * Validates EVERY runtime database URL configured in `env` (web, worker, system — whichever are present) against the
 * one authority and against each other, before any pool exists. Throws a non-sensitive ConnectionConfigError.
 */
export function assertRuntimeDatabaseIdentity(env: Environment, developmentPin: string = DEVELOPMENT_PROJECT_REF_SHA256): DatabaseAuthority {
  const authority = resolveDatabaseAuthority(env, developmentPin);
  const seen: { readonly kind: RuntimeKind; readonly identity: string }[] = [];
  for (const kind of RUNTIME_KINDS) {
    const label = RUNTIME_URL_VARIABLES[kind];
    const raw = env[label];
    if (raw === undefined || raw === "") continue;
    const target = parseDatabaseUrl(raw, label);
    const problems = databaseIdentityProblems(authority, target, label, developmentPin);
    if (problems.length > 0) throw new ConnectionConfigError(problems.join("; "));
    seen.push({ kind, identity: target.endpoint === "local" ? "local" : `ref:${target.projectRef ?? ""}` });
  }
  if (new Set(seen.map((entry) => entry.identity)).size > 1) {
    throw new ConnectionConfigError(`${seen.map((entry) => RUNTIME_URL_VARIABLES[entry.kind]).join(", ")} point at different database projects`);
  }
  return authority;
}
