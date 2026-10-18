/**
 * The hosted web's permanent provider-credential sealing path (Step 7E.10; live-proven 2026-10-16), offline. The
 * production web composition (server/connections/runtime.ts) runs for real — the Vercel OIDC adapter, the official
 * provider, the STS and KMS clients — against an in-process AWS double: `fetch` (Vercel's audience exchange) is stubbed
 * and every HTTP(S) request is trapped and answered locally, so no packet leaves the process. Synthetic account
 * 000000000000, synthetic unsigned tokens and synthetic keys only.
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import type * as SimulatorModule from "@/server/connections/simulator";
import { completeConnectionAuthorization } from "@/server/connections/authorization";
import { connectionAuthorizationRuntime } from "@/server/connections/runtime";

// Count simulator constructions (the original still runs); the web database is never reached in these tests.
const simulatorCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/server/connections/simulator", async (importOriginal) => {
  const original = await importOriginal<typeof SimulatorModule>();
  return { ...original, localSimulator: (...args: Parameters<typeof original.localSimulator>) => { simulatorCalls.count += 1; return original.localSimulator(...args); } };
});
vi.mock("@/server/persistence/runtime", () => ({ webUnitOfWork: () => ({ synthetic: "unit-of-work-never-used" }) }));

const KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-web-encrypt";
const ISSUER = "https://oidc.vercel.com/social-intelligence";
const SUBJECT = "owner:social-intelligence:project:social-intelligence-platform:environment:production";
const SESSION_KEY = "ASIASYNTHETICWEBSESSION0";
const SESSION_SECRET = `synthetic-web-session-secret-${randomUUID()}`;
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
/** Synthetic identifiers of the sealing test (never a real workspace or credential). */
const WORKSPACE_ID = "5eed0000-d1a9-4000-8000-00000000f001";
const CREDENTIAL_ID = "5eed0000-d1a9-4000-8000-00000000f002";
const EXPECTED_CONTEXT = {
  app: "social-intelligence-platform",
  purpose: "provider-credential",
  env: "dev",
  v: "1",
  workspace_id: WORKSPACE_ID,
  credential_id: CREDENTIAL_ID,
};

type Env = Record<string, string | undefined>;
/** The hosted Production web configuration: KMS metadata and the web role; no static AWS credential, no token variable. */
const hostedEnv = (overrides: Env = {}): Env => ({
  NODE_ENV: "production",
  CREDENTIAL_CONTEXT_ENV: "dev",
  CREDENTIAL_KMS_KEY_ARN: KEY,
  CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY,
  CREDENTIAL_KMS_WEB_ROLE_ARN: ROLE,
  APP_BASE_URL: "https://app.example.test",
  OAUTH_PKCE_DERIVATION_KEY: randomBytes(32).toString("base64url"),
  ...overrides,
});

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: Record<string, unknown>): string => [segment({ alg: "RS256" }), segment(payload), "c2lnbmF0dXJl"].join(".");
const now = (): number => Math.floor(Date.now() / 1000);
/** A fresh request token (unique jti: the official provider caches exchanges per token). */
const vercelToken = (claims: Record<string, unknown> = {}): string => jwt({ iss: ISSUER, sub: SUBJECT, aud: "https://vercel.com/social-intelligence", exp: now() + 3600, jti: randomUUID(), ...claims });
function setRequestToken(token: string | undefined): void {
  (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => (token === undefined ? {} : { headers: { "x-vercel-oidc-token": token } }) };
}

// ── In-process AWS + Vercel exchange double ────────────────────────────────────────────────────────────────────
interface Exchange { readonly host: string; readonly target: string; readonly authorization: string; body: string }
const text = (chunk: unknown): string => (typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "");
const header = (headers: Record<string, unknown> | undefined, name: string): string => {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : "";
};
const stsXml = (): string =>
  '<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials>' +
  `<AccessKeyId>${SESSION_KEY}</AccessKeyId><SecretAccessKey>${SESSION_SECRET}</SecretAccessKey>` +
  `<SessionToken>synthetic-web-session-token</SessionToken><Expiration>${new Date(Date.now() + 3_600_000).toISOString()}</Expiration></Credentials>` +
  `<SubjectFromWebIdentityToken>${SUBJECT}</SubjectFromWebIdentityToken><AssumedRoleUser><AssumedRoleId>AROASYNTHETICWEB000000:wrenkind-vercel-web</AssumedRoleId>` +
  "<Arn>arn:aws:sts::000000000000:assumed-role/social-intelligence-platform-dev-web-encrypt/wrenkind-vercel-web</Arn></AssumedRoleUser>" +
  "<Provider>arn:aws:iam::000000000000:oidc-provider/oidc.vercel.com/social-intelligence</Provider><Audience>sts.amazonaws.com</Audience>" +
  "</AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>";

interface World {
  readonly exchanges: Exchange[];
  readonly vercelExchanges: { url: string; aud: unknown }[];
}
function offlineWorld(kms: (exchange: Exchange) => { status: number; body: unknown } = () => ({ status: 200, body: { KeyId: KEY, Plaintext: randomBytes(32).toString("base64"), CiphertextBlob: randomBytes(184).toString("base64") } })): World {
  const world: World = { exchanges: [], vercelExchanges: [] };
  vi.stubGlobal("fetch", (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "null") as { aud?: unknown };
    world.vercelExchanges.push({ url, aud: body.aud });
    return Promise.resolve(new Response(JSON.stringify({ token: jwt({ iss: ISSUER, sub: SUBJECT, aud: body.aud, exp: now() + 3600 }) }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  const trap = (options: unknown, callback?: (response: unknown) => void) => {
    const o = options as { hostname?: string; host?: string; headers?: Record<string, unknown> };
    const exchange: Exchange = { host: o.hostname ?? o.host ?? "", target: header(o.headers, "x-amz-target"), authorization: header(o.headers, "authorization"), body: "" };
    world.exchanges.push(exchange);
    const respond = (): void => {
      let reply = { status: 400, contentType: "application/x-amz-json-1.1", body: JSON.stringify({ __type: "UnexpectedRequest" }) };
      if (exchange.host === "sts.sa-east-1.amazonaws.com" && exchange.body.startsWith("Action=AssumeRoleWithWebIdentity&")) reply = { status: 200, contentType: "text/xml", body: stsXml() };
      else if (exchange.host === "kms.sa-east-1.amazonaws.com" && exchange.target === "TrentService.GenerateDataKey") {
        const answer = kms(exchange);
        reply = { status: answer.status, contentType: "application/x-amz-json-1.1", body: JSON.stringify(answer.body) };
      }
      const response = Object.assign(Readable.from([Buffer.from(reply.body, "utf8")]), { statusCode: reply.status, statusMessage: "", headers: { "content-type": reply.contentType, "x-amzn-requestid": "synthetic" } });
      callback?.(response);
    };
    const request = Object.assign(new EventEmitter(), {
      setTimeout: () => request, setNoDelay: () => undefined, setSocketKeepAlive: () => undefined, destroy: () => undefined, abort: () => undefined,
      write: (chunk: unknown) => { exchange.body += text(chunk); return true; },
      end: (chunk?: unknown) => { if (chunk !== undefined) exchange.body += text(chunk); setImmediate(respond); },
    });
    return request;
  };
  vi.spyOn(https, "request").mockImplementation(trap as never);
  vi.spyOn(http, "request").mockImplementation(trap as never);
  return world;
}
const sts = (world: World) => world.exchanges.filter((e) => e.host.startsWith("sts."));
const kms = (world: World) => world.exchanges.filter((e) => e.host.startsWith("kms."));

beforeEach(() => {
  vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
  vi.stubEnv("AWS_CONFIG_FILE", "/nonexistent/synthetic-aws-config-for-tests");
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/synthetic-aws-config-for-tests");
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe("7E.10 · hosted connection composition: no local-only adapter, the real KMS sealer through Vercel OIDC", () => {
  it("composes without constructing the simulator; every provider is unavailable; the callback fails closed before any database work", async () => {
    const world = offlineWorld();
    simulatorCalls.count = 0;
    const deps = connectionAuthorizationRuntime({ getVerifiedUser: () => Promise.resolve(undefined) }, hostedEnv());
    expect(simulatorCalls.count).toBe(0);
    expect(deps.providers.authorization("simulator")).toBeUndefined();
    // Step 7G-D: without the Meta app configuration the hosted web still composes (boots), and Meta is unavailable.
    expect(deps.providers.authorization("meta")).toBeUndefined();
    const result = await completeConnectionAuthorization(deps, { provider: "simulator", query: [["state", "synthetic"], ["code", "synthetic"]] });
    expect(result).toEqual({ status: "restart_required", reason: "invalid_callback" });
    expect(await completeConnectionAuthorization(deps, { provider: "meta", query: [["state", "synthetic"], ["code", "synthetic"]] })).toEqual({ status: "restart_required", reason: "invalid_callback" });
    expect(world.exchanges).toEqual([]);
    expect(simulatorCalls.count).toBe(0);
  });

  it("sealing is KMS GenerateDataKey through the federated identity: one exchange for sts.amazonaws.com, the fixed session, the exact context, no Decrypt", async () => {
    const world = offlineWorld();
    const deps = connectionAuthorizationRuntime({ getVerifiedUser: () => Promise.resolve(undefined) }, hostedEnv());
    setRequestToken(vercelToken());
    const envelope = await deps.sealing.seal(new Uint8Array(randomBytes(32)), { workspaceId: parseWorkspaceId(WORKSPACE_ID) as WorkspaceId, credentialId: CREDENTIAL_ID });
    expect(envelope.byteLength).toBeGreaterThan(0);
    expect(world.vercelExchanges).toEqual([{ url: "https://oidc.vercel.com/~token", aud: "sts.amazonaws.com" }]);
    expect(sts(world)).toHaveLength(1);
    const assume = new URLSearchParams(sts(world)[0]?.body ?? "");
    expect(sts(world)[0]?.host).toBe("sts.sa-east-1.amazonaws.com");
    expect(assume.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(assume.get("RoleArn")).toBe(ROLE);
    expect(assume.get("RoleSessionName")).toBe("wrenkind-vercel-web");
    expect(assume.get("DurationSeconds")).toBe("3600");
    expect(kms(world).map((e) => e.target)).toEqual(["TrentService.GenerateDataKey"]);
    expect(kms(world)[0]?.authorization).toContain(`Credential=${SESSION_KEY}/`);
    const request = JSON.parse(kms(world)[0]?.body ?? "{}") as Record<string, unknown>;
    expect(request["KeyId"]).toBe(KEY);
    expect(request["EncryptionContext"]).toEqual(EXPECTED_CONTEXT);
    expect(Object.keys(request["EncryptionContext"] as object)).toEqual(["app", "purpose", "env", "v", "workspace_id", "credential_id"]);
    for (const exchange of world.exchanges) expect(exchange.target).not.toMatch(/Decrypt|ReEncrypt|\.Encrypt$|CreateGrant/);
    expect(simulatorCalls.count).toBe(0);
  });
});
