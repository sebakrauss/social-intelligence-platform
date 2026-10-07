/**
 * Static database guards that run in every CI build without a database (TA §64–§65; R1, R4, R8; F-S6).
 *
 *   migration lint     — no destructive statements, no session-level context, no passwords, every table
 *                        classified with RLS enabled AND forced, every SECURITY DEFINER pinned to an
 *                        empty search_path, nothing granted to anon/service_role/PUBLIC/login roles;
 *   F-S6 role guard    — no file in the repository drops, renames or terminates pooled login roles;
 *   credential guard   — no service-role key anywhere in runtime configuration, and the privileged
 *                        migration URL is read only by migration/provisioning tooling and tests.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { readMigrations } from "@/tools/db/migrations";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE = "tests/db/support/t26-fixture.sql";

function repositoryFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((file) => file !== "" && !file.startsWith("spikes/") && !file.startsWith("docs/") && !/\.(zip|png|jpg|ico|woff2?)$/.test(file));
}

function read(file: string): string {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return "";
  }
}

/** SQL without comments, lowercased, whitespace collapsed. */
const normalize = (text: string): string =>
  text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();

const sqlSources = (): { name: string; sql: string }[] => [
  ...readMigrations().map((migration) => ({ name: migration.name, sql: normalize(migration.sql) })),
  { name: FIXTURE, sql: normalize(read(FIXTURE)) },
];

/**
 * Closed-vocabulary CHECK constraints that may only ever be WIDENED: the audit vocabulary (TA §41) and the
 * connect-attempt state machine (Step 5D, 0008). PostgreSQL can't alter a CHECK expression in place, so widening
 * is, in ONE migration and as top-level statements in this order:
 *   alter table <table> drop constraint <name>;
 *   alter table <table> add constraint <name> check (<column> in ('…', …)) not valid;
 *   alter table <table> validate constraint <name>;
 * The value list must be quoted literals only and must contain every value earlier migrations allowed (equal is
 * fine; narrowing is not). The earlier value set is read from the column's inline CHECK inside that table's own
 * CREATE TABLE statement (PostgreSQL names it <table>_<column>_check deterministically), never from another table.
 * Only the exact DROP statement of an exactly listed constraint is exempted from the lint; every other DROP, REVOKE
 * or RLS weakening is still rejected. This is a text guard (see the limits test).
 */
const WIDENABLE_CHECKS: Readonly<Record<string, { readonly table: string; readonly column: string }>> = {
  audit_events_action_check: { table: "audit.audit_events", column: "action" },
  audit_events_target_type_check: { table: "audit.audit_events", column: "target_type" },
  connect_attempts_status_check: { table: "connections.connect_attempts", column: "status" },
};

const LITERAL_LIST = /^\s*'[^']*'(\s*,\s*'[^']*')*\s*$/;
const quotedValues = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only top-level SQL: block comments and dollar-quoted bodies (function/DO bodies) are not executed by the migration. */
const topLevel = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, " ");

/** The body of the top-level CREATE TABLE statement for `table` (up to its terminating `;`), if this SQL has one. */
function createTableBody(sql: string, table: string): string | undefined {
  const match = statements(sql, new RegExp(`create table ${escapeRegExp(table)} (\\([^;]*);`))[0];
  return match?.[2];
}

/** Positions of a top-level statement (at the start or right after a `;`). */
function statements(sql: string, statement: RegExp): RegExpExecArray[] {
  return [...sql.matchAll(new RegExp(`(?:^|;)\\s*(${statement.source})`, "g"))];
}

/** Migrations with each VERIFIED widening's DROP removed; throws if any exempted-looking drop isn't one. */
function withVerifiedWideningsRemoved(sources: readonly { name: string; sql: string }[]): { name: string; sql: string }[] {
  const allowed = new Map<string, Set<string>>();
  return sources.map((source) => {
    let sql = source.sql;
    const top = topLevel(source.sql);
    for (const [name, { table, column }] of Object.entries(WIDENABLE_CHECKS)) {
      const t = escapeRegExp(table);
      const body = createTableBody(top, table);
      const inline = body === undefined ? null : new RegExp(`(?:\\(|,) ${column} text not null check \\(${column} in \\(([^)]*)\\)\\)`).exec(body);
      if (inline && !allowed.has(name)) allowed.set(name, new Set(quotedValues(inline[1] ?? "")));
      const drops = statements(top, new RegExp(`alter table ${t} drop constraint ${name};`));
      if (drops.length === 0) continue;
      const fail = (reason: string): never => {
        throw new Error(`${source.name}: ${name} ${reason}`);
      };
      if (drops.length > 1) fail("is dropped more than once");
      const dropAt = drops[0]?.index ?? -1;
      const readds = statements(top, new RegExp(`alter table ${t} add constraint ${name} check \\(${column} in \\(([^)]*)\\)\\) not valid;`));
      const validates = statements(top, new RegExp(`alter table ${t} validate constraint ${name};`));
      const readd = readds.find((match) => match.index > dropAt);
      if (readds.length !== 1 || readd === undefined) fail("is dropped without exactly one later same-name NOT VALID re-add in the same migration");
      const validate = validates.find((match) => match.index > (readd?.index ?? Number.POSITIVE_INFINITY));
      if (validates.length !== 1 || validate === undefined) fail("is re-added without exactly one later VALIDATE CONSTRAINT");
      const list = readd?.[2] ?? "";
      if (!LITERAL_LIST.test(list)) fail("is re-added with a non-literal value list");
      const previous = allowed.get(name) ?? fail("has no earlier definition to widen");
      const next = new Set(quotedValues(list));
      const lost = [...previous].filter((value) => !next.has(value));
      if (lost.length > 0) fail(`would narrow (removes ${lost.join(", ")})`);
      allowed.set(name, next);
      sql = sql.replace(`alter table ${table} drop constraint ${name};`, " ");
    }
    return { name: source.name, sql };
  });
}

/**
 * Exactly PINNED CHECK rewrites: a non-vocabulary CHECK that a reviewed decision changes in one exact way. Each entry
 * names the table, the constraint, the exact (normalized) expression the table was CREATED with, and the ONE exact
 * expression it may become. Nothing is inferred or compared semantically: any other expression, table, name or
 * order is rejected, so this is not a general CHECK-rewrite escape hatch. Same statement shape as a widening:
 *   alter table <table> drop constraint <name>;
 *   alter table <table> add constraint <name> check <to> not valid;
 *   alter table <table> validate constraint <name>;
 *
 *   connect_attempts_closed_recorded (0008, Step 5D): EXCHANGING is an intermediate, not closed, state. Identical for
 *   every pre-0008 status; the only expansion is EXCHANGING ⇔ closed_at IS NULL.
 *   asset_moves_reason_code_check (0010, Steps 5F/5G): the TEMPORARY TA-Q-02 rejection reason, distinct from M-01's
 *   ASSET_ACTIVE_ELSEWHERE, and the destination's generic SOURCE_RELEASE_REJECTED (G4). The 0007 CHECK is the
 *   NULLABLE column's inline check (`reason_code text check (…)`, named <table>_<column>_check by PostgreSQL), so
 *   the entry names its `column`: the original is read from exactly that
 *   column definition in the table's own CREATE TABLE (balanced parentheses), never from another column or table.
 *   This is not the vocabulary-widening mechanism above: the exact expression is pinned, value order included.
 */
const PINNED_CHECK_REWRITES: Readonly<Record<string, { readonly table: string; readonly column?: string; readonly from: string; readonly to: string }>> = {
  connect_attempts_closed_recorded: {
    table: "connections.connect_attempts",
    from: "((status = 'pending') = (closed_at is null))",
    to: "((status in ('pending', 'exchanging')) = (closed_at is null))",
  },
  asset_moves_reason_code_check: {
    table: "connections.asset_moves",
    column: "reason_code",
    from:
      "(reason_code in ( 'source_not_active', 'authority_revoked', 'destination_connection_unhealthy', 'asset_active_elsewhere'," +
      " 'asset_not_discovered', 'activation_retries_exhausted'))",
    to:
      "(reason_code in ( 'source_not_active', 'authority_revoked', 'destination_connection_unhealthy', 'asset_active_elsewhere'," +
      " 'asset_not_discovered', 'activation_retries_exhausted', 'ad_account_single_workspace_pending_validation'," +
      " 'source_release_rejected'))",
  },
};

/** The parenthesized expression starting at `open` (which must be "("), with balanced parentheses; undefined if unbalanced. */
function balanced(text: string, open: number): string | undefined {
  if (text[open] !== "(") return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    if (depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

/** A pinned constraint's definition inside its table's CREATE TABLE body: named constraint, or a nullable column's inline check. */
function pinnedDefinition(body: string, name: string, table: string, column: string | undefined): string | undefined {
  if (column === undefined) {
    const defined = new RegExp(`(?:\\(|,) constraint ${name} check (.*?)(?=,|\\) ?$)`).exec(body);
    return defined ? (defined[1] ?? "").trim() : undefined;
  }
  // PostgreSQL's deterministic name for the inline check; any other pairing is a misconfigured entry.
  if (name !== `${table.slice(table.indexOf(".") + 1)}_${column}_check`) throw new Error(`${name}: not the inline check name of ${table}.${column}`);
  const definitions = [...body.matchAll(new RegExp(`(?:\\(|,) ${column} text check `, "g"))];
  if (definitions.length !== 1) return undefined;
  const match = definitions[0];
  return match === undefined ? undefined : balanced(body, match.index + match[0].length);
}

/** Migrations with each verified pinned rewrite's DROP removed; throws if a rewrite isn't exactly the pinned one. */
function withPinnedRewritesRemoved(sources: readonly { name: string; sql: string }[]): { name: string; sql: string }[] {
  const current = new Map<string, string>();
  return sources.map((source) => {
    let sql = source.sql;
    const top = topLevel(source.sql);
    for (const [name, { table, column, from, to }] of Object.entries(PINNED_CHECK_REWRITES)) {
      const t = escapeRegExp(table);
      const body = createTableBody(top, table);
      if (body !== undefined && !current.has(name)) {
        const defined = pinnedDefinition(body, name, table, column);
        if (defined !== undefined) current.set(name, defined);
      }
      const drops = statements(top, new RegExp(`alter table ${t} drop constraint ${name};`));
      if (drops.length === 0) continue;
      const fail = (reason: string): never => {
        throw new Error(`${source.name}: ${name} ${reason}`);
      };
      if (drops.length > 1) fail("is dropped more than once");
      const dropAt = drops[0]?.index ?? -1;
      const readds = statements(top, new RegExp(`alter table ${t} add constraint ${name} check ([^;]*?) not valid;`));
      const readd = readds.find((match) => match.index > dropAt);
      if (readds.length !== 1 || readd === undefined) fail("is dropped without exactly one later same-name NOT VALID re-add in the same migration");
      const validates = statements(top, new RegExp(`alter table ${t} validate constraint ${name};`));
      const validate = validates.find((match) => match.index > (readd?.index ?? Number.POSITIVE_INFINITY));
      if (validates.length !== 1 || validate === undefined) fail("is re-added without exactly one later VALIDATE CONSTRAINT");
      if (current.get(name) !== from) fail("rewrites a definition other than the pinned original");
      if ((readd?.[2] ?? "").trim() !== to) fail("is re-added with an expression other than the pinned rewrite");
      current.set(name, to);
      sql = sql.replace(`alter table ${table} drop constraint ${name};`, " ");
    }
    return { name: source.name, sql };
  });
}

const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bdrop\s+(table|column|schema|role|user|owned|database|function|policy|trigger|index|view|type)\b/, "DROP"],
  [/\btruncate\b/, "TRUNCATE"],
  [/\brename\s+(to|column)\b/, "RENAME"],
  [/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?\S+\s+(alter\s+column\s+\S+\s+type|drop)\b/, "column narrowing"],
  [/\bdrop\s+(column|constraint)\b/, "DROP column/constraint (anywhere in ALTER TABLE)"],
  [/\bdisable\s+row\s+level\s+security\b|\bno\s+force\s+row\s+level\s+security\b/, "RLS weakening"],
  [/\brevoke\b[^;]*\bfrom\s+(?!public\s*(?:;|'|$))/, "grant narrowing (REVOKE from anything but PUBLIC)"],
  [/\bbypassrls\b(?![^;]*\bnobypassrls\b)/, "BYPASSRLS grant"],
  [/\bpassword\b/, "password in SQL"],
  [/set_config\([^)]*,\s*false\s*\)/, "session-level set_config"],
  [/(^|;|\$\$|then|begin)\s*set\s+(?!local\b|role\s+app_owner\b|search_path)/, "session-level SET"],
  [/(^|;)\s*(begin|commit|rollback)\s*;/, "transaction control (the runner owns transactions)"],
  [/\bpg_terminate_backend\b/, "backend termination"],
];

/** Lint findings for a migration sequence (empty = clean). */
function lintMigrations(sources: readonly { name: string; sql: string }[]): string[] {
  let checked: { name: string; sql: string }[];
  try {
    checked = withPinnedRewritesRemoved(withVerifiedWideningsRemoved(sources));
  } catch (error) {
    return [(error as Error).message];
  }
  return checked.flatMap((source) => FORBIDDEN.filter(([pattern]) => pattern.test(source.sql)).map(([, label]) => `${source.name}: ${label}`));
}

describe("migration lint", () => {
  it("contains no destructive or lifecycle-unsafe statements", () => {
    expect(lintMigrations(sqlSources())).toEqual([]);
  });

  describe("the audit-vocabulary widening exemption is narrow (adversarial)", () => {
    const BASE = { name: "0001_base.sql", sql: normalize("create table audit.audit_events ( action text not null check (action in ('a', 'b')), target_type text not null check (target_type in ('x')) );") };
    const widen = (extra = ""): string =>
      "alter table audit.audit_events drop constraint audit_events_action_check;" +
      " alter table audit.audit_events add constraint audit_events_action_check check (action in ('a', 'b', 'c')) not valid;" +
      " alter table audit.audit_events validate constraint audit_events_action_check;" + extra;
    const lint = (...later: string[]): string[] => lintMigrations([BASE, ...later.map((sql, i) => ({ name: `000${String(i + 2)}_m.sql`, sql: normalize(sql) }))]);

    it("accepts a verified widening, an equal set, and case/whitespace/comment formatting variants", () => {
      expect(lint(widen())).toEqual([]);
      expect(lint(widen().replace("'a', 'b', 'c'", "'b', 'a'"))).toEqual([]);
      expect(lint(widen().toUpperCase().replace(/'A', 'B', 'C'/, "'a', 'b', 'c'").replace(/\s+/g, "\n   "))).toEqual([]);
      expect(lint(`-- note\n${widen()}`)).toEqual([]);
    });

    it("rejects narrowing, non-literal lists and a missing/misplaced re-add or VALIDATE", () => {
      expect(lint(widen().replace("'a', 'b', 'c'", "'a'"))[0]).toMatch(/would narrow/);
      expect(lint(widen().replace("'a', 'b', 'c'", "'a', 'b', action"))[0]).toMatch(/non-literal/);
      expect(lint("alter table audit.audit_events drop constraint audit_events_action_check;")[0]).toMatch(/without exactly one later/);
      expect(lint(widen().replace("not valid;", ";"))[0]).toMatch(/without exactly one later/);
      expect(lint(widen().replace("add constraint audit_events_action_check", "add constraint audit_events_action_check2"))[0]).toMatch(/without exactly one later/);
      expect(lint(widen().replace(" alter table audit.audit_events validate constraint audit_events_action_check;", ""))[0]).toMatch(/VALIDATE/);
      const validateFirst = "alter table audit.audit_events validate constraint audit_events_action_check; " + widen().replace(" alter table audit.audit_events validate constraint audit_events_action_check;", "");
      expect(lint(validateFirst)[0]).toMatch(/VALIDATE/);
      expect(lint(widen(" alter table audit.audit_events drop constraint audit_events_action_check;"))[0]).toMatch(/more than once/);
    });

    it("re-add/VALIDATE hidden in comments or dollar-quoted bodies doesn't count", () => {
      const hidden = "alter table audit.audit_events drop constraint audit_events_action_check; /* " + widen().slice(widen().indexOf(" alter")) + " */";
      expect(lint(hidden)[0]).toMatch(/without exactly one later/);
      const inBody = "alter table audit.audit_events drop constraint audit_events_action_check; do $$ begin " + widen().slice(widen().indexOf(" alter")) + " end $$;";
      expect(lint(inBody)[0]).toMatch(/without exactly one later/);
    });

    it("the re-add must be in the SAME migration", () => {
      const findings = lint(
        "alter table audit.audit_events drop constraint audit_events_action_check;",
        widen().slice(widen().indexOf(" alter")),
      );
      expect(findings[0]).toMatch(/without exactly one later/);
    });

    it.each([
      ["another CHECK", "alter table tenancy.workspaces drop constraint workspaces_mode_check;"],
      ["a UNIQUE constraint", "alter table connections.connections drop constraint connections_workspace_id_id_key;"],
      ["a foreign key", "alter table connections.connected_accounts drop constraint connected_accounts_workspace_id_connection_id_fkey;"],
      ["an exempt name on another table", "alter table tenancy.workspaces drop constraint audit_events_action_check;"],
      ["drop if exists", "alter table audit.audit_events drop constraint if exists audit_events_action_check;"],
      ["alter table only", "alter table only audit.audit_events drop constraint audit_events_action_check;"],
      ["combined drop", "alter table audit.audit_events drop constraint audit_events_action_check, drop column action;"],
      ["a column", "alter table audit.audit_events drop column change;"],
      ["a column after another clause", "alter table audit.audit_events add column x int, drop column change;"],
      ["a constraint after another clause", "alter table tenancy.workspaces add column x int, drop constraint workspaces_mode_check;"],
      ["a table", "drop table connections.asset_moves;"],
      ["a policy", "drop policy member_read on connections.connections;"],
      ["an index", "drop index connections.connected_accounts_m01_active_content_asset;"],
      ["RLS disabled", "alter table connections.connections disable row level security;"],
      ["RLS not forced", "alter table connections.connections no force row level security;"],
      ["a runtime grant", "revoke select on connections.connections from authenticated;"],
      ["a runtime grant listed after PUBLIC", "revoke all on schema connections from public, app_worker;"],
    ])("still rejects dropping %s, even next to a valid widening", (_label, statement) => {
      expect(lint(widen(` ${statement}`)).length).toBeGreaterThan(0);
      expect(lint(statement).length).toBeGreaterThan(0);
    });

    it("known limit: it is a text guard — the database tests prove the applied result", () => {
      // The lint can't evaluate SQL semantics (e.g. string literals that mimic statements). The DB suites check the
      // live constraints after migrating (validated, closed vocabulary equal to the application's) — see
      // tests/db/suites/connections.ts "the audit vocabulary constraints are validated and match the application".
      expect(Object.keys(WIDENABLE_CHECKS).sort()).toEqual(["audit_events_action_check", "audit_events_target_type_check", "connect_attempts_status_check"]);
    });
  });

  describe("the pinned closed_at rewrite (0008) allows exactly one transformation (adversarial)", () => {
    const BASE = {
      name: "0001_base.sql",
      sql: normalize(
        "create table connections.connect_attempts ( id uuid, status text not null check (status in ('PENDING', 'COMPLETED')), closed_at timestamptz," +
          " constraint connect_attempts_closed_recorded check ((status = 'PENDING') = (closed_at is null)), x int );",
      ),
    };
    const rewrite = (expression = "((status in ('PENDING', 'EXCHANGING')) = (closed_at is null))", table = "connections.connect_attempts"): string =>
      `alter table ${table} drop constraint connect_attempts_closed_recorded;` +
      ` alter table ${table} add constraint connect_attempts_closed_recorded check ${expression} not valid;` +
      ` alter table ${table} validate constraint connect_attempts_closed_recorded;`;
    const lint = (...later: string[]): string[] => lintMigrations([BASE, ...later.map((sql, i) => ({ name: `000${String(i + 2)}_m.sql`, sql: normalize(sql) }))]);

    it("accepts exactly the pinned rewrite (case and whitespace normalized)", () => {
      expect(lint(rewrite())).toEqual([]);
      expect(lint(rewrite().replace(/ /g, "\n  ").toUpperCase().replace("'PENDING', 'EXCHANGING'", "'pending', 'exchanging'"))).toEqual([]);
    });

    it.each([
      ["a broader expression", "((status in ('PENDING', 'EXCHANGING', 'COMPLETED')) = (closed_at is null))"],
      ["a weaker expression", "(true)"],
      ["a reordered value list", "((status in ('EXCHANGING', 'PENDING')) = (closed_at is null))"],
      ["an extra clause", "((status in ('PENDING', 'EXCHANGING')) = (closed_at is null) or true)"],
    ])("rejects %s", (_label, expression) => {
      expect(lint(rewrite(expression))[0]).toMatch(/other than the pinned rewrite/);
    });

    it("rejects a rewrite of anything but the pinned original, a missing VALIDATE/NOT VALID, and other tables or names", () => {
      const altered = { ...BASE, sql: BASE.sql.replace("((status = 'pending') = (closed_at is null))", "((status = 'pending') = (closed_at is null) or true)") };
      expect(lintMigrations([altered, { name: "0002_m.sql", sql: normalize(rewrite()) }])[0]).toMatch(/other than the pinned original/);
      expect(lint(rewrite().replace(/ alter table connections\.connect_attempts validate[^;]*;/, ""))[0]).toMatch(/VALIDATE/);
      expect(lint(rewrite().replace(" not valid;", ";"))[0]).toMatch(/without exactly one later/);
      expect(lint(rewrite(undefined, "connections.connections")).length).toBeGreaterThan(0);
      expect(lint("alter table connections.connect_attempts drop constraint connect_attempts_pkce_cleared_when_closed;").length).toBeGreaterThan(0);
      expect(lint(`${rewrite()} ${rewrite()}`)[0]).toMatch(/more than once/);
    });

    it("pins exactly the reviewed rewrites", () => {
      expect(Object.keys(PINNED_CHECK_REWRITES)).toEqual(["connect_attempts_closed_recorded", "asset_moves_reason_code_check"]);
    });
  });

  describe("the pinned TA-Q-02 reason rewrite (0010) allows exactly one transformation (adversarial)", () => {
    const VALUES = "'SOURCE_NOT_ACTIVE', 'AUTHORITY_REVOKED', 'DESTINATION_CONNECTION_UNHEALTHY', 'ASSET_ACTIVE_ELSEWHERE', 'ASSET_NOT_DISCOVERED', 'ACTIVATION_RETRIES_EXHAUSTED'";
    const BASE = {
      name: "0001_base.sql",
      sql: normalize(
        `create table connections.connections ( id uuid, reason_code text check (reason_code in ('X')) );` +
          ` create table connections.asset_moves ( move_id uuid, status text not null, reason_code text check (reason_code in (\n ${VALUES})),` +
          " created_at timestamptz not null, constraint asset_moves_failure_reason check (status <> 'REJECTED' or reason_code is not null) );",
      ),
    };
    const TO = `(reason_code in (\n ${VALUES}, 'AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION', 'SOURCE_RELEASE_REJECTED'))`;
    const rewrite = (expression = TO, table = "connections.asset_moves", name = "asset_moves_reason_code_check"): string =>
      `alter table ${table} drop constraint ${name};` +
      ` alter table ${table} add constraint ${name} check ${expression} not valid;` +
      ` alter table ${table} validate constraint ${name};`;
    const lint = (...later: string[]): string[] => lintMigrations([BASE, ...later.map((sql, i) => ({ name: `000${String(i + 2)}_m.sql`, sql: normalize(sql) }))]);

    it("accepts exactly the pinned rewrite (case and whitespace normalized)", () => {
      expect(lint(rewrite())).toEqual([]);
      expect(lint(rewrite().replace(/ /g, "\n  ").toUpperCase())).toEqual([]);
    });

    it.each([
      ["a broader expression (another extra reason)", TO.replace("'))", "', 'SOMETHING_ELSE'))")],
      ["TRUE", "(true)"],
      ["an expression that also admits anything", `(${TO.slice(1, -1)} or true)`],
      ["the original list (no TA-Q-02 reason)", `(reason_code in (\n ${VALUES}))`],
      ["only the TA-Q-02 reason (no generic source rejection)", `(reason_code in (\n ${VALUES}, 'AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION'))`],
      ["a destination reason that leaks the source's precise state", TO.replace("'SOURCE_RELEASE_REJECTED'", "'SOURCE_RELEASE_REJECTED', 'SOURCE_AUTHORITY_REVOKED'")],
      ["a narrowed list", "(reason_code in ('AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION'))"],
      ["a reordered list", TO.replace("'SOURCE_NOT_ACTIVE', 'AUTHORITY_REVOKED'", "'AUTHORITY_REVOKED', 'SOURCE_NOT_ACTIVE'")],
    ])("rejects %s", (_label, expression) => {
      expect(lint(rewrite(expression))[0]).toMatch(/other than the pinned rewrite/);
    });

    it("rejects another table, another constraint, a missing NOT VALID or VALIDATE, and a double DROP", () => {
      expect(lint(rewrite(TO, "connections.connections")).length).toBeGreaterThan(0);
      expect(lint(rewrite(TO, "connections.asset_moves", "asset_moves_failure_reason")).length).toBeGreaterThan(0);
      expect(lint(rewrite(TO, "connections.asset_moves", "asset_moves_status_check")).length).toBeGreaterThan(0);
      expect(lint(rewrite().replace(" not valid;", ";"))[0]).toMatch(/without exactly one later/);
      expect(lint(rewrite().replace(/ alter table connections\.asset_moves validate[^;]*;/, ""))[0]).toMatch(/VALIDATE/);
      expect(lint(`${rewrite()} alter table connections.asset_moves drop constraint asset_moves_reason_code_check;`)[0]).toMatch(/more than once/);
      expect(lint(rewrite(), rewrite())[0]).toMatch(/other than the pinned original/);
    });

    it("reads the original from asset_moves' own reason_code column, never from another table's or column's check", () => {
      // connections.connections.reason_code is not the pinned original; neither is an altered asset_moves definition.
      const altered = { ...BASE, sql: BASE.sql.replace("'activation_retries_exhausted'))", "'activation_retries_exhausted', 'extra'))") };
      expect(lintMigrations([altered, { name: "0002_m.sql", sql: normalize(rewrite()) }])[0]).toMatch(/other than the pinned original/);
      const notNull = { ...BASE, sql: BASE.sql.replace("status text not null, reason_code text check (", "status text not null, reason_code text not null check (") };
      expect(lintMigrations([notNull, { name: "0002_m.sql", sql: normalize(rewrite()) }])[0]).toMatch(/other than the pinned original/);
    });

    it("is not a vocabulary widening: the generic widening parser still doesn't cover asset_moves.reason_code", () => {
      expect(Object.keys(WIDENABLE_CHECKS)).not.toContain("asset_moves_reason_code_check");
    });
  });

  describe("the connect-attempt status widening (0008) is equally narrow (adversarial)", () => {
    const BASE = {
      name: "0001_base.sql",
      sql: normalize(
        "create table connections.connections ( id uuid, status text not null check (status in ('ACTIVE', 'REMOVED', 'EXTRA')) );" +
          " create table connections.connect_attempts ( id uuid, status text not null check (status in ('PENDING', 'COMPLETED')), x int );",
      ),
    };
    const widen = (values = "'PENDING', 'COMPLETED', 'EXCHANGING'"): string =>
      "alter table connections.connect_attempts drop constraint connect_attempts_status_check;" +
      ` alter table connections.connect_attempts add constraint connect_attempts_status_check check (status in (${values})) not valid;` +
      " alter table connections.connect_attempts validate constraint connect_attempts_status_check;";
    const lint = (...later: string[]): string[] => lintMigrations([BASE, ...later.map((sql, i) => ({ name: `000${String(i + 2)}_m.sql`, sql: normalize(sql) }))]);

    it("accepts a verified widening of exactly connect_attempts.status", () => {
      expect(lint(widen())).toEqual([]);
    });

    it("reads the earlier values from connect_attempts' own CREATE TABLE, never from another table's status column", () => {
      // 'ACTIVE'/'REMOVED' belong to connections.connections: dropping PENDING/COMPLETED is still narrowing.
      expect(lint(widen("'ACTIVE', 'REMOVED', 'EXTRA'"))[0]).toMatch(/would narrow \(removes pending, completed\)/);
      expect(lint(widen("'PENDING'"))[0]).toMatch(/would narrow/);
    });

    it("rejects a missing VALIDATE, a non-literal list, another constraint name and another table", () => {
      expect(lint(widen().replace(/ alter table connections\.connect_attempts validate[^;]*;/, ""))[0]).toMatch(/VALIDATE/);
      expect(lint(widen("'PENDING', 'COMPLETED', status"))[0]).toMatch(/non-literal/);
      expect(lint("alter table connections.connect_attempts drop constraint connect_attempts_provider_check;").length).toBeGreaterThan(0);
      expect(lint("alter table connections.connections drop constraint connect_attempts_status_check;").length).toBeGreaterThan(0);
      expect(lint("alter table connections.connect_attempts drop constraint connect_attempts_pkce_paired;").length).toBeGreaterThan(0);
    });

    it("has no earlier definition to widen when the table was never created with an inline status CHECK", () => {
      const findings = lintMigrations([{ name: "0001_base.sql", sql: normalize("create table connections.connect_attempts ( id uuid );") }, { name: "0002_m.sql", sql: normalize(widen()) }]);
      expect(findings[0]).toMatch(/no earlier definition/);
    });
  });

  it("grants nothing to anon, service_role, PUBLIC or the login roles", () => {
    for (const source of sqlSources()) {
      const grants = source.sql.match(/\bgrant\b[^;]*;/g) ?? [];
      for (const grant of grants) {
        const recipients = grant.replace(/^.*\bto\b/, "");
        expect(/\b(anon|service_role|public|web_login|worker_login|system_login|postgres)\b/.test(recipients), `${source.name}: ${grant}`).toBe(false);
      }
    }
  });

  it("classifies every created table and enables AND forces RLS on it", () => {
    for (const source of sqlSources()) {
      for (const match of source.sql.matchAll(/create table (?:if not exists )?([a-z_]+\.[a-z_]+)/g)) {
        const table = match[1] ?? "";
        expect(Object.keys(TABLE_CLASSIFICATION), `${source.name}: ${table} is unclassified`).toContain(table);
        expect(source.sql.includes(`alter table ${table} enable row level security`), `${source.name}: ${table} RLS not enabled`).toBe(true);
        expect(source.sql.includes(`alter table ${table} force row level security`), `${source.name}: ${table} RLS not forced`).toBe(true);
      }
    }
  });

  it("pins every SECURITY DEFINER function to an empty search_path", () => {
    for (const source of sqlSources()) {
      for (const match of source.sql.matchAll(/create function ([a-z_]+\.[a-z_]+)\(.*?\bas \$\$/g)) {
        const header = match[0];
        if (header.includes("security definer")) expect(header, `${source.name}: ${match[1] ?? ""}`).toContain("set search_path = ''");
      }
    }
  });

  it("switches roles only to fixed literals", () => {
    for (const source of sqlSources()) {
      for (const match of source.sql.matchAll(/set (?:local )?role ([^;']+)/g)) {
        expect(["app_owner"], `${source.name}: set role ${match[1] ?? ""}`).toContain((match[1] ?? "").trim());
      }
    }
    const scopes = read("platform/db/scopes.ts") + read("platform/db/system-scope.ts");
    const switches = [...scopes.matchAll(/set local role ([a-z_]+)/g)].map((match) => match[1]);
    expect(switches.sort()).toEqual(["app_system", "app_worker", "authenticated"]);
    expect(scopes).not.toMatch(/set local role \$\{/);
  });
});

describe("F-S6 / R8 guard: pooled login roles are never torn down", () => {
  // Built from parts so this file does not match itself.
  const drop = ["dr", "op"].join("");
  const patterns: [RegExp, string][] = [
    [new RegExp(`\\b${drop}\\s+(role|user)\\b`, "i"), "role drop"],
    [new RegExp(`\\b${drop}\\s+owned\\b`, "i"), "drop owned"],
    [new RegExp(`\\breassign\\s+owned\\b`, "i"), "reassign owned"],
    [new RegExp(`\\balter\\s+(role|user)\\s+\\S+\\s+rename\\b`, "i"), "role rename"],
    [new RegExp(["pg_", "terminate_backend"].join(""), "i"), "backend termination"],
    [new RegExp(`\\b${drop}Role\\b|\\bteardownRoles?\\b`, "i"), "role teardown helper"],
  ];

  it("no script, migration, test or tool contains role teardown", () => {
    const self = path.relative(root, import.meta.filename);
    for (const file of repositoryFiles()) {
      if (file === self || !/\.(ts|tsx|js|mjs|cjs|sql|json|ya?ml|sh)$/.test(file)) continue;
      const text = read(file);
      for (const [pattern, label] of patterns) {
        expect(pattern.test(text), `${file}: ${label}`).toBe(false);
      }
    }
  });
});

describe("database test runs report failures", () => {
  // embedded-postgres installs an exit hook that calls process.exit(0) on `beforeExit`, which masks a failing
  // Vitest run's exit code. It may only be loaded by the cluster child process, never by a test process.
  it("only the local cluster child process loads embedded-postgres", () => {
    const self = path.relative(root, import.meta.filename);
    const sources = repositoryFiles().filter((file) => file !== self);
    const loaders = sources.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && /from\s+["']embedded-postgres["']/.test(read(file)));
    expect(loaders).toEqual(["tests/db/support/local-cluster.ts"]);
    const clusterImporters = sources.filter((file) => /\.(ts|tsx)$/.test(file) && /from\s+["']\.\/local-cluster(\.ts)?["']|support\/local-cluster/.test(read(file)));
    expect(clusterImporters).toEqual(["tests/db/support/cluster-process.ts"]);
  });
});

describe("privileged credentials stay out of runtime", () => {
  const files = repositoryFiles();
  const runtime = files.filter((file) => /^(app|ui|server|domain|modules|platform|db|jobs|integrations|ai|mutations)\//.test(file) || file === "proxy.ts");

  it("no service-role key is configured or referenced anywhere outside guards and docs", () => {
    const serviceKey = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
    for (const file of [...runtime, ".env.example", ...files.filter((name) => name.startsWith(".github/") || name.startsWith("tools/"))]) {
      expect(read(file).includes(serviceKey), file).toBe(false);
    }
  });

  it("the migration URL is read only by migration/provisioning tooling and database tests", () => {
    const variable = ["DATABASE", "MIGRATION", "URL"].join("_");
    const readers = files.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && read(file).includes(variable));
    for (const file of readers) {
      expect(/^(tools\/db|tests)\//.test(file), file).toBe(true);
    }
    for (const file of runtime) expect(read(file).includes(variable), file).toBe(false);
  });

  it("runtime code never connects as a privileged role and creates pools only in platform/db", () => {
    for (const file of runtime.filter((name) => /\.(ts|tsx)$/.test(name))) {
      const text = read(file);
      if (!file.startsWith("platform/db/")) {
        expect(/new\s+(pg\.)?(Pool|Client)\s*\(/.test(text), `${file}: constructs a database client`).toBe(false);
        expect(/from\s+["']pg["']/.test(text), `${file}: imports the pg driver`).toBe(false);
        expect(/drizzle-orm\/node-postgres/.test(text), `${file}: imports the Drizzle connection constructor`).toBe(false);
      }
    }
  });

  it(".env.example lists variable names only", () => {
    for (const line of read(".env.example").split("\n")) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      expect(line, "value present in .env.example").toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
  });
});
