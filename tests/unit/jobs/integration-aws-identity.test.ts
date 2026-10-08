/**
 * The integration worker's AWS identity (Step 7E.4C), offline. Synthetic account 000000000000 and synthetic keys only.
 * Most tests inject a recording STS sender and a clock; the request-contract tests drive the REAL pinned STSClient (and a
 * real KMSClient) with every outbound HTTPS request trapped, so no packet leaves the process.
 */
import https from "node:https";
import http from "node:http";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import { DecryptCommand } from "@aws-sdk/client-kms";
import type { AssumeRoleCommand, AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationWorkerAwsCredentials } from "@/jobs/connections";
import {
  INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS,
  INTEGRATION_WORKER_ROLE_SESSION_NAME,
  INTEGRATION_WORKER_SESSION_SECONDS,
  createIntegrationWorkerAwsCredentials,
  readBootstrapIdentity,
  stsIdentityFailure,
  type AssumeRoleSender,
  type IntegrationAwsIdentityDependencies,
} from "@/jobs/integration-aws-identity";
import { AwsIdentityError, type AwsIdentityFailure } from "@/platform/aws/identity";
import { createKmsClient } from "@/platform/crypto/credentials/aws-kms-client";
import { kmsErrorCode } from "@/platform/crypto/credentials/aws-kms-common";
import { parseKmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";

const KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-integration-worker";
const KMS = parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY, allowedKeyArns: KEY });
const KEY_A = "SYNTHETICBOOTSTRAPKEYA1";
const KEY_B = "SYNTHETICBOOTSTRAPKEYB2";
const SECRET_A = "synthetic/secret+value-for-key-a-0000000000";
const SECRET_B = "synthetic/secret+value-for-key-b-0000000000";
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
/** The fake STS session key id for a bootstrap key id (never containing the bootstrap id itself). */
const sessionKeyOf = (accessKeyId: string): string => `SESSION${accessKeyId.toLowerCase().replaceAll("synthetic", "temporary")}`;

const bootstrap = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: KEY_A,
  INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: SECRET_A,
  INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE,
  ...overrides,
});

const sessionFor = (accessKeyId: string, expiresInSeconds: number, nowMs = NOW): AssumeRoleCommandOutput => ({
  $metadata: {},
  Credentials: {
    AccessKeyId: sessionKeyOf(accessKeyId),
    SecretAccessKey: `session-secret-of-${accessKeyId}`,
    SessionToken: `session-token-of-${accessKeyId}`,
    Expiration: new Date(nowMs + expiresInSeconds * 1000),
  },
});

/** A recording STS: which bootstrap key signed, in which region, with which request — and a scripted answer. */
function fakeSts(answer: (accessKeyId: string) => Promise<AssumeRoleCommandOutput>) {
  const calls: { region: string; accessKeyId: string; secretAccessKey: string; input: AssumeRoleCommand["input"] }[] = [];
  const stsClient = (region: string, credentials: { accessKeyId: string; secretAccessKey: string }): AssumeRoleSender => ({
    send: (command) => {
      calls.push({ region, accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, input: command.input });
      return answer(credentials.accessKeyId);
    },
  });
  return { calls, stsClient };
}

function provider(overrides: Partial<IntegrationAwsIdentityDependencies> & { env?: () => Record<string, string | undefined> }) {
  let clock = NOW;
  const sts = fakeSts((accessKeyId) => Promise.resolve(sessionFor(accessKeyId, 900, clock)));
  const resolve = createIntegrationWorkerAwsCredentials(KMS, {
    readEnvironment: overrides.env ?? (() => bootstrap()),
    stsClient: sts.stsClient,
    nowMs: () => clock,
    ...overrides,
  });
  return { resolve, sts, advance: (seconds: number) => (clock += seconds * 1000), now: () => clock };
}

async function failureOf(promise: Promise<unknown>): Promise<AwsIdentityFailure> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AwsIdentityError);
  return (error as AwsIdentityError).failure;
}

const rendered = (error: unknown): string => `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 6 })} ${(error as Error).stack ?? ""}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("bootstrap configuration (re-read on every resolution, never the AWS default chain)", () => {
  it.each([
    ["missing access key id", { INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: undefined }],
    ["empty access key id", { INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: "" }],
    ["padded access key id", { INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: ` ${KEY_A}` }],
    ["access key id with a symbol", { INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: "AKIA-SYNTHETIC-0001" }],
    ["missing secret", { INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: undefined }],
    ["empty secret", { INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: "" }],
    ["secret with surrounding whitespace", { INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: `${SECRET_A}\n` }],
    ["missing role ARN", { INTEGRATION_AWS_WORKER_ROLE_ARN: undefined }],
    ["malformed role ARN (a user)", { INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws:iam::000000000000:user/bootstrap" }],
    ["role ARN with an impossible account", { INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws:iam::00000000000:role/worker" }],
    ["role in another account than the KMS key", { INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws:iam::111111111111:role/worker" }],
    ["role in another partition than the KMS key", { INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws-cn:iam::000000000000:role/worker" }],
  ] as const)("%s → IDENTITY_MISCONFIGURED before any STS call, value never echoed", async (_label, change) => {
    const { resolve, sts } = provider({ env: () => bootstrap(change) });
    const error = await resolve().then(() => undefined, (caught: unknown) => caught);
    expect((error as AwsIdentityError).failure).toBe("IDENTITY_MISCONFIGURED");
    expect(sts.calls).toEqual([]);
    const configured: string[] = Object.values(change as Record<string, string | undefined>).filter((v): v is string => v !== undefined && v !== "");
    for (const value of [KEY_A, SECRET_A, ROLE, ...configured]) {
      expect(rendered(error).includes(value.trim()), value).toBe(false);
    }
  });

  it("a valid configuration is accepted (no AKIA prefix or exact secret length is assumed)", () => {
    expect(readBootstrapIdentity(bootstrap(), KMS)).toEqual({ accessKeyId: KEY_A, secretAccessKey: SECRET_A, roleArn: ROLE });
    expect(readBootstrapIdentity(bootstrap({ INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: "SYNTHETIC00000000ID" }), KMS).accessKeyId).toBe("SYNTHETIC00000000ID");
    expect(readBootstrapIdentity(bootstrap({ INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws:iam::000000000000:role/path/to/worker" }), KMS).roleArn).toBe("arn:aws:iam::000000000000:role/path/to/worker");
  });

  it("the standard AWS credential variables are never an identity source", async () => {
    const { resolve, sts } = provider({ env: () => ({ AWS_ACCESS_KEY_ID: KEY_B, AWS_SECRET_ACCESS_KEY: SECRET_B, AWS_SESSION_TOKEN: "ambient", AWS_PROFILE: "ambient" }) });
    expect(await failureOf(resolve())).toBe("IDENTITY_MISCONFIGURED");
    expect(sts.calls).toEqual([]);
  });
});

describe("the AssumeRole request", () => {
  it("exact role, 900 s, the fixed session name — nothing else — signed by the bootstrap key in the KMS key's region", async () => {
    const { resolve, sts } = provider({});
    await resolve();
    expect(sts.calls).toEqual([{ region: "sa-east-1", accessKeyId: KEY_A, secretAccessKey: SECRET_A, input: { RoleArn: ROLE, RoleSessionName: "integration-worker", DurationSeconds: 900 } }]);
    expect(INTEGRATION_WORKER_SESSION_SECONDS).toBe(900);
    expect(INTEGRATION_WORKER_ROLE_SESSION_NAME).toBe("integration-worker");
  });

  it("KMS receives only the TEMPORARY assumed-role credentials, never the bootstrap key", async () => {
    const { resolve } = provider({});
    const credentials = await resolve();
    expect(credentials).toEqual({ accessKeyId: sessionKeyOf(KEY_A), secretAccessKey: `session-secret-of-${KEY_A}`, sessionToken: `session-token-of-${KEY_A}`, expiration: new Date(NOW + 900_000) });
    expect(Object.values(credentials).map(String).some((value) => value === KEY_A || value === SECRET_A)).toBe(false);
  });
});

describe("response validation", () => {
  const answering = (output: AssumeRoleCommandOutput) => provider({ stsClient: fakeSts(() => Promise.resolve(output)).stsClient });
  it.each([
    ["no Credentials", { $metadata: {} }],
    ["missing session token", { $metadata: {}, Credentials: { AccessKeyId: "ASIAX", SecretAccessKey: "s", SessionToken: undefined as never, Expiration: new Date(NOW + 900_000) } }],
    ["missing expiration", { $metadata: {}, Credentials: { AccessKeyId: "ASIAX", SecretAccessKey: "s", SessionToken: "t", Expiration: undefined as never } }],
    ["already expired", { $metadata: {}, Credentials: { AccessKeyId: "ASIAX", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(NOW - 1) } }],
    ["invalid expiration date", { $metadata: {}, Credentials: { AccessKeyId: "ASIAX", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Number.NaN) } }],
    ["empty access key id", { $metadata: {}, Credentials: { AccessKeyId: "", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(NOW + 900_000) } }],
  ] as const)("%s → IDENTITY_MISCONFIGURED", async (_label, output) => {
    expect(await failureOf(answering(output as AssumeRoleCommandOutput).resolve())).toBe("IDENTITY_MISCONFIGURED");
  });
});

describe("error normalization (no message, request, response, key or cause kept)", () => {
  const raw = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`raw ${name} ${SECRET_A} ${ROLE} <xml>body</xml>`), { name, ...extra });
  it.each([
    ["AccessDenied", raw("AccessDenied"), "IDENTITY_ACCESS_DENIED"],
    ["AccessDeniedException", raw("AccessDeniedException"), "IDENTITY_ACCESS_DENIED"],
    ["InvalidClientTokenId (revoked/unknown bootstrap key)", raw("InvalidClientTokenId"), "IDENTITY_ACCESS_DENIED"],
    ["UnrecognizedClientException", raw("UnrecognizedClientException"), "IDENTITY_ACCESS_DENIED"],
    ["SignatureDoesNotMatch (wrong secret)", raw("SignatureDoesNotMatch"), "IDENTITY_ACCESS_DENIED"],
    ["ExpiredToken", raw("ExpiredToken"), "IDENTITY_ACCESS_DENIED"],
    ["ExpiredTokenException", raw("ExpiredTokenException"), "IDENTITY_ACCESS_DENIED"],
    ["Throttling", raw("Throttling", { $retryable: { throttling: true } }), "IDENTITY_UNAVAILABLE"],
    ["TooManyRequestsException", raw("TooManyRequestsException"), "IDENTITY_UNAVAILABLE"],
    ["ServiceUnavailable", raw("ServiceUnavailable", { $fault: "server" }), "IDENTITY_UNAVAILABLE"],
    ["InternalFailure", raw("InternalFailure"), "IDENTITY_UNAVAILABLE"],
    ["an unnamed 5xx", raw("SomethingNew", { $fault: "server" }), "IDENTITY_UNAVAILABLE"],
    ["TimeoutError", raw("TimeoutError"), "IDENTITY_UNAVAILABLE"],
    ["transport reset", raw("Error", { code: "ECONNRESET" }), "IDENTITY_UNAVAILABLE"],
    ["transport reset (cause)", raw("Error", { cause: { code: "ETIMEDOUT" } }), "IDENTITY_UNAVAILABLE"],
    ["RequestTimeTooSkewed", raw("RequestTimeTooSkewed"), "IDENTITY_UNAVAILABLE"],
    ["RegionDisabledException", raw("RegionDisabledException"), "IDENTITY_MISCONFIGURED"],
    ["MalformedPolicyDocument", raw("MalformedPolicyDocument"), "IDENTITY_MISCONFIGURED"],
    ["ValidationError", raw("ValidationError"), "IDENTITY_MISCONFIGURED"],
    ["unknown", raw("SomethingNew"), "IDENTITY_MISCONFIGURED"],
    ["not an error", "a string", "IDENTITY_MISCONFIGURED"],
  ] as const)("%s → %s", async (_label, error, expected) => {
    expect(stsIdentityFailure(error)).toBe(expected);
    const { resolve } = provider({ stsClient: fakeSts(() => Promise.reject(error instanceof Error ? error : new Error(error))).stsClient });
    const caught = await resolve().then(() => undefined, (failure: unknown) => failure);
    expect((caught as AwsIdentityError).failure).toBe(expected);
    for (const secret of [SECRET_A, KEY_A, ROLE, "<xml>", "raw "]) expect(rendered(caught).includes(secret), secret).toBe(false);
    expect((caught as Error).cause).toBeUndefined();
  });

  it("identity failures keep their keyring meaning through KMS (7E.2 mapping)", () => {
    expect(kmsErrorCode(new AwsIdentityError("IDENTITY_ACCESS_DENIED"))).toBe("KEYRING_ACCESS_DENIED");
    expect(kmsErrorCode(new AwsIdentityError("IDENTITY_UNAVAILABLE"))).toBe("KEYRING_UNAVAILABLE");
    expect(kmsErrorCode(new AwsIdentityError("IDENTITY_MISCONFIGURED"))).toBe("KEYRING_MISCONFIGURED");
  });
});

describe("temporary credential cache", () => {
  it("a healthy session is reused; at 120 s or less it is refreshed; an expired one is never served", async () => {
    const { resolve, sts, advance } = provider({});
    const first = await resolve();
    expect(sts.calls).toHaveLength(1);
    advance(900 - INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS - 1); // 121 s left
    expect(await resolve()).toBe(first);
    expect(sts.calls).toHaveLength(1);
    advance(1); // exactly 120 s left
    const second = await resolve();
    expect(sts.calls).toHaveLength(2);
    expect(second).not.toBe(first);
    advance(10_000); // long past expiry
    expect((await resolve()).expiration?.getTime()).toBeGreaterThan(Date.UTC(2026, 9, 8, 12, 0, 0) + 10_000_000);
    expect(sts.calls).toHaveLength(3);
  });

  it("concurrent callers share ONE AssumeRole and get the same credential set", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sts = fakeSts(async (accessKeyId) => {
      await gate;
      return sessionFor(accessKeyId, 900);
    });
    const { resolve } = provider({ stsClient: sts.stsClient });
    const pending = Array.from({ length: 8 }, () => resolve());
    release();
    const results = await Promise.all(pending);
    expect(sts.calls).toHaveLength(1);
    expect(new Set(results).size).toBe(1);
  });

  it("a failed refresh does not poison the provider: the next resolution tries again", async () => {
    let fail = true;
    const sts = fakeSts((accessKeyId) => (fail ? Promise.reject(Object.assign(new Error("throttled"), { name: "Throttling" })) : Promise.resolve(sessionFor(accessKeyId, 900))));
    const { resolve } = provider({ stsClient: sts.stsClient });
    expect(await failureOf(resolve())).toBe("IDENTITY_UNAVAILABLE");
    fail = false;
    expect((await resolve()).sessionToken).toBe(`session-token-of-${KEY_A}`);
    expect(sts.calls).toHaveLength(2);
  });
});

describe("bootstrap rotation", () => {
  it("key A → session A; the source changes to key B → the cached session A is dropped and B assumes the role", async () => {
    let env = bootstrap();
    const { resolve, sts } = provider({ env: () => env });
    expect((await resolve()).sessionToken).toBe(`session-token-of-${KEY_A}`);
    env = bootstrap({ INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: KEY_B, INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: SECRET_B });
    expect((await resolve()).sessionToken).toBe(`session-token-of-${KEY_B}`);
    expect(sts.calls.map((call) => [call.accessKeyId, call.secretAccessKey])).toEqual([[KEY_A, SECRET_A], [KEY_B, SECRET_B]]);
  });

  it("a removed bootstrap fails closed even while a cached session would still be valid", async () => {
    let env = bootstrap();
    const { resolve } = provider({ env: () => env });
    await resolve();
    env = bootstrap({ INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: undefined });
    expect(await failureOf(resolve())).toBe("IDENTITY_MISCONFIGURED");
  });
});

describe("cache identity: a session is reused only while the configuration targets the principal that produced it", () => {
  const ROLE_B = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-integration-worker-b";
  /** A role-aware STS double: the session names both the bootstrap key and the role it was assumed with. */
  function roleAwareSts(gate?: (roleArn: string) => Promise<void>) {
    const calls: { accessKeyId: string; roleArn: string }[] = [];
    const stsClient = (_region: string, credentials: { accessKeyId: string; secretAccessKey: string }): AssumeRoleSender => ({
      send: async (command) => {
        const roleArn = command.input.RoleArn ?? "";
        calls.push({ accessKeyId: credentials.accessKeyId, roleArn });
        if (gate !== undefined) await gate(roleArn);
        const output = sessionFor(credentials.accessKeyId, 900);
        return { ...output, Credentials: { ...output.Credentials, SessionToken: `session:${credentials.accessKeyId}:${roleArn.split("/").pop() ?? ""}` } as never };
      },
    });
    return { calls, stsClient };
  }
  const token = async (resolve: () => Promise<{ sessionToken?: string }>) => (await resolve()).sessionToken;

  it("role ARN rotation (same bootstrap key): the RoleA session is never served for RoleB; RoleB is assumed", async () => {
    let env = bootstrap();
    const sts = roleAwareSts();
    const { resolve } = provider({ env: () => env, stsClient: sts.stsClient });
    expect(await token(resolve)).toBe(`session:${KEY_A}:social-intelligence-platform-dev-integration-worker`);
    env = bootstrap({ INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE_B });
    expect(await token(resolve)).toBe(`session:${KEY_A}:social-intelligence-platform-dev-integration-worker-b`);
    expect(sts.calls).toEqual([{ accessKeyId: KEY_A, roleArn: ROLE }, { accessKeyId: KEY_A, roleArn: ROLE_B }]);
    // RoleA's session is gone, not merely skipped: switching back assumes RoleA again.
    env = bootstrap();
    await resolve();
    expect(sts.calls).toHaveLength(3);
  });

  it("bootstrap key and role rotated together: exactly one new AssumeRole, with B and RoleB", async () => {
    let env = bootstrap();
    const sts = roleAwareSts();
    const { resolve } = provider({ env: () => env, stsClient: sts.stsClient });
    await resolve();
    env = bootstrap({ INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: KEY_B, INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: SECRET_B, INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE_B });
    expect(await token(resolve)).toBe(`session:${KEY_B}:social-intelligence-platform-dev-integration-worker-b`);
    expect(sts.calls).toEqual([{ accessKeyId: KEY_A, roleArn: ROLE }, { accessKeyId: KEY_B, roleArn: ROLE_B }]);
  });

  it("an unchanged identity reuses the healthy session, whatever unrelated configuration changes", async () => {
    let env = bootstrap();
    const sts = roleAwareSts();
    const { resolve } = provider({ env: () => env, stsClient: sts.stsClient });
    const first = await resolve();
    env = { ...bootstrap(), UNRELATED_SETTING: "changed", AWS_REGION: "eu-west-1", DATABASE_WORKER_URL: "postgres://synthetic" };
    expect(await resolve()).toBe(first);
    expect(sts.calls).toHaveLength(1);
  });

  it.each([
    ["the role moved to another account than the KMS key", { INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws:iam::111111111111:role/worker" }],
    ["the role moved to another partition", { INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws-cn:iam::000000000000:role/worker" }],
    ["the role became malformed", { INTEGRATION_AWS_WORKER_ROLE_ARN: "not-an-arn" }],
    ["the bootstrap key id was removed", { INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: "" }],
    ["the bootstrap secret was removed", { INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: "" }],
  ] as const)("a cache hit never bypasses validation: %s → MISCONFIGURED, the cached session is not returned", async (_label, change) => {
    let env = bootstrap();
    const sts = roleAwareSts();
    const { resolve } = provider({ env: () => env, stsClient: sts.stsClient });
    await resolve();
    env = bootstrap(change);
    expect(await failureOf(resolve())).toBe("IDENTITY_MISCONFIGURED");
    expect(sts.calls).toHaveLength(1);
  });

  it("after an identity change, N concurrent callers share ONE AssumeRole for the new identity and none gets the old session", async () => {
    let env = bootstrap();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sts = roleAwareSts((roleArn) => (roleArn === ROLE_B ? gate : Promise.resolve()));
    const { resolve } = provider({ env: () => env, stsClient: sts.stsClient });
    await resolve();
    env = bootstrap({ INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE_B });
    const pending = Array.from({ length: 6 }, () => token(resolve));
    release();
    const tokens = await Promise.all(pending);
    expect(new Set(tokens)).toEqual(new Set([`session:${KEY_A}:social-intelligence-platform-dev-integration-worker-b`]));
    expect(sts.calls).toEqual([{ accessKeyId: KEY_A, roleArn: ROLE }, { accessKeyId: KEY_A, roleArn: ROLE_B }]);
  });

  it.each([["the old refresh finishes first"], ["the new refresh finishes first"]] as const)(
    "a refresh started for RoleA never becomes the cached session once RoleB is current (%s)",
    async (order) => {
      let env = bootstrap();
      const gates = new Map<string, () => void>();
      const sts = roleAwareSts((roleArn) => new Promise<void>((resolve) => { gates.set(roleArn, resolve); }));
      const { resolve } = provider({ env: () => env, stsClient: sts.stsClient });
      const oldCall = token(resolve); // reads A/RoleA, starts AssumeRole(RoleA)
      await Promise.resolve();
      env = bootstrap({ INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE_B });
      const newCall = token(resolve); // reads A/RoleB, starts AssumeRole(RoleB)
      await vi.waitFor(() => { expect(gates.size).toBe(2); });
      const [first, second] = order === "the old refresh finishes first" ? [ROLE, ROLE_B] : [ROLE_B, ROLE];
      gates.get(first)?.();
      await Promise.resolve();
      gates.get(second)?.();
      expect(await oldCall).toBe(`session:${KEY_A}:social-intelligence-platform-dev-integration-worker`); // its own observed configuration
      expect(await newCall).toBe(`session:${KEY_A}:social-intelligence-platform-dev-integration-worker-b`);
      // The cache holds RoleB's session: served without another AssumeRole, and never RoleA's.
      expect(await token(resolve)).toBe(`session:${KEY_A}:social-intelligence-platform-dev-integration-worker-b`);
      expect(sts.calls).toHaveLength(2);
    },
  );
});

describe("composition: lazy, integration-only, local/test untouched", () => {
  it("building the provider reads and requests nothing", () => {
    const readEnvironment = vi.fn(() => bootstrap());
    const sts = fakeSts(() => Promise.resolve(sessionFor(KEY_A, 900)));
    createIntegrationWorkerAwsCredentials(KMS, { readEnvironment, stsClient: sts.stsClient });
    expect(readEnvironment).not.toHaveBeenCalled();
    expect(sts.calls).toEqual([]);
  });

  it("local/test (no KMS configuration) composes no AWS identity and needs none of the bootstrap names", () => {
    expect(integrationWorkerAwsCredentials({ NODE_ENV: "test", LOCAL_KEYRING_KEY: Buffer.alloc(32, 7).toString("base64url") })).toBeUndefined();
  });

  it("deployed KMS without the bootstrap fails closed on first use (KEYRING_MISCONFIGURED), never falling back", async () => {
    const credentials = integrationWorkerAwsCredentials({ CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY });
    expect(credentials).toBeTypeOf("function");
    vi.stubEnv("INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID", "");
    const error = await credentials?.().then(() => undefined, (caught: unknown) => caught);
    expect((error as AwsIdentityError).failure).toBe("IDENTITY_MISCONFIGURED");
    expect(kmsErrorCode(error)).toBe("KEYRING_MISCONFIGURED");
  });
});

describe("the REAL pinned SDK clients, offline (every HTTPS request trapped)", () => {
  type Captured = { host: string; authorization: string; body: string };
  function trapHttps(): Captured[] {
    const captured: Captured[] = [];
    const trap = (options: unknown) => {
      const o = options as { hostname?: string; host?: string; headers?: Record<string, string> };
      const record: Captured = { host: o.hostname ?? o.host ?? "", authorization: o.headers?.["authorization"] ?? "", body: "" };
      const text = (chunk: unknown): string => (typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "");
      captured.push(record);
      const request = Object.assign(new EventEmitter(), {
        setTimeout: () => request, setNoDelay: () => undefined, setSocketKeepAlive: () => undefined, destroy: () => undefined, abort: () => undefined,
        write: (chunk: unknown) => { record.body += text(chunk); return true; },
        end: (chunk?: unknown) => {
          if (chunk !== undefined) record.body += text(chunk);
          setImmediate(() => request.emit("error", Object.assign(new Error("offline trap"), { code: "ECONNRESET" })));
        },
      });
      return request;
    };
    vi.spyOn(https, "request").mockImplementation(trap as never);
    vi.spyOn(http, "request").mockImplementation(trap as never);
    return captured;
  }
  const poison = () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "SYNTHETICAMBIENTPOISON0");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-poison-secret-0000000000");
    vi.stubEnv("AWS_SESSION_TOKEN", "ambient-poison-token");
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AWS_DEFAULT_REGION", "eu-west-1");
    vi.stubEnv("AWS_ENDPOINT_URL", "https://poison.invalid.example.test");
    vi.stubEnv("AWS_ENDPOINT_URL_STS", "https://sts-poison.invalid.example.test");
  };

  it("STS: regional host from the KMS key, signed by the bootstrap key, exact AssumeRole body — poisoned AWS_* ignored", async () => {
    poison();
    const captured = trapHttps();
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => bootstrap(), nowMs: () => Date.now() });
    expect(await failureOf(resolve())).toBe("IDENTITY_UNAVAILABLE"); // the trapped transport, as a network failure
    expect(captured.length).toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.host).toBe("sts.sa-east-1.amazonaws.com");
      expect(request.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${KEY_A}/\\d{8}/sa-east-1/sts/aws4_request`));
      expect(request.body).toBe(`Action=AssumeRole&Version=2011-06-15&RoleArn=${encodeURIComponent(ROLE)}&RoleSessionName=integration-worker&DurationSeconds=900`);
      expect(request.body).not.toMatch(/ExternalId|SourceIdentity|Tags|Policy|SerialNumber|TokenCode/);
    }
  });

  it("end to end: STS is called only when KMS needs credentials, and KMS signs with the assumed-role session only", async () => {
    poison();
    const captured = trapHttps();
    const sts = fakeSts((accessKeyId) => Promise.resolve(sessionFor(accessKeyId, 900, Date.now())));
    const credentials = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => bootstrap(), stsClient: sts.stsClient });
    const kms = createKmsClient(KMS, credentials);
    expect(sts.calls).toEqual([]); // building the opener path requests nothing
    await kms.send(new DecryptCommand({ CiphertextBlob: new Uint8Array([1, 2, 3]) })).catch(() => undefined);
    expect(sts.calls).toHaveLength(1);
    const kmsRequests = captured.filter((request) => request.host.startsWith("kms."));
    expect(kmsRequests.length).toBeGreaterThan(0);
    for (const request of kmsRequests) {
      expect(request.host).toBe("kms.sa-east-1.amazonaws.com");
      expect(request.authorization).toContain(`Credential=${sessionKeyOf(KEY_A)}/`);
      expect(request.authorization).not.toContain(KEY_A);
      expect(request.authorization).not.toContain("SYNTHETICAMBIENTPOISON0");
    }
  });
});
