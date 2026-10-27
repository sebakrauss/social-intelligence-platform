/**
 * Step 7G-H5.5-P12-D2a — static guards around the REPLIES_NOT_READ limitation:
 *   - migration 0016 widens the limitation-code CHECK to exactly the application's LIMITATION_CODES, keeping every code
 *     0009 admitted, and changes nothing else (no data, column, index, policy, grant; no other constraint);
 *   - the vocabulary gains exactly one code and no state; no catalog in code names it yet (catalog r5 is a later gate),
 *     so neither catalog revision moved.
 * Behavior on PostgreSQL is proven in tests/db/suites/capability.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_STATES, LIMITATION_CODES, PLATFORM_CATALOG, PROFILE_STATES, SIMULATOR_CATALOG } from "@/modules/capability";
import { REPOSITORY_ROOT, codeOf } from "../support/source-scan";

const MIGRATION = "db/migrations/0016_capability_replies_not_read.sql";
const raw = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
const quoted = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");

describe("migration 0016 mirrors the limitation vocabulary exactly", () => {
  const sql = raw(MIGRATION).replace(/--.*$/gm, "");

  it("the widened CHECK admits exactly LIMITATION_CODES, a superset of what 0009 admitted", () => {
    const widened = /add constraint profile_entries_limitation_code_check check \(limitation_code in \(([^)]*)\)\) not valid;/.exec(sql);
    expect(widened).not.toBeNull();
    expect(quoted(widened?.[1] ?? "").sort()).toEqual([...LIMITATION_CODES].sort());
    const original = /limitation_code\s+text check \(limitation_code in \(([^)]*)\)\)/.exec(raw("db/migrations/0009_capability_profiles.sql"));
    expect(original).not.toBeNull();
    for (const code of quoted(original?.[1] ?? "")) expect(LIMITATION_CODES).toContain(code);
    expect(sql).toMatch(/alter table capability\.profile_entries drop constraint profile_entries_limitation_code_check;/);
    expect(sql).toMatch(/alter table capability\.profile_entries validate constraint profile_entries_limitation_code_check;/);
  });

  it("is a pure CHECK widening: one constraint, no data change, column, index, policy or grant", () => {
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate)\b|\badd column\b|\bdrop column\b|\bcreate (unique )?index\b|\bpolicy\b|\bgrant\b|\brevoke\b|\bfunction\b|\b(create|alter|drop) role\b/i);
    expect(sql.match(/^(set|reset) role\b.*$/gm)).toEqual(["set role app_owner;", "reset role;"]);
    expect([...sql.matchAll(/constraint (\w+)/g)].map((m) => m[1])).toEqual(["profile_entries_limitation_code_check", "profile_entries_limitation_code_check", "profile_entries_limitation_code_check"]);
    expect(sql.match(/^alter table /gm)).toHaveLength(3);
  });
});

describe("REPLIES_NOT_READ: one code, no state, not yet in any catalog", () => {
  it("the vocabulary gains exactly REPLIES_NOT_READ; the states are unchanged", () => {
    expect(LIMITATION_CODES).toEqual(["HISTORY_DEPTH_LIMITED", "HIDE_VISIBLE_TO_AUTHOR", "REPLIES_NOT_READ"]);
    expect(CATALOG_STATES).toEqual(["SUPPORTED", "AVAILABLE_WITH_LIMITATION", "UNSUPPORTED", "UNKNOWN_NOT_VALIDATED"]);
    expect(PROFILE_STATES).toEqual(["SUPPORTED", "AVAILABLE_WITH_LIMITATION", "UNSUPPORTED", "NOT_AUTHORIZED", "UNKNOWN_NOT_VALIDATED"]);
  });

  it("no catalog names it and neither catalog revision moved (catalog r5 is a later gate)", () => {
    expect(codeOf("modules/capability/domain/catalog.ts")).not.toMatch(/REPLIES_NOT_READ/);
    expect([...PLATFORM_CATALOG.entries, ...SIMULATOR_CATALOG.entries].filter((entry) => entry.limitation?.code === "REPLIES_NOT_READ")).toEqual([]);
    expect([PLATFORM_CATALOG.revision, PLATFORM_CATALOG.entries.length, SIMULATOR_CATALOG.revision]).toEqual([4, 2, 2]);
  });
});
