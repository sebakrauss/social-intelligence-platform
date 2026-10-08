/**
 * Step 7E.3B — the hosted web's Vercel OIDC → AWS identity adapter (TA §39, ADR-64). Network-isolated: the request
 * context is simulated through Vercel's documented global symbol, tokens are synthetic unsigned JWTs, the official
 * provider is either a spy or the real package with `fetch` stubbed and every HTTP(S) request trapped. Role ARNs use
 * account 000000000000.
 */
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWS_STS_OIDC_AUDIENCE, AwsIdentityError, type AwsCredentialProvider, type AwsIdentityFailure } from "@/platform/aws/identity";
import { LOCAL_KEYRING_KEY_ENV } from "@/platform/crypto/credentials/local-sealer";
import { composeCredentialSealer } from "@/server/connections/credential-crypto";
import {
  VERCEL_OIDC_MAX_TOKEN_LENGTH,
  VERCEL_OIDC_PREFLIGHT_MIN_TTL_SECONDS,
  VERCEL_WEB_SESSION_SECONDS,
  createVercelAwsIdentity,
  preflightVercelOidcToken,
  vercelIdentityFailure,
  type VercelAwsIdentityDependencies,
} from "@/server/connections/vercel-aws-identity";
import { composeWebAwsCredentials, type WebAwsIdentityConfig } from "@/server/connections/web-identity";

const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-web-encrypt";
const KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const CONFIG: WebAwsIdentityConfig = Object.freeze({ roleArn: ROLE, audience: AWS_STS_OIDC_AUDIENCE, stsRegion: "sa-east-1" });
const SECRET = `sensitive-${randomUUID()}`;
const NOW = 1_800_000_000;
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown): string => [segment({ alg: "RS256" }), segment(payload), "c2lnbmF0dXJl"].join(".");
const tokenExpiringIn = (seconds: number, marker = "A"): string => jwt({ exp: NOW + seconds, sub: `synthetic-${marker}` });

type Official = VercelAwsIdentityDependencies["officialProvider"];
const officialSpy = () =>
  vi.fn<Official>(() => () => Promise.resolve({ accessKeyId: "SYNTHETICKEY", secretAccessKey: SECRET, sessionToken: "synthetic-session", expiration: new Date(NOW * 1000 + 3_600_000), accountId: "000000000000" }));

function setRequestHeaders(headers: Record<string, string> | undefined): void {
  (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => (headers === undefined ? {} : { headers }) };
}

async function failureOf(provider: AwsCredentialProvider): Promise<AwsIdentityFailure | "resolved"> {
  const error = await provider().then(() => "resolved" as const, (e: unknown) => e);
  if (error === "resolved") return error;
  expect(error).toBeInstanceOf(AwsIdentityError);
  return (error as AwsIdentityError).failure;
}

beforeEach(() => {
  vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("7E.3B.4/5 · token preflight (structural, not authentication)", () => {
  const failure = (token: unknown, now = NOW): AwsIdentityFailure | "ok" => {
    try {
      preflightVercelOidcToken(token, now);
      return "ok";
    } catch (error) {
      expect(error).toBeInstanceOf(AwsIdentityError);
      return (error as AwsIdentityError).failure;
    }
  };

  it("accepts a token with more than 120 s left, and exactly 120 s; refuses 119 s as transiently unusable", () => {
    expect(VERCEL_OIDC_PREFLIGHT_MIN_TTL_SECONDS).toBe(120);
    expect(failure(tokenExpiringIn(3600))).toBe("ok");
    expect(failure(tokenExpiringIn(120))).toBe("ok");
    expect(failure(tokenExpiringIn(119))).toBe("IDENTITY_UNAVAILABLE");
    expect(failure(tokenExpiringIn(1))).toBe("IDENTITY_UNAVAILABLE");
  });

  it.each([
    ["expired", tokenExpiringIn(-1), "IDENTITY_ACCESS_DENIED"],
    ["expiring exactly now", tokenExpiringIn(0), "IDENTITY_ACCESS_DENIED"],
    ["missing", undefined, "IDENTITY_MISCONFIGURED"],
    ["empty", "", "IDENTITY_MISCONFIGURED"],
    ["two segments", `${segment({ alg: "RS256" })}.${segment({ exp: NOW + 3600 })}`, "IDENTITY_ACCESS_DENIED"],
    ["four segments", `${tokenExpiringIn(3600)}.x`, "IDENTITY_ACCESS_DENIED"],
    ["empty signature", `${segment({ alg: "RS256" })}.${segment({ exp: NOW + 3600 })}.`, "IDENTITY_ACCESS_DENIED"],
    ["standard base64 characters", `${segment({})}.${segment({ exp: NOW + 3600 })}+/.sig`, "IDENTITY_ACCESS_DENIED"],
    ["padded payload", `${segment({})}.${segment({ exp: NOW + 3600 })}==.sig`, "IDENTITY_ACCESS_DENIED"],
    ["non-canonical base64url payload", `${segment({})}.${segment({ exp: NOW + 3600 }).slice(0, -1)}B.sig`, "IDENTITY_ACCESS_DENIED"],
    ["payload not JSON", `${segment({})}.${Buffer.from("not json").toString("base64url")}.sig`, "IDENTITY_ACCESS_DENIED"],
    ["payload is an array", jwt([NOW + 3600]), "IDENTITY_ACCESS_DENIED"],
    ["payload is a number", jwt(NOW + 3600), "IDENTITY_ACCESS_DENIED"],
    ["missing exp", jwt({ sub: "x" }), "IDENTITY_ACCESS_DENIED"],
    ["string exp", jwt({ exp: String(NOW + 3600) }), "IDENTITY_ACCESS_DENIED"],
    ["fractional exp", jwt({ exp: NOW + 3600.5 }), "IDENTITY_ACCESS_DENIED"],
    ["negative exp", jwt({ exp: -5 }), "IDENTITY_ACCESS_DENIED"],
    ["oversized token", `${segment({})}.${segment({ exp: NOW + 3600, pad: "p".repeat(VERCEL_OIDC_MAX_TOKEN_LENGTH) })}.sig`, "IDENTITY_ACCESS_DENIED"],
  ] as const)("%s → %s", (_label, token, expected) => {
    expect(failure(token)).toBe(expected);
  });

  it("never echoes the token or its payload", () => {
    const token = jwt({ exp: NOW - 10, marker: SECRET });
    let caught: unknown;
    try {
      preflightVercelOidcToken(token, NOW);
    } catch (error) {
      caught = error;
    }
    const rendered = `${String(caught)} ${JSON.stringify(caught)} ${inspect(caught, { depth: 5 })} ${(caught as Error).stack ?? ""}`;
    expect(rendered.includes(token)).toBe(false);
    expect(rendered.includes(SECRET)).toBe(false);
    expect((caught as Error).cause).toBeUndefined();
  });
});

describe("7E.3B.6 · structural refresh-path exclusion", () => {
  it.each([
    ["missing (no header, no env)", () => { setRequestHeaders(undefined); }, "IDENTITY_MISCONFIGURED"],
    ["expired", () => { setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(-60) }); }, "IDENTITY_ACCESS_DENIED"],
    ["near expiry", () => { setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(60) }); }, "IDENTITY_UNAVAILABLE"],
    ["malformed", () => { setRequestHeaders({ "x-vercel-oidc-token": "not.a-jwt" }); }, "IDENTITY_ACCESS_DENIED"],
  ] as const)("%s: the official provider is never invoked (%s)", async (_label, arrange, expected) => {
    arrange();
    const official = officialSpy();
    const provider = createVercelAwsIdentity({ officialProvider: official, nowSeconds: () => NOW })(CONFIG);
    expect(await failureOf(provider)).toBe(expected);
    expect(official).not.toHaveBeenCalled();
  });

  it("a usable token invokes the official provider once, and only the four credential fields come back", async () => {
    setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(3600) });
    const official = officialSpy();
    const credentials = await createVercelAwsIdentity({ officialProvider: official, nowSeconds: () => NOW })(CONFIG)();
    expect(official).toHaveBeenCalledTimes(1);
    expect(Object.keys(credentials).sort()).toEqual(["accessKeyId", "expiration", "secretAccessKey", "sessionToken"]);
  });
});

describe("7E.3B · token sources (getContext semantics of @vercel/oidc 3.8.10, no refresh)", () => {
  const resolveWith = async (): Promise<AwsIdentityFailure | "resolved"> =>
    failureOf(createVercelAwsIdentity({ officialProvider: officialSpy(), nowSeconds: () => NOW })(CONFIG));

  it("the request header wins over VERCEL_OIDC_TOKEN (both directions)", async () => {
    setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(3600) });
    vi.stubEnv("VERCEL_OIDC_TOKEN", tokenExpiringIn(-60));
    expect(await resolveWith()).toBe("resolved");
    setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(-60) });
    vi.stubEnv("VERCEL_OIDC_TOKEN", tokenExpiringIn(3600));
    expect(await resolveWith()).toBe("IDENTITY_ACCESS_DENIED");
  });

  it("no request header (or no context at all) falls back to VERCEL_OIDC_TOKEN", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", tokenExpiringIn(3600));
    setRequestHeaders({});
    expect(await resolveWith()).toBe("resolved");
    Reflect.deleteProperty(globalThis, REQUEST_CONTEXT);
    expect(await resolveWith()).toBe("resolved");
  });

  it("neither source → IDENTITY_MISCONFIGURED", async () => {
    setRequestHeaders({});
    expect(await resolveWith()).toBe("IDENTITY_MISCONFIGURED");
  });

  it("an EMPTY header does not fall back to the environment (exact 3.8.10 semantics) and an empty env counts as missing", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", tokenExpiringIn(3600));
    setRequestHeaders({ "x-vercel-oidc-token": "" });
    expect(await resolveWith()).toBe("IDENTITY_MISCONFIGURED");
    setRequestHeaders({});
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    expect(await resolveWith()).toBe("IDENTITY_MISCONFIGURED");
  });

  it("a malformed or nearly expired env token fails in the preflight, before the official provider", async () => {
    setRequestHeaders({});
    const official = officialSpy();
    const provider = createVercelAwsIdentity({ officialProvider: official, nowSeconds: () => NOW })(CONFIG);
    vi.stubEnv("VERCEL_OIDC_TOKEN", "malformed");
    expect(await failureOf(provider)).toBe("IDENTITY_ACCESS_DENIED");
    vi.stubEnv("VERCEL_OIDC_TOKEN", tokenExpiringIn(30));
    expect(await failureOf(provider)).toBe("IDENTITY_UNAVAILABLE");
    expect(official).not.toHaveBeenCalled();
  });

  it("the reader never mutates VERCEL_OIDC_TOKEN", async () => {
    setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(3600) });
    await resolveWith();
    expect(process.env["VERCEL_OIDC_TOKEN"]).toBeUndefined();
  });
});

describe("7E.3B.12 · request isolation", () => {
  it("every resolution reads the current request's token again: A resolves, then B (expired) fails, then B' resolves", async () => {
    const official = officialSpy();
    const reads: string[] = [];
    let current = tokenExpiringIn(3600, "A");
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => (reads.push(current), { headers: { "x-vercel-oidc-token": current } }) };
    const provider = createVercelAwsIdentity({ officialProvider: official, nowSeconds: () => NOW })(CONFIG);
    expect(await failureOf(provider)).toBe("resolved");
    current = tokenExpiringIn(-30, "B");
    expect(await failureOf(provider)).toBe("IDENTITY_ACCESS_DENIED");
    current = tokenExpiringIn(3600, "B2");
    expect(await failureOf(provider)).toBe("resolved");
    expect(reads).toHaveLength(3);
    expect(official).toHaveBeenCalledTimes(2);
  });
});

describe("7E.3B.7–10 · official provider configuration", () => {
  it("exact role, audience constant, explicit STS region, ignored endpoint overrides, one-hour session — nothing else", async () => {
    setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(3600) });
    const official = officialSpy();
    await createVercelAwsIdentity({ officialProvider: official, nowSeconds: () => NOW })(CONFIG)();
    const init = official.mock.calls[0]?.[0];
    expect(init).toEqual({
      roleArn: ROLE,
      audience: "sts.amazonaws.com",
      durationSeconds: 3600,
      clientConfig: { region: "sa-east-1", ignoreConfiguredEndpointUrls: true },
    });
    expect(init?.audience).toBe(AWS_STS_OIDC_AUDIENCE);
    expect(init?.audience).not.toBe("https://sts.amazonaws.com");
    expect(VERCEL_WEB_SESSION_SECONDS).toBeLessThanOrEqual(3600);
  });
});

describe("7E.3B.11 · error normalization", () => {
  it.each([
    ["Vercel exchange failure", new Error(`Failed to exchange token: ${SECRET}`), "IDENTITY_UNAVAILABLE"],
    ["Vercel exchange unreachable", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET", detail: SECRET } }), "IDENTITY_UNAVAILABLE"],
    ["STS throttling", Object.assign(new Error(SECRET), { name: "ThrottlingException", $fault: "client", $retryable: { throttling: true } }), "IDENTITY_UNAVAILABLE"],
    ["STS outage", Object.assign(new Error(SECRET), { name: "SomeFutureOutage", $fault: "server" }), "IDENTITY_UNAVAILABLE"],
    ["IdP communication", Object.assign(new Error(SECRET), { name: "IDPCommunicationErrorException" }), "IDENTITY_UNAVAILABLE"],
    ["network reset", Object.assign(new Error(SECRET), { code: "ECONNRESET" }), "IDENTITY_UNAVAILABLE"],
    ["AccessDenied", Object.assign(new Error(SECRET), { name: "AccessDenied" }), "IDENTITY_ACCESS_DENIED"],
    ["InvalidIdentityToken", Object.assign(new Error(SECRET), { name: "InvalidIdentityTokenException" }), "IDENTITY_ACCESS_DENIED"],
    ["IDPRejectedClaim", Object.assign(new Error(SECRET), { name: "IDPRejectedClaimException" }), "IDENTITY_ACCESS_DENIED"],
    ["ExpiredToken", Object.assign(new Error(SECRET), { name: "ExpiredTokenException" }), "IDENTITY_ACCESS_DENIED"],
    ["region disabled", Object.assign(new Error(SECRET), { name: "RegionDisabledException" }), "IDENTITY_MISCONFIGURED"],
    ["invalid STS response (role ARN in message)", new Error(`Invalid response from STS.assumeRoleWithWebIdentity call with role ${ROLE}`), "IDENTITY_MISCONFIGURED"],
    ["unknown", Object.assign(new Error(SECRET), { name: "SomethingNew" }), "IDENTITY_MISCONFIGURED"],
    ["non-error value", SECRET, "IDENTITY_MISCONFIGURED"],
  ] as const)("%s → %s, with no raw detail kept", async (_label, raw, expected) => {
    expect(vercelIdentityFailure(raw)).toBe(expected);
    setRequestHeaders({ "x-vercel-oidc-token": tokenExpiringIn(3600) });
    const failing: Official = () => () => Promise.reject(raw instanceof Error ? raw : new Error(raw));
    const error = await createVercelAwsIdentity({ officialProvider: failing, nowSeconds: () => NOW })(CONFIG)().then(() => undefined, (e: unknown) => e);
    const rendered = `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 5 })} ${(error as Error).stack ?? ""}`;
    for (const sensitive of [SECRET, ROLE, "Failed to exchange", "fetch failed"]) expect(rendered.includes(sensitive), sensitive).toBe(false);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("7E.3B.13 · web composition", () => {
  const kmsWebEnvironment = { NODE_ENV: "production", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY, CREDENTIAL_KMS_WEB_ROLE_ARN: ROLE };

  it("deployed KMS web: the adapter gets role, fixed audience and the KMS key's region; nothing is read or resolved at composition", () => {
    const readToken = vi.fn(() => tokenExpiringIn(3600));
    const official = officialSpy();
    const factory = vi.fn(createVercelAwsIdentity({ readToken, officialProvider: official, nowSeconds: () => NOW }));
    const composed = composeCredentialSealer(kmsWebEnvironment, composeWebAwsCredentials(kmsWebEnvironment, factory));
    expect(factory).toHaveBeenCalledWith({ roleArn: ROLE, audience: "sts.amazonaws.com", stsRegion: "sa-east-1" });
    expect(readToken).not.toHaveBeenCalled();
    expect(official).not.toHaveBeenCalled();
    expect(Object.keys(composed.sealer)).toEqual(["seal"]);
  });

  it("local/test: no Vercel identity is composed, even with a role ARN present", () => {
    const factory = vi.fn(createVercelAwsIdentity({ officialProvider: officialSpy() }));
    const local = { NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: Buffer.alloc(32, 7).toString("base64url"), CREDENTIAL_KMS_WEB_ROLE_ARN: ROLE };
    expect(composeWebAwsCredentials(local, factory)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(composeCredentialSealer(local, composeWebAwsCredentials(local, factory)).contextEnv).toBe("test");
  });
});

describe("7E.3B.9 · STS endpoint hardening with the REAL official provider (offline)", () => {
  it("STS goes to the KMS key's regional endpoint; AWS_REGION and AWS_ENDPOINT_URL* are ignored; the exchange asks for sts.amazonaws.com", async () => {
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AWS_DEFAULT_REGION", "eu-west-1");
    vi.stubEnv("AWS_ENDPOINT_URL", "https://override.invalid.example.test");
    vi.stubEnv("AWS_ENDPOINT_URL_STS", "https://sts-override.invalid.example.test");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AMBIENTKEYNOTUSED");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-not-used");
    const now = Math.floor(Date.now() / 1000);
    const source = jwt({ exp: now + 3600, sub: "owner:synthetic:project:synthetic:environment:preview" });
    setRequestHeaders({ "x-vercel-oidc-token": source });
    const exchanges: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: { body?: string }) => {
      exchanges.push({ url, body: JSON.parse(init?.body ?? "null") });
      return Promise.resolve(new Response(JSON.stringify({ token: jwt({ exp: now + 3600, aud: "sts.amazonaws.com" }) }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    const hosts: string[] = [];
    const trap = (options: unknown): never => {
      const o = options as { hostname?: string; host?: string };
      hosts.push(String(o.hostname ?? o.host));
      throw Object.assign(new Error("offline trap"), { code: "ECONNRESET" });
    };
    vi.spyOn(https, "request").mockImplementation(trap);
    vi.spyOn(http, "request").mockImplementation(trap);
    const error = await createVercelAwsIdentity()(CONFIG)().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AwsIdentityError);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.url).toBe("https://oidc.vercel.com/~token");
    expect((exchanges[0]?.body as { aud?: unknown }).aud).toBe("sts.amazonaws.com");
    expect(hosts.length).toBeGreaterThan(0);
    expect(new Set(hosts)).toEqual(new Set(["sts.sa-east-1.amazonaws.com"]));
  });
});
