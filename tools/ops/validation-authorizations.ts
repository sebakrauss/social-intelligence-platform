/**
 * The validation-authorization operator's database calls (Step 7B-14I2; 0029). Exactly three fixed, parameterized calls —
 * never SQL built from input, never a SELECT / INSERT / UPDATE on a table — each inside ONE transaction that first
 * switches to the fixed literal role `app_validation_operator` (R3):
 *
 *   issue   select * from mutations.issue_validation_authorization($1..$6)    (READ COMMITTED; committed only with apply)
 *   revoke  select mutations.revoke_validation_authorization($1, $2, $3)       (committed only with apply)
 *   status  select * from mutations.validation_authorization_status($1, $2)   (READ ONLY; always rolled back)
 *
 * Before any call, the session itself is checked: the database login must be a validation operator login (never the
 * migration role, never BYPASSRLS / superuser / CREATEROLE). The database re-checks all of it inside every function.
 */
import { OPERATOR_LOGIN } from "../db/validation-operator-target.ts";
import type { ValidationCommand } from "./validation-authorization-command.ts";

/** The minimal client surface used here (a pg client satisfies it; tests pass a fake). */
export interface OperatorQueryable {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export const OPERATOR_ROLE = "app_validation_operator";
export { OPERATOR_LOGIN };

const SET_ROLE = "set local role app_validation_operator";
const ISSUE = "select authorization_id, expires_at from mutations.issue_validation_authorization($1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer, $6::boolean)";
const REVOKE = "select mutations.revoke_validation_authorization($1::uuid, $2::uuid, $3::text) as revoked_at";
const STATUS = "select * from mutations.validation_authorization_status($1::uuid, $2::uuid)";
const SESSION = `select session_user::text as login, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit,
  pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER') as operator,
  pg_catalog.current_setting('transaction_isolation') as isolation
  from pg_catalog.pg_roles r where r.rolname = session_user`;

/** Why this session may not act as a validation operator (empty: it may). Reads only the catalog. */
export async function operatorSessionProblems(client: OperatorQueryable): Promise<readonly string[]> {
  const row = (await client.query(SESSION)).rows[0] as { login: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolinherit: boolean; operator: boolean; isolation: string } | undefined;
  if (row === undefined) return ["the session login is unknown"];
  const problems: string[] = [];
  if (!OPERATOR_LOGIN.test(row.login)) problems.push("the session login is not a validation_operator_<handle> login");
  if (row.rolsuper || row.rolbypassrls || row.rolcreaterole || row.rolcreatedb || row.rolreplication) problems.push("the session login holds an elevated attribute (superuser, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION)");
  if (row.rolinherit) problems.push("the session login inherits privileges (must be NOINHERIT)");
  if (!row.operator) problems.push(`the session login is not a member of ${OPERATOR_ROLE}`);
  if (row.isolation !== "read committed") problems.push("the session default isolation is not READ COMMITTED");
  return problems;
}

export type ValidationCallResult =
  | { readonly action: "issue"; readonly committed: boolean; readonly authorizationId: string; readonly expiresAt: string }
  | { readonly action: "revoke"; readonly committed: boolean; readonly revokedAt: string }
  | { readonly action: "status"; readonly status: Readonly<Record<string, string | number | boolean | null>> };

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

/** Runs the command's ONE call in ONE transaction; commits only an applied issue / revoke. Throws the database refusal. */
export async function runValidationCall(client: OperatorQueryable, command: ValidationCommand): Promise<ValidationCallResult> {
  const readOnly = command.action === "status";
  await client.query(readOnly ? "begin transaction isolation level read committed read only" : "begin transaction isolation level read committed");
  let commit = false;
  try {
    await client.query(SET_ROLE);
    if (command.action === "issue") {
      const row = (await client.query(ISSUE, [command.workspaceId, command.preflightId, command.initiatorUserId, command.reason, command.lifetimeMinutes, command.acceptTokenTypeNotVerified])).rows[0];
      if (row === undefined) throw new Error("issuance returned nothing");
      commit = command.apply;
      return { action: "issue", committed: commit, authorizationId: String(row["authorization_id"]), expiresAt: iso(row["expires_at"]) };
    }
    if (command.action === "revoke") {
      const row = (await client.query(REVOKE, [command.workspaceId, command.authorizationId, command.reason])).rows[0];
      if (row === undefined) throw new Error("revocation returned nothing");
      commit = command.apply;
      return { action: "revoke", committed: commit, revokedAt: iso(row["revoked_at"]) };
    }
    const row = (await client.query(STATUS, [command.workspaceId, command.authorizationId])).rows[0];
    if (row === undefined) throw new Error("status returned nothing");
    const status: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(row)) status[key] = value === null || typeof value === "number" || typeof value === "boolean" ? value : iso(value);
    return { action: "status", status };
  } finally {
    await client.query(commit ? "commit" : "rollback");
  }
}

/** A database refusal as one closed line: its SQLSTATE and the function's own message (never data). */
export function refusalLine(error: unknown): string {
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "error";
  const message = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "refused";
  return `REFUSED: ${code} ${message}`;
}
