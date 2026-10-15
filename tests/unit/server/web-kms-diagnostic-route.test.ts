/**
 * Step 7E.10-C0 — the TEMPORARY operator route of the hosted web KMS identity diagnostic, offline. The handler is tested
 * with a diagnostic spy (every pre-diagnostic refusal, the single invocation, the sanitized responses), and the real
 * app route is driven end to end through the production composition against in-process doubles: `fetch` (Vercel's
 * audience exchange) is stubbed and every HTTP(S) request is trapped, so no packet leaves the process. Operator keys
 * are generated per run; nothing here is a real secret.
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "@/app/api/internal/kms-web-diagnostic/route";
import { WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT, WebKmsDiagnosticError, type WebKmsDiagnosticOutcome } from "@/server/connections/web-kms-diagnostic";
import {
  WEB_KMS_DIAGNOSTIC_OPERATOR_HEADER,
  WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV,
  WEB_KMS_DIAGNOSTIC_ROUTE_REFUSED,
  handleWebKmsDiagnosticRequest,
  isStrongOperatorKey,
  type WebKmsDiagnose,
} from "@/server/connections/web-kms-diagnostic-route";

const URL_PATH = "https://app.example.test/api/internal/kms-web-diagnostic";
const KEY = randomBytes(32).toString("base64url");
const OIDC_MARKER = `synthetic-oidc-${randomUUID()}`;
const ACK_BODY = JSON.stringify({ acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT });
const OUTCOME: WebKmsDiagnosticOutcome = Object.freeze({
  result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_PASSED",
  nodeVersion: "v22.16.0",
  node22: true,
  contextEnv: "dev",
  issuerMode: "team",
  expectedSubjectMatched: true,
  roleSessionName: "wrenkind-vercel-web",
  generateDataKey: true,
});

type Env = Record<string, string | undefined>;
const productionEnv = (overrides: Env = {}): Env => ({ NODE_ENV: "production", VERCEL_ENV: "production", [WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV]: KEY, ...overrides });
const post = (options: { readonly url?: string; readonly key?: string | null; readonly body?: string; readonly method?: string; readonly headers?: Record<string, string> } = {}): Request => {
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
  if (options.key !== null) headers[WEB_KMS_DIAGNOSTIC_OPERATOR_HEADER] = options.key ?? KEY;
  const method = options.method ?? "POST";
  return new Request(options.url ?? URL_PATH, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: options.body ?? ACK_BODY }) });
};

const spy = () => vi.fn<WebKmsDiagnose>(() => Promise.resolve(OUTCOME));

async function expectRefused(response: Response, diagnose: ReturnType<typeof spy>): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual(WEB_KMS_DIAGNOSTIC_ROUTE_REFUSED);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(diagnose).not.toHaveBeenCalled();
}

describe("7E.10-C0 · the app route", () => {
  it("A · exports POST only (GET, PUT, … never reach anything) and is dynamic", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic"]);
    expect(route.dynamic).toBe("force-dynamic");
  });
});

describe("7E.10-C0 · every pre-diagnostic check refuses with the same generic 404 and never invokes the diagnostic", () => {
  it("A · a GET (or any non-POST) request is refused even with the right key and body", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const diagnose = spy();
      await expectRefused(await handleWebKmsDiagnosticRequest(post({ method }), productionEnv(), diagnose), diagnose);
    }
  });

  it.each<[string, Env]>([
    ["B · no operator key configured", productionEnv({ [WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV]: undefined })],
    ["B · empty operator key configured", productionEnv({ [WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV]: "" })],
    ["B · weak key (short base64url)", productionEnv({ [WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV]: "short-key" })],
    ["B · weak key (63 hex characters)", productionEnv({ [WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV]: "a".repeat(63) })],
    ["B · malformed key (whitespace)", productionEnv({ [WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV]: `${KEY} ` })],
    ["H · Vercel Preview", productionEnv({ VERCEL_ENV: "preview" })],
    ["I · Vercel Development", productionEnv({ VERCEL_ENV: "development" })],
    ["I · development runtime", productionEnv({ NODE_ENV: "development" })],
    ["I · test runtime", productionEnv({ NODE_ENV: "test" })],
    ["not on Vercel", productionEnv({ VERCEL_ENV: undefined })],
  ])("%s", async (_label, env) => {
    const diagnose = spy();
    // Even a request carrying exactly the configured value is refused.
    const configured = env[WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV];
    await expectRefused(await handleWebKmsDiagnosticRequest(post({ key: configured === undefined || configured === "" ? KEY : configured }), env, diagnose), diagnose);
  });

  it.each<[string, Parameters<typeof post>[0]]>([
    ["C · no diagnostic header", { key: null }],
    ["C · empty diagnostic header", { key: "" }],
    ["D · wrong key of the same length", { key: randomBytes(32).toString("base64url") }],
    ["D · the right key with a suffix", { key: `${KEY}x` }],
    ["D · the right key's prefix", { key: KEY.slice(0, -1) }],
    ["D · the key in the query string (refused even with the header)", { url: `${URL_PATH}?key=${KEY}` }],
    ["D · any query string at all", { url: `${URL_PATH}?x=1` }],
    ["D · the key in the body instead of the header", { key: null, body: JSON.stringify({ acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT, key: KEY }) }],
    ["D · the key in another header", { key: null, headers: { authorization: `Bearer ${KEY}` } }],
    ["E · missing acknowledgement", { body: "{}" }],
    ["E · empty body", { body: "" }],
    ["E · not JSON", { body: "acknowledge=VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_V1" }],
    ["E · JSON array", { body: JSON.stringify([WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT]) }],
    ["F · wrong acknowledgement", { body: JSON.stringify({ acknowledge: "INTEGRATION_KMS_WORKER_AUTH_DIAGNOSTIC_V1" }) }],
    ["F · acknowledgement in another case", { body: JSON.stringify({ acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT.toLowerCase() }) }],
    ["G · extra body field", { body: JSON.stringify({ acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT, workspaceId: "5eed0000-d1a9-4000-8000-00000000e001" }) }],
    ["G · an OIDC token in the body is never accepted", { body: JSON.stringify({ acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT, token: OIDC_MARKER }) }],
    ["oversized body", { body: JSON.stringify({ acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT, pad: "a".repeat(2048) }) }],
  ])("%s", async (_label, options) => {
    const diagnose = spy();
    await expectRefused(await handleWebKmsDiagnosticRequest(post(options), productionEnv(), diagnose), diagnose);
  });

  it("the key strength contract: ≥ 32 random bytes as 64+ hex or 43+ base64url characters", () => {
    expect(isStrongOperatorKey(randomBytes(32).toString("base64url"))).toBe(true);
    expect(isStrongOperatorKey(randomBytes(32).toString("hex"))).toBe(true);
    expect(isStrongOperatorKey(randomBytes(31).toString("base64url"))).toBe(false);
    expect(isStrongOperatorKey(randomBytes(31).toString("hex"))).toBe(false);
    expect(isStrongOperatorKey(Buffer.alloc(32, 0xfb).toString("base64"))).toBe(false); // standard base64 (+ / =) is not accepted
    expect(isStrongOperatorKey(undefined)).toBe(false);
    expect(isStrongOperatorKey("")).toBe(false);
  });
});

describe("7E.10-C0 · the single invocation and its sanitized responses", () => {
  it("J/K · Production + the right key + the exact acknowledgement invokes the diagnostic exactly once and returns only its outcome", async () => {
    const diagnose = spy();
    const env = productionEnv();
    const response = await handleWebKmsDiagnosticRequest(post({ headers: { "x-vercel-oidc-token": OIDC_MARKER } }), env, diagnose);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(OUTCOME);
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose).toHaveBeenCalledWith({ acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT }, env);
    // L/M · neither the operator key nor any token appears in the response.
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(OIDC_MARKER);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("K · a diagnostic failure is its closed code only (500), invoked once, never retried, no raw message", async () => {
    const failing = vi.fn<WebKmsDiagnose>(() => Promise.reject(new WebKmsDiagnosticError("web_kms_diagnostic_keyring_access_denied")));
    const response = await handleWebKmsDiagnosticRequest(post(), productionEnv(), failing);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_FAILED", failure: "web_kms_diagnostic_keyring_access_denied" });
    expect(failing).toHaveBeenCalledTimes(1);

    const unexpected = vi.fn<WebKmsDiagnose>(() => Promise.reject(new Error(`synthetic ${KEY} ${OIDC_MARKER} arn:aws:kms:sa-east-1:000000000000:key/leak`)));
    const leak = await handleWebKmsDiagnosticRequest(post(), productionEnv(), unexpected);
    const text = await leak.text();
    expect(JSON.parse(text)).toEqual({ result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_FAILED", failure: "web_kms_diagnostic_failed" });
    for (const needle of [KEY, OIDC_MARKER, "arn:aws", "000000000000", "synthetic"]) expect(text).not.toContain(needle);
    expect(unexpected).toHaveBeenCalledTimes(1);
  });
});

// ── End to end through the real app route and the production composition (offline doubles) ──────────────────────
const KMS_KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-web-encrypt";
const ISSUER = "https://oidc.vercel.com/social-intelligence";
const SUBJECT = "owner:social-intelligence:project:social-intelligence-platform:environment:production";
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: Record<string, unknown>): string => [segment({ alg: "RS256" }), segment(payload), "c2lnbmF0dXJl"].join(".");
const now = (): number => Math.floor(Date.now() / 1000);

interface Exchange { readonly host: string; readonly target: string; body: string }
function offline(kmsStatus = 200): { readonly exchanges: Exchange[]; readonly vercel: number[] } {
  const world = { exchanges: [] as Exchange[], vercel: [] as number[] };
  vi.stubGlobal("fetch", (_url: string, init?: { body?: string }) => {
    world.vercel.push(1);
    const aud = (JSON.parse(init?.body ?? "null") as { aud?: unknown }).aud;
    return Promise.resolve(new Response(JSON.stringify({ token: jwt({ iss: ISSUER, sub: SUBJECT, aud, exp: now() + 3600 }) }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  const trap = (options: unknown, callback?: (response: unknown) => void) => {
    const o = options as { hostname?: string; host?: string; headers?: Record<string, unknown> };
    const target = Object.entries(o.headers ?? {}).find(([k]) => k.toLowerCase() === "x-amz-target")?.[1];
    const exchange: Exchange = { host: o.hostname ?? o.host ?? "", target: typeof target === "string" ? target : "", body: "" };
    world.exchanges.push(exchange);
    const respond = (): void => {
      let status = 400;
      let contentType = "application/x-amz-json-1.1";
      let body = JSON.stringify({ __type: "UnexpectedRequest" });
      if (exchange.host === "sts.sa-east-1.amazonaws.com") {
        status = 200;
        contentType = "text/xml";
        body =
          '<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials>' +
          `<AccessKeyId>ASIASYNTHETICROUTE000</AccessKeyId><SecretAccessKey>synthetic-route-session-secret</SecretAccessKey><SessionToken>synthetic</SessionToken>` +
          `<Expiration>${new Date(Date.now() + 3_600_000).toISOString()}</Expiration></Credentials><AssumedRoleUser><AssumedRoleId>AROASYNTHETIC:wrenkind-vercel-web</AssumedRoleId>` +
          "<Arn>arn:aws:sts::000000000000:assumed-role/social-intelligence-platform-dev-web-encrypt/wrenkind-vercel-web</Arn></AssumedRoleUser></AssumeRoleWithWebIdentityResult>" +
          "<ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>";
      } else if (exchange.host === "kms.sa-east-1.amazonaws.com" && exchange.target === "TrentService.GenerateDataKey") {
        status = kmsStatus;
        body = kmsStatus === 200 ? JSON.stringify({ KeyId: KMS_KEY, Plaintext: randomBytes(32).toString("base64"), CiphertextBlob: randomBytes(184).toString("base64") }) : JSON.stringify({ __type: "KMSInternalException", message: "synthetic" });
      }
      callback?.(Object.assign(Readable.from([Buffer.from(body, "utf8")]), { statusCode: status, statusMessage: "", headers: { "content-type": contentType, "x-amzn-requestid": "synthetic" } }));
    };
    const request = Object.assign(new EventEmitter(), {
      setTimeout: () => request, setNoDelay: () => undefined, setSocketKeepAlive: () => undefined, destroy: () => undefined, abort: () => undefined,
      write: (chunk: unknown) => { exchange.body += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"); return true; },
      end: (chunk?: unknown) => { if (chunk !== undefined) exchange.body += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"); setImmediate(respond); },
    });
    return request;
  };
  vi.spyOn(https, "request").mockImplementation(trap as never);
  vi.spyOn(http, "request").mockImplementation(trap as never);
  return world;
}

describe("7E.10-C0 · end to end through the real app route (production composition, offline)", () => {
  const hosted: Env = { NODE_ENV: "production", VERCEL_ENV: "production", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KMS_KEY, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KMS_KEY, CREDENTIAL_KMS_WEB_ROLE_ARN: ROLE, [WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV]: KEY };
  const useEnv = (env: Env): void => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  };
  const setRequestToken = (token: string): void => {
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ headers: { "x-vercel-oidc-token": token } }) };
  };

  beforeEach(() => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    vi.stubEnv("AWS_CONFIG_FILE", "/nonexistent/synthetic-aws-config-for-tests");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/synthetic-aws-config-for-tests");
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "LOCAL_KEYRING_KEY"]) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("J/P · one POST → one exchange, ONE AssumeRoleWithWebIdentity (fixed session), ONE GenerateDataKey, no Decrypt, sanitized 200", async () => {
    useEnv(hosted);
    const world = offline();
    const token = jwt({ iss: ISSUER, sub: SUBJECT, exp: now() + 3600, jti: randomUUID() });
    setRequestToken(token);
    const response = await route.POST(post());
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_PASSED", roleSessionName: "wrenkind-vercel-web", generateDataKey: true, contextEnv: "dev", issuerMode: "team" });
    expect(world.vercel).toHaveLength(1);
    const stsCalls = world.exchanges.filter((e) => e.host.startsWith("sts."));
    const kmsCalls = world.exchanges.filter((e) => e.host.startsWith("kms."));
    expect(stsCalls).toHaveLength(1);
    expect(new URLSearchParams(stsCalls[0]?.body ?? "").get("RoleSessionName")).toBe("wrenkind-vercel-web");
    expect(kmsCalls.map((e) => e.target)).toEqual(["TrentService.GenerateDataKey"]);
    for (const needle of [KEY, token, "ASIASYNTHETICROUTE000", "synthetic-route-session-secret", ROLE, KMS_KEY]) expect(text).not.toContain(needle);
  });

  it("P · a KMS server error is not retried: still one AssumeRoleWithWebIdentity and one GenerateDataKey; closed failure code", async () => {
    useEnv(hosted);
    const world = offline(500);
    setRequestToken(jwt({ iss: ISSUER, sub: SUBJECT, exp: now() + 3600, jti: randomUUID() }));
    const response = await route.POST(post());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_FAILED", failure: "web_kms_diagnostic_keyring_unavailable" });
    expect(world.exchanges.filter((e) => e.host.startsWith("sts."))).toHaveLength(1);
    expect(world.exchanges.filter((e) => e.host.startsWith("kms."))).toHaveLength(1);
  });

  it("N · static AWS credentials in the hosted web are refused before any exchange or AWS request", async () => {
    useEnv({ ...hosted, AWS_ACCESS_KEY_ID: "AKIASYNTHETICSTATIC00", AWS_SECRET_ACCESS_KEY: "synthetic-static-secret" });
    const world = offline();
    setRequestToken(jwt({ iss: ISSUER, sub: SUBJECT, exp: now() + 3600, jti: randomUUID() }));
    const response = await route.POST(post());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_FAILED", failure: "web_kms_diagnostic_environment_refused" });
    expect(world.exchanges).toEqual([]);
    expect(world.vercel).toEqual([]);
  });

  it("H · a Preview deployment never reaches the diagnostic, even with the key, the acknowledgement and a valid token", async () => {
    useEnv({ ...hosted, VERCEL_ENV: "preview" });
    const world = offline();
    setRequestToken(jwt({ iss: ISSUER, sub: SUBJECT.replace("production", "preview"), exp: now() + 3600, jti: randomUUID() }));
    const response = await route.POST(post());
    expect(response.status).toBe(404);
    expect(world.exchanges).toEqual([]);
    expect(world.vercel).toEqual([]);
  });
});
