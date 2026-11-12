/**
 * The validation operator's database identity fence (Step 7B-14I2), checked BEFORE any connection. Development only:
 * the pinned social-intelligence-dev-v2 authority (the database tooling's own), and ONE connection URL —
 * DATABASE_VALIDATION_OPERATOR_URL in `.env.local` — whose login must be a dedicated validation_operator_<handle> login
 * (never the migration role), on the expected project and region, with the strict CA for a managed endpoint. The URL,
 * its password and the project reference are never printed (role, endpoint, region and a masked reference only).
 */
import pg from "pg";
import { parseDatabaseUrl, type ConnectionTarget } from "../../platform/db/connection.ts";
import { checkCa, MIGRATION_ROLES, resolveTargetAuthority, type Environment } from "./environment.ts";

/** A dedicated validation operator login (0029): never the migration role, never a runtime login. */
export const OPERATOR_LOGIN = /^validation_operator_[a-z0-9_]{2,40}$/;

export const VALIDATION_OPERATOR_URL = "DATABASE_VALIDATION_OPERATOR_URL";

export interface ValidationOperatorFence {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly target?: ConnectionTarget;
}

const mask = (ref: string | undefined): string => (ref === undefined ? "none" : `${ref.slice(0, 4)}…`);

/** Verifies the configuration without connecting. */
export function checkValidationOperatorTarget(env: Environment, developmentPin?: string): ValidationOperatorFence {
  const authority = developmentPin === undefined ? resolveTargetAuthority("development", env) : resolveTargetAuthority("development", env, developmentPin);
  const problems: string[] = [...authority.problems];
  const lines: string[] = [`  target                   development (${authority.label}) region=${authority.expectedRegion ?? "unset"} ref=${mask(authority.expectedProjectRef)}`];
  const raw = env[VALIDATION_OPERATOR_URL];
  let target: ConnectionTarget | undefined;
  if (raw === undefined || raw.trim() === "") {
    problems.push(`${VALIDATION_OPERATOR_URL} is absent (a dedicated validation operator login is provisioned by a separately authorized gate)`);
  } else {
    try {
      target = parseDatabaseUrl(raw, VALIDATION_OPERATOR_URL);
      lines.push(`  ${VALIDATION_OPERATOR_URL.padEnd(24)} role=${target.role} endpoint=${target.endpoint} region=${target.region ?? "n/a"} ref=${mask(target.projectRef)}`);
      if (MIGRATION_ROLES.includes(target.role) || !OPERATOR_LOGIN.test(target.role)) problems.push(`${VALIDATION_OPERATOR_URL} must use a validation_operator_<handle> login (never the migration role)`);
      if (!["direct", "session_pooler", "local"].includes(target.endpoint)) problems.push(`${VALIDATION_OPERATOR_URL} must use the direct or session pooler endpoint`);
      if (target.endpoint !== "local") {
        if (authority.expectedProjectRef === undefined || target.projectRef !== authority.expectedProjectRef) problems.push(`${VALIDATION_OPERATOR_URL} does not point at the pinned development project`);
        if (target.region !== undefined && target.region !== authority.expectedRegion) problems.push(`${VALIDATION_OPERATOR_URL} is not in ${authority.expectedRegion ?? "the expected region"}`);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${VALIDATION_OPERATOR_URL} is invalid`);
    }
  }
  for (const problem of problems) lines.push(`  PROBLEM: ${problem}`);
  return { ok: problems.length === 0, lines, ...(target === undefined ? {} : { target }) };
}

/** A client for the operator login (TLS verified against the project CA for a managed endpoint). */
export function validationOperatorClient(target: ConnectionTarget, env: Environment, root?: string): { readonly client: pg.Client } | { readonly problem: string } {
  let ca: string | undefined;
  if (target.endpoint !== "local") {
    const checked = root === undefined ? checkCa(env) : checkCa(env, root);
    if ("problem" in checked) return { problem: checked.problem };
    ca = checked.ca;
  }
  return {
    client: new pg.Client({
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
      ssl: target.endpoint === "local" ? false : { ca, rejectUnauthorized: true },
      application_name: "validation-operator",
    }),
  };
}
