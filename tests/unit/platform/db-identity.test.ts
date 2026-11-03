/**
 * Step H7-production-data-plane-guard — runtime database-environment identity. Pure: no connection, synthetic
 * project references only (the development project is pinned by digest; tests inject a synthetic project's digest).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectionConfigError, assertRuntimeDatabaseIdentity, createRuntimeDatabaseFromEnv, resolveDatabaseAuthority } from "@/platform/db";
import { DEVELOPMENT_PROJECT_REF_SHA256, DEVELOPMENT_REGION } from "@/platform/db/identity";
import { DEV_V2_PROJECT_REF_SHA256 } from "@/tools/db/dev-fixture-guard";
import { codeOf } from "../../support/source-scan";

const DEV = "devdevdevdevdevdevde";
const PROD = "prodprodprodprodprod";
const OTHER = "zyxwvutsrqponmlkjihg";
const PIN = createHash("sha256").update(DEV, "utf8").digest("hex");
const PASSWORD = "synthetic-password-never-echoed";
const url = (login: string, ref: string, region = "sa-east-1"): string => `postgresql://${login}.${ref}:${PASSWORD}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
const local = (login: string): string => `postgresql://${login}:${PASSWORD}@127.0.0.1:5432/postgres`;
const prod = (extra: Record<string, string | undefined> = {}) => ({ DATABASE_ENVIRONMENT_CLASS: "production", DATABASE_EXPECTED_PROJECT_REF: PROD, ...extra });
const dev = (extra: Record<string, string | undefined> = {}) => ({ DATABASE_ENVIRONMENT_CLASS: "development", DATABASE_EXPECTED_PROJECT_REF: DEV, ...extra });

/** Throws a ConnectionConfigError that never echoes a password, URL or project reference. */
const refuses = (run: () => unknown): ConnectionConfigError => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConnectionConfigError);
  const message = (caught as Error).message;
  for (const secret of [PASSWORD, DEV, PROD, OTHER, "postgresql://", "pooler.supabase.com"]) expect(message).not.toContain(secret);
  return caught as ConnectionConfigError;
};

describe("runtime: every connection belongs to the environment's one database project", () => {
  it("1. the correct development project → PASS (explicit authority, and the legacy pin)", () => {
    expect(assertRuntimeDatabaseIdentity(dev({ DATABASE_WORKER_URL: url("worker_login", DEV), DATABASE_SYSTEM_URL: url("system_login", DEV) }))).toMatchObject({ mode: "explicit", environmentClass: "development" });
    expect(assertRuntimeDatabaseIdentity({ DATABASE_WORKER_URL: url("worker_login", DEV), DATABASE_SYSTEM_URL: url("system_login", DEV) }, PIN)).toMatchObject({ mode: "legacy_development" });
    expect(assertRuntimeDatabaseIdentity(prod({ DATABASE_WORKER_URL: url("worker_login", PROD) }), PIN)).toMatchObject({ environmentClass: "production" });
  });

  it("2. a wrong project → FAIL CLOSED (production expecting prod, handed dev; legacy pin handed another project)", () => {
    expect(refuses(() => assertRuntimeDatabaseIdentity(prod({ DATABASE_WORKER_URL: url("worker_login", DEV) }), PIN)).message).toMatch(/DATABASE_WORKER_URL does not belong to the expected production database project; DATABASE_WORKER_URL belongs to the development project/);
    expect(refuses(() => assertRuntimeDatabaseIdentity(dev({ DATABASE_WORKER_URL: url("worker_login", OTHER) }))).message).toMatch(/expected development database project/);
    refuses(() => assertRuntimeDatabaseIdentity({ DATABASE_WORKER_URL: url("worker_login", OTHER) }, PIN));
    refuses(() => assertRuntimeDatabaseIdentity({ DATABASE_WORKER_URL: url("worker_login", OTHER) })); // the real pin: no synthetic ref matches it
  });

  it("3. production (or development) without its expected project reference → FAIL; partial or invalid authority → FAIL", () => {
    expect(refuses(() => assertRuntimeDatabaseIdentity({ DATABASE_ENVIRONMENT_CLASS: "production", DATABASE_WORKER_URL: url("worker_login", PROD) })).message).toMatch(/DATABASE_EXPECTED_PROJECT_REF is required for the production/);
    refuses(() => resolveDatabaseAuthority({ DATABASE_ENVIRONMENT_CLASS: "development" }));
    expect(refuses(() => resolveDatabaseAuthority({ DATABASE_EXPECTED_PROJECT_REF: PROD })).message).toMatch(/DATABASE_ENVIRONMENT_CLASS must be set/);
    refuses(() => resolveDatabaseAuthority({ DATABASE_EXPECTED_REGION: "us-east-1" }));
    for (const value of ["prod", "Production", "staging", "preview", "dev", " "]) {
      if (value.trim() === "") continue;
      expect(refuses(() => resolveDatabaseAuthority({ DATABASE_ENVIRONMENT_CLASS: value, DATABASE_EXPECTED_PROJECT_REF: PROD })).message, value).toMatch(/must be one of development, production/);
    }
    refuses(() => resolveDatabaseAuthority(prod({ DATABASE_EXPECTED_PROJECT_REF: "not-a-ref" })));
    refuses(() => resolveDatabaseAuthority(prod({ DATABASE_EXPECTED_REGION: "sa-east" })));
  });

  it("4. an unparseable or absent actual project identity → FAIL CLOSED (unknown host, local database outside legacy mode)", () => {
    expect(refuses(() => assertRuntimeDatabaseIdentity(prod({ DATABASE_WORKER_URL: `postgresql://worker_login:${PASSWORD}@db.example.com:6543/postgres` }), PIN)).message).toMatch(/carries no recognizable project identity/);
    expect(refuses(() => assertRuntimeDatabaseIdentity(prod({ DATABASE_WORKER_URL: `postgresql://worker_login.short:${PASSWORD}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres` }), PIN)).message).toMatch(/no recognizable project identity/);
    expect(refuses(() => assertRuntimeDatabaseIdentity(prod({ DATABASE_WORKER_URL: local("worker_login") }), PIN)).message).toMatch(/local database, which has no project identity \(production requires one\)/);
    refuses(() => assertRuntimeDatabaseIdentity(dev({ DATABASE_WORKER_URL: local("worker_login") })));
    expect(assertRuntimeDatabaseIdentity({ DATABASE_WORKER_URL: local("worker_login"), DATABASE_SYSTEM_URL: local("system_login") })).toMatchObject({ mode: "legacy_development" });
  });

  it("5. mixed projects in one process → FAIL CLOSED (MAIN: worker → prod, system → dev; or local + managed)", () => {
    expect(refuses(() => assertRuntimeDatabaseIdentity(prod({ DATABASE_WORKER_URL: url("worker_login", PROD), DATABASE_SYSTEM_URL: url("system_login", DEV) }), PIN)).message).toMatch(/DATABASE_SYSTEM_URL does not belong/);
    expect(refuses(() => assertRuntimeDatabaseIdentity({ DATABASE_WORKER_URL: url("worker_login", DEV), DATABASE_SYSTEM_URL: local("system_login") }, PIN)).message).toMatch(/DATABASE_WORKER_URL, DATABASE_SYSTEM_URL point at different database projects/);
    // The check covers EVERY configured runtime URL, whichever pool is created first.
    refuses(() => createRuntimeDatabaseFromEnv("system", { ...prod(), DATABASE_SYSTEM_URL: url("system_login", PROD), DATABASE_WORKER_URL: url("worker_login", OTHER) }));
  });

  it("6. production authority naming the development project → FAIL, even when every URL agrees with it", () => {
    expect(refuses(() => resolveDatabaseAuthority(prod({ DATABASE_EXPECTED_PROJECT_REF: DEV }), PIN)).message).toMatch(/names the development project in the production database environment/);
    refuses(() => assertRuntimeDatabaseIdentity(prod({ DATABASE_EXPECTED_PROJECT_REF: DEV, DATABASE_WORKER_URL: url("worker_login", DEV) }), PIN));
  });

  it("region: optional at runtime (the project ref is the identity); when set, every pooler connection must be in it", () => {
    expect(assertRuntimeDatabaseIdentity(prod({ DATABASE_WORKER_URL: url("worker_login", PROD, "eu-central-1") }), PIN)).toMatchObject({ expectedRegion: undefined });
    expect(assertRuntimeDatabaseIdentity(prod({ DATABASE_EXPECTED_REGION: "eu-central-1", DATABASE_WORKER_URL: url("worker_login", PROD, "eu-central-1") }), PIN)).toMatchObject({ expectedRegion: "eu-central-1" });
    expect(refuses(() => assertRuntimeDatabaseIdentity(prod({ DATABASE_EXPECTED_REGION: "eu-central-1", DATABASE_WORKER_URL: url("worker_login", PROD, "us-east-1") }), PIN)).message).toMatch(/not in the expected region/);
    expect(refuses(() => assertRuntimeDatabaseIdentity({ DATABASE_WORKER_URL: url("worker_login", DEV, "us-east-1") }, PIN)).message).toMatch(/not in the expected region/);
  });

  it("pool creation runs the identity guard BEFORE any pool exists; the legacy pin is the dev-fixture pin and sa-east-1", () => {
    const pool = codeOf("platform/db/pool.ts");
    const body = pool.slice(pool.indexOf("export function createRuntimeDatabaseFromEnv"));
    expect(body.indexOf("assertRuntimeDatabaseIdentity(env);")).toBeGreaterThan(-1);
    expect(body.indexOf("assertRuntimeDatabaseIdentity(env);")).toBeLessThan(body.indexOf("return createRuntimeDatabase("));
    expect(DEVELOPMENT_PROJECT_REF_SHA256).toBe(DEV_V2_PROJECT_REF_SHA256);
    expect(DEVELOPMENT_REGION).toBe("sa-east-1");
    expect(codeOf("platform/db/identity.ts")).not.toMatch(/[a-z0-9]{20}\.supabase|EXPECTED_PROJECT_REF\s*=\s*"/);
    // The three runtimes' only pool factories all go through the guarded entry point.
    for (const [file, kind] of [["jobs/runtime.ts", "worker"], ["jobs/main-runtime.ts", "system"], ["server/persistence/runtime.ts", "web"]] as const) {
      expect(codeOf(file), file).toMatch(new RegExp(`createRuntimeDatabaseFromEnv\\("${kind}"`));
      expect(codeOf(file), file).not.toMatch(/createRuntimeDatabase\(/);
    }
  });
});
