/**
 * W12-PREP-01 — the shared-dev Workflow acceptance argument guard (pure). Mutation is never the default, each command
 * has its own confirmation phrase, the U2 role sequence is the only role change, and the vitest run re-parses the CLI's
 * vector. The target fence is the existing dev-fixture guard's (tests/unit/tools/dev-fixture-guard.test.ts), proven
 * here for the new tool's use with a synthetic non-dev-v2 environment.
 */
import { describe, expect, it } from "vitest";
import { devFixtureTargetProblems } from "@/tools/db/dev-fixture-guard";
import { checkTarget } from "@/tools/db/environment";
import {
  isAllowedU2Transition,
  parseWorkflowAcceptanceArguments as parse,
  WORKFLOW_ACCEPTANCE_ARGS_VARIABLE,
  WORKFLOW_ACCEPTANCE_CONFIRMATIONS as PHRASE,
  workflowAcceptanceOperationFromEnvironment,
} from "@/tools/db/workflow-acceptance-guard";

const U1 = "0b0e5b1e-1d2c-4f3a-9a8b-7c6d5e4f3a21";
const U2 = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const ok = (args: readonly string[]) => {
  const result = parse(args);
  if ("error" in result) throw new Error(result.error);
  return result.operation;
};
const refused = (args: readonly string[]): string => {
  const result = parse(args);
  if (!("error" in result)) throw new Error(`accepted: ${JSON.stringify(result.operation)}`);
  return result.error;
};

describe("plan is the default; apply needs the command's own exact phrase", () => {
  it("every command plans without --apply", () => {
    expect(ok(["fixture"])).toEqual({ command: "fixture", mode: "plan" });
    expect(ok(["reply", "--kind", "audience"])).toEqual({ command: "reply", mode: "plan", kind: "audience" });
    expect(ok(["members", "--u1", U1, "--u2", U2])).toEqual({ command: "members", mode: "plan", u1: U1, u2: U2 });
    expect(ok(["role", "--u2", U2, "--from", "RESPONDER", "--to", "ANALYST_VIEWER"])).toMatchObject({ command: "role", mode: "plan" });
    expect(ok(["verify", "--u1", U1, "--u2", U2])).toEqual({ command: "verify", mode: "plan", u1: U1, u2: U2 });
  });

  it("apply with the exact phrase of THAT command only", () => {
    expect(ok(["fixture", "--apply", "--confirm", PHRASE.fixture]).mode).toBe("apply");
    expect(ok(["reply", "--kind", "account", "--confirm", PHRASE.reply, "--apply"]).mode).toBe("apply");
    expect(ok(["members", "--u1", U1, "--u2", U2, "--apply", "--confirm", PHRASE.members]).mode).toBe("apply");
    expect(ok(["role", "--u2", U2, "--from", "ANALYST_VIEWER", "--to", "CLIENT_GUEST", "--apply", "--confirm", PHRASE.role]).mode).toBe("apply");
    expect(refused(["fixture", "--apply", "--confirm", PHRASE.members])).toMatch(/exact fixture confirmation phrase/);
    expect(refused(["members", "--u1", U1, "--u2", U2, "--apply", "--confirm", PHRASE.fixture])).toMatch(/exact members confirmation phrase/);
    expect(refused(["fixture", "--apply"])).toMatch(/exact fixture confirmation phrase/);
    expect(refused(["fixture", "--apply", "--confirm"])).toMatch(/needs the confirmation phrase/);
    expect(refused(["fixture", "--confirm", PHRASE.fixture])).toMatch(/only valid with --apply/);
    expect(new Set(Object.values(PHRASE)).size).toBe(4);
  });

  it("verify is read-only: --apply is refused", () => {
    expect(refused(["verify", "--u1", U1, "--u2", U2, "--apply", "--confirm", "anything"])).toMatch(/read-only/);
  });

  it("anything unexpected is refused before anything connects", () => {
    expect(refused([])).toMatch(/first argument/);
    expect(refused(["delete"])).toMatch(/first argument/);
    expect(refused(["fixture", "--reset"])).toMatch(/unknown argument/);
    expect(refused(["fixture", "--apply", "--apply", "--confirm", PHRASE.fixture])).toMatch(/repeated/);
    expect(refused(["reply"])).toMatch(/needs --kind/);
    expect(refused(["reply", "--kind", "brand"])).toMatch(/audience or account/);
    expect(refused(["members", "--u1", U1])).toMatch(/needs --u2/);
    expect(refused(["members", "--u1", U1, "--u2", U1])).toMatch(/two different users/);
    expect(refused(["members", "--u1", U1.toUpperCase(), "--u2", U2])).toMatch(/canonical lower-case UUID/);
    expect(refused(["members", "--u1", "me@example.com", "--u2", U2])).toMatch(/canonical lower-case UUID/);
    expect(refused(["role", "--u2", U2, "--from", "RESPONDER", "--to", "ANALYST_VIEWER", "--u1", U1])).toMatch(/unknown argument/);
  });
});

describe("the U2 role sequence is the only role change", () => {
  it("one step forward along RESPONDER → ANALYST_VIEWER → CLIENT_GUEST; nothing else", () => {
    expect(isAllowedU2Transition("RESPONDER", "ANALYST_VIEWER")).toBe(true);
    expect(isAllowedU2Transition("ANALYST_VIEWER", "CLIENT_GUEST")).toBe(true);
    for (const [from, to] of [["RESPONDER", "CLIENT_GUEST"], ["CLIENT_GUEST", "RESPONDER"], ["ANALYST_VIEWER", "RESPONDER"], ["RESPONDER", "RESPONDER"],
      ["RESPONDER", "OWNER"], ["MANAGER", "OWNER"], ["OWNER", "ADMIN"], ["CLIENT_GUEST", "OWNER"]] as const) {
      expect(isAllowedU2Transition(from, to), `${from}→${to}`).toBe(false);
      expect(refused(["role", "--u2", U2, "--from", from, "--to", to])).toMatch(/one step at a time/);
    }
  });
});

describe("the vitest run re-parses the CLI's vector", () => {
  it("absent, malformed or invalid vectors are refused; a valid one yields the same operation", () => {
    const errorOf = (env: Readonly<Record<string, string | undefined>>): string => {
      const result = workflowAcceptanceOperationFromEnvironment(env);
      return "error" in result ? result.error : "accepted";
    };
    expect(errorOf({})).toMatch(/absent/);
    expect(errorOf({ [WORKFLOW_ACCEPTANCE_ARGS_VARIABLE]: "fixture" })).toMatch(/not JSON/);
    expect(errorOf({ [WORKFLOW_ACCEPTANCE_ARGS_VARIABLE]: JSON.stringify([1]) })).toMatch(/string array/);
    expect(errorOf({ [WORKFLOW_ACCEPTANCE_ARGS_VARIABLE]: JSON.stringify(["fixture", "--apply"]) })).toMatch(/phrase/);
    const args = ["fixture", "--apply", "--confirm", PHRASE.fixture];
    expect(workflowAcceptanceOperationFromEnvironment({ [WORKFLOW_ACCEPTANCE_ARGS_VARIABLE]: JSON.stringify(args) })).toEqual(parse(args));
  });
});

describe("DEV identity fence (shared with db:dev-fixture)", () => {
  it("a target that is not the pinned dev-v2 project, or not managed, is refused with problems", () => {
    const ref = "abcdefghijklmnopqrst";
    const password = "synthetic-password-never-echoed";
    const env = {
      SUPABASE_PROJECT_REF: ref,
      DATABASE_SSL_ROOT_CERT: "certs/ca.pem",
      DATABASE_MIGRATION_URL: `postgresql://postgres.${ref}:${password}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
      DATABASE_WORKER_URL: `postgresql://worker_login.${ref}:${password}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`,
    };
    const problems = devFixtureTargetProblems(env, checkTarget(env, { migration: true, runtime: ["worker"] }));
    expect(problems.join("; ")).toMatch(/not the pinned social-intelligence-dev-v2 project/);
    const local = { DATABASE_MIGRATION_URL: `postgresql://postgres:${password}@127.0.0.1:5432/postgres`, DATABASE_WORKER_URL: `postgresql://worker_login:${password}@127.0.0.1:5432/postgres` };
    expect(devFixtureTargetProblems(local, checkTarget(local, { migration: true, runtime: ["worker"] })).length).toBeGreaterThan(0);
  });
});
