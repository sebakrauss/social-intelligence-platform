/**
 * TA-11A hosted-web hardening, without a database: security headers, Secure session cookies, the serverless web
 * pool, the forbidden-configuration guard, the generic health contract, and the provider connection flow still
 * failing closed in a production-built runtime. The real web pool against a database is proven in
 * tests/db/suites/hosted-web.ts.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const createServerClient = vi.fn((...args: unknown[]) => ({ auth: {}, argumentCount: args.length }));
vi.mock("@supabase/ssr", () => ({ createServerClient: (...args: unknown[]) => createServerClient(...args) }));

import nextConfig from "@/next.config";
import { createSupabaseAuth, readSupabaseAuthConfig } from "@/platform/auth";
import { ConnectionConfigError, createRuntimeDatabaseFromEnv, type RuntimeDatabase } from "@/platform/db";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "@/server/http/security-headers";
import { FORBIDDEN_WEB_VARIABLES, WebEnvironmentError, assertWebEnvironment, forbiddenWebVariables, rejectForbiddenWebEnvironment } from "@/server/http/web-environment";
import { HEALTHY, UNHEALTHY, webHealth } from "@/server/http/health";
import { createWebDatabase, webPoolMax } from "@/server/persistence/runtime";
import { connectionAuthorizationRuntime } from "@/server/connections/runtime";

const LOCAL_WEB_URL = ["postgresql://web_login:", "local-test", "@127.0.0.1:5432/postgres"].join("");
const SECRET_MARKER = "synthetic-secret-value-never-echoed";

afterEach(() => {
  createServerClient.mockClear();
});

describe("6B.1 · security headers", () => {
  it("every path gets the reviewed minimum headers", async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS.map(({ key, value }) => ({ key, value })) }]);
    const byKey = Object.fromEntries(SECURITY_HEADERS.map(({ key, value }) => [key, value]));
    expect(byKey).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
      "Strict-Transport-Security": "max-age=31536000",
    });
  });

  it("never fakes a strict CSP and never touches Cache-Control (the proxy's private, no-store stays authoritative)", () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|script-src|style-src|default-src|https?:/);
    expect(SECURITY_HEADERS.some(({ key }) => key.toLowerCase() === "cache-control")).toBe(false);
  });
});

describe("6B.2 · Secure session cookies outside local development", () => {
  const env = (nodeEnv: string | undefined) => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://project.example.test",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-test-key",
    ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
  });
  const cookieOptionsFor = (nodeEnv: string | undefined): unknown => {
    const config = readSupabaseAuthConfig(env(nodeEnv));
    if (config === undefined) throw new Error("config");
    createSupabaseAuth(config, { getAll: () => [], setAll: () => undefined });
    const options = createServerClient.mock.calls.at(-1)?.[2] as { cookieOptions?: unknown };
    return options.cookieOptions;
  };

  it.each(["production", undefined, "staging"])("hosted runtime (NODE_ENV=%s): Secure is set explicitly, nothing else", (nodeEnv) => {
    expect(readSupabaseAuthConfig(env(nodeEnv))?.secureCookies).toBe(true);
    expect(cookieOptionsFor(nodeEnv)).toEqual({ secure: true }); // SameSite/httpOnly/maxAge stay the library defaults
  });

  it.each(["development", "test"])("local runtime (NODE_ENV=%s) on http://localhost keeps the previous behavior", (nodeEnv) => {
    expect(readSupabaseAuthConfig(env(nodeEnv))?.secureCookies).toBe(false);
    expect(cookieOptionsFor(nodeEnv)).toBeUndefined();
  });
});

describe("6B.3 · web pool size for serverless hosting", () => {
  const maxOf = (database: RuntimeDatabase): unknown => (database.pool as unknown as { options: { max: unknown } }).options.max;

  it("a hosted web instance keeps exactly one connection; local development/test keep 4", () => {
    expect(webPoolMax({ NODE_ENV: "production" })).toBe(1);
    expect(webPoolMax({})).toBe(1);
    expect(webPoolMax({ NODE_ENV: "development" })).toBe(4);
    expect(webPoolMax({ NODE_ENV: "test" })).toBe(4);
    const hosted = createWebDatabase({ NODE_ENV: "production", DATABASE_WEB_URL: LOCAL_WEB_URL });
    const local = createWebDatabase({ NODE_ENV: "development", DATABASE_WEB_URL: LOCAL_WEB_URL });
    expect([maxOf(hosted), maxOf(local)]).toEqual([1, 4]);
    void hosted.end();
    void local.end();
  });

  it("only the web runtime changed: other runtime pools keep their own sizing", () => {
    const worker = createRuntimeDatabaseFromEnv("worker", { DATABASE_WORKER_URL: LOCAL_WEB_URL.replace("web_login", "worker_login") });
    expect(maxOf(worker)).toBe(4);
    void worker.end();
  });

  it("the web role and transaction-pooler guards still apply to the web pool", () => {
    for (const url of [LOCAL_WEB_URL.replace("web_login", "postgres"), LOCAL_WEB_URL.replace("web_login", "worker_login")]) {
      expect(() => createWebDatabase({ NODE_ENV: "production", DATABASE_WEB_URL: url })).toThrow(ConnectionConfigError);
    }
  });
});

describe("6B.4 · forbidden configuration in the hosted web runtime", () => {
  it("the closed list is exactly the reviewed one", () => {
    expect([...FORBIDDEN_WEB_VARIABLES]).toEqual([
      "DATABASE_WORKER_URL",
      "DATABASE_SYSTEM_URL",
      "DATABASE_MIGRATION_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SECRET_KEY",
      "TRIGGER_PREVIEW_SECRET_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "SUPABASE_PROJECT_REF",
      "TRIGGER_PROJECT_REF",
      "APP_DEPLOYMENT_ENV",
      "CAPABILITY_PROVIDER_MODE",
    ]);
    expect(FORBIDDEN_WEB_VARIABLES).not.toContain("TRIGGER_SECRET_KEY");
    expect(FORBIDDEN_WEB_VARIABLES).not.toContain("TRIGGER_PREVIEW_BRANCH");
  });

  // 6B.1: tooling and job-composition configuration never reaches the deployed web, each name on its own.
  const TOOLING_AND_JOB_CONFIGURATION = ["SUPABASE_PROJECT_REF", "TRIGGER_PROJECT_REF", "APP_DEPLOYMENT_ENV", "CAPABILITY_PROVIDER_MODE"] as const;

  it.each([...TOOLING_AND_JOB_CONFIGURATION])("%s alone fails closed (even empty): guard, pool and proxy all refuse, naming only it", async (name) => {
    for (const value of [SECRET_MARKER, ""]) {
      const environment = { NODE_ENV: "production", DATABASE_WEB_URL: LOCAL_WEB_URL, [name]: value };
      expect(forbiddenWebVariables(environment)).toEqual([name]);
      expect(() => { createWebDatabase(environment); }).toThrow(WebEnvironmentError);
      let error: unknown;
      try {
        assertWebEnvironment(environment);
      } catch (caught) {
        error = caught;
      }
      expect((error as WebEnvironmentError).variables).toEqual([name]);
      expect((error as Error).message).toBe(`web runtime refuses forbidden configuration: ${name}`);
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(SECRET_MARKER);

      const lines: string[] = [];
      const consoleLog = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      try {
        const response = rejectForbiddenWebEnvironment(environment);
        expect(response?.status).toBe(503);
        expect(await response?.text()).toBe("");
      } finally {
        consoleLog.mockRestore();
      }
      const logged = lines.join("");
      expect(logged).toContain("web.environment.rejected");
      expect(logged).toContain(name);
      expect(logged).not.toContain(SECRET_MARKER);
      for (const other of FORBIDDEN_WEB_VARIABLES.filter((candidate) => candidate !== name)) expect(logged).not.toContain(`${other}"`);
    }
  });

  it.each(["development", "test"])("the %s exemption is unchanged for the tooling/job configuration", (nodeEnv) => {
    const environment = Object.fromEntries(TOOLING_AND_JOB_CONFIGURATION.map((name) => [name, SECRET_MARKER]));
    expect(forbiddenWebVariables({ NODE_ENV: nodeEnv, ...environment })).toEqual([]);
    expect(rejectForbiddenWebEnvironment({ NODE_ENV: nodeEnv, ...environment })).toBeUndefined();
  });

  it.each([...FORBIDDEN_WEB_VARIABLES])("%s is refused by name, never by value, before any pool exists", (name) => {
    const environment = { NODE_ENV: "production", DATABASE_WEB_URL: LOCAL_WEB_URL, [name]: SECRET_MARKER };
    expect(forbiddenWebVariables(environment)).toEqual([name]);
    let error: unknown;
    try {
      createWebDatabase(environment);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WebEnvironmentError);
    expect((error as Error).message).toContain(name);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(SECRET_MARKER);
  });

  it("the proxy answers a generic 503 (no-store, no body) for every request while forbidden configuration is present", async () => {
    const response = rejectForbiddenWebEnvironment({ NODE_ENV: "production", DATABASE_SYSTEM_URL: SECRET_MARKER, AWS_SECRET_ACCESS_KEY: SECRET_MARKER });
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.text()).toBe("");
    expect(rejectForbiddenWebEnvironment({ NODE_ENV: "production", DATABASE_WEB_URL: LOCAL_WEB_URL })).toBeUndefined();
  });

  it("development/test runtimes are exempt; presence alone (even empty) is refused; the TA-11A contract passes", () => {
    expect(forbiddenWebVariables({ NODE_ENV: "development", DATABASE_MIGRATION_URL: SECRET_MARKER })).toEqual([]);
    expect(forbiddenWebVariables({ NODE_ENV: "test", DATABASE_WORKER_URL: SECRET_MARKER })).toEqual([]);
    expect(forbiddenWebVariables({ NODE_ENV: "production", DATABASE_WORKER_URL: "" })).toEqual(["DATABASE_WORKER_URL"]);
    expect(() => {
      assertWebEnvironment({
      NODE_ENV: "production",
      DATABASE_WEB_URL: "x",
      DATABASE_SSL_ROOT_CERT_PEM: "x",
      NEXT_PUBLIC_SUPABASE_URL: "x",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "x",
      APP_BASE_URL: "x",
      // Optional for later TA-11B; not forbidden, not required:
      TRIGGER_SECRET_KEY: "x",
      });
    }).not.toThrow();
  });
});

describe("6B.5 · health contract", () => {
  const ok = { pool: { query: () => Promise.resolve({ rows: [{ "?column?": 1 }] }) } } as unknown as RuntimeDatabase<"web">;

  it("200 {status: ok}, never cached, when one round trip succeeds", async () => {
    const response = await webHealth(() => ok);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(HEALTHY);
  });

  it.each([
    ["a database failure carrying details", () => ({ pool: { query: () => Promise.reject(new Error(`password authentication failed for user "web_login" host=db.internal ${SECRET_MARKER}`)) } }) as unknown as RuntimeDatabase<"web">],
    ["a privileged DATABASE_WEB_URL", () => createWebDatabase({ NODE_ENV: "production", DATABASE_WEB_URL: LOCAL_WEB_URL.replace("web_login", "postgres") })],
    ["a worker credential as DATABASE_WEB_URL", () => createWebDatabase({ NODE_ENV: "production", DATABASE_WEB_URL: LOCAL_WEB_URL.replace("web_login", "worker_login") })],
    ["a missing DATABASE_WEB_URL", () => createWebDatabase({ NODE_ENV: "production" })],
    ["forbidden configuration present", () => createWebDatabase({ NODE_ENV: "production", DATABASE_WEB_URL: LOCAL_WEB_URL, DATABASE_MIGRATION_URL: SECRET_MARKER })],
  ])("%s → generic 503 with no detail", async (_label, open) => {
    const response = await webHealth(open);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(UNHEALTHY);
    expect(text).not.toMatch(/web_login|worker|postgres|password|host|select|DATABASE_|synthetic/i);
  });
});

describe("6B.6 · provider connections stay fail-closed in a production-built web runtime", () => {
  const identity = { getVerifiedUser: () => Promise.resolve(undefined) };
  const hosted = {
    NODE_ENV: "production",
    APP_BASE_URL: "https://app.example.test",
    OAUTH_PKCE_DERIVATION_KEY: randomBytes(32).toString("base64url"),
  };

  it("the simulated provider flow can't be composed: the simulator is development/test only", () => {
    expect(() => connectionAuthorizationRuntime(identity, hosted)).toThrow(/simulator is local\/test only/);
  });

  it("the staging stub never applies to the web flow, and a local keyring is refused, not adopted", () => {
    expect(() => connectionAuthorizationRuntime(identity, { ...hosted, APP_DEPLOYMENT_ENV: "preview", CAPABILITY_PROVIDER_MODE: "staging_stub" })).toThrow(/simulator is local\/test only/);
    expect(() => connectionAuthorizationRuntime(identity, { ...hosted, LOCAL_KEYRING_KEY: randomBytes(32).toString("base64url") })).toThrow(/local_keyring_forbidden/);
  });
});
