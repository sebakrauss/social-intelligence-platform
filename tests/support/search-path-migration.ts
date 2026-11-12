/**
 * TA §11 R4a (Step 7B-14P1) — the shape of a "search_path only" migration such as 0031, shared by the central database
 * guard and the per-domain migration guards (which otherwise require that a later migration name none of their objects).
 *
 * Such a migration may contain ONLY:
 *   - `do $$ … $$;` blocks that read the catalogs (pg_catalog.*) and raise — no application schema, no DML/DDL, no
 *     dynamic SQL, no role switch;
 *   - `set role app_owner;` … `reset role;` around
 *   - `alter function <schema>.<name>(<argument types>) set search_path = pg_catalog, pg_temp;` statements.
 * Anything else — a grant, a body, an owner, a security mode, another path, a table, a policy — is a problem.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const SAFE_SEARCH_PATH = "pg_catalog, pg_temp";

/** Step 7B-14P1: the platform-wide re-pin. It names functions of every domain — and nothing but their search_path. */
export const R4A_MIGRATION = "0031_privileged_name_resolution_hardening.sql";

/** The shape problems of 0031 itself (empty: it only re-pins search paths). For the per-domain migration guards. */
export function r4aMigrationShapeProblems(): string[] {
  return searchPathOnlyMigrationProblems(readFileSync(path.join(import.meta.dirname, "../../db/migrations", R4A_MIGRATION), "utf8"));
}

const APPLICATION_SCHEMA_REFERENCE =
  /\b(app|app_private|tenancy|audit|system|idempotency|connections|credentials|capability|content|interactions|conversations|coverage|ingestion|classification|mutations|t26_fixture|app_migrations|auth|public)\s*\./;
const FORBIDDEN_IN_CHECKS = /\b(insert|update|delete|alter|create|grant|revoke|drop|truncate|execute|copy|call|lock|listen|notify|vacuum|analyze|comment|security|owner)\b|\bset\s+(?:local\s+)?role\b/;

/** Problems with a migration that must only re-pin function search paths (empty: the shape holds). */
export function searchPathOnlyMigrationProblems(raw: string): string[] {
  const problems: string[] = [];
  const sql = raw.replace(/--[^\n]*/g, " ").toLowerCase();
  const blocks = [...sql.matchAll(/\bdo \$\$([\s\S]*?)\$\$\s*;/g)];
  for (const block of blocks) {
    // String literals (messages, GUC names, catalog constants) carry no executable reference.
    const code = (block[1] ?? "").replace(/'(?:[^']|'')*'/g, "''");
    if (APPLICATION_SCHEMA_REFERENCE.test(code)) problems.push("a check block references an application schema");
    if (FORBIDDEN_IN_CHECKS.test(code)) problems.push(`a check block does more than read the catalog (${FORBIDDEN_IN_CHECKS.exec(code)?.[0] ?? ""})`);
  }
  const rest = sql.replace(/\bdo \$\$[\s\S]*?\$\$\s*;/g, " ;").split(";").map((statement) => statement.replace(/\s+/g, " ").trim()).filter((statement) => statement !== "");
  let switched = false;
  let alters = 0;
  for (const statement of rest) {
    if (statement === "set role app_owner") {
      if (switched) problems.push("set role app_owner twice");
      switched = true;
    } else if (statement === "reset role") {
      if (!switched) problems.push("reset role without set role app_owner");
      switched = false;
    } else if (/^alter function [a-z_]+\.[a-z_]+\([a-z0-9_ ,[\]]*\) set search_path = pg_catalog, pg_temp$/.test(statement)) {
      if (!switched) problems.push(`re-pin outside set role app_owner: ${statement}`);
      alters += 1;
    } else {
      problems.push(`statement other than a search_path re-pin: ${statement.slice(0, 120)}`);
    }
  }
  if (switched) problems.push("set role app_owner without reset role");
  if (alters === 0) problems.push("no search_path re-pin");
  return problems;
}
