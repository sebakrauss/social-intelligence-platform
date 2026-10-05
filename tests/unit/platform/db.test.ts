import { describe, expect, it } from "vitest";
import {
  ConnectionConfigError,
  ScopeError,
  assertRuntimeTarget,
  classifyDatabaseError,
  createRuntimeDatabase,
  parseDatabaseClaims,
  parseDatabaseUrl,
} from "@/platform/db";
import { createOutboxMessage } from "@/platform/outbox";

const REF = "abcdefghijklmnopqrst";
const POOLER = "aws-0-sa-east-1.pooler.supabase.com";
const secret = "s3cr3t-value-never-echoed";
const url = (user: string, host: string, port: number) => `postgresql://${user}:${secret}@${host}:${String(port)}/postgres`;
const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

describe("database URL parsing", () => {
  it("recognizes the Supavisor transaction pooler, session pooler and direct endpoints", () => {
    expect(parseDatabaseUrl(url(`web_login.${REF}`, POOLER, 6543), "X")).toMatchObject({
      endpoint: "transaction_pooler", role: "web_login", projectRef: REF, region: "sa-east-1",
    });
    expect(parseDatabaseUrl(url(`postgres.${REF}`, POOLER, 5432), "X")).toMatchObject({ endpoint: "session_pooler", role: "postgres", projectRef: REF });
    expect(parseDatabaseUrl(url("postgres", `db.${REF}.supabase.co`, 5432), "X")).toMatchObject({ endpoint: "direct", projectRef: REF });
    expect(parseDatabaseUrl(url("web_login", "127.0.0.1", 5432), "X")).toMatchObject({ endpoint: "local" });
  });

  it("drops query parameters (no smuggled session options) and tolerates the dashboard's [password] template", () => {
    const parsed = parseDatabaseUrl(`postgresql://web_login.${REF}:[${secret}]@${POOLER}:6543/postgres?options=-c%20role%3Dservice_role&sslmode=disable`, "X");
    expect(parsed.password).toBe(secret);
    expect(Object.keys(parsed).sort()).toEqual(["database", "endpoint", "host", "password", "port", "projectRef", "region", "role", "user"]);
  });

  it("never echoes the URL or password in errors", () => {
    for (const bad of [undefined, "", "not a url", `mysql://u:${secret}@h/db`, `postgresql://${POOLER}:6543/postgres`]) {
      try {
        parseDatabaseUrl(bad, "DATABASE_WEB_URL");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectionConfigError);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).toContain("DATABASE_WEB_URL");
      }
    }
  });
});

describe("runtime connection guards (R1)", () => {
  it("accepts only the runtime's own login role through the transaction pooler", () => {
    expect(() => {
      assertRuntimeTarget("web", parseDatabaseUrl(url(`web_login.${REF}`, POOLER, 6543), "X"));
    }).not.toThrow();
    expect(() => {
      assertRuntimeTarget("worker", parseDatabaseUrl(url(`worker_login.${REF}`, POOLER, 6543), "X"));
    }).not.toThrow();
    expect(() => {
      assertRuntimeTarget("system", parseDatabaseUrl(url(`system_login.${REF}`, POOLER, 6543), "X"));
    }).not.toThrow();
  });

  it.each([
    ["postgres through the pooler", `postgres.${REF}`, POOLER, 6543],
    ["postgres direct", "postgres", `db.${REF}.supabase.co`, 5432],
    ["service_role", `service_role.${REF}`, POOLER, 6543],
    ["supabase_admin", `supabase_admin.${REF}`, POOLER, 6543],
    ["authenticator", `authenticator.${REF}`, POOLER, 6543],
    ["the owner role", `app_owner.${REF}`, POOLER, 6543],
    ["another runtime's login", `worker_login.${REF}`, POOLER, 6543],
    ["the session pooler", `web_login.${REF}`, POOLER, 5432],
    ["the direct endpoint", "web_login", `db.${REF}.supabase.co`, 5432],
  ])("refuses %s for the web runtime", (_label, user, host, port) => {
    expect(() => createRuntimeDatabase("web", url(user, host, port), { sslRootCert: CA })).toThrow(ConnectionConfigError);
  });

  it("requires a CA certificate for managed endpoints (TLS is always verified)", () => {
    expect(() => createRuntimeDatabase("web", url(`web_login.${REF}`, POOLER, 6543))).toThrow(/DATABASE_SSL_ROOT_CERT/);
  });
});

describe("database claims (R3 allowlist)", () => {
  const sub = "10000000-0000-4000-8000-000000000001";

  it("accepts a verified subject with no role or the authenticated role, and always sets role authenticated", () => {
    expect(parseDatabaseClaims({ sub })).toEqual({ sub, role: "authenticated" });
    expect(parseDatabaseClaims({ sub, role: "authenticated" })).toEqual({ sub, role: "authenticated" });
  });

  it.each([
    ["role: service_role", { sub, role: "service_role" }],
    ["role: postgres", { sub, role: "postgres" }],
    ["role: anon", { sub, role: "anon" }],
    ["a non-UUID subject", { sub: "admin" }],
    ["no subject", { role: "authenticated" }],
    ["nothing", null],
  ])("rejects %s before any query", (_label, identity) => {
    expect(() => parseDatabaseClaims(identity)).toThrow(ScopeError);
  });
});

describe("database error classification", () => {
  it("maps the last-Owner constraint, uniqueness, references and denials; ignores everything else", () => {
    expect(classifyDatabaseError({ code: "23514", constraint: "workspace_keeps_an_owner" })).toBe("last_owner");
    expect(classifyDatabaseError({ cause: { code: "23514", constraint: "organization_keeps_an_owner" } })).toBe("last_owner");
    expect(classifyDatabaseError({ code: "23514", constraint: "some_other_check" })).toBeUndefined();
    expect(classifyDatabaseError({ code: "23505" })).toBe("duplicate");
    expect(classifyDatabaseError({ code: "23503" })).toBe("missing_reference");
    expect(classifyDatabaseError({ code: "42501" })).toBe("denied");
    expect(classifyDatabaseError(new Error("boom"))).toBeUndefined();
  });
});

describe("outbox messages carry identifiers only", () => {
  const valid = {
    id: "00000000-0000-4000-8000-000000000001",
    topic: "tenancy.workspace_mode_changed",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    subjectIds: { workspace_id: "00000000-0000-4000-8000-000000000002" },
    correlationId: "corr-0001-abcdef",
    initiator: { type: "user", userId: "10000000-0000-4000-8000-000000000001" },
    dispatchKey: "dispatch-0001-abcdef",
    createdAt: new Date("2026-10-05T12:00:00Z"),
  };

  it("accepts and freezes a well-formed message", () => {
    const message = createOutboxMessage(valid);
    expect(message).toEqual(valid);
    expect(Object.isFrozen(message)).toBe(true);
  });

  it.each([
    ["an undeclared payload field", { ...valid, payload: { text: "a comment" } }],
    ["an email as a subject", { ...valid, subjectIds: { recipient: "person@example.test" } }],
    ["free text as a subject", { ...valid, subjectIds: { note: "hello world" } }],
    ["a malformed subject name", { ...valid, subjectIds: { "Bad Name": valid.workspaceId } }],
    ["too many subjects", { ...valid, subjectIds: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${String(i)}`, valid.workspaceId])) }],
    ["a free-form topic", { ...valid, topic: "Send email to person@example.test" }],
    ["a user initiator without a user", { ...valid, initiator: { type: "user" } }],
    ["an initiator with extra data", { ...valid, initiator: { type: "system", name: "cron" } }],
    ["a non-UUID workspace", { ...valid, workspaceId: "Workspace A" }],
  ])("rejects %s", (_label, input) => {
    expect(() => createOutboxMessage(input)).toThrow(TypeError);
  });
});
