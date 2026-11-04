/**
 * Step H7-production-kill-switch-tooling — the operator switch command: explicit target, production confirmation,
 * exact plan, idempotent audited writes, "nothing else moved" verification. No database: a scripted fake client.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT, loadTargetEnvironment, prepareTarget } from "@/tools/db/environment";
import { describeResolution, parseSwitchCommand, planSwitchChange, type SwitchCommand } from "@/tools/ops/switch-command";
import { clearSwitch, readSwitchRow, setSwitch, snapshotSwitches, unexpectedChanges, type Queryable, type SwitchRow } from "@/tools/ops/switches";
import { codeOf } from "../../support/source-scan";

const KILL = ["--key", "ai.task_kill", "--qualifier", "classification_understanding", "--scope", "global"];
const ATTR = ["--operator", "tl@wrenkind", "--reason", "release"];
const ACTIVE = ["--value", '{"active":true}'];
const kill = (value: unknown): SwitchRow => ({ switchKey: "ai.task_kill", qualifier: "classification_understanding", scope: "global", organizationId: null, workspaceId: null, value });
const other = (value: unknown): SwitchRow => ({ switchKey: "ingestion.provider_pause", qualifier: "tiktok", scope: "global", organizationId: null, workspaceId: null, value });
const parse = (...argv: string[]) => parseSwitchCommand(argv);
/** Asserts a refusal whose problem matches `expected` (a string is matched exactly). */
const refuses = (parsed: ReturnType<typeof parseSwitchCommand>, expected: RegExp | string): void => {
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  if (typeof expected === "string") expect(parsed.problem).toBe(expected);
  else expect(parsed.problem).toMatch(expected);
};
const command = (...argv: string[]): SwitchCommand => {
  const parsed = parse(...argv);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.command;
};

/** A fake client: records every statement; answers `select … same` and row reads from a script. */
function fakeClient(script: { same?: boolean; row?: SwitchRow; failOn?: RegExp } = {}): Queryable & { readonly statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    query(text: string) {
      statements.push(text.replace(/\s+/g, " ").trim());
      if (script.failOn?.test(text)) return Promise.reject(Object.assign(new Error("boom"), { code: "XX000" }));
      if (/\) as same from/.test(text)) return Promise.resolve({ rowCount: script.same === undefined ? 0 : 1, rows: script.same === undefined ? [] : [{ same: script.same }] });
      if (/^select switch_key/.test(text.trim())) {
        const row = script.row;
        return Promise.resolve({ rowCount: row ? 1 : 0, rows: row ? [{ switch_key: row.switchKey, qualifier: row.qualifier, scope: row.scope, organization_id: row.organizationId, workspace_id: row.workspaceId, value: row.value }] : [] });
      }
      if (/^delete/.test(text.trim())) return Promise.resolve({ rowCount: script.row ? 1 : 0, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    },
  };
}

describe("ops:switch — argument contract (nothing is contacted when these refuse)", () => {
  it("1. requires exactly one explicit --target development|production", () => {
    refuses(parse("set", ...KILL, ...ACTIVE, ...ATTR), /exactly one --target/);
    refuses(parse("set", "--target", "staging", ...KILL, ...ACTIVE, ...ATTR), /exactly one --target/);
    refuses(parse("set", "--target", "development", "--target", "production", ...KILL, ...ACTIVE, ...ATTR), /exactly one --target/);
    expect(parse("set", "--target", "production", ...KILL, ...ACTIVE, ...ATTR)).toMatchObject({ ok: true, command: { databaseTarget: "production", apply: false } });
    expect(parse("set", "--target=development", ...KILL, ...ACTIVE, ...ATTR)).toMatchObject({ ok: true, command: { databaseTarget: "development" } });
  });

  it("2. a production write needs --apply AND --confirm-production; the confirmation is refused on development", () => {
    refuses(parse("set", "--target", "production", "--apply", ...KILL, ...ACTIVE, ...ATTR), /requires --confirm-production/);
    expect(parse("set", "--target", "production", "--apply", "--confirm-production", ...KILL, ...ACTIVE, ...ATTR)).toMatchObject({ ok: true, command: { apply: true, confirmProduction: true } });
    refuses(parse("set", "--target", "development", "--apply", "--confirm-production", ...KILL, ...ACTIVE, ...ATTR), /only meaningful with --target production/);
    expect(parse("set", "--target", "development", "--apply", ...KILL, ...ACTIVE, ...ATTR)).toMatchObject({ ok: true, command: { apply: true, confirmProduction: false } });
  });

  it("3. one switch per invocation, validated against the registry; attribution and value shape are mandatory", () => {
    refuses(parse("set", "--target", "production", "--key", "ai.task_kill", "--scope", "workspace", "--workspace", "5eed2e00-0000-4000-8000-000000000001", ...ACTIVE, ...ATTR), /scope not allowed/);
    refuses(parse("set", "--target", "production", "--key", "ai.kill_all", "--scope", "global", ...ACTIVE, ...ATTR), "unknown switch key");
    refuses(parse("set", "--target", "production", ...KILL, "--value", '{"active":"yes"}', ...ATTR), /value shape/);
    refuses(parse("set", "--target", "production", ...KILL, "--value", "not json", ...ATTR), "--value must be JSON");
    refuses(parse("set", "--target", "production", ...KILL, ...ACTIVE, "--operator", "tl@wrenkind", "--reason", "because"), /--reason must be one of/);
    refuses(parse("set", "--target", "production", ...KILL, ...ACTIVE, "--reason", "release"), /--operator is required/);
    refuses(parse("clear", "--target", "production", ...KILL, ...ACTIVE, ...ATTR), "clear takes no --value");
    refuses(parse("toggle", "--target", "production", ...KILL), /action must be one of/);
    refuses(parse("set", "--target", "production", ...KILL, ...ACTIVE, ...ATTR, "--force"), "unknown or malformed argument");
    refuses(parse("set", "extra", "--target", "production", ...KILL, ...ACTIVE, ...ATTR), /action must be one of/);
  });

  it("4. show is read-only: defaults to the global scope and refuses write flags", () => {
    expect(parse("show", "--target", "production", "--key", "ai.task_kill", "--qualifier", "classification_understanding")).toMatchObject({ ok: true, command: { action: "show", apply: false, target: { scope: "global" } } });
    refuses(parse("show", "--target", "production", ...KILL, "--apply"), /show is read-only/);
    refuses(parse("show", "--target", "production", ...KILL, ...ATTR), /show is read-only/);
  });
});

describe("ops:switch — the exact plan from the stored row", () => {
  const set = command("set", "--target", "production", ...KILL, ...ACTIVE, ...ATTR);
  const clear = command("clear", "--target", "production", ...KILL, ...ATTR);

  it("5. absent → create; same value → unchanged (no write); different value → replace", () => {
    expect(planSwitchChange(set, undefined)).toMatchObject({ outcome: "create", writes: true });
    expect(planSwitchChange(set, kill({ active: true }))).toMatchObject({ outcome: "unchanged", writes: false });
    expect(planSwitchChange(set, kill({ active: false }))).toMatchObject({ outcome: "replace", writes: true });
    expect(planSwitchChange(set, kill({ active: true })).lines.join("\n")).toMatch(/NOTHING TO DO \(idempotent\)/);
    expect(planSwitchChange(set, undefined).lines.join("\n")).toMatch(/\(absent\) → \{"active":true\}/);
  });

  it("6. clear: existing → clear; absent → nothing to do", () => {
    expect(planSwitchChange(clear, kill({ active: true }))).toMatchObject({ outcome: "clear", writes: true });
    expect(planSwitchChange(clear, undefined)).toMatchObject({ outcome: "absent", writes: false });
  });

  it("7. the runtime's view: no row → default (not killed); the planned row → killed; a '*' row also kills (any_restrictive)", () => {
    expect(describeResolution([], set.target)).toMatch(/→ \{"active":false\} \(source: default\)/);
    expect(describeResolution([kill({ active: true })], set.target)).toMatch(/→ \{"active":true\} \(source: global\)/);
    expect(describeResolution([{ ...kill({ active: true }), qualifier: "*" }], set.target)).toMatch(/→ \{"active":true\}/);
    expect(describeResolution([kill({ active: "yes" })], set.target)).toMatch(/FAIL-SAFE/);
  });
});

describe("ops:switch — audited, idempotent writes and the nothing-else-moved oracle", () => {
  const target = command("set", "--target", "production", ...KILL, ...ACTIVE, ...ATTR).target;
  const attribution = { operator: "tl@wrenkind", reason: "release" as const };

  it("8. an identical stored value writes nothing: lock, compare, commit — no insert, no history", async () => {
    const client = fakeClient({ same: true });
    expect(await setSwitch(client, target, { active: true }, attribution)).toEqual({ changed: false });
    expect(client.statements.filter((s) => /^insert/.test(s))).toEqual([]);
    expect(client.statements[0]).toBe("begin");
    expect(client.statements[1]).toMatch(/set_config\('app\.operator_id'/);
    expect(client.statements.at(-1)).toBe("commit");
  });

  it("9. absent or different → one upsert inside the audited transaction, exactly the targeted identity", async () => {
    for (const same of [undefined, false]) {
      const client = fakeClient(same === undefined ? {} : { same });
      expect(await setSwitch(client, target, { active: true }, attribution)).toEqual({ changed: true });
      const inserts = client.statements.filter((s) => /^insert/.test(s));
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toMatch(/on conflict \(switch_key, qualifier, scope, organization_id, workspace_id\)/);
      expect(client.statements.indexOf(inserts[0] ?? "")).toBeGreaterThan(client.statements.findIndex((s) => /set_config/.test(s)));
    }
  });

  it("10. a failure inside the transaction rolls back and surfaces; nothing commits", async () => {
    const client = fakeClient({ same: false, failOn: /^\s*insert/ });
    await expect(setSwitch(client, target, { active: true }, attribution)).rejects.toMatchObject({ code: "XX000" });
    expect(client.statements.at(-1)).toBe("rollback");
    expect(client.statements).not.toContain("commit");
  });

  it("11. clear deletes exactly the targeted identity; invalid attribution is refused before BEGIN", async () => {
    const client = fakeClient({ row: kill({ active: true }) });
    expect(await clearSwitch(client, target, attribution)).toBe(true);
    expect(client.statements.filter((s) => /^delete/.test(s))[0]).toMatch(/organization_id is not distinct from \$4::uuid and workspace_id is not distinct from \$5::uuid/);
    const untouched = fakeClient();
    await expect(setSwitch(untouched, target, { active: true }, { operator: "x", reason: "release" })).rejects.toThrow(/operator id is not valid/);
    expect(untouched.statements).toEqual([]);
  });

  it("12. readSwitchRow / snapshotSwitches map rows; unexpectedChanges ignores the target and flags anything else", async () => {
    expect(await readSwitchRow(fakeClient({ row: kill({ active: true }) }), target)).toEqual(kill({ active: true }));
    expect(await readSwitchRow(fakeClient(), target)).toBeUndefined();
    expect(await snapshotSwitches(fakeClient({ row: other({ paused: true }) }))).toEqual([other({ paused: true })]);
    expect(unexpectedChanges([], [kill({ active: true })], target)).toEqual([]);
    expect(unexpectedChanges([kill({ active: false })], [kill({ active: true })], target)).toEqual([]);
    expect(unexpectedChanges([other({ paused: true })], [other({ paused: true }), kill({ active: true })], target)).toEqual([]);
    expect(unexpectedChanges([other({ paused: true })], [kill({ active: true })], target)).toHaveLength(1);
    expect(unexpectedChanges([other({ paused: true })], [other({ paused: false }), kill({ active: true })], target)).toHaveLength(1);
    expect(unexpectedChanges([], [other({ paused: true }), kill({ active: true })], target)).toHaveLength(1);
  });
});

describe("ops:switch — the CLI stands behind the database target fence", () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  it("13. production never falls back: an empty root refuses before any connection; development reads .env.local only", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wk-switch-"));
    roots.push(root);
    const production = prepareTarget(["--target", "production"], { migration: true, runtime: [] }, { root, processEnv: { DATABASE_MIGRATION_URL: "postgresql://postgres.devdevdevdevdevdevde:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres" } });
    expect(production.ok).toBe(false);
    expect(production.lines.join("\n")).toMatch(/never falls back to the development configuration/);
    const development = prepareTarget(["--target", "development"], { migration: true, runtime: [] }, { root, processEnv: {} });
    expect(development.ok).toBe(false);
  });

  it("14. the CLI uses the target fence (never the development-only loader), reads before it plans, and verifies after it writes", () => {
    const cli = codeOf("tools/ops/switch.ts");
    expect(cli).toMatch(/parseSwitchCommand\(process\.argv\.slice\(2\)\)/);
    expect(cli).toMatch(/prepareTarget\(\["--target", command\.databaseTarget\]/);
    expect(cli).not.toMatch(/loadEnvironment\(|EXPECTED_PROJECT_LABEL|\.env\.local/);
    expect(cli.indexOf("begin read only")).toBeLessThan(cli.indexOf("planSwitchChange(command, current)"));
    expect(cli.indexOf("setSwitch(")).toBeLessThan(cli.indexOf("unexpectedChanges(before, snapshot"));
    expect(cli).toMatch(/if \(status\.pending\.length > 0\) fail\(/);
    expect(cli).not.toMatch(/console\.log\([^)]*(password|DATABASE_[A-Z_]*URL\b[^_])/);
  });

  it("15. spawned without a target, with --apply on production without confirmation, or with the confirmation on development: REFUSED, nothing contacted", () => {
    const cases = [
      ["set", ...KILL, ...ACTIVE, ...ATTR, "--apply"],
      ["set", "--target", "production", ...KILL, ...ACTIVE, ...ATTR, "--apply"],
      ["set", "--target", "development", ...KILL, ...ACTIVE, ...ATTR, "--apply", "--confirm-production"],
      ["show", "--target", "staging", ...KILL],
    ];
    for (const args of cases) {
      const run = spawnSync(process.execPath, [path.join(ROOT, "tools/ops/switch.ts"), ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" }, timeout: 20_000 });
      expect(run.status, args.join(" ")).toBe(1);
      expect(run.stdout, args.join(" ")).toMatch(/^REFUSED: .*Nothing was contacted\./m);
      expect(run.stdout).not.toMatch(/APPLIED|DRY RUN|stored/);
    }
  });

  it("16. without a development configuration, a development dry run refuses at the fence (covers CI)", () => {
    if (loadTargetEnvironment("development").found) return; // an operator machine: the fence itself is covered by tests/unit/tools/db-target.test.ts
    const run = spawnSync(process.execPath, [path.join(ROOT, "tools/ops/switch.ts"), "set", "--target", "development", ...KILL, ...ACTIVE, ...ATTR], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" }, timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/REFUSED: configuration incomplete or unsafe\. Nothing was contacted\./);
  });

  it("17. the README documents the explicit target and the production confirmation", () => {
    const readme = codeOf("README.md");
    expect(readme).toMatch(/ops:switch -- (set|show)[^\n]*--target/);
    expect(readme).toMatch(/--confirm-production/);
    expect(readme).toMatch(/ai\.task_kill/);
  });
});
