/**
 * Step 7E.10-B — the hosted web's OIDC → KMS sealing path and its KMS identity diagnostic, offline. The production
 * composition (server/connections/runtime.ts) runs for real — the Vercel adapter, the official provider, the STS and KMS
 * clients — against an in-process AWS double: `fetch` (Vercel's audience exchange) is stubbed and every HTTP(S) request
 * is trapped and answered locally, so no packet leaves the process and every AWS attempt is counted. Synthetic account
 * 000000000000, synthetic unsigned tokens and synthetic keys only.
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { CredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { KMS_PROVIDER_CREDENTIALS_KEY_REF } from "@/platform/crypto/credentials/aws-kms-config";
import type { CredentialSealer } from "@/platform/crypto/credentials/seal";
import type * as SimulatorModule from "@/server/connections/simulator";
import { completeConnectionAuthorization } from "@/server/connections/authorization";
import { connectionAuthorizationRuntime, webKmsIdentityDiagnostic } from "@/server/connections/runtime";
import {
  WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT,
  WEB_KMS_DIAGNOSTIC_CREDENTIAL_ID,
  WEB_KMS_DIAGNOSTIC_FAILURES,
  WEB_KMS_DIAGNOSTIC_WORKSPACE_ID,
  WebKmsDiagnosticError,
  runWebKmsIdentityDiagnostic,
  type WebKmsDiagnosticDependencies,
  type WebKmsDiagnosticFailure,
} from "@/server/connections/web-kms-diagnostic";

// Count simulator constructions (the original still runs); the web database is never reached in these tests.
const simulatorCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/server/connections/simulator", async (importOriginal) => {
  const original = await importOriginal<typeof SimulatorModule>();
  return { ...original, localSimulator: (...args: Parameters<typeof original.localSimulator>) => { simulatorCalls.count += 1; return original.localSimulator(...args); } };
});
vi.mock("@/server/persistence/runtime", () => ({ webUnitOfWork: () => ({ synthetic: "unit-of-work-never-used" }) }));

const KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const KEY_OTHER = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000bb";
const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-web-encrypt";
const ISSUER = "https://oidc.vercel.com/social-intelligence";
const SUBJECT = "owner:social-intelligence:project:social-intelligence-platform:environment:production";
const SESSION_KEY = "ASIASYNTHETICWEBSESSION0";
const SESSION_SECRET = `synthetic-web-session-secret-${randomUUID()}`;
const ACK = { acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT };
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const EXPECTED_CONTEXT = {
  app: "social-intelligence-platform",
  purpose: "provider-credential",
  env: "dev",
  v: "1",
  workspace_id: WEB_KMS_DIAGNOSTIC_WORKSPACE_ID,
  credential_id: WEB_KMS_DIAGNOSTIC_CREDENTIAL_ID,
};

type Env = Record<string, string | undefined>;
/** The approved hosted Production web configuration for the diagnostic (no static AWS credential, no token variable). */
const hostedEnv = (overrides: Env = {}): Env => ({
  NODE_ENV: "production",
  VERCEL_ENV: "production",
  CREDENTIAL_CONTEXT_ENV: "dev",
  CREDENTIAL_KMS_KEY_ARN: KEY,
  CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY,
  CREDENTIAL_KMS_WEB_ROLE_ARN: ROLE,
  ...overrides,
});
const withoutKey = (env: Env, name: string): Env => Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));

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

async function failureOf(run: Promise<unknown>): Promise<WebKmsDiagnosticFailure | "resolved"> {
  const error = await run.then(() => "resolved" as const, (e: unknown) => e);
  if (error === "resolved") return error;
  expect(error).toBeInstanceOf(WebKmsDiagnosticError);
  return (error as WebKmsDiagnosticError).failure;
}

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

describe("7E.10-B · the production diagnostic composition, end to end against the in-process doubles", () => {
  it("passes with ONE exchange (sts.amazonaws.com), ONE AssumeRoleWithWebIdentity (fixed session), ONE GenerateDataKey (exact context), no Decrypt", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    const world = offlineWorld();
    setRequestToken(vercelToken());
    const outcome = await webKmsIdentityDiagnostic(ACK, hostedEnv());

    expect(outcome).toEqual({
      result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_PASSED",
      nodeVersion: process.version,
      node22: true,
      contextEnv: "dev",
      issuerMode: "team",
      expectedSubjectMatched: true,
      roleSessionName: "wrenkind-vercel-web",
      generateDataKey: true,
    });
    // Vercel's audience exchange: once, for the AWS-targeted audience only.
    expect(world.vercelExchanges).toEqual([{ url: "https://oidc.vercel.com/~token", aud: "sts.amazonaws.com" }]);
    // STS: regional, the exact federation request with the fixed session name.
    expect(sts(world)).toHaveLength(1);
    const assume = new URLSearchParams(sts(world)[0]?.body ?? "");
    expect(sts(world)[0]?.host).toBe("sts.sa-east-1.amazonaws.com");
    expect(assume.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(assume.get("RoleArn")).toBe(ROLE);
    expect(assume.get("RoleSessionName")).toBe("wrenkind-vercel-web");
    expect(assume.get("DurationSeconds")).toBe("3600");
    expect(assume.get("WebIdentityToken")).not.toBeNull();
    // KMS: exactly one GenerateDataKey, signed by the federated session, exact key and six-field context; no Decrypt.
    expect(kms(world)).toHaveLength(1);
    expect(kms(world)[0]?.target).toBe("TrentService.GenerateDataKey");
    expect(kms(world)[0]?.authorization).toContain(`Credential=${SESSION_KEY}/`);
    const request = JSON.parse(kms(world)[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["EncryptionContext", "KeyId", "KeySpec"]);
    expect(request["KeyId"]).toBe(KEY);
    expect(request["KeySpec"]).toBe("AES_256");
    expect(request["EncryptionContext"]).toEqual(EXPECTED_CONTEXT);
    expect(Object.keys(request["EncryptionContext"] as object)).toEqual(["app", "purpose", "env", "v", "workspace_id", "credential_id"]);
    for (const exchange of world.exchanges) {
      expect(exchange.target).not.toMatch(/Decrypt|ReEncrypt|\.Encrypt$|CreateGrant/);
      expect(exchange.host).toMatch(/^(sts|kms)\.sa-east-1\.amazonaws\.com$/);
    }
    // Nothing sensitive in the outcome, however it is rendered.
    const rendered = [JSON.stringify(outcome), inspect(outcome, { depth: 5 })].join("\n");
    for (const needle of [SESSION_KEY, SESSION_SECRET, ROLE, KEY, "000000000000", ISSUER, SUBJECT, WEB_KMS_DIAGNOSTIC_WORKSPACE_ID]) expect(rendered).not.toContain(needle);
  });

  it("an SDK retry can't add a second GenerateDataKey or AssumeRoleWithWebIdentity: one attempt each, failure is one fixed code", async () => {
    const world = offlineWorld(() => ({ status: 500, body: { __type: "KMSInternalException", message: "synthetic" } }));
    setRequestToken(vercelToken());
    expect(await failureOf(webKmsIdentityDiagnostic(ACK, hostedEnv()))).toBe("web_kms_diagnostic_keyring_unavailable");
    expect(sts(world)).toHaveLength(1);
    expect(kms(world)).toHaveLength(1);
  });

  it("KMS access denied → keyring_access_denied, still exactly one GenerateDataKey and no detail kept", async () => {
    const world = offlineWorld(() => ({ status: 400, body: { __type: "AccessDeniedException", message: `synthetic ${KEY}` } }));
    setRequestToken(vercelToken());
    const run = webKmsIdentityDiagnostic(ACK, hostedEnv());
    const error = await run.then(() => undefined, (e: unknown) => e);
    expect((error as WebKmsDiagnosticError).failure).toBe("web_kms_diagnostic_keyring_access_denied");
    expect(`${String(error)} ${inspect(error, { depth: 5 })}`).not.toContain(KEY);
    expect(kms(world)).toHaveLength(1);
  });

  it.each<[string, Env, WebKmsDiagnosticFailure]>([
    ["static AWS access key in the hosted web", hostedEnv({ AWS_ACCESS_KEY_ID: "AKIASYNTHETICSTATIC00" }), "web_kms_diagnostic_environment_refused"],
    ["static AWS secret in the hosted web", hostedEnv({ AWS_SECRET_ACCESS_KEY: "synthetic-static-secret" }), "web_kms_diagnostic_environment_refused"],
    ["static AWS session token in the hosted web", hostedEnv({ AWS_SESSION_TOKEN: "synthetic-static-token" }), "web_kms_diagnostic_environment_refused"],
    ["local keyring next to KMS", hostedEnv({ LOCAL_KEYRING_KEY: Buffer.alloc(32, 7).toString("base64url") }), "web_kms_diagnostic_environment_refused"],
    ["the worker's bootstrap identity in the web", hostedEnv({ INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: "SYNTHETICBOOTSTRAPKEYA1" }), "web_kms_diagnostic_environment_refused"],
  ])("%s → refused before any exchange or AWS request", async (_label, env, failure) => {
    const world = offlineWorld();
    setRequestToken(vercelToken());
    expect(await failureOf(webKmsIdentityDiagnostic(ACK, env))).toBe(failure);
    expect(world.exchanges).toEqual([]);
    expect(world.vercelExchanges).toEqual([]);
  });
});

describe("7E.10-B · every guard runs before anything AWS-capable exists (fake dependencies)", () => {
  const sealerCalls = { compose: 0, seal: 0 };
  const okSealer: CredentialSealer = {
    seal: () => {
      sealerCalls.seal += 1;
      return Promise.resolve(
        Object.freeze({ formatVersion: 1, algorithm: "AES-256-GCM", kekProvider: "aws-kms", keyRef: KMS_PROVIDER_CREDENTIALS_KEY_REF, contextVersion: 1, wrappedDek: new Uint8Array(randomBytes(184)), iv: new Uint8Array(12), ciphertext: new Uint8Array(randomBytes(64)), authTag: new Uint8Array(16) }) as never,
      );
    },
  };
  const deps = (overrides: Partial<WebKmsDiagnosticDependencies> = {}): WebKmsDiagnosticDependencies => ({
    nodeVersion: "v22.16.0",
    readClaims: () => ({ issuer: ISSUER, subject: SUBJECT }),
    expected: { issuer: ISSUER, subject: SUBJECT },
    composeSealer: () => {
      sealerCalls.compose += 1;
      return { sealer: okSealer, contextEnv: "dev" };
    },
    ...overrides,
  });
  const throwing = (): never => {
    throw new Error("synthetic unusable token");
  };
  beforeEach(() => {
    sealerCalls.compose = 0;
    sealerCalls.seal = 0;
  });

  it("the happy path seals exactly once", async () => {
    expect(await failureOf(runWebKmsIdentityDiagnostic(ACK, hostedEnv(), deps()))).toBe("resolved");
    expect(sealerCalls).toEqual({ compose: 1, seal: 1 });
  });

  it.each<[string, unknown, Env, Partial<WebKmsDiagnosticDependencies>, WebKmsDiagnosticFailure]>([
    ["missing acknowledgement", {}, hostedEnv(), {}, "web_kms_diagnostic_input_refused"],
    ["no payload", undefined, hostedEnv(), {}, "web_kms_diagnostic_input_refused"],
    ["wrong acknowledgement", { acknowledge: "INTEGRATION_KMS_WORKER_AUTH_DIAGNOSTIC_V1" }, hostedEnv(), {}, "web_kms_diagnostic_input_refused"],
    ["extra payload field", { ...ACK, workspaceId: WEB_KMS_DIAGNOSTIC_WORKSPACE_ID }, hostedEnv(), {}, "web_kms_diagnostic_input_refused"],
    ["development runtime", ACK, hostedEnv({ NODE_ENV: "development" }), {}, "web_kms_diagnostic_runtime_refused"],
    ["test runtime", ACK, hostedEnv({ NODE_ENV: "test" }), {}, "web_kms_diagnostic_runtime_refused"],
    ["Vercel Preview deployment", ACK, hostedEnv({ VERCEL_ENV: "preview" }), {}, "web_kms_diagnostic_runtime_refused"],
    ["Vercel Development", ACK, hostedEnv({ VERCEL_ENV: "development" }), {}, "web_kms_diagnostic_runtime_refused"],
    ["not on Vercel", ACK, withoutKey(hostedEnv(), "VERCEL_ENV"), {}, "web_kms_diagnostic_runtime_refused"],
    ["Node 20", ACK, hostedEnv(), { nodeVersion: "v20.19.0" }, "web_kms_diagnostic_node_refused"],
    ["static AWS key", ACK, hostedEnv({ AWS_ACCESS_KEY_ID: "AKIASYNTHETICSTATIC00" }), {}, "web_kms_diagnostic_environment_refused"],
    ["no KMS configuration", ACK, withoutKey(withoutKey(withoutKey(hostedEnv(), "CREDENTIAL_CONTEXT_ENV"), "CREDENTIAL_KMS_KEY_ARN"), "CREDENTIAL_KMS_ALLOWED_KEY_ARNS"), {}, "web_kms_diagnostic_kms_configuration_refused"],
    ["incomplete KMS configuration", ACK, withoutKey(hostedEnv(), "CREDENTIAL_KMS_ALLOWED_KEY_ARNS"), {}, "web_kms_diagnostic_kms_configuration_refused"],
    ["context env test", ACK, hostedEnv({ CREDENTIAL_CONTEXT_ENV: "test" }), {}, "web_kms_diagnostic_kms_configuration_refused"],
    ["context env prod", ACK, hostedEnv({ CREDENTIAL_CONTEXT_ENV: "prod" }), {}, "web_kms_diagnostic_kms_configuration_refused"],
    ["two allowed keys", ACK, hostedEnv({ CREDENTIAL_KMS_ALLOWED_KEY_ARNS: `${KEY},${KEY_OTHER}` }), {}, "web_kms_diagnostic_kms_configuration_refused"],
    ["missing role ARN", ACK, withoutKey(hostedEnv(), "CREDENTIAL_KMS_WEB_ROLE_ARN"), {}, "web_kms_diagnostic_role_refused"],
    ["malformed role ARN", ACK, hostedEnv({ CREDENTIAL_KMS_WEB_ROLE_ARN: "social-intelligence-platform-dev-web-encrypt" }), {}, "web_kms_diagnostic_role_refused"],
    ["missing / malformed / expired OIDC token", ACK, hostedEnv(), { readClaims: throwing }, "web_kms_diagnostic_oidc_token_refused"],
    ["Preview subject", ACK, hostedEnv(), { readClaims: () => ({ issuer: ISSUER, subject: "owner:social-intelligence:project:social-intelligence-platform:environment:preview" }) }, "web_kms_diagnostic_oidc_subject_refused"],
    ["Development subject", ACK, hostedEnv(), { readClaims: () => ({ issuer: ISSUER, subject: "owner:social-intelligence:project:social-intelligence-platform:environment:development" }) }, "web_kms_diagnostic_oidc_subject_refused"],
    ["another project", ACK, hostedEnv(), { readClaims: () => ({ issuer: ISSUER, subject: "owner:social-intelligence:project:another-project:environment:production" }) }, "web_kms_diagnostic_oidc_subject_refused"],
    ["another team", ACK, hostedEnv(), { readClaims: () => ({ issuer: "https://oidc.vercel.com/another-team", subject: "owner:another-team:project:social-intelligence-platform:environment:production" }) }, "web_kms_diagnostic_oidc_subject_refused"],
    ["global issuer", ACK, hostedEnv(), { readClaims: () => ({ issuer: "https://oidc.vercel.com", subject: SUBJECT }) }, "web_kms_diagnostic_oidc_subject_refused"],
    ["no subject claim", ACK, hostedEnv(), { readClaims: () => ({ issuer: ISSUER, subject: undefined }) }, "web_kms_diagnostic_oidc_subject_refused"],
    ["no expectation configured", ACK, hostedEnv(), { expected: { issuer: undefined, subject: undefined }, readClaims: () => ({ issuer: undefined, subject: undefined }) }, "web_kms_diagnostic_oidc_subject_refused"],
  ])("%s → %s, and nothing is composed or sealed", async (_label, payload, env, overrides, failure) => {
    expect(await failureOf(runWebKmsIdentityDiagnostic(payload, env, deps(overrides)))).toBe(failure);
    expect(sealerCalls).toEqual({ compose: 0, seal: 0 });
  });

  it("the real token reader fails closed on a missing, malformed or expired token (through the production composition)", async () => {
    const world = offlineWorld();
    for (const token of [undefined, "not-a-jwt", jwt({ iss: ISSUER, sub: SUBJECT, exp: now() - 10 })]) {
      setRequestToken(token);
      expect(await failureOf(webKmsIdentityDiagnostic(ACK, hostedEnv()))).toBe("web_kms_diagnostic_oidc_token_refused");
    }
    setRequestToken(vercelToken({ sub: "owner:social-intelligence:project:social-intelligence-platform:environment:preview" }));
    expect(await failureOf(webKmsIdentityDiagnostic(ACK, hostedEnv()))).toBe("web_kms_diagnostic_oidc_subject_refused");
    expect(world.exchanges).toEqual([]);
    expect(world.vercelExchanges).toEqual([]);
  });

  it.each<[string, () => never, WebKmsDiagnosticFailure]>([
    ["access denied", () => { throw new CredentialCryptoError("KEYRING_ACCESS_DENIED"); }, "web_kms_diagnostic_keyring_access_denied"],
    ["misconfigured", () => { throw new CredentialCryptoError("KEYRING_MISCONFIGURED"); }, "web_kms_diagnostic_keyring_misconfigured"],
    ["unavailable", () => { throw new CredentialCryptoError("KEYRING_UNAVAILABLE"); }, "web_kms_diagnostic_keyring_unavailable"],
    ["anything else", () => { throw new Error("synthetic unexpected"); }, "web_kms_diagnostic_failed"],
  ])("a sealing failure (%s) becomes one fixed code", async (_label, fail, failure) => {
    const sealer: CredentialSealer = { seal: () => Promise.resolve().then(fail) };
    expect(await failureOf(runWebKmsIdentityDiagnostic(ACK, hostedEnv(), deps({ composeSealer: () => ({ sealer, contextEnv: "dev" }) })))).toBe(failure);
  });

  it("an envelope that is not a v1 aws-kms envelope of the provider-credential key reference is refused", async () => {
    const wrong: CredentialSealer = { seal: async (plaintext, context) => ({ ...(await okSealer.seal(plaintext, context)), keyRef: "kms-provider-credentials-v2" }) };
    expect(await failureOf(runWebKmsIdentityDiagnostic(ACK, hostedEnv(), deps({ composeSealer: () => ({ sealer: wrong, contextEnv: "dev" }) })))).toBe("web_kms_diagnostic_envelope_invalid");
    const local: CredentialSealer = { seal: async (plaintext, context) => ({ ...(await okSealer.seal(plaintext, context)), kekProvider: "local" }) };
    expect(await failureOf(runWebKmsIdentityDiagnostic(ACK, hostedEnv(), deps({ composeSealer: () => ({ sealer: local, contextEnv: "dev" }) })))).toBe("web_kms_diagnostic_envelope_invalid");
  });

  it("a sealer composed for another context env is refused before sealing", async () => {
    expect(await failureOf(runWebKmsIdentityDiagnostic(ACK, hostedEnv(), deps({ composeSealer: () => ({ sealer: okSealer, contextEnv: "test" }) })))).toBe("web_kms_diagnostic_kms_configuration_refused");
    expect(sealerCalls.seal).toBe(0);
  });

  it("the failure vocabulary is closed and every code is fixed", () => {
    expect(new Set(WEB_KMS_DIAGNOSTIC_FAILURES).size).toBe(WEB_KMS_DIAGNOSTIC_FAILURES.length);
    for (const code of WEB_KMS_DIAGNOSTIC_FAILURES) expect(code).toMatch(/^web_kms_diagnostic_[a-z_]+$/);
    expect(new WebKmsDiagnosticError("web_kms_diagnostic_failed").message).toBe("web_kms_diagnostic_failed");
  });
});

describe("7E.10-B · hosted connection composition: no local-only adapter, the real KMS sealer", () => {
  it("composes without constructing the simulator; every provider is unavailable; the callback fails closed before any database work; sealing is KMS", async () => {
    const world = offlineWorld();
    simulatorCalls.count = 0;
    const env = hostedEnv({ VERCEL_ENV: undefined, APP_BASE_URL: "https://app.example.test", OAUTH_PKCE_DERIVATION_KEY: randomBytes(32).toString("base64url") });
    const deps = connectionAuthorizationRuntime({ getVerifiedUser: () => Promise.resolve(undefined) }, env);
    expect(simulatorCalls.count).toBe(0);
    expect(deps.providers.authorization("simulator")).toBeUndefined();
    const result = await completeConnectionAuthorization(deps, { provider: "simulator", query: [["state", "synthetic"], ["code", "synthetic"]] });
    expect(result).toEqual({ status: "restart_required", reason: "invalid_callback" });
    expect(world.exchanges).toEqual([]);
    // The sealing is the KMS GenerateDataKey path through the federated identity (product composition: SDK defaults).
    setRequestToken(vercelToken());
    const envelope = await deps.sealing.seal(new Uint8Array(randomBytes(32)), { workspaceId: parseWorkspaceId(WEB_KMS_DIAGNOSTIC_WORKSPACE_ID) as WorkspaceId, credentialId: WEB_KMS_DIAGNOSTIC_CREDENTIAL_ID });
    expect(envelope.byteLength).toBeGreaterThan(0);
    expect(sts(world)).toHaveLength(1);
    expect(new URLSearchParams(sts(world)[0]?.body ?? "").get("RoleSessionName")).toBe("wrenkind-vercel-web");
    expect(kms(world).map((e) => e.target)).toEqual(["TrentService.GenerateDataKey"]);
    expect(simulatorCalls.count).toBe(0);
  });
});
