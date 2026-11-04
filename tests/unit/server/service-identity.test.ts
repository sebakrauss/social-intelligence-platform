/**
 * Step H7-ops-tooling-production-parity — the hosted WEB's database/auth identity coherence guard. Pure: synthetic
 * project references and URLs only (the development project is pinned by digest; tests use a synthetic ref where the
 * legacy pin is irrelevant and an explicit authority elsewhere). No connection, no auth client.
 */
import { describe, expect, it } from "vitest";
import { createWebDatabase } from "@/server/persistence/runtime";
import { rejectForbiddenWebEnvironment } from "@/server/http/web-environment";
import {
  SERVICE_IDENTITY_VARIABLES,
  ServiceIdentityError,
  assertServiceIdentity,
  parsePublicSupabaseProject,
  publishableKeyVerification,
  serviceIdentityCoherent,
  serviceIdentityProblems,
} from "@/server/http/service-identity";
import { codeOf } from "../../support/source-scan";

const DEV = "devdevdevdevdevdevde";
const PROD = "prodprodprodprodprod";
const PASSWORD = "synthetic-password-never-echoed";
const db = (ref: string, region = "sa-east-1"): string => `postgresql://web_login.${ref}:${PASSWORD}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
const pub = (ref: string): string => `https://${ref}.supabase.co`;
const explicit = (cls: "development" | "production", ref: string, region = "sa-east-1") => ({ DATABASE_ENVIRONMENT_CLASS: cls, DATABASE_EXPECTED_PROJECT_REF: ref, DATABASE_EXPECTED_REGION: region });
const legacyJwt = (claims: Record<string, unknown>): string => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.c2lnbmF0dXJl`;
const hosted = { NODE_ENV: "production" };
const local = { NODE_ENV: "test" };
const coherentProd = { ...hosted, ...explicit("production", PROD), DATABASE_WEB_URL: db(PROD), NEXT_PUBLIC_SUPABASE_URL: pub(PROD), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic0123456789" };

/** Problems never echo a password, a URL, a key or a project reference. */
const clean = (problems: readonly string[]): readonly string[] => {
  for (const problem of problems) {
    for (const secret of [PASSWORD, DEV, PROD, "postgresql://", "supabase.co", "sb_publishable", "eyJ"]) expect(problem).not.toContain(secret);
  }
  return problems;
};

describe("service identity guard — one project for PostgreSQL and Supabase Auth", () => {
  it("1. a coherent explicit production configuration passes; a coherent explicit development one passes", () => {
    expect(clean(serviceIdentityProblems(coherentProd))).toEqual([]);
    expect(serviceIdentityProblems({ ...hosted, ...explicit("development", DEV), DATABASE_WEB_URL: db(DEV), NEXT_PUBLIC_SUPABASE_URL: pub(DEV) })).toEqual([]);
    expect(serviceIdentityCoherent(coherentProd)).toBe(true);
  });

  it("2. crossed projects fail closed: production database with the development auth project, and the reverse", () => {
    expect(clean(serviceIdentityProblems({ ...coherentProd, NEXT_PUBLIC_SUPABASE_URL: pub(DEV) })).join("\n")).toMatch(/names a different Supabase project than DATABASE_WEB_URL/);
    expect(clean(serviceIdentityProblems({ ...coherentProd, NEXT_PUBLIC_SUPABASE_URL: pub(DEV) })).join("\n")).toMatch(/than DATABASE_EXPECTED_PROJECT_REF/);
    expect(clean(serviceIdentityProblems({ ...hosted, ...explicit("development", DEV), DATABASE_WEB_URL: db(DEV), NEXT_PUBLIC_SUPABASE_URL: pub(PROD) })).length).toBeGreaterThan(0);
    // The database itself off the declared project is the database guard's finding, surfaced here too.
    expect(clean(serviceIdentityProblems({ ...coherentProd, DATABASE_WEB_URL: db(DEV) })).join("\n")).toMatch(/does not belong to the expected production database project/);
  });

  it("3. incomplete or contradictory authority fails closed; a hosted runtime needs both halves", () => {
    expect(clean(serviceIdentityProblems({ ...coherentProd, DATABASE_ENVIRONMENT_CLASS: undefined })).join("\n")).toMatch(/DATABASE_ENVIRONMENT_CLASS must be set/);
    expect(clean(serviceIdentityProblems({ ...coherentProd, DATABASE_EXPECTED_REGION: "us-east-1" })).join("\n")).toMatch(/not in the expected region/);
    expect(clean(serviceIdentityProblems({ ...coherentProd, DATABASE_EXPECTED_PROJECT_REF: DEV, DATABASE_ENVIRONMENT_CLASS: "production" })).length).toBeGreaterThan(0);
    // One half alone has no cross-project to detect (hosted contract: pool guard owns a missing URL, auth reports "unavailable").
    expect(serviceIdentityProblems({ ...hosted, NEXT_PUBLIC_SUPABASE_URL: pub(PROD) })).toEqual([]);
    expect(serviceIdentityProblems({ ...hosted, DATABASE_WEB_URL: db(PROD) })).toEqual([]);
    expect(serviceIdentityProblems({ ...hosted })).toEqual([]);
  });

  it("4. the public URL must name a project by reference: custom domains, http and local emulators are refused against a managed database", () => {
    expect(parsePublicSupabaseProject(pub(PROD))).toEqual({ kind: "project", ref: PROD });
    expect(parsePublicSupabaseProject("https://auth.example.com")).toEqual({ kind: "unknown_host" });
    expect(parsePublicSupabaseProject("http://localhost:54321")).toEqual({ kind: "local" });
    expect(parsePublicSupabaseProject(`http://${PROD}.supabase.co`)).toEqual({ kind: "invalid" });
    expect(parsePublicSupabaseProject("not a url")).toEqual({ kind: "invalid" });
    expect(clean(serviceIdentityProblems({ ...coherentProd, NEXT_PUBLIC_SUPABASE_URL: "https://auth.example.com" })).join("\n")).toMatch(/custom domains are not verifiable here/);
    expect(clean(serviceIdentityProblems({ ...coherentProd, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })).join("\n")).toMatch(/names a local Supabase instance but DATABASE_WEB_URL is a managed database/);
  });

  it("5. local runtimes: one half alone is allowed (current behaviour), both halves must still cohere, local pairs with local in legacy mode only", () => {
    expect(serviceIdentityProblems({ ...local })).toEqual([]);
    expect(serviceIdentityProblems({ ...local, DATABASE_WEB_URL: db(DEV), ...explicit("development", DEV) })).toEqual([]);
    expect(serviceIdentityProblems({ ...local, NEXT_PUBLIC_SUPABASE_URL: pub(DEV) })).toEqual([]);
    expect(clean(serviceIdentityProblems({ ...local, ...explicit("development", DEV), DATABASE_WEB_URL: db(DEV), NEXT_PUBLIC_SUPABASE_URL: pub(PROD) })).length).toBeGreaterThan(0);
    const localDb = `postgresql://web_login:${PASSWORD}@127.0.0.1:5432/postgres`;
    expect(serviceIdentityProblems({ ...local, DATABASE_WEB_URL: localDb, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })).toEqual([]);
    expect(clean(serviceIdentityProblems({ ...local, DATABASE_WEB_URL: localDb, NEXT_PUBLIC_SUPABASE_URL: pub(DEV) })).join("\n")).toMatch(/must name a local Supabase instance/);
    expect(clean(serviceIdentityProblems({ ...local, ...explicit("development", DEV), DATABASE_WEB_URL: localDb, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })).join("\n")).toMatch(/local database/);
  });

  it("6. publishable key: a legacy JWT's ref claim is verifiable offline (and refused on mismatch); sb_publishable_ keys are not verifiable locally", () => {
    expect(publishableKeyVerification(undefined, PROD)).toBe("absent");
    expect(publishableKeyVerification("sb_publishable_synthetic0123456789", PROD)).toBe("unverifiable_locally");
    expect(publishableKeyVerification(legacyJwt({ iss: "supabase", ref: PROD, role: "anon" }), PROD)).toBe("verified_by_claim");
    expect(publishableKeyVerification(legacyJwt({ iss: "supabase", ref: DEV, role: "anon" }), PROD)).toBe("mismatch");
    expect(publishableKeyVerification(legacyJwt({ iss: "supabase", role: "anon" }), PROD)).toBe("unverifiable_locally");
    expect(publishableKeyVerification("eyJ.broken", PROD)).toBe("malformed");
    expect(clean(serviceIdentityProblems({ ...coherentProd, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacyJwt({ ref: DEV }) })).join("\n")).toMatch(/PUBLISHABLE_KEY belongs to a different Supabase project/);
    expect(serviceIdentityProblems({ ...coherentProd, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacyJwt({ ref: PROD }) })).toEqual([]);
  });

  it("7. the guard runs BEFORE any pool exists, and the proxy answers 503 (no-store, no body) on an incoherent identity", () => {
    expect(() => createWebDatabase({ ...coherentProd, NEXT_PUBLIC_SUPABASE_URL: pub(DEV) })).toThrow(ServiceIdentityError);
    expect(() => { assertServiceIdentity({ ...coherentProd, NEXT_PUBLIC_SUPABASE_URL: pub(DEV) }); }).toThrow(/refuses incoherent service identity/);
    const runtime = codeOf("server/persistence/runtime.ts");
    expect(runtime.indexOf("assertWebEnvironment(environment);")).toBeLessThan(runtime.indexOf("assertServiceIdentity(environment);"));
    expect(runtime.indexOf("assertServiceIdentity(environment);")).toBeLessThan(runtime.indexOf("createRuntimeDatabaseFromEnv(\"web\""));
    const refused = rejectForbiddenWebEnvironment({ ...coherentProd, NEXT_PUBLIC_SUPABASE_URL: pub(DEV) });
    expect(refused?.status).toBe(503);
    expect(refused?.headers.get("Cache-Control")).toBe("no-store");
    expect(rejectForbiddenWebEnvironment(coherentProd)).toBeUndefined();
    expect(rejectForbiddenWebEnvironment({ ...local })).toBeUndefined();
    // Auth clients are gated on the same predicate (server/auth): the config is read only when coherent.
    for (const file of ["server/auth/request-auth.ts", "server/auth/proxy.ts"]) expect(codeOf(file), file).toMatch(/serviceIdentityCoherent\(process\.env\) \? readSupabaseAuthConfig\(process\.env\) : undefined/);
    expect(Object.values(SERVICE_IDENTITY_VARIABLES)).toEqual(["DATABASE_WEB_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]);
  });
});
