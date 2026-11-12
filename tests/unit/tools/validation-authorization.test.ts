/**
 * Step 7B-14I2 — the validation-authorization operator tool, offline: argument parsing (development only, no identity
 * argument, UUIDs only, closed reasons, ≤ 60 minutes), the identity fence (a validation_operator_<handle> login on the
 * pinned project — never the migration role), the session check, and the database calls (exactly the three fixed,
 * parameterized statements after SET LOCAL ROLE; committed only with --apply; status read-only and rolled back).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeValidationCommand, parseValidationCommand, type ValidationCommand } from "../../../tools/ops/validation-authorization-command.ts";
import { operatorSessionProblems, refusalLine, runValidationCall } from "../../../tools/ops/validation-authorizations.ts";
import { checkValidationOperatorTarget, validationOperatorClient, VALIDATION_OPERATOR_URL, verifyOperatorEndpoint } from "../../../tools/db/validation-operator-target.ts";
import { parseDatabaseUrl } from "../../../platform/db/connection.ts";

const W = "24782ada-316d-49ae-b6d4-e017ba4f84f1";
const P = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";
const base = ["--target", "development", "--workspace", W];
const issueArgs = ["issue", ...base, "--preflight", P, "--initiator", U, "--reason", "live_validation"];

describe("7B-14I2: parsing (nothing is contacted on a refusal)", () => {
  it("issue: defaults to 60 minutes, a dry run, and no token-type acceptance", () => {
    expect(parseValidationCommand(issueArgs)).toEqual({ ok: true, command: { action: "issue", workspaceId: W, preflightId: P, initiatorUserId: U, reason: "live_validation", lifetimeMinutes: 60, acceptTokenTypeNotVerified: false, apply: false } });
    expect(parseValidationCommand([...issueArgs, "--lifetime-minutes", "30", "--accept-token-type-not-verified", "--apply"])).toMatchObject({ ok: true, command: { lifetimeMinutes: 30, acceptTokenTypeNotVerified: true, apply: true } });
  });

  it.each([
    ["no action", ["--target", "development"]],
    ["two actions", ["issue", "status", ...base]],
    ["an unknown action", ["grant", ...base]],
    ["production", ["status", "--target", "production", "--workspace", W, "--authorization", A]],
    ["no target", ["status", "--workspace", W, "--authorization", A]],
    ["two targets", ["status", "--target", "development", "--target", "development", "--workspace", W, "--authorization", A]],
    ["an operator identity argument", [...issueArgs, "--operator", "someone"]],
    ["an unknown argument", [...issueArgs, "--sql", "select 1"]],
    ["a non-UUID workspace", ["status", "--target", "development", "--workspace", "w1", "--authorization", A]],
    ["an uppercase UUID", ["status", "--target", "development", "--workspace", W.toUpperCase(), "--authorization", A]],
    ["a provider id as preflight", ["issue", ...base, "--preflight", "17900000000000001", "--initiator", U, "--reason", "live_validation"]],
    ["a lifetime over 60", [...issueArgs, "--lifetime-minutes", "61"]],
    ["a lifetime of 0", [...issueArgs, "--lifetime-minutes", "0"]],
    ["a non-integer lifetime", [...issueArgs, "--lifetime-minutes", "1.5"]],
    ["a revocation reason on issue", ["issue", ...base, "--preflight", P, "--initiator", U, "--reason", "incident"]],
    ["an issue reason on revoke", ["revoke", ...base, "--authorization", A, "--reason", "live_validation"]],
    ["--apply on status", ["status", ...base, "--authorization", A, "--apply"]],
    ["issue-only flags on revoke", ["revoke", ...base, "--authorization", A, "--reason", "incident", "--accept-token-type-not-verified"]],
  ] as const)("refuses %s", (_name, argv) => {
    expect(parseValidationCommand(argv).ok).toBe(false);
  });

  it("the printed plan says who the operator is (the session login) and never asks for it", () => {
    const parsed = parseValidationCommand(issueArgs);
    if (!parsed.ok) throw new Error("parse");
    const lines = describeValidationCommand(parsed.command).join("\n");
    expect(lines).toMatch(/DRY RUN: executed then rolled back/);
    expect(lines).toMatch(/the authenticated session login \(never an argument\)/);
    expect(lines).toMatch(/not accepted \(issuance will be refused\)/);
  });
});

describe("7B-14I2: the identity fence (before any connection)", () => {
  const REF = "abcdefghijklmnopqrst";
  const PASSWORD = "secret-marker";
  const pin = createHash("sha256").update(REF).digest("hex");
  const env = (url: string | undefined) => ({ SUPABASE_PROJECT_REF: REF, [VALIDATION_OPERATOR_URL]: url });
  const pooler = (user: string) => `postgresql://${user}.${REF}:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;

  it("accepts a validation_operator_<handle> login on the pinned project's session pooler; never prints the password", () => {
    const fence = checkValidationOperatorTarget(env(pooler("validation_operator_seba")), pin);
    expect(fence.ok).toBe(true);
    expect(fence.lines.join("\n")).not.toMatch(/secret-marker|abcdefghijklmnopqrst/);
  });

  it.each([
    ["absent", undefined],
    ["the migration role", pooler("postgres")],
    ["a runtime login", pooler("worker_login")],
    ["a misnamed login", pooler("operator_seba")],
    ["the transaction pooler", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`],
    ["another project", `postgresql://validation_operator_seba.zzzzzzzzzzzzzzzzzzzz:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`],
    ["another region", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`],
  ] as const)("refuses %s", (_name, url) => {
    expect(checkValidationOperatorTarget(env(url), pin).ok).toBe(false);
  });

  it("refuses an unpinned development project", () => {
    expect(checkValidationOperatorTarget(env(pooler("validation_operator_seba")), createHash("sha256").update("other").digest("hex")).ok).toBe(false);
  });

  // Step 7B-14I3H (H3): a local endpoint proves nothing about the project behind it.
  it("accepts the pinned project's direct host (and only that host)", () => {
    expect(checkValidationOperatorTarget(env(`postgresql://validation_operator_seba:${PASSWORD}@db.${REF}.supabase.co:5432/postgres`), pin).ok).toBe(true);
    expect(checkValidationOperatorTarget(env(`postgresql://validation_operator_seba:${PASSWORD}@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres`), pin).ok).toBe(false);
  });

  it.each([
    ["(M) localhost claiming to be DEV (a tunnel / port forward)", `postgresql://validation_operator_seba:${PASSWORD}@localhost:5432/postgres`],
    ["(M) 127.0.0.1 with the pinned project's login tenant", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@127.0.0.1:6544/postgres`],
    ["(M) ::1", `postgresql://validation_operator_seba:${PASSWORD}@[::1]:5432/postgres`],
    ["(M) localhost on the pooler port", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@localhost:5432/postgres`],
    ["(N) an IP literal", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@10.0.0.7:5432/postgres`],
    ["(N) a host alias of the pinned project", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@dev-db.internal:5432/postgres`],
    ["(N) a look-alike pooler host", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com.evil.example:5432/postgres`],
    ["(N) another project's direct host with the pinned tenant in the login", `postgresql://validation_operator_seba.${REF}:${PASSWORD}@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres`],
  ] as const)("refuses %s — no local or development bypass, nothing printed", (_name, url) => {
    const fence = checkValidationOperatorTarget(env(url), pin);
    expect(fence.ok).toBe(false);
    expect(fence.lines.join("\n")).not.toMatch(/secret-marker|abcdefghijklmnopqrst/);
  });

  it("(M) a local target never yields a client, even if handed over directly", () => {
    const local = parseDatabaseUrl(`postgresql://validation_operator_seba:${PASSWORD}@127.0.0.1:5432/postgres`, VALIDATION_OPERATOR_URL);
    expect(validationOperatorClient(local, env(undefined))).toEqual({ problem: expect.stringMatching(/no verifiable project identity/) as unknown });
  });

  it("(N) after connecting: only an authorized TLS session whose certificate names the expected host passes", () => {
    const target = parseDatabaseUrl(pooler("validation_operator_seba"), VALIDATION_OPERATOR_URL);
    const certificate = (altnames: string) => ({ subject: { CN: altnames.replace(/^DNS:/, "") }, subjectaltname: altnames }) as never;
    const socket = (over: Partial<{ encrypted: boolean; authorized: boolean; altnames: string }> = {}) => ({
      encrypted: over.encrypted ?? true, authorized: over.authorized ?? true, getPeerCertificate: () => certificate(over.altnames ?? "DNS:*.pooler.supabase.com"),
    });
    expect(verifyOperatorEndpoint(socket(), target)).toEqual([]);
    expect(verifyOperatorEndpoint(undefined, target)).toHaveLength(1);
    expect(verifyOperatorEndpoint(socket({ encrypted: false }), target)).toHaveLength(1);
    expect(verifyOperatorEndpoint(socket({ authorized: false }), target)).toHaveLength(1);
    expect(verifyOperatorEndpoint(socket({ altnames: "DNS:evil.example" }), target)).toHaveLength(1);
    expect(verifyOperatorEndpoint({ encrypted: true, authorized: true, getPeerCertificate: () => ({}) }, target)).toHaveLength(1);
  });
});

/** A fake client recording every statement; answers by statement shape. */
function fakeClient(session: Record<string, unknown> = {}) {
  const statements: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  return {
    statements,
    query: (text: string, values: readonly unknown[] = []) => {
      statements.push({ text, values });
      if (text.includes("from pg_catalog.pg_roles r where r.rolname = session_user")) {
        return Promise.resolve({ rows: [{ login: "validation_operator_seba", rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false, operator: true, isolation: "read committed",
          memberships: 1, exact_membership: true, acted_through: false, role_settings: false, foreign_objects: false, can_create: false, ...session }] });
      }
      if (text.includes("issue_validation_authorization")) return Promise.resolve({ rows: [{ authorization_id: A, expires_at: new Date("2026-11-12T16:00:00Z") }] });
      if (text.includes("revoke_validation_authorization")) return Promise.resolve({ rows: [{ revoked_at: new Date("2026-11-12T15:10:00Z") }] });
      if (text.includes("validation_authorization_status")) return Promise.resolve({ rows: [{ state: "ISSUED", intent_id: null, operator_events: 1, issued_at: new Date("2026-11-12T15:00:00Z") }] });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as { statements: { text: string; values: readonly unknown[] }[]; query: never };
}

describe("7B-14I2: the session check and the three fixed calls", () => {
  it("a validation operator session passes; the migration role, BYPASSRLS, INHERIT, a non-member, a misnamed login do not", async () => {
    expect(await operatorSessionProblems(fakeClient() as never)).toEqual([]);
    for (const session of [{ login: "postgres", rolbypassrls: true, rolcreaterole: true }, { rolbypassrls: true }, { rolinherit: true }, { operator: false }, { login: "operator_seba" }, { isolation: "serializable" },
      // Step 7B-14I3H (H4): a second membership, an INHERIT / ADMIN / no-SET membership, a role acting through the login,
      // per-role settings, owned objects or direct grants, CREATE anywhere.
      { memberships: 2 }, { exact_membership: false }, { acted_through: true }, { role_settings: true }, { foreign_objects: true }, { can_create: true }]) {
      expect((await operatorSessionProblems(fakeClient(session) as never)).length, JSON.stringify(session)).toBeGreaterThan(0);
    }
  });

  const run = async (argv: readonly string[]) => {
    const parsed = parseValidationCommand(argv);
    if (!parsed.ok) throw new Error(parsed.problem);
    const client = fakeClient();
    const command: ValidationCommand = parsed.command;
    const result = await runValidationCall(client, command);
    return { result, texts: client.statements.map((s) => s.text), statements: client.statements };
  };

  it("issue (dry run): BEGIN READ COMMITTED → SET LOCAL ROLE → the ONE call with six parameters → ROLLBACK", async () => {
    const { result, texts, statements } = await run(issueArgs);
    expect(texts).toEqual([
      "begin transaction isolation level read committed",
      "set local role app_validation_operator",
      "select authorization_id, expires_at from mutations.issue_validation_authorization($1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer, $6::boolean)",
      "rollback",
    ]);
    expect(statements[2]?.values).toEqual([W, P, U, "live_validation", 60, false]);
    expect(result).toEqual({ action: "issue", committed: false, authorizationId: A, expiresAt: "2026-11-12T16:00:00.000Z" });
  });

  it("issue / revoke with --apply commit; status is read-only and always rolled back", async () => {
    expect((await run([...issueArgs, "--apply", "--accept-token-type-not-verified"])).texts.at(-1)).toBe("commit");
    const revoke = await run(["revoke", ...base, "--authorization", A, "--reason", "incident", "--apply"]);
    expect(revoke.texts).toEqual(["begin transaction isolation level read committed", "set local role app_validation_operator", "select mutations.revoke_validation_authorization($1::uuid, $2::uuid, $3::text) as revoked_at", "commit"]);
    const status = await run(["status", ...base, "--authorization", A]);
    expect(status.texts).toEqual(["begin transaction isolation level read committed read only", "set local role app_validation_operator", "select * from mutations.validation_authorization_status($1::uuid, $2::uuid)", "rollback"]);
    expect(status.result).toEqual({ action: "status", status: { state: "ISSUED", intent_id: null, operator_events: 1, issued_at: "2026-11-12T15:00:00.000Z" } });
  });

  it("no statement is ever built from input: every value travels as a parameter; no table is named", async () => {
    for (const argv of [issueArgs, ["revoke", ...base, "--authorization", A, "--reason", "incident"], ["status", ...base, "--authorization", A]]) {
      const { texts } = await run(argv);
      for (const text of texts) {
        expect(text).not.toContain(W);
        expect(text).not.toMatch(/\b(insert into|update|delete from)\b|from mutations\.(validation_authorizations|validation_preflights|mutation_intents)/);
      }
    }
  });

  it("a database refusal is one closed line: SQLSTATE + the function's own message", () => {
    expect(refusalLine(Object.assign(new Error("validation operator: the preflight is not fresh (30 minutes at most)"), { code: "42501" }))).toBe("REFUSED: 42501 validation operator: the preflight is not fresh (30 minutes at most)");
  });
});
