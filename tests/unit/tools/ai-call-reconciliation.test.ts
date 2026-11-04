/**
 * Step H7-ops-tooling-production-parity — the READ-ONLY AI call reconciliation is target-aware and stands behind the
 * database target fence. Pure apart from a temporary directory; every reference, password and CA is synthetic.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CALL_ACCOUNTING_SQL } from "@/tools/db/ai-call-accounting";
import { parseReconciliationArguments } from "@/tools/db/ai-call-reconciliation-args";
import { ROOT, TARGET_CONFIG_FILES, loadTargetEnvironment, prepareTarget } from "@/tools/db/environment";
import { codeOf } from "../../support/source-scan";

const DEV = "devdevdevdevdevdevde";
const PROD = "prodprodprodprodprod";
const PIN = createHash("sha256").update(DEV, "utf8").digest("hex");
const PASSWORD = "synthetic-password-never-echoed";
const migration = (ref: string, region = "sa-east-1"): string => `postgresql://postgres.${ref}:${PASSWORD}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
const PEM = `-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUSyntheticTestBodyAAAAAAAAAAAAAAAAAAAAAAAAAAA\nU3ludGhldGljQ2VydGlmaWNhdGVCb2R5Rm9yVGVzdHNPbmx5\n-----END CERTIFICATE-----\n`;
const roots: string[] = [];
function root(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wk-recon-"));
  roots.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}
const envFile = (values: Readonly<Record<string, string>>): string => Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
const productionFile = (overrides: Readonly<Record<string, string>> = {}): string => envFile({
  DATABASE_ENVIRONMENT_CLASS: "production", DATABASE_EXPECTED_PROJECT_REF: PROD, DATABASE_EXPECTED_REGION: "sa-east-1", SUPABASE_PROJECT_REF: PROD,
  DATABASE_SSL_ROOT_CERT: "ca.crt", DATABASE_MIGRATION_URL: migration(PROD), ...overrides,
});
const fence = (target: "development" | "production", dir: string, processEnv: Readonly<Record<string, string>> = {}) =>
  prepareTarget(["--target", target], { migration: true, runtime: [] }, { root: dir, processEnv, developmentPin: PIN });
const refusedWith = (result: ReturnType<typeof prepareTarget>, pattern: RegExp): void => {
  expect(result.ok).toBe(false);
  const text = result.lines.join("\n");
  expect(text).toMatch(pattern);
  for (const secret of [PASSWORD, PEM, "postgresql://", DEV, PROD]) expect(text).not.toContain(secret);
};
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

describe("ai-call-reconciliation — arguments (refused before any connection)", () => {
  it("1. --target is mandatory and closed; --stale-minutes is bounded; --rows is the only other flag", () => {
    expect(parseReconciliationArguments([])).toMatchObject({ ok: false, problem: "--target development|production is required" });
    expect(parseReconciliationArguments(["--target", "staging"])).toMatchObject({ ok: false, problem: "--target must be one of development, production" });
    expect(parseReconciliationArguments(["--target", "development", "--target", "production"])).toMatchObject({ ok: false, problem: "--target was given more than once" });
    expect(parseReconciliationArguments(["--target", "production"])).toEqual({ ok: true, value: { target: "production", staleMinutes: 15, rows: false } });
    expect(parseReconciliationArguments(["--target=development", "--stale-minutes", "60", "--rows"])).toEqual({ ok: true, value: { target: "development", staleMinutes: 60, rows: true } });
    expect(parseReconciliationArguments(["--target", "production", "--stale-minutes=1440"])).toMatchObject({ ok: true, value: { staleMinutes: 1440 } });
    for (const bad of ["0", "1441", "-5", "abc", "1.5"]) expect(parseReconciliationArguments(["--target", "production", "--stale-minutes", bad]), bad).toMatchObject({ ok: false, problem: "--stale-minutes must be an integer from 1 to 1440" });
    expect(parseReconciliationArguments(["--target", "production", "--apply"])).toMatchObject({ ok: false, problem: "unknown argument" });
    expect(parseReconciliationArguments(["--target", "production", "--rows", "extra"])).toMatchObject({ ok: false, problem: "unknown argument" });
  });

  it("2. the CLI stands behind the target fence, opens one READ ONLY transaction, and the SQL only reads", () => {
    const cli = codeOf("tools/db/ai-call-reconciliation.ts");
    expect(cli).toMatch(/prepareTarget\(\["--target", target\], \{ migration: true, runtime: \[\] \}\)/);
    expect(cli).not.toMatch(/loadEnvironment\(|checkTarget\(|readCa\(/);
    expect(cli).toMatch(/begin read only/);
    expect(cli.indexOf("begin read only")).toBeLessThan(cli.indexOf("query<CallAccountingRow>(CALL_ACCOUNTING_SQL"));
    expect(cli).not.toMatch(/\b(insert|update|delete|commit)\b/i);
    expect(CALL_ACCOUNTING_SQL).not.toMatch(/\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|set_config|pg_advisory)\b/i);
    expect(CALL_ACCOUNTING_SQL).not.toMatch(/source_text|summary|prompt|response|reasoning/i);
    // Row output is a closed set of identifiers, enums and times.
    const rowKeys = [...cli.matchAll(/\b(\w+): (?:row\.\w+|new Date\(row\.\w+\)\.toISOString\(\))/g)].map((m) => m[1]);
    expect(rowKeys.sort()).toEqual(["attempt", "attemptOutcome", "createdAt", "generation", "intent", "kind", "request", "requestGeneration", "requestState", "state"]);
    expect(cli).not.toMatch(/console\.log\([^)]*(password|DATABASE_\w*URL\b[^_]|fence\.env|target\.host)/);
  });
});

describe("ai-call-reconciliation — the target fence it inherits", () => {
  it("3. wrong or missing target configuration: production never falls back to development", () => {
    const dir = root({ ".env.local": envFile({ SUPABASE_PROJECT_REF: DEV, DATABASE_MIGRATION_URL: migration(DEV), DATABASE_SSL_ROOT_CERT: "ca.crt" }), "ca.crt": PEM });
    refusedWith(fence("production", dir, { DATABASE_MIGRATION_URL: migration(DEV) }), /never falls back to the development configuration/);
    expect(fence("development", dir).ok).toBe(true);
  });

  it("4. partial production configuration is refused (missing class, ref or region)", () => {
    for (const missing of ["DATABASE_ENVIRONMENT_CLASS", "DATABASE_EXPECTED_PROJECT_REF", "DATABASE_EXPECTED_REGION"]) {
      const file = productionFile().split("\n").filter((line) => !line.startsWith(`${missing}=`)).join("\n");
      const dir = root({ [TARGET_CONFIG_FILES.production]: file, "ca.crt": PEM });
      expect(fence("production", dir).ok, missing).toBe(false);
    }
  });

  it("5. an invalid or missing CA is refused before any connection (TLS is always verified for managed endpoints)", () => {
    refusedWith(fence("production", root({ [TARGET_CONFIG_FILES.production]: productionFile(), "ca.crt": "not a certificate" })), /not a PEM CA certificate bundle/);
    refusedWith(fence("production", root({ [TARGET_CONFIG_FILES.production]: productionFile() })), /DATABASE_SSL_ROOT_CERT/);
    expect(fence("production", root({ [TARGET_CONFIG_FILES.production]: productionFile(), "ca.crt": PEM })).ok).toBe(true);
  });

  it("6. crossed identities are refused: production authority with the development project's URL, a foreign ref, a wrong region", () => {
    refusedWith(fence("production", root({ [TARGET_CONFIG_FILES.production]: productionFile({ DATABASE_MIGRATION_URL: migration(DEV) }), "ca.crt": PEM })), /DATABASE_MIGRATION_URL/);
    refusedWith(fence("production", root({ [TARGET_CONFIG_FILES.production]: productionFile({ DATABASE_EXPECTED_PROJECT_REF: DEV, SUPABASE_PROJECT_REF: DEV, DATABASE_MIGRATION_URL: migration(DEV) }), "ca.crt": PEM })), /development project/);
    refusedWith(fence("production", root({ [TARGET_CONFIG_FILES.production]: productionFile({ DATABASE_MIGRATION_URL: migration(PROD, "us-east-1") }), "ca.crt": PEM })), /region/);
    refusedWith(fence("development", root({ ".env.local": envFile({ SUPABASE_PROJECT_REF: PROD, DATABASE_MIGRATION_URL: migration(PROD), DATABASE_SSL_ROOT_CERT: "ca.crt" }), "ca.crt": PEM })), /SUPABASE_PROJECT_REF|development/);
  });

  it("7. spawned without a target, with an unknown target or an unknown flag: REFUSED, nothing contacted", () => {
    for (const args of [[], ["--target", "staging"], ["--target", "production", "--apply"], ["--rows"]]) {
      const run = spawnSync(process.execPath, [path.join(ROOT, "tools/db/ai-call-reconciliation.ts"), ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" }, timeout: 20_000 });
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stdout, args.join(" ")).toMatch(/^REFUSED: .*Nothing was contacted\./m);
      expect(run.stdout).not.toMatch(/intents|staleMinutes/);
    }
  });

  it("8. without a development configuration a development run refuses at the fence (covers CI)", () => {
    if (loadTargetEnvironment("development").found) return; // an operator machine: the fence itself is covered above
    const run = spawnSync(process.execPath, [path.join(ROOT, "tools/db/ai-call-reconciliation.ts"), "--target", "development"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" }, timeout: 20_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/REFUSED: target configuration incomplete or unsafe\. Nothing was contacted\./);
  });
});
