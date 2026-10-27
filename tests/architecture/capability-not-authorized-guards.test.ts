/**
 * Step 7G-H5.5-P4-C — static guards around the profile-only NOT_AUTHORIZED state:
 *   - the database coherence CHECK (migration 0015) admits exactly the application's state ↔ reason mapping, and the
 *     state CHECK exactly the application's profile states;
 *   - no catalog in code can name NOT_AUTHORIZED (types + catalog source), and neither catalog revision moved;
 *   - outside the capability module, no runtime code reads stored profile rows or the overlay's raw inputs: every
 *     consumer goes through capabilityAvailability, so NOT_AUTHORIZED can't be reinterpreted as platform non-support or
 *     as available anywhere else;
 *   - REAUTHORIZED does not (yet) request a capability evaluation: that lifecycle step is a future gate.
 * Behavior is proven in tests/unit/modules/capability-not-authorized.test.ts and on PostgreSQL in
 * tests/db/suites/capability.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_STATES, PLATFORM_CATALOG, PROFILE_STATES, PROFILE_STATE_REASONS, SIMULATOR_CATALOG } from "@/modules/capability";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const MIGRATION = "db/migrations/0015_capability_not_authorized.sql";
const raw = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
const quoted = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");

describe("migration 0015 mirrors the application vocabulary exactly", () => {
  const sql = raw(MIGRATION).replace(/--.*$/gm, "");

  it("the widened state CHECK admits exactly PROFILE_STATES", () => {
    const states = /add constraint profile_entries_state_check check \(state in \(([^)]*)\)\) not valid;/.exec(sql);
    expect(states).not.toBeNull();
    expect(quoted(states?.[1] ?? "").sort()).toEqual([...PROFILE_STATES].sort());
    expect(sql).toMatch(/alter table capability\.profile_entries validate constraint profile_entries_state_check;/);
  });

  it("the coherence CHECK maps every profile state to exactly its admitted reasons, and nothing else", () => {
    const body = /add constraint profile_entries_state_reasons check \(case state([\s\S]*?)end\) not valid;/.exec(sql)?.[1] ?? "";
    const arms = Object.fromEntries([...body.matchAll(/when '([A-Z_]+)' then reason_codes <@ array\[([^\]]*)\]::text\[\]/g)].map((m) => [m[1] ?? "", quoted(m[2] ?? "")]));
    expect(arms).toEqual(Object.fromEntries(Object.entries(PROFILE_STATE_REASONS).map(([state, reasons]) => [state, [...reasons]])));
    expect(body).toMatch(/else false\s*$/);
    expect(sql).toMatch(/alter table capability\.profile_entries validate constraint profile_entries_state_reasons;/);
  });

  it("is additive: no data change, column, index, policy or grant", () => {
    expect(sql).not.toMatch(/\b(insert|update|delete)\b|\badd column\b|\bcreate (unique )?index\b|\bpolicy\b|\bgrant\b|\brevoke\b/i);
  });
});

describe("NOT_AUTHORIZED is profile-only", () => {
  it("the catalog vocabulary excludes it; no catalog entry in code carries it; only published entries (P5-C9-C, P11-E, P12-D2b) moved the platform revision", () => {
    expect(CATALOG_STATES).not.toContain("NOT_AUTHORIZED");
    expect(PROFILE_STATES).toContain("NOT_AUTHORIZED");
    expect(codeOf("modules/capability/domain/catalog.ts")).not.toMatch(/NOT_AUTHORIZED/);
    expect([...PLATFORM_CATALOG.entries, ...SIMULATOR_CATALOG.entries].filter((entry) => !(CATALOG_STATES as readonly string[]).includes(entry.state))).toEqual([]);
    expect([PLATFORM_CATALOG.revision, PLATFORM_CATALOG.label, SIMULATOR_CATALOG.revision, SIMULATOR_CATALOG.label, PLATFORM_CATALOG.entries.length]).toEqual([5, "platform-catalog-r5", 2, "simulator-catalog-r2", 4]);
  });

  it("the evaluator writes NOT_AUTHORIZED only for the two authorization reasons, and UNSUPPORTED only for non-support", () => {
    const profile = codeOf("modules/capability/domain/profile.ts");
    expect([...profile.matchAll(/result\("NOT_AUTHORIZED", \["([A-Z_]+)"\]/g)].map((m) => m[1])).toEqual(["ACCOUNT_PERMISSION_MISSING", "OBSERVED_PERMISSION_MISSING"]);
    expect([...profile.matchAll(/result\("UNSUPPORTED", \["([A-Z_]+)"\]/g)].map((m) => m[1])).toEqual(["CATALOG_UNSUPPORTED", "OBSERVED_NOT_ELIGIBLE"]);
  });
});

describe("consumers go through capabilityAvailability", () => {
  const RUNTIME_ROOTS = ["app", "ui", "server", "domain", "integrations", "jobs", "platform", "tools", "mutations", "ai", "modules"];
  const outside = (): string[] => sourceFiles(RUNTIME_ROOTS).filter((file) => !file.startsWith("modules/capability/"));

  it("no runtime code outside the capability module reads stored profile rows or the overlay's raw inputs", () => {
    const hits = outside().filter((file) => /profile_entries|profileEntries|\bbaseState\b|\beffectiveAvailability\b|\bresolveEntry\b|\bevaluateProfile\b|\.entries\.find\(.*state/.test(codeOf(file)));
    expect(hits).toEqual([]);
  });

  it("no runtime code outside the capability module branches on a profile state (it consumes availability reasons)", () => {
    const hits = outside().filter((file) => /["'`](NOT_AUTHORIZED|UNSUPPORTED|UNKNOWN_NOT_VALIDATED)["'`]/.test(codeOf(file)));
    expect(hits).toEqual([]);
  });

  it("REAUTHORIZED itself requests no capability evaluation and no manual re-check: the refresh is emitted only by that credential's validated discovery (AUTO_REEVALUATE_AFTER_REAUTHORIZED = IMPLEMENTED_VIA_VALIDATED_DISCOVERY)", () => {
    const authorization = codeOf("modules/connections/application/authorization.ts");
    expect(authorization).toMatch(/"REAUTHORIZED"/);
    expect(authorization).not.toMatch(/capabilityEvaluationRequest|capability\.evaluate_account|requestCapabilityReevaluation/);
    // The one producer of credential-reason requests is the validated-discovery refresh (Step 7G-H5.5-P12-C0-R1), never the human re-check.
    const discovery = codeOf("modules/connections/application/discovery.ts");
    expect(discovery).toMatch(/reason: \{ kind: "credential", credentialId: refresh\.credentialId \}/);
    expect(discovery).not.toMatch(/requestCapabilityReevaluation|REEVALUATION_REQUESTED/);
  });
});
