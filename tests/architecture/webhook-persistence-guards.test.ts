/**
 * Step H6-F2 — static guards around migration 0022 (provider webhook signals; design H6-F0, D-F1 … D-F5):
 *   - the exact object inventory: three tables, five webhook definers (system ones in `system`, the worker reader in
 *     `ingestion`), one same-signature replacement of 0019's request boundary that differs ONLY by the worker `plan`;
 *   - every definer: SECURITY DEFINER, empty search_path, no dynamic SQL, fixed reason codes, caller-gated;
 *   - nothing webhook-derived can write canonical, coverage, watermark, conversation or removal state, claim a
 *     capability, return or copy the raw body, or route to an ordering-chosen subset of tenants;
 *   - the frozen numbers: 1 MiB, 1000 changes/hints, 7 days, 5 organizations, 10/40 operations, account|relist.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FUNCTION_EXECUTE, RESTRICTIVE_POLICIES, TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { MAX_WEBHOOK_BODY_BYTES, MAX_WEBHOOK_CHANGES } from "@/integrations/providers/meta/webhooks";
import { DEFAULT_MAX_OPERATIONS, PROVIDER_EVENT_INBOX_POLICY, RECONCILIATION_OPERATIONS_CEILING } from "@/modules/ingestion";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const MIGRATION = "db/migrations/0022_provider_webhook_signals.sql";
const raw = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
const strip = (sql: string): string => sql.replace(/--[^\n]*/g, " ");
const sql0022 = strip(raw(MIGRATION));
const functionBody = (sql: string, header: string): string => {
  const start = sql.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf("end $$;", start) + "end $$;".length);
};
const DEFINERS = {
  "system.record_provider_webhook": "create function system.record_provider_webhook(",
  "system.route_provider_hint": "create function system.route_provider_hint(",
  "system.dispatch_due_signal_marks": "create function system.dispatch_due_signal_marks(",
  "ingestion.provider_event_hint": "create function ingestion.provider_event_hint(",
  "system.purge_provider_events": "create function system.purge_provider_events(",
} as const;
const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

describe("H6-F2: 0022's inventory", () => {
  it("creates exactly three tables, five webhook definers and replaces exactly one function (the request boundary)", () => {
    expect([...sql0022.matchAll(/create table ([a-z_.]+)/g)].map((m) => m[1])).toEqual(["system.provider_event_inbox", "system.provider_event_hints", "ingestion.signal_marks"]);
    expect([...sql0022.matchAll(/create function ([a-z_.]+)\(/g)].map((m) => m[1])).toEqual(Object.keys(DEFINERS));
    expect([...sql0022.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((m) => m[1])).toEqual(["ingestion.request_reconciliation"]);
    for (const table of ["system.provider_event_inbox", "system.provider_event_hints", "ingestion.signal_marks"]) {
      expect(sql0022).toContain(`alter table ${table} enable row level security;`);
      expect(sql0022).toContain(`alter table ${table} force row level security;`);
      expect(TABLE_CLASSIFICATION[table], table).toBeDefined();
    }
    expect(TABLE_CLASSIFICATION["system.provider_event_inbox"]).toMatchObject({ class: "system", privileges: {} });
    expect(TABLE_CLASSIFICATION["system.provider_event_hints"]?.privileges).toEqual({ app_system: ["SELECT"] });
    expect(Object.keys(TABLE_CLASSIFICATION["ingestion.signal_marks"]?.privileges ?? {})).toEqual(["app_worker"]);
  });

  it("each definer is a reviewed SECURITY DEFINER: empty search_path, no dynamic SQL, fixed messages, caller-gated", () => {
    for (const [name, header] of Object.entries(DEFINERS)) {
      const body = functionBody(sql0022, header);
      expect(body, name).toMatch(/security definer set search_path = '' as \$\$/);
      expect(body, name).not.toMatch(/\bexecute\b|\bformat\(|quote_ident|quote_literal|set_config|set role|current_setting/i);
      // Every raised message is a literal (no value is ever concatenated into an error).
      for (const raise of body.matchAll(/raise exception ([^;]*);/g)) expect(raise[1], name).toMatch(/^'[a-z ]+: [a-z ]+' using errcode = '(42501|22023)'$/);
      expect(body, name).toMatch(/pg_catalog\.pg_has_role\(session_user, '(authenticated|app_system|app_worker)', 'MEMBER'\)/);
    }
    expect(FUNCTION_EXECUTE).toMatchObject({
      "system.record_provider_webhook(text,text,text,bytea,integer,boolean,integer,integer,integer,integer,integer,jsonb)": ["authenticated"],
      "system.route_provider_hint(uuid)": ["app_system"],
      "system.dispatch_due_signal_marks(integer)": ["app_system"],
      "system.purge_provider_events(integer)": ["app_system"],
      "ingestion.provider_event_hint(uuid,uuid)": ["app_worker"],
    });
    // The receipt boundary requires NO claims and NO workspace; the system ones require no workspace.
    expect(functionBody(sql0022, DEFINERS["system.record_provider_webhook"])).toMatch(/app_private\.claimed_user\(\) is not null or app\.current_workspace\(\) is not null then/);
    for (const name of ["system.route_provider_hint", "system.dispatch_due_signal_marks", "system.purge_provider_events"] as const) {
      expect(functionBody(sql0022, DEFINERS[name]), name).toMatch(/not pg_catalog\.pg_has_role\(session_user, 'app_system', 'MEMBER'\) or app\.current_workspace\(\) is not null/);
    }
  });
});

describe("H6-F2: the request boundary (0019) is replaced only to name a plan", () => {
  it("the 0022 body equals 0019's once the plan handling is removed; the web branch can't choose a plan", () => {
    const before = functionBody(strip(raw("db/migrations/0019_reconciliation_request.sql")), "create function ingestion.request_reconciliation(").replace("create function", "");
    const after = functionBody(sql0022, "create or replace function ingestion.request_reconciliation(").replace("create or replace function", "");
    const withoutPlan = after
      .replace(/\s+v_plan\s+text := 'account';/, "")
      .replace(", 'max_operations', 'plan'))", ", 'max_operations'))")
      .replace(/\s+or \(p_budget \? 'plan' and \(pg_catalog\.jsonb_typeof\(p_budget -> 'plan'\) <> 'string' or \(p_budget ->> 'plan'\) not in \('account', 'relist'\)\)\)/, "")
      .replace(/\s+v_plan := coalesce\(p_budget ->> 'plan', v_plan\);/, "")
      .replace("content_items_used, plan, created_at", "content_items_used, created_at")
      .replace("0, 0, 0, v_plan, v_at, v_at", "0, 0, 0, v_at, v_at");
    expect(normalize(withoutPlan)).toBe(normalize(before));
    expect(after).toMatch(/if p_budget is not null or p_requested_at is not null then\s+raise exception [^;]* using errcode = '42501';/);
    expect(after).toMatch(/v_max\s+integer := 40;/);
    expect(DEFAULT_MAX_OPERATIONS).toBe(40);
    expect(RECONCILIATION_OPERATIONS_CEILING).toBe(40);
  });

  it("the plan is closed (account | relist), defaults to account and is never a worker UPDATE target", () => {
    expect(sql0022).toMatch(/alter table ingestion\.reconciliation_runs add column plan text not null default 'account';/);
    expect(sql0022).toMatch(/add constraint reconciliation_runs_plan check \(plan in \('account', 'relist'\)\);/);
    expect(TABLE_CLASSIFICATION["ingestion.reconciliation_runs"]?.privileges.app_worker).not.toContain("UPDATE(plan)");
    // No second budget column, no plan-dependent budget CHECK: the runtime chooses 10 for signals, the DB keeps 1..40.
    expect(sql0022).not.toMatch(/add column [a-z_]*(budget|operations)/);
    expect(sql0022).not.toMatch(/check \([^)]*plan[^)]*max_operations|check \([^)]*max_operations[^)]*plan/);
  });
});

describe("H6-F2: a webhook is a signal", () => {
  it("no 0022 statement writes canonical, coverage, watermark, conversation or removal state", () => {
    const writes = [...sql0022.matchAll(/\b(insert into|update|delete from)\s+([a-z_]+\.[a-z_]+)/g)].map((m) => m[2]);
    expect([...new Set(writes)].sort()).toEqual(["audit.audit_events", "ingestion.reconciliation_runs", "ingestion.signal_marks", "system.outbox", "system.provider_event_hints", "system.provider_event_inbox"]);
    expect(sql0022).not.toMatch(/removed_at_source|explicit_provider_signal|direct_fetch_confirmed|tombstone/);
    expect(sql0022).not.toMatch(/coverage\.|reconciliation_watermarks|conversations\.|interactions\.|source_text_versions/);
    // content.content_items appears only as the relist mark's ownership FOREIGN KEY (a reference, never a write).
    expect([...sql0022.matchAll(/content\.content_items/g)].length).toBe(1);
    expect(sql0022).toMatch(/foreign key \(workspace_id, content_item_id, connected_account_id\) references content\.content_items \(workspace_id, id, connected_account_id\)/);
  });

  it("hints and marks carry identifiers and enums only — no text, author, body copy or capability claim", () => {
    const table = (name: string): string => sql0022.slice(sql0022.indexOf(`create table ${name}`), sql0022.indexOf(");", sql0022.indexOf(`create table ${name}`)));
    for (const name of ["system.provider_event_hints", "ingestion.signal_marks"]) {
      const columns = [...table(name).matchAll(/^\s+([a-z_]+)\s+(?:uuid|text|integer|timestamptz|boolean|bytea)/gm)].map((m) => m[1] ?? "");
      expect(columns.length, name).toBeGreaterThan(5);
      for (const column of columns) expect(column, `${name}.${column}`).not.toMatch(/body|text$|message|author|name|username|from|capab|support|coverage|visib|availab/);
    }
    // The body exists in one table only and is never an output of any function.
    expect([...sql0022.matchAll(/\bbody\s+bytea/g)]).toHaveLength(1);
    for (const [name, header] of Object.entries(DEFINERS)) {
      const signature = functionBody(sql0022, header).split("language plpgsql")[0] ?? "";
      expect(signature, name).not.toMatch(/out [a-z_]*body/);
    }
  });

  it("D-F2: routing counts every ACTIVE match without ordering or LIMIT, and refuses more than five as a whole", () => {
    const route = functionBody(sql0022, DEFINERS["system.route_provider_hint"]);
    const matchQuery = route.slice(route.indexOf("into v_accounts, v_orgs, v_spaces"), route.indexOf("v_matches := pg_catalog.cardinality(v_accounts);"));
    expect(matchQuery).toMatch(/a\.status = 'ACTIVE' and a\.asset_class = 'content_bearing'/);
    expect(matchQuery).not.toMatch(/\blimit\b|order by|offset/i);
    expect(route).toMatch(/elsif v_matches > 5 then[\s\S]*?state = 'MULTI_ORG_LIMIT'[\s\S]*?outcome := 'multi_org_limit';[\s\S]*?else\s+insert into system\.outbox/);
    expect(sql0022).toMatch(/routed_count\s+integer check \(routed_count between 1 and 5\)/);
  });

  it("the frozen numbers: 1 MiB body, 1000 hints, 7-day purge, 7-day mark expiry, the F1 bounds", () => {
    expect(MAX_WEBHOOK_BODY_BYTES).toBe(1_048_576);
    expect(MAX_WEBHOOK_CHANGES).toBe(1000);
    expect(sql0022).toMatch(/body_bytes\s+integer not null check \(body_bytes between 0 and 1048576\)/);
    expect(sql0022).toMatch(/pg_catalog\.jsonb_array_length\(p_hints\) > 1000/);
    expect(PROVIDER_EVENT_INBOX_POLICY.rawBodyRetentionDays).toBe(7);
    expect(functionBody(sql0022, DEFINERS["system.purge_provider_events"])).toMatch(/v_cutoff timestamptz := pg_catalog\.statement_timestamp\(\) - interval '7 days';/);
    // Retention is decided at purge time, never a wall-clock CHECK at insert.
    expect(sql0022).not.toMatch(/check \([^)]*now\(\)|check \([^)]*statement_timestamp/);
  });

  it("the internal processing topic is blocked for members and workers, and is not yet a registered task", () => {
    expect(sql0022).toMatch(/create policy no_direct_signal_routing on system\.outbox as restrictive for insert to authenticated, app_worker\s+with check \(topic not in \('ingestion\.process_signals'\)\);/);
    expect(RESTRICTIVE_POLICIES).toContain("system.outbox no_direct_signal_routing");
    expect(PRODUCTION_TASKS.tenant("ingestion.process_signals")).toBeUndefined();
    // Only the two system definers write it; the cross-workspace owner reads are gated on a system login with no workspace.
    expect([...sql0022.matchAll(/'ingestion\.process_signals'/g)].length).toBeGreaterThanOrEqual(3);
    for (const policy of ["owner_signal_route_read", "owner_due_read", "owner_due_update", "owner_signal_dispatch"]) {
      const statement = sql0022.slice(sql0022.indexOf(`create policy ${policy}`), sql0022.indexOf(";", sql0022.indexOf(`create policy ${policy}`)));
      expect(statement, policy).toMatch(/\(select app\.current_workspace\(\)\) is null/);
      expect(statement, policy).toMatch(/pg_catalog\.pg_has_role\(session_user, 'app_system', 'MEMBER'\)/);
    }
  });

  it("no TypeScript calls the new definers yet (the receiver and the jobs are H6-F3/F4)", () => {
    const callers = sourceFiles(["app", "ui", "server", "modules", "platform", "integrations", "jobs"]).filter((file) =>
      /record_provider_webhook|route_provider_hint|dispatch_due_signal_marks|provider_event_hint\(|purge_provider_events|signal_marks/.test(codeOf(file)));
    expect(callers).toEqual([]);
  });
});
