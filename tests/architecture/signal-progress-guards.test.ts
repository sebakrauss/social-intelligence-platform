/**
 * Step H6-F4b — static guards around migration 0023 (TL D-F4B-1 … D-F4B-6): its exact objects, and what it must never do.
 *   - persistence only: no row is inserted, updated or deleted at the top level (no historical outbox/audit/business
 *     mutation); no outbox or restrictive policy is touched; no outbox read and no runtime table grant is added;
 *   - no provider, network or dynamic SQL; the function bodies write signal marks only (never canonical state, coverage
 *     or a watermark), and the parked cursor never leaves its slice;
 *   - confirmed_through_at is a column distinct from read_started_at, and only the definers move either.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT } from "../support/source-scan";

const SQL = readFileSync(path.join(REPOSITORY_ROOT, "db/migrations/0023_resumable_signal_progress.sql"), "utf8");
const code = SQL.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();
const topLevel = code.replace(/\$\$[\s\S]*?\$\$/g, " ");
const bodies = [...code.matchAll(/create function ([a-z_]+\.[a-z_]+)\([\s\S]*?\$\$([\s\S]*?)\$\$/g)].map((m) => ({ name: m[1] ?? "", body: m[2] ?? "" }));

describe("H6-F4b: 0023's exact objects", () => {
  it("creates exactly two columns on slices, three on marks, two triggers, four definers, three owner policies and two indexes", () => {
    expect([...topLevel.matchAll(/alter table ([a-z_.]+) add column ([a-z_]+)/g)].map((m) => `${m[1] ?? ""}.${m[2] ?? ""}`)).toEqual([
      "ingestion.reconciliation_slices.cursor_parked_at", "ingestion.signal_marks.interaction_id", "ingestion.signal_marks.read_started_at", "ingestion.signal_marks.confirmed_through_at",
    ]);
    expect(bodies.map((b) => b.name)).toEqual([
      "ingestion.reconciliation_slice_park_cursor", "ingestion.signal_mark_confirmation_guard", "ingestion.claim_signal_confirmation",
      "ingestion.begin_signal_confirmation_read", "ingestion.complete_signal_confirmation_read", "system.expire_signal_marks",
    ]);
    expect([...topLevel.matchAll(/create trigger ([a-z_]+) before insert or update on ([a-z_.]+)/g)].map((m) => `${m[2] ?? ""} ${m[1] ?? ""}`)).toEqual([
      "ingestion.reconciliation_slices reconciliation_slice_park_cursor", "ingestion.signal_marks signal_mark_confirmation_guard",
    ]);
    expect([...topLevel.matchAll(/create policy ([a-z_]+) on ([a-z_.]+)( as restrictive)? for ([a-z]+) to ([a-z_]+)/g)].map((m) => `${m[2] ?? ""} ${m[1] ?? ""} ${m[4] ?? ""} ${m[5] ?? ""}${m[3] ?? ""}`)).toEqual([
      "ingestion.signal_marks owner_confirm_read select app_owner", "ingestion.signal_marks owner_confirm_update update app_owner", "ingestion.signal_marks owner_expiry_delete delete app_owner",
    ]);
    expect([...topLevel.matchAll(/create (unique )?index ([a-z_]+) on ([a-z_.]+)/g)].map((m) => `${m[3] ?? ""} ${m[2] ?? ""}${m[1] === undefined ? "" : " unique"}`)).toEqual([
      "ingestion.reconciliation_slices reconciliation_slices_one_parked unique", "ingestion.signal_marks signal_marks_by_expiry",
    ]);
    expect([...topLevel.matchAll(/grant [^;]*;/g)].map((m) => m[0])).toEqual([
      "grant execute on function ingestion.claim_signal_confirmation(uuid, uuid) to app_worker;",
      "grant execute on function ingestion.begin_signal_confirmation_read(uuid, uuid) to app_worker;",
      "grant execute on function ingestion.complete_signal_confirmation_read(uuid, uuid, timestamptz) to app_worker;",
      "grant execute on function system.expire_signal_marks(integer) to app_system;",
    ]);
  });

  it("is persistence only: no top-level DML, no outbox or restrictive policy, no outbox read, no provider or network surface", () => {
    expect(topLevel).not.toMatch(/\binsert into\b|\bupdate [a-z_]+\.[a-z_]+ set\b|\bdelete from\b|\btruncate\b/);
    expect(code).not.toMatch(/system\.outbox|as restrictive|no_direct_|grant select|to authenticated|to anon|service_role/);
    // No network extension or dynamic SQL (the only EXECUTE clauses are the triggers' `execute function`).
    expect(code).not.toMatch(/\bhttp|pg_net|dblink|\bnet\.http|\bcopy \S+ (from|to)\b|execute (format|'|v_|p_|\$)/);
    expect([...code.matchAll(/\bexecute ([a-z]+)/g)].map((m) => m[1]).every((word) => word === "function" || word === "on")).toBe(true);
    for (const { name, body } of bodies) {
      // Writes, if any, are to signal marks only — never canonical rows, coverage, watermarks, runs or the outbox.
      const writes = [...body.matchAll(/\b(?:insert into|update|delete from) ([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]);
      for (const target of writes) expect(target, name).toBe("ingestion.signal_marks");
      expect(body, name).not.toMatch(/interactions\.interactions|content\.content_items|conversations\.|coverage\.|reconciliation_watermarks|reconciliation_runs|source_text|state_observations/);
    }
    for (const definer of ["ingestion.claim_signal_confirmation", "ingestion.begin_signal_confirmation_read", "ingestion.complete_signal_confirmation_read", "system.expire_signal_marks"]) {
      expect(code).toMatch(new RegExp(`create function ${definer.replace(".", "\\.")}\\([^$]*language plpgsql volatile security definer set search_path = '' as \\$\\$`));
      expect(code).toMatch(new RegExp(`revoke all on function ${definer.replace(".", "\\.")}\\([^)]*\\) from public;`));
    }
  });

  it("the cursor stays on its slice; confirmations have two distinct DB-time columns; the cooldown is fixed in the database", () => {
    const [partA = "", rest = ""] = SQL.split("-- ── B. confirmation marks");
    expect(rest.replace(/--[^\n]*/g, "")).not.toMatch(/cursor/i);
    expect(partA).toMatch(/new\.cursor_parked_at := pg_catalog\.statement_timestamp\(\);/);
    expect(code).toMatch(/add column read_started_at timestamptz;/);
    expect(code).toMatch(/add column confirmed_through_at timestamptz;/);
    expect(code).toMatch(/confirmed_through_at is null or \(read_started_at is not null and confirmed_through_at <= read_started_at\)/);
    expect(code).toMatch(/deferred_until = v_at \+ interval '5 minutes'/);
    expect(code).toMatch(/v_at timestamptz := pg_catalog\.statement_timestamp\(\);/);
    // Only the definers move the claim counter and the confirmation times (no runtime UPDATE grant in 0023).
    expect(code).not.toMatch(/grant update/);
    // The expiry reads only stored state against the DB clock and never joins an account.
    const expiry = bodies.find((b) => b.name === "system.expire_signal_marks")?.body ?? "";
    expect(expiry).toMatch(/where m\.expires_at <= v_at/);
    expect(expiry).toMatch(/for update skip locked/);
    expect(expiry).not.toMatch(/connected_accounts|status/);
  });
});
