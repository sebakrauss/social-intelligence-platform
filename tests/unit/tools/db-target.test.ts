/**
 * Step H7-production-data-plane-guard — explicit database target selection and the pre-connection identity fence of
 * db:migrate / db:provision-roles / db:preflight. Pure apart from a temporary directory: no connection is ever made,
 * every file and reference is synthetic (the development project is pinned by digest; tests inject a synthetic one).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ROOT,
  TARGET_CONFIG_FILES,
  loadTargetEnvironment,
  parseTargetArgument,
  prepareTarget,
  resolveTargetAuthority,
  type Environment,
} from "@/tools/db/environment";
import { codeOf } from "../../support/source-scan";

const DEV = "devdevdevdevdevdevde";
const PROD = "prodprodprodprodprod";
const OTHER = "zyxwvutsrqponmlkjihg";
const PIN = createHash("sha256").update(DEV, "utf8").digest("hex");
const PASSWORD = "synthetic-password-never-echoed";
const DEV_PASSWORD = "synthetic-dev-password-never-echoed";
const pooler = (login: string, ref: string, port: number, region: string, password = PASSWORD): string =>
  `postgresql://${login}.${ref}:${password}@aws-0-${region}.pooler.supabase.com:${String(port)}/postgres`;
const PEM = `-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUSyntheticTestBodyAAAAAAAAAAAAAAAAAAAAAAAAAAA\nU3ludGhldGljQ2VydGlmaWNhdGVCb2R5Rm9yVGVzdHNPbmx5\n-----END CERTIFICATE-----\n`;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const file = (values: Environment): string => Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v ?? ""}`).join("\n") + "\n";
/** A temporary repository root with the given target files and a synthetic CA at certs/ca.pem (or junk). */
const rootWith = (files: { readonly development?: Environment; readonly production?: Environment }, ca = PEM): string => {
  const root = mkdtempSync(path.join(tmpdir(), "db-target-"));
  roots.push(root);
  writeFileSync(path.join(root, "ca.pem"), ca);
  if (files.development !== undefined) writeFileSync(path.join(root, TARGET_CONFIG_FILES.development), file(files.development));
  if (files.production !== undefined) writeFileSync(path.join(root, TARGET_CONFIG_FILES.production), file(files.production));
  return root;
};
const devConfig = (extra: Environment = {}): Environment => ({
  SUPABASE_PROJECT_REF: DEV,
  DATABASE_SSL_ROOT_CERT: "ca.pem",
  DATABASE_MIGRATION_URL: pooler("postgres", DEV, 5432, "sa-east-1", DEV_PASSWORD),
  DATABASE_WEB_URL: pooler("web_login", DEV, 6543, "sa-east-1", DEV_PASSWORD),
  DATABASE_WORKER_URL: pooler("worker_login", DEV, 6543, "sa-east-1", DEV_PASSWORD),
  DATABASE_SYSTEM_URL: pooler("system_login", DEV, 6543, "sa-east-1", DEV_PASSWORD),
  ...extra,
});
const prodConfig = (extra: Environment = {}): Environment => ({
  DATABASE_ENVIRONMENT_CLASS: "production",
  DATABASE_EXPECTED_PROJECT_REF: PROD,
  DATABASE_EXPECTED_REGION: "eu-central-1",
  DATABASE_SSL_ROOT_CERT: "ca.pem",
  DATABASE_MIGRATION_URL: pooler("postgres", PROD, 5432, "eu-central-1"),
  DATABASE_WEB_URL: pooler("web_login", PROD, 6543, "eu-central-1"),
  DATABASE_WORKER_URL: pooler("worker_login", PROD, 6543, "eu-central-1"),
  DATABASE_SYSTEM_URL: pooler("system_login", PROD, 6543, "eu-central-1"),
  ...extra,
});
const MIGRATE = { migration: true, runtime: [] } as const;
const PROVISION = { migration: true, runtime: ["web", "worker", "system"] } as const;
const fence = (args: readonly string[], root: string, need: Parameters<typeof prepareTarget>[1] = MIGRATE, processEnv: Environment = {}) =>
  prepareTarget(args, need, { root, processEnv, developmentPin: PIN });
const problems = (lines: readonly string[]): string[] => lines.filter((line) => line.includes("PROBLEM:")).map((line) => line.replace(/^\s*PROBLEM: /, ""));
const noSecrets = (lines: readonly string[]): void => {
  const text = lines.join("\n");
  for (const secret of [PASSWORD, DEV_PASSWORD, DEV, PROD, OTHER, "postgresql://", "BEGIN CERTIFICATE"]) expect(text).not.toContain(secret);
};

describe("target selection", () => {
  it("--target is mandatory, closed and single", () => {
    expect(parseTargetArgument(["--target", "development"])).toEqual({ target: "development" });
    expect(parseTargetArgument(["--apply", "--target=production"])).toEqual({ target: "production" });
    for (const args of [[], ["--apply"], ["--target"], ["--target", "--apply"], ["--target", "staging"], ["--target", "prod"], ["--target", "development", "--target", "production"], ["--target="]]) {
      expect(parseTargetArgument(args), args.join(" ")).toHaveProperty("error");
    }
    expect(fence([], rootWith({ development: devConfig() })).ok).toBe(false);
  });

  it("7. an explicit development target loads .env.local (over the process environment) and proves the pinned project", () => {
    const root = rootWith({ development: devConfig() });
    const loaded = loadTargetEnvironment("development", { root, processEnv: { SUPABASE_PROJECT_REF: OTHER, EXTRA: "from-process" } });
    expect(loaded).toMatchObject({ target: "development", source: ".env.local", found: true });
    expect(loaded.env["SUPABASE_PROJECT_REF"]).toBe(DEV); // the file wins
    expect(loaded.env["EXTRA"]).toBe("from-process");
    const result = fence(["--target", "development"], root, PROVISION);
    expect(problems(result.lines)).toEqual([]);
    expect(result).toMatchObject({ ok: true, target: "development" });
    expect(result.ca).toBe(PEM);
    expect(result.report?.migration?.projectRef).toBe(DEV);
    // Without the injected digest, the synthetic project is not the pinned development project.
    expect(problems(prepareTarget(["--target", "development"], MIGRATE, { root, processEnv: {} }).lines)).toContain("SUPABASE_PROJECT_REF is not the pinned social-intelligence-dev-v2 project");
  });

  it("8/14. production NEVER falls back to development configuration (.env.local or the process environment)", () => {
    const devOnly = rootWith({ development: devConfig() });
    const processEnv = { ...devConfig(), ...prodConfig() };
    for (const need of [MIGRATE, PROVISION]) {
      const result = fence(["--target", "production"], devOnly, need, processEnv);
      expect(result.ok).toBe(false);
      expect(problems(result.lines)).toEqual([".env.database-production.local is missing (production never falls back to the development configuration)"]);
      expect(result.report).toBeUndefined();
    }
    expect(loadTargetEnvironment("production", { root: devOnly, processEnv }).env).toEqual({});
    // A production file missing a URL is NOT completed from .env.local or the process environment.
    const partial = rootWith({ development: devConfig(), production: prodConfig({ DATABASE_MIGRATION_URL: undefined, DATABASE_WORKER_URL: undefined }) });
    expect(problems(fence(["--target", "production"], partial, PROVISION, processEnv).lines)).toEqual(expect.arrayContaining(["DATABASE_MIGRATION_URL is absent", "DATABASE_WORKER_URL is absent"]));
  });

  it("9. production configuration incomplete (class, project ref, region — the region is the operator's decision) → FAIL before any connection", () => {
    const cases: readonly [Environment, string][] = [
      [prodConfig({ DATABASE_ENVIRONMENT_CLASS: undefined }), "DATABASE_ENVIRONMENT_CLASS must be production in .env.database-production.local"],
      [prodConfig({ DATABASE_ENVIRONMENT_CLASS: "development" }), "DATABASE_ENVIRONMENT_CLASS must be production in .env.database-production.local"],
      [prodConfig({ DATABASE_EXPECTED_PROJECT_REF: undefined }), "DATABASE_EXPECTED_PROJECT_REF is not configured"],
      [prodConfig({ DATABASE_EXPECTED_REGION: undefined }), "DATABASE_EXPECTED_REGION is not configured (the production region is an operator decision)"],
      [prodConfig({ DATABASE_EXPECTED_REGION: "frankfurt" }), "DATABASE_EXPECTED_REGION is not a region identifier"],
      [prodConfig({ DATABASE_EXPECTED_PROJECT_REF: DEV, DATABASE_MIGRATION_URL: pooler("postgres", DEV, 5432, "eu-central-1") }), "DATABASE_EXPECTED_PROJECT_REF names the development project — refusing"],
      [prodConfig({ SUPABASE_PROJECT_REF: OTHER }), "SUPABASE_PROJECT_REF disagrees with DATABASE_EXPECTED_PROJECT_REF"],
    ];
    for (const [config, expected] of cases) {
      const result = fence(["--target", "production"], rootWith({ production: config }));
      expect(result.ok, expected).toBe(false);
      expect(problems(result.lines), expected).toContain(expected);
      expect(result.ca, expected).toBeUndefined();
    }
    expect(resolveTargetAuthority("production", prodConfig({ DATABASE_EXPECTED_REGION: undefined }), PIN).expectedRegion).toBeUndefined();
  });

  it("10. a URL on another project (including the development project) → FAIL before migration", () => {
    const wrong = rootWith({ production: prodConfig({ DATABASE_MIGRATION_URL: pooler("postgres", OTHER, 5432, "eu-central-1") }) });
    expect(problems(fence(["--target", "production"], wrong).lines)).toContain("DATABASE_MIGRATION_URL does not point at the expected production project");
    const devUrl = rootWith({ production: prodConfig({ DATABASE_SYSTEM_URL: pooler("system_login", DEV, 6543, "eu-central-1") }) });
    expect(problems(fence(["--target", "production"], devUrl, PROVISION).lines)).toEqual(expect.arrayContaining([
      "DATABASE_SYSTEM_URL does not point at the expected production project",
      "DATABASE_SYSTEM_URL points at the development project — refusing",
    ]));
  });

  it("11. a URL in another region, or one whose region can't be verified → FAIL before migration (both targets)", () => {
    const region = rootWith({ production: prodConfig({ DATABASE_MIGRATION_URL: pooler("postgres", PROD, 5432, "us-east-1") }) });
    expect(problems(fence(["--target", "production"], region).lines)).toContain("DATABASE_MIGRATION_URL is not in eu-central-1");
    const direct = rootWith({ production: prodConfig({ DATABASE_MIGRATION_URL: `postgresql://postgres:${PASSWORD}@db.${PROD}.supabase.co:5432/postgres` }) });
    expect(problems(fence(["--target", "production"], direct).lines)).toEqual(expect.arrayContaining(["DATABASE_MIGRATION_URL must use session_pooler", "DATABASE_MIGRATION_URL carries no verifiable region"]));
    const devRegion = rootWith({ development: devConfig({ DATABASE_MIGRATION_URL: pooler("postgres", DEV, 5432, "us-east-1") }) });
    expect(problems(fence(["--target", "development"], devRegion).lines)).toContain("DATABASE_MIGRATION_URL is not in sa-east-1");
    const local = rootWith({ production: prodConfig({ DATABASE_WORKER_URL: `postgresql://worker_login:${PASSWORD}@127.0.0.1:5432/postgres` }) });
    expect(problems(fence(["--target", "production"], local, PROVISION).lines)).toContain("DATABASE_WORKER_URL must use transaction_pooler");
  });

  it("migration role, endpoint class and CA (strict runtime parser) are part of the fence", () => {
    const role = rootWith({ production: prodConfig({ DATABASE_MIGRATION_URL: pooler("worker_login", PROD, 5432, "eu-central-1") }) });
    expect(problems(fence(["--target", "production"], role).lines)).toContain("DATABASE_MIGRATION_URL must use the migration role (postgres)");
    const runtimeOnSession = rootWith({ production: prodConfig({ DATABASE_WORKER_URL: pooler("worker_login", PROD, 5432, "eu-central-1") }) });
    expect(problems(fence(["--target", "production"], runtimeOnSession, PROVISION).lines)).toContain("DATABASE_WORKER_URL must use transaction_pooler");
    const junkCa = rootWith({ production: prodConfig() }, `not a certificate ${PASSWORD}`);
    expect(problems(fence(["--target", "production"], junkCa).lines)).toEqual(["DATABASE_SSL_ROOT_CERT is not a PEM CA certificate bundle"]);
    const noCa = rootWith({ production: prodConfig({ DATABASE_SSL_ROOT_CERT: undefined }) });
    expect(problems(fence(["--target", "production"], noCa).lines)).toContain("DATABASE_SSL_ROOT_CERT must point to the project's CA certificate");
  });

  it("12/13. the correct identity → the migration and provisioning planners may proceed", () => {
    const root = rootWith({ development: devConfig(), production: prodConfig() });
    for (const need of [MIGRATE, PROVISION]) {
      const result = fence(["--target", "production"], root, need, devConfig());
      expect(problems(result.lines)).toEqual([]);
      expect(result).toMatchObject({ ok: true, target: "production", ca: PEM });
      expect(result.report?.migration).toMatchObject({ projectRef: PROD, region: "eu-central-1", role: "postgres", endpoint: "session_pooler" });
    }
    expect(fence(["--target", "production"], root, PROVISION).report?.runtime.system?.projectRef).toBe(PROD);
  });

  it("15. plans and problems never contain a password, URL, project reference or CA content", () => {
    const root = rootWith({ development: devConfig(), production: prodConfig({ DATABASE_MIGRATION_URL: pooler("postgres", OTHER, 5432, "us-east-1") }) });
    for (const target of ["development", "production"]) noSecrets(fence(["--target", target], root, PROVISION).lines);
    noSecrets(fence(["--target", "production"], rootWith({ production: prodConfig() }, `junk ${PASSWORD}`)).lines);
    noSecrets(fence(["--target", "production"], rootWith({ production: prodConfig({ DATABASE_WORKER_URL: "postgresql://broken" }) }), PROVISION).lines);
  });
});

describe("the tools: fence before any client; no arbitrary URL interface", () => {
  it("13/14. migrate, provision-roles and preflight pass prepareTarget before creating a client, and no longer read .env.local directly", () => {
    for (const tool of ["tools/db/migrate.ts", "tools/db/provision-roles.ts", "tools/db/preflight.ts"]) {
      const code = codeOf(tool);
      expect(code.indexOf("prepareTarget(args"), tool).toBeGreaterThan(-1);
      expect(code.indexOf("prepareTarget(args"), tool).toBeLessThan(code.indexOf("privilegedClient("));
      expect(code.indexOf("process.exit(1)"), tool).toBeLessThan(code.indexOf("privilegedClient("));
      expect(code, tool).not.toMatch(/loadEnvironment\(|checkTarget\(|readCa\(|process\.env\[|--url\b|DATABASE_MIGRATION_URL=/);
    }
  });

  it("13/14. with no production configuration, every target-aware tool refuses production with no connection (real CLI, offline)", () => {
    if (loadTargetEnvironment("production").found) return; // an operator machine with a production file: covered by the unit fence above
    for (const tool of ["tools/db/migrate.ts", "tools/db/provision-roles.ts", "tools/db/preflight.ts"]) {
      for (const args of [["--target", "production", "--apply"], ["--apply"]]) {
        const run = spawnSync(process.execPath, [path.join(ROOT, tool), ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" }, timeout: 20_000 });
        expect(run.status, `${tool} ${args.join(" ")}`).toBe(1);
        expect(run.stdout, tool).toMatch(/REFUSED|PREFLIGHT: configuration incomplete/);
        expect(run.stdout, tool).not.toMatch(/APPLIED|created|PASS \(current_user/);
      }
    }
  });

  it("16. both target configuration files are git-ignored; 17. no production configuration or credential is tracked", () => {
    for (const name of Object.values(TARGET_CONFIG_FILES)) {
      const ignored = spawnSync("git", ["check-ignore", "-q", name], { cwd: ROOT });
      expect(ignored.status, name).toBe(0);
    }
    const tracked = spawnSync("git", ["ls-files", "--", ".env*", "*.env"], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n").filter((line) => line !== "");
    expect(tracked).toEqual([".env.example"]);
    // The production file is deliberately not a name Next.js loads into `next build` / `next start`.
    expect(TARGET_CONFIG_FILES.production).not.toMatch(/^\.env(\.production)?(\.local)?$/);
    for (const source of ["platform/db/identity.ts", "tools/db/environment.ts", ".env.example"]) {
      expect(codeOf(source), source).not.toMatch(/postgres(ql)?:\/\/[^$`\s"]*:[^$`\s"]+@|[a-z0-9]{20}\.supabase\.co/);
    }
  });
});
