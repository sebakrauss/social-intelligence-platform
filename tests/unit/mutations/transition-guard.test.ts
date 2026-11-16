/**
 * Step 7B-16E — static parity between the intent model (mutations/domain/intent.ts) and migration 0033's transition
 * guard. The expected matrix is DERIVED from the domain's own assertTransition (never copied); the SQL's allowed pairs
 * are parsed from the migration. The database's actual behaviour for all 30 changes is proven separately on PostgreSQL
 * (tests/db/suites/mutations.ts, "Step 7B-16E"). A negative control proves the comparison detects a divergence.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTENT_STATUSES, assertTransition, type IntentStatus } from "@/mutations/domain/intent";

const MIGRATION = readFileSync(new URL("../../../db/migrations/0033_mutation_intent_state_transition_guard.sql", import.meta.url), "utf8");
const code = (sql: string): string => sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

const domainAllows = (from: IntentStatus, to: IntentStatus): boolean => {
  try {
    assertTransition(from, to);
    return true;
  } catch {
    return false;
  }
};

/** The `(old.status = 'X' and new.status in (...))` clauses of the guard, as "FROM→TO" pairs. */
function sqlPairs(sql: string): string[] {
  const pairs: string[] = [];
  for (const match of code(sql).matchAll(/\(old\.status = '([A-Z_]+)' and new\.status in \(([^)]*)\)\)/g)) {
    for (const to of [...(match[2] ?? "").matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])) pairs.push(`${match[1] ?? ""}→${to ?? ""}`);
  }
  return pairs.sort();
}

const domainPairs = (allows: (from: IntentStatus, to: IntentStatus) => boolean): string[] =>
  INTENT_STATUSES.flatMap((from) => INTENT_STATUSES.filter((to) => to !== from && allows(from, to)).map((to) => `${from}→${to}`)).sort();

describe("7B-16E: migration 0033 ↔ the intent model", () => {
  it("the guard admits exactly the domain's transitions (derived from assertTransition), nothing else", () => {
    expect(sqlPairs(MIGRATION)).toEqual(domainPairs(domainAllows));
    expect(sqlPairs(MIGRATION)).toHaveLength(8);
  });

  it("negative control: a guard with one extra pair (a resurrection) or one missing pair is detected", () => {
    const resurrecting = MIGRATION.replace("(old.status = 'OUTCOME_UNKNOWN' and new.status in ('CONFIRMED', 'FAILED'))", "(old.status = 'OUTCOME_UNKNOWN' and new.status in ('CONFIRMED', 'FAILED')) or (old.status = 'BLOCKED' and new.status in ('PENDING'))");
    expect(resurrecting).not.toBe(MIGRATION);
    expect(sqlPairs(resurrecting)).not.toEqual(domainPairs(domainAllows));
    const narrowed = MIGRATION.replace("new.status in ('CONFIRMED', 'FAILED', 'BLOCKED', 'OUTCOME_UNKNOWN')", "new.status in ('CONFIRMED', 'FAILED', 'BLOCKED')");
    expect(narrowed).not.toBe(MIGRATION);
    expect(sqlPairs(narrowed)).not.toEqual(domainPairs(domainAllows));
  });

  it("is one invoker trigger function pinned to pg_catalog, pg_temp and one BEFORE UPDATE OF status trigger — nothing else", () => {
    const sql = code(MIGRATION).replace(/\$\$[\s\S]*?\$\$/g, () => "$$body$$").replace(/\s+/g, " ").trim();
    expect(sql).toBe(
      "set role app_owner; create function mutations.intent_transition_guard() returns trigger language plpgsql volatile security invoker set search_path = pg_catalog, pg_temp as $$body$$; "
      + "revoke all on function mutations.intent_transition_guard() from public; "
      + "create trigger intent_transition_guard before update of status on mutations.mutation_intents for each row when (old.status is distinct from new.status) execute function mutations.intent_transition_guard(); "
      + "reset role;",
    );
    // The refusal is 42501 and names only the two closed statuses.
    expect(code(MIGRATION)).toMatch(/raise exception 'not a transition of the mutation intent model: % → %', old\.status, new\.status using errcode = '42501';/);
  });
});
