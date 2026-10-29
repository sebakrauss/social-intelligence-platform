/** Step H7-B1b-0 — the shared-dev fixture's argument, mode, target and protected-workspace guards (pure; no connection). */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEV_FIXTURE_CONFIRMATION,
  DEV_FIXTURE_CONFIRMATION_VARIABLE,
  DEV_FIXTURE_MODE_VARIABLE,
  DEV_V2_PROJECT_REF_SHA256,
  devFixtureModeFromEnvironment,
  devFixtureTargetProblems,
  isProtectedWorkspace,
  parseDevFixtureArguments,
} from "@/tools/db/dev-fixture-guard";
import { checkTarget, type Environment } from "@/tools/db/environment";
import { H7_CLASSIFICATION_ACCEPTANCE_FIXTURE } from "../../db/dev-fixtures/classification-acceptance";

const REF = "abcdefghijklmnopqrst";
const OTHER = "zyxwvutsrqponmlkjihg";
const PASSWORD = "synthetic-password-never-echoed";
const url = (role: string, ref: string, port: number, region = "sa-east-1"): string => `postgresql://${role}.${ref}:${PASSWORD}@aws-0-${region}.pooler.supabase.com:${String(port)}/postgres`;
const localUrl = (role: string): string => `postgresql://${role}:${PASSWORD}@127.0.0.1:5432/postgres`;
const env = (ref: string, overrides: Environment = {}): Environment => ({
  SUPABASE_PROJECT_REF: ref,
  DATABASE_SSL_ROOT_CERT: "certs/ca.pem",
  DATABASE_MIGRATION_URL: url("postgres", ref, 5432),
  DATABASE_WORKER_URL: url("worker_login", ref, 6543),
  ...overrides,
});
/** The guard with the pinned digest swapped for the synthetic ref's (the pin itself is checked separately). */
const problemsFor = (e: Environment): readonly string[] => devFixtureTargetProblems(e, checkTarget(e, { migration: true, runtime: ["worker"] }));

describe("arguments: mutation is never the default", () => {
  it("no argument → plan; exactly --apply + the exact phrase → apply (either order)", () => {
    expect(parseDevFixtureArguments([])).toEqual({ mode: "plan" });
    expect(parseDevFixtureArguments(["--apply", "--confirm-dev-fixture", DEV_FIXTURE_CONFIRMATION])).toEqual({ mode: "apply" });
    expect(parseDevFixtureArguments(["--confirm-dev-fixture", DEV_FIXTURE_CONFIRMATION, "--apply"])).toEqual({ mode: "apply" });
  });

  it("a missing phrase, a typo, an extra or repeated argument → refused (nothing runs)", () => {
    for (const args of [["--apply"], ["--apply", "--confirm-dev-fixture"], ["--apply", "--confirm-dev-fixture", `${DEV_FIXTURE_CONFIRMATION}x`], ["--aply"],
      ["--confirm-dev-fixture", DEV_FIXTURE_CONFIRMATION], ["--apply", "--apply", "--confirm-dev-fixture", DEV_FIXTURE_CONFIRMATION], ["--apply", "--confirm-dev-fixture", DEV_FIXTURE_CONFIRMATION, "--reset"],
      ["--delete"], ["--reset"], ["plan"]]) {
      expect(parseDevFixtureArguments(args), args.join(" ")).toHaveProperty("error");
    }
  });

  it("the vitest run accepts apply only with BOTH variables exactly as the CLI sets them", () => {
    expect(devFixtureModeFromEnvironment({})).toEqual({ mode: "plan" });
    expect(devFixtureModeFromEnvironment({ [DEV_FIXTURE_MODE_VARIABLE]: "apply", [DEV_FIXTURE_CONFIRMATION_VARIABLE]: DEV_FIXTURE_CONFIRMATION })).toEqual({ mode: "apply" });
    expect(devFixtureModeFromEnvironment({ [DEV_FIXTURE_MODE_VARIABLE]: "apply" })).toHaveProperty("error");
    expect(devFixtureModeFromEnvironment({ [DEV_FIXTURE_MODE_VARIABLE]: "apply", [DEV_FIXTURE_CONFIRMATION_VARIABLE]: "yes" })).toHaveProperty("error");
    expect(devFixtureModeFromEnvironment({ [DEV_FIXTURE_MODE_VARIABLE]: "reset" })).toHaveProperty("error");
  });
});

describe("target: exactly social-intelligence-dev-v2", () => {
  it("1/3. any project whose reference is not the pinned one (production, preview, unknown) is refused", () => {
    expect(createHash("sha256").update(REF).digest("hex")).not.toBe(DEV_V2_PROJECT_REF_SHA256);
    expect(problemsFor(env(REF))).toContain("SUPABASE_PROJECT_REF is not the pinned social-intelligence-dev-v2 project");
    expect(problemsFor(env(OTHER)).length).toBeGreaterThan(0);
  });

  it("2. an ambiguous target (URLs on different projects, missing worker, wrong region, local endpoint) is refused", () => {
    expect(problemsFor(env(REF, { DATABASE_WORKER_URL: url("worker_login", OTHER, 6543) }))).toContain("database configuration check failed");
    expect(problemsFor(env(REF, { DATABASE_WORKER_URL: undefined }))).toContain("DATABASE_WORKER_URL is absent");
    expect(problemsFor(env(REF, { DATABASE_WORKER_URL: url("worker_login", REF, 6543, "us-east-1") }))).toContain("DATABASE_WORKER_URL is not in sa-east-1");
    const local = env(REF, { DATABASE_MIGRATION_URL: localUrl("postgres"), DATABASE_WORKER_URL: localUrl("worker_login") });
    expect(problemsFor(local)).toEqual(expect.arrayContaining(["DATABASE_MIGRATION_URL must be the managed direct or session endpoint", "DATABASE_WORKER_URL must use the transaction pooler"]));
  });

  it("the pin is a SHA-256 (no project reference is committed)", () => {
    expect(DEV_V2_PROJECT_REF_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("protected workspace", () => {
  it("4. the P2-E workspace and its whole id range are refused; the fixture's own ids are not in it", () => {
    expect(isProtectedWorkspace("5eed2e00-0000-4000-8000-000000000001")).toBe(true);
    expect(isProtectedWorkspace("5EED2E00-0000-4000-8000-000000000001")).toBe(true);
    expect(isProtectedWorkspace("5eed2e00-1111-4000-8000-000000000002")).toBe(true);
    const d = H7_CLASSIFICATION_ACCEPTANCE_FIXTURE;
    for (const id of [d.organization.id, d.workspace.id, d.connection.id, d.discoveredAssetId, d.connectedAccountId, d.connection.authorizedBy]) expect(isProtectedWorkspace(id), id).toBe(false);
  });
});
