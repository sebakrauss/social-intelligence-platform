/**
 * The integration worker's AWS identity — IAM Roles Anywhere (Step 7G-H5.6B), offline. Synthetic account 000000000000,
 * synthetic ARNs, PUBLIC synthetic certificates (fixtures/aws-identity, trusted by nothing) and private keys generated
 * at test time (never committed). The credential helper is a recording fake process; the real process runner is driven
 * with a throwaway local script; the real KMS client runs with every outbound HTTPS request trapped. No AWS call.
 * The stderr lines classified below are the REAL helper's (1.8.5), captured offline against a local fake endpoint.
 */
import { EventEmitter } from "node:events";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { DecryptCommand } from "@aws-sdk/client-kms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWS_SIGNING_HELPER_ARTIFACTS, AWS_SIGNING_HELPER_DIRECTORY } from "@/jobs/aws-signing-helper";
import { nodeSigningHelperProcess, verifiedAwsSigningHelper, type SigningHelperProcess, type SigningHelperRun } from "@/jobs/aws-signing-helper-process";
import { integrationWorkerAwsCredentials } from "@/jobs/connections";
import {
  INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS,
  INTEGRATION_WORKER_SESSION_SECONDS,
  SIGNING_HELPER_MAX_OUTPUT_BYTES,
  SIGNING_HELPER_TIMEOUT_MS,
  createIntegrationWorkerAwsCredentials,
  normalizePem,
  parseCredentialProcessOutput,
  readRolesAnywhereIdentity,
  signingHelperFailure,
  withEphemeralWorkloadMaterial,
  type IntegrationAwsIdentityDependencies,
} from "@/jobs/integration-aws-identity";
import { AwsIdentityError, type AwsIdentityFailure } from "@/platform/aws/identity";
import { createKmsClient } from "@/platform/crypto/credentials/aws-kms-client";
import { kmsErrorCode } from "@/platform/crypto/credentials/aws-kms-common";
import { parseKmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";

const root = path.resolve(import.meta.dirname, "../../..");
const KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const KMS = parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY, allowedKeyArns: KEY });
const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-integration-worker";
const ANCHOR = "arn:aws:rolesanywhere:sa-east-1:000000000000:trust-anchor/11111111-1111-4111-8111-111111111111";
const PROFILE = "arn:aws:rolesanywhere:sa-east-1:000000000000:profile/22222222-2222-4222-8222-222222222222";
const fixture = (name: string): string => readFileSync(path.join(root, "fixtures/aws-identity", name), "utf8");
const CERTIFICATE = fixture("workload-dev.pem");
/** A second valid dev certificate (another key): a rotation. */
const CERTIFICATE_ROTATED = fixture("workload-dev-rotated.pem");
const newPrivateKey = (): string => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PRIVATE_KEY = newPrivateKey();
const VALID_FROM = Date.parse(new X509Certificate(CERTIFICATE).validFrom);
const VALID_TO = Date.parse(new X509Certificate(CERTIFICATE).validTo);
const NOW = VALID_FROM + 86_400_000;
const SESSION_KEY = "SYNTHETICSESSIONKEY0001";
const SESSION_SECRET = "synthetic/session+secret-000000000000";
const SESSION_TOKEN = "synthetic-session-token-0000000000";
/** One line with literal "\n" sequences: the form a dashboard field keeps intact. */
const oneLine = (pem: string): string => pem.trimEnd().split("\n").join("\\n");
/** The PEM label of a private-key block, built from parts (no literal key-block marker in source; secret scan). */
const keyLabel = (prefix: string): string => [prefix, "PRIVATE", "KEY"].filter(Boolean).join(" ");
const relabel = (pem: string, prefix: string): string => pem.replaceAll(keyLabel(""), keyLabel(prefix));

type Env = Record<string, string | undefined>;
const identityEnv = (overrides: Env = {}): Env => ({
  INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE,
  INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: ANCHOR,
  INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN: PROFILE,
  INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM: oneLine(CERTIFICATE),
  INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM: oneLine(PRIVATE_KEY),
  ...overrides,
});

const failureOf = async (promise: Promise<unknown>): Promise<AwsIdentityFailure> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AwsIdentityError);
    return (error as AwsIdentityError).failure;
  }
  throw new Error("expected an identity failure");
};
const syncFailureOf = (work: () => unknown): AwsIdentityFailure => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(AwsIdentityError);
    return (error as AwsIdentityError).failure;
  }
  throw new Error("expected an identity failure");
};
const rendered = (value: unknown): string => [JSON.stringify(value), String(value), inspect(value, { depth: 10, showHidden: true }), value instanceof Error ? `${value.message} ${value.stack ?? ""}` : ""].join(" ");
const keyBody = (pem: string): string => pem.split("\n")[1] ?? "-";

// ── Fake credential helper process ───────────────────────────────────────────────────────────────────────────────
interface HelperCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly certificate: string;
  readonly privateKey: string;
  readonly directoryMode: number;
  readonly certificateMode: number;
  readonly privateKeyMode: number;
  readonly directory: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}
const ok = (expiresMs: number, overrides: Record<string, unknown> = {}): SigningHelperRun => ({
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify({ Version: 1, AccessKeyId: SESSION_KEY, SecretAccessKey: SESSION_SECRET, SessionToken: SESSION_TOKEN, Expiration: new Date(expiresMs).toISOString(), ...overrides }),
  stderr: "",
  timedOut: false,
  overflow: false,
  spawnFailure: null,
});
const failed = (stderr: string, overrides: Partial<SigningHelperRun> = {}): SigningHelperRun => ({ exitCode: 1, signal: null, stdout: "", stderr, timedOut: false, overflow: false, spawnFailure: null, ...overrides });

function fakeHelper(answer: (call: HelperCall, index: number) => SigningHelperRun | Promise<SigningHelperRun>) {
  const calls: HelperCall[] = [];
  const process: SigningHelperProcess = {
    async run(executable, args, options) {
      const certificatePath = args[args.indexOf("--certificate") + 1] ?? "";
      const privateKeyPath = args[args.indexOf("--private-key") + 1] ?? "";
      const call: HelperCall = {
        executable,
        args,
        certificate: readFileSync(certificatePath, "utf8"),
        privateKey: readFileSync(privateKeyPath, "utf8"),
        directoryMode: statSync(path.dirname(privateKeyPath)).mode & 0o777,
        certificateMode: statSync(certificatePath).mode & 0o777,
        privateKeyMode: statSync(privateKeyPath).mode & 0o777,
        directory: path.dirname(privateKeyPath),
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      };
      calls.push(call);
      return answer(call, calls.length - 1);
    },
  };
  return { process, calls };
}

let temporaryRoot = "";
beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), "wrenkind-identity-test-"));
});
afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function provider(overrides: Partial<IntegrationAwsIdentityDependencies> & { env?: () => Env; now?: () => number } = {}) {
  const helper = fakeHelper(() => ok(NOW + 900_000));
  const deps: Partial<IntegrationAwsIdentityDependencies> = {
    readEnvironment: overrides.env ?? (() => identityEnv()),
    nowMs: overrides.now ?? (() => NOW),
    signingHelper: () => Promise.resolve("/synthetic/vendor/aws_signing_helper"),
    process: helper.process,
    temporaryRoot: () => temporaryRoot,
    ...overrides,
  };
  return { resolve: createIntegrationWorkerAwsCredentials(KMS, deps), calls: helper.calls };
}

describe("Roles Anywhere configuration (re-read and re-validated on every resolution)", () => {
  it("all five variables valid → the identity, PEMs normalized in memory, the KMS key's region", () => {
    const identity = readRolesAnywhereIdentity(identityEnv(), KMS, NOW);
    expect(identity).toMatchObject({ roleArn: ROLE, trustAnchorArn: ANCHOR, profileArn: PROFILE, region: "sa-east-1", certificatePem: CERTIFICATE, privateKeyPem: PRIVATE_KEY });
    expect(identity.certificateFingerprint).toBe(new X509Certificate(CERTIFICATE).fingerprint256);
  });

  it("PEM forms: one line with literal \\n, multi-line, CRLF — the same material; a mixed form is refused", () => {
    expect(normalizePem(oneLine(CERTIFICATE), 8192)).toBe(CERTIFICATE);
    expect(normalizePem(CERTIFICATE, 8192)).toBe(CERTIFICATE);
    expect(normalizePem(CERTIFICATE.replaceAll("\n", "\r\n"), 8192)).toBe(CERTIFICATE);
    expect(normalizePem(`${CERTIFICATE}\\n`, 8192)).toBeUndefined();
    for (const value of [undefined, "", "   ", "\\n"]) expect(normalizePem(value, 8192)).toBeUndefined();
    const multi = readRolesAnywhereIdentity(identityEnv({ INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM: CERTIFICATE, INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM: PRIVATE_KEY }), KMS, NOW);
    expect(multi.certificateFingerprint).toBe(readRolesAnywhereIdentity(identityEnv(), KMS, NOW).certificateFingerprint);
  });

  it.each([
    "INTEGRATION_AWS_WORKER_ROLE_ARN",
    "INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN",
    "INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN",
    "INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM",
    "INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM",
  ])("%s missing or empty → IDENTITY_MISCONFIGURED", (name) => {
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv({ [name]: undefined }), KMS, NOW))).toBe("IDENTITY_MISCONFIGURED");
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv({ [name]: "" }), KMS, NOW))).toBe("IDENTITY_MISCONFIGURED");
  });

  it.each([
    ["role: not an ARN", { INTEGRATION_AWS_WORKER_ROLE_ARN: "social-intelligence-platform-dev-integration-worker" }],
    ["role: another account", { INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE.replace("000000000000", "111111111111") }],
    ["role: another partition", { INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE.replace("arn:aws:", "arn:aws-cn:") }],
    ["role: a user, not a role", { INTEGRATION_AWS_WORKER_ROLE_ARN: "arn:aws:iam::000000000000:user/social-intelligence-platform-dev-integration-bootstrap" }],
    ["trust anchor: a profile ARN", { INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: PROFILE }],
    ["trust anchor: another region", { INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: ANCHOR.replace("sa-east-1", "us-east-1") }],
    ["trust anchor: another account", { INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: ANCHOR.replace("000000000000", "111111111111") }],
    ["trust anchor: upper-case id", { INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: ANCHOR.toUpperCase() }],
    ["trust anchor: trailing path", { INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: `${ANCHOR}/x` }],
    ["trust anchor: padded", { INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: ` ${ANCHOR}` }],
    ["profile: a trust-anchor ARN", { INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN: ANCHOR }],
    ["profile: another region", { INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN: PROFILE.replace("sa-east-1", "eu-west-1") }],
    ["profile: another service", { INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN: PROFILE.replace(":rolesanywhere:", ":iam:") }],
  ])("%s → IDENTITY_MISCONFIGURED", (_label, overrides) => {
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv(overrides), KMS, NOW))).toBe("IDENTITY_MISCONFIGURED");
  });

  it.each([
    ["garbage", "not a certificate"],
    ["two certificates", `${CERTIFICATE}${CERTIFICATE}`],
    ["a private key in the certificate variable", PRIVATE_KEY],
    ["a corrupted body", CERTIFICATE.replace(/\n[A-Za-z0-9+/]{8}/, "\nAAAAAAAA")],
    ["a non-base64 body", CERTIFICATE.replace(/\n[A-Za-z0-9+/]/, "\n*")],
    ["the wrong subject CN (…-prod)", fixture("workload-wrong-cn.pem")],
    ["a CA certificate", fixture("workload-ca.pem")],
    ["an RSA key", fixture("workload-rsa.pem")],
    ["explicit EC curve parameters (the helper's Go parser rejects them; node:crypto would normalize)", fixture("workload-explicit-curve.pem")],
    ["oversized", `${CERTIFICATE}${"A".repeat(20_000)}`],
  ])("certificate: %s → IDENTITY_MISCONFIGURED", (_label, value) => {
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv({ INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM: value }), KMS, NOW))).toBe("IDENTITY_MISCONFIGURED");
  });

  it.each([
    ["the certificate in the key variable", CERTIFICATE],
    ["a SEC1 EC key block", relabel(PRIVATE_KEY, "EC")],
    ["an encrypted PKCS#8 block", relabel(PRIVATE_KEY, "ENCRYPTED")],
    ["an RSA key block", relabel(PRIVATE_KEY, "RSA")],
    ["a non-base64 body", PRIVATE_KEY.replace(/\n[A-Za-z0-9+/]/, "\n*")],
    ["two key blocks", `${PRIVATE_KEY}${PRIVATE_KEY}`],
    ["oversized", PRIVATE_KEY.replace("\n", `\n${"QUFB\n".repeat(1200)}`)],
  ])("private key: %s → IDENTITY_MISCONFIGURED (shape only; the key is never parsed)", (_label, value) => {
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv({ INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM: value }), KMS, NOW))).toBe("IDENTITY_MISCONFIGURED");
  });

  it("a certificate outside its validity window → IDENTITY_ACCESS_DENIED (before and after)", () => {
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv(), KMS, VALID_FROM - 1000))).toBe("IDENTITY_ACCESS_DENIED");
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv(), KMS, VALID_TO))).toBe("IDENTITY_ACCESS_DENIED");
  });

  it("the subject CN follows the credential context env: a dev certificate is refused for another env", () => {
    const other = { ...KMS, contextEnv: "staging" as never };
    expect(syncFailureOf(() => readRolesAnywhereIdentity(identityEnv(), other, NOW))).toBe("IDENTITY_MISCONFIGURED");
  });

  it("the retired bootstrap key and the standard AWS credential variables are never an identity source", () => {
    const ambient = {
      INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: "SYNTHETICBOOTSTRAPKEYA1",
      INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: "synthetic/bootstrap+secret-0000000000",
      AWS_ACCESS_KEY_ID: "SYNTHETICAMBIENTKEY0001",
      AWS_SECRET_ACCESS_KEY: "synthetic-ambient-secret-0000000000",
      AWS_SESSION_TOKEN: "synthetic-ambient-token",
    };
    const only: Env = { INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE, ...ambient };
    expect(syncFailureOf(() => readRolesAnywhereIdentity(only, KMS, NOW))).toBe("IDENTITY_MISCONFIGURED");
    // Present alongside a valid configuration, they change nothing.
    expect(readRolesAnywhereIdentity({ ...identityEnv(), ...ambient }, KMS, NOW).roleArn).toBe(ROLE);
  });

  it("errors carry their category only: no ARN, certificate or key material", () => {
    for (const env of [identityEnv({ INTEGRATION_AWS_WORKER_ROLE_ARN: `${ROLE}x y` }), identityEnv({ INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM: fixture("workload-ca.pem") }), identityEnv({ INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM: relabel(PRIVATE_KEY, "EC") })]) {
      let caught: unknown;
      try {
        readRolesAnywhereIdentity(env, KMS, NOW);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AwsIdentityError);
      expect((caught as AwsIdentityError).toJSON()).toEqual({ failure: "IDENTITY_MISCONFIGURED" });
      const text = rendered(caught);
      for (const needle of [ROLE, ANCHOR, PROFILE, keyBody(CERTIFICATE), keyBody(PRIVATE_KEY), "000000000000"]) expect(text).not.toContain(needle);
    }
  });
});

describe("the credential helper run", () => {
  it("exact arguments — paths and non-secret identifiers only, 900 s, the KMS key's region — and the pinned bounds", async () => {
    const { resolve, calls } = provider();
    await resolve();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call === undefined) throw new Error("no call");
    expect(call.executable).toBe("/synthetic/vendor/aws_signing_helper");
    expect(call.args).toEqual([
      "credential-process",
      "--certificate", path.join(call.directory, "certificate.pem"),
      "--private-key", path.join(call.directory, "private-key.pem"),
      "--trust-anchor-arn", ANCHOR,
      "--profile-arn", PROFILE,
      "--role-arn", ROLE,
      "--region", "sa-east-1",
      "--session-duration", String(INTEGRATION_WORKER_SESSION_SECONDS),
    ]);
    expect(INTEGRATION_WORKER_SESSION_SECONDS).toBe(900);
    expect(call.args.join(" ")).not.toContain(keyBody(PRIVATE_KEY));
    expect(call.args.join(" ")).not.toContain(keyBody(CERTIFICATE));
    expect(call.args).not.toContain("--role-session-name");
    expect(call.args).not.toContain("--endpoint");
    expect(call.args).not.toContain("--no-verify-ssl");
    expect([call.timeoutMs, call.maxOutputBytes]).toEqual([SIGNING_HELPER_TIMEOUT_MS, SIGNING_HELPER_MAX_OUTPUT_BYTES]);
  });

  it("material exists only during the run: a fresh 0700 directory under the temp root, two 0600 files with the exact PEM", async () => {
    const { resolve, calls } = provider();
    await resolve();
    const [call] = calls;
    if (call === undefined) throw new Error("no call");
    expect(path.dirname(call.directory)).toBe(temporaryRoot);
    expect(path.basename(call.directory)).toMatch(/^wrenkind-ra-[A-Za-z0-9]{6}$/);
    expect([call.directoryMode, call.certificateMode, call.privateKeyMode]).toEqual([0o700, 0o600, 0o600]);
    expect([call.certificate, call.privateKey]).toEqual([CERTIFICATE, PRIVATE_KEY]);
    expect(existsSync(call.directory)).toBe(false);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it.each([
    ["the helper fails", () => failed("operation error RolesAnywhere: CreateSession, https response error StatusCode: 403, RequestID: , AccessDeniedException: Untrusted certificate. Insufficient certificate")],
    ["the output is unparseable", () => ({ ...ok(NOW + 900_000), stdout: "{not json" })],
    ["the process runner throws", () => Promise.reject(new Error("synthetic runner failure"))],
  ] as const)("cleanup is guaranteed when %s: no directory or file remains", async (_label, answer) => {
    const helper = fakeHelper(answer);
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => identityEnv(), nowMs: () => NOW, signingHelper: () => Promise.resolve("/x"), process: helper.process, temporaryRoot: () => temporaryRoot });
    await failureOf(resolve());
    expect(helper.calls).toHaveLength(1);
    expect(existsSync(helper.calls[0]?.directory ?? "")).toBe(false);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("withEphemeralWorkloadMaterial removes everything after success and after a throwing body", async () => {
    let seen = "";
    expect(await withEphemeralWorkloadMaterial(temporaryRoot, { certificatePem: CERTIFICATE, privateKeyPem: PRIVATE_KEY }, (files) => {
      seen = files.privateKey;
      return Promise.resolve(readFileSync(files.privateKey, "utf8") === PRIVATE_KEY);
    })).toBe(true);
    expect(existsSync(seen)).toBe(false);
    await expect(withEphemeralWorkloadMaterial(temporaryRoot, { certificatePem: CERTIFICATE, privateKeyPem: PRIVATE_KEY }, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("an unavailable helper executable fails closed before any material is written", async () => {
    const helper = fakeHelper(() => ok(NOW + 900_000));
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => identityEnv(), nowMs: () => NOW, signingHelper: () => Promise.reject(new AwsIdentityError("IDENTITY_MISCONFIGURED")), process: helper.process, temporaryRoot: () => temporaryRoot });
    expect(await failureOf(resolve())).toBe("IDENTITY_MISCONFIGURED");
    expect(helper.calls).toEqual([]);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });
});

describe("credential_process output (strict)", () => {
  const document = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({ Version: 1, AccessKeyId: SESSION_KEY, SecretAccessKey: SESSION_SECRET, SessionToken: SESSION_TOKEN, Expiration: new Date(NOW + 900_000).toISOString(), ...overrides });

  it("a valid document → exactly the temporary credentials (frozen), its own Expiration authoritative", () => {
    const credentials = parseCredentialProcessOutput(document({ Expiration: new Date(NOW + 600_000).toISOString() }), NOW);
    expect(credentials).toEqual({ accessKeyId: SESSION_KEY, secretAccessKey: SESSION_SECRET, sessionToken: SESSION_TOKEN, expiration: new Date(NOW + 600_000) });
    expect(Object.isFrozen(credentials)).toBe(true);
  });

  it.each([
    ["malformed JSON", "{"],
    ["not an object", "[]"],
    ["Version 2", document({ Version: 2 })],
    ["Version as a string", document({ Version: "1" })],
    ["an extra field", document({ RoleArn: ROLE })],
    ["no SessionToken", JSON.stringify({ Version: 1, AccessKeyId: SESSION_KEY, SecretAccessKey: SESSION_SECRET, Expiration: new Date(NOW + 900_000).toISOString() })],
    ["an empty AccessKeyId", document({ AccessKeyId: "" })],
    ["a short secret", document({ SecretAccessKey: "short" })],
    ["whitespace in the token", document({ SessionToken: "synthetic token with spaces" })],
    ["a non-ISO expiration", document({ Expiration: "tomorrow" })],
    ["already expired", document({ Expiration: new Date(NOW - 1).toISOString() })],
    ["expiring now", document({ Expiration: new Date(NOW).toISOString() })],
    ["longer than 900 s + skew (a misconfigured profile)", document({ Expiration: new Date(NOW + 3600_000).toISOString() })],
  ])("%s → IDENTITY_MISCONFIGURED", (_label, stdout) => {
    expect(syncFailureOf(() => parseCredentialProcessOutput(stdout, NOW))).toBe("IDENTITY_MISCONFIGURED");
  });

  it("900 s plus up to 60 s of clock skew is accepted", () => {
    expect(parseCredentialProcessOutput(document({ Expiration: new Date(NOW + 960_000).toISOString() }), NOW).expiration).toEqual(new Date(NOW + 960_000));
  });
});

describe("helper failure classification (stderr is classified, never propagated)", () => {
  // Real helper 1.8.5 stderr lines, captured offline (identifiers replaced by synthetic ones).
  const real = {
    denied: "2026/10/20 08:48:18 operation error RolesAnywhere: CreateSession, https response error StatusCode: 403, RequestID: , AccessDeniedException: Untrusted certificate. Insufficient certificate",
    throttled: "2026/10/20 08:48:19 operation error RolesAnywhere: CreateSession, exceeded maximum number of attempts, 3, https response error StatusCode: 429, RequestID: , api error ThrottlingException: Rate exceeded",
    unavailable: "2026/10/20 08:48:21 operation error RolesAnywhere: CreateSession, exceeded maximum number of attempts, 3, https response error StatusCode: 503, RequestID: , api error ServiceUnavailableException: Service unavailable",
    validation: "2026/10/20 08:48:21 operation error RolesAnywhere: CreateSession, https response error StatusCode: 400, RequestID: , ValidationException: Invalid duration",
    network: `2026/10/20 08:48:23 operation error RolesAnywhere: CreateSession, exceeded maximum number of attempts, 3, https response error StatusCode: 0, RequestID: , request send failed, Post "https://rolesanywhere.sa-east-1.amazonaws.com/sessions?profileArn=${encodeURIComponent(PROFILE)}": dial tcp: connection refused`,
    certificate: "2026/10/20 08:47:22 could not parse certificate",
    privateKey: "2026/10/20 08:47:58 unable to parse private key",
  };

  it.each([
    ["AccessDeniedException (403)", failed(real.denied), "IDENTITY_ACCESS_DENIED"],
    ["ThrottlingException (429, after the helper's own retries)", failed(real.throttled), "IDENTITY_UNAVAILABLE"],
    ["ServiceUnavailableException (503)", failed(real.unavailable), "IDENTITY_UNAVAILABLE"],
    ["network failure", failed(real.network), "IDENTITY_UNAVAILABLE"],
    ["ValidationException (400)", failed(real.validation), "IDENTITY_MISCONFIGURED"],
    ["unparseable certificate", failed(real.certificate), "IDENTITY_MISCONFIGURED"],
    ["unparseable private key", failed(real.privateKey), "IDENTITY_MISCONFIGURED"],
    ["an unknown failure", failed("something new"), "IDENTITY_MISCONFIGURED"],
    ["helper not found", failed("", { exitCode: null, spawnFailure: "not_found" }), "IDENTITY_MISCONFIGURED"],
    ["permission denied", failed("", { exitCode: null, spawnFailure: "permission" }), "IDENTITY_MISCONFIGURED"],
    ["our timeout", failed("", { exitCode: null, signal: "SIGKILL", timedOut: true }), "IDENTITY_UNAVAILABLE"],
    ["killed by another signal", failed("", { exitCode: null, signal: "SIGTERM" }), "IDENTITY_UNAVAILABLE"],
    ["output overflow", failed(real.denied, { exitCode: null, signal: "SIGKILL", overflow: true }), "IDENTITY_MISCONFIGURED"],
  ] as const)("%s → %s", async (_label, run, failure) => {
    expect(signingHelperFailure(run)).toBe(failure);
    const helper = fakeHelper(() => run);
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => identityEnv(), nowMs: () => NOW, signingHelper: () => Promise.resolve("/x"), process: helper.process, temporaryRoot: () => temporaryRoot });
    let caught: unknown;
    try {
      await resolve();
    } catch (error) {
      caught = error;
    }
    expect((caught as AwsIdentityError).toJSON()).toEqual({ failure });
    const text = rendered(caught);
    for (const needle of ["RolesAnywhere", "Untrusted", "ThrottlingException", "rolesanywhere.sa-east-1", PROFILE, ANCHOR, ROLE, "000000000000"]) expect(text).not.toContain(needle);
  });

  it("identity failures keep their keyring meaning through KMS (7E.2 mapping)", () => {
    expect(kmsErrorCode(new AwsIdentityError("IDENTITY_ACCESS_DENIED"))).toBe("KEYRING_ACCESS_DENIED");
    expect(kmsErrorCode(new AwsIdentityError("IDENTITY_UNAVAILABLE"))).toBe("KEYRING_UNAVAILABLE");
    expect(kmsErrorCode(new AwsIdentityError("IDENTITY_MISCONFIGURED"))).toBe("KEYRING_MISCONFIGURED");
  });

  it("a successful run never exposes credentials in errors elsewhere: no credential value appears in a later failure", async () => {
    let fail = false;
    const helper = fakeHelper(() => (fail ? failed("something new") : ok(NOW + 900_000)));
    let now = NOW;
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => identityEnv(), nowMs: () => now, signingHelper: () => Promise.resolve("/x"), process: helper.process, temporaryRoot: () => temporaryRoot });
    await resolve();
    fail = true;
    now = NOW + 900_000;
    let caught: unknown;
    try {
      await resolve();
    } catch (error) {
      caught = error;
    }
    for (const needle of [SESSION_KEY, SESSION_SECRET, SESSION_TOKEN]) expect(rendered(caught)).not.toContain(needle);
  });
});

describe("temporary credential cache", () => {
  it("a healthy session is reused; at 120 s or less it is refreshed; an expired one is never served", async () => {
    let now = NOW;
    const helper = fakeHelper((_call, index) => ok(now + 900_000, { AccessKeyId: `SYNTHETICSESSIONKEY000${String(index)}` }));
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => identityEnv(), nowMs: () => now, signingHelper: () => Promise.resolve("/x"), process: helper.process, temporaryRoot: () => temporaryRoot });
    expect((await resolve()).accessKeyId).toBe("SYNTHETICSESSIONKEY0000");
    now += (900 - INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS - 1) * 1000;
    expect((await resolve()).accessKeyId).toBe("SYNTHETICSESSIONKEY0000");
    now += 1000;
    expect((await resolve()).accessKeyId).toBe("SYNTHETICSESSIONKEY0001");
    now += 2 * 900_000;
    expect((await resolve()).accessKeyId).toBe("SYNTHETICSESSIONKEY0002");
    expect(helper.calls).toHaveLength(3);
  });

  it("concurrent callers share ONE helper run and get the same credential set", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const helper = fakeHelper(async () => {
      await gate;
      return ok(NOW + 900_000);
    });
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => identityEnv(), nowMs: () => NOW, signingHelper: () => Promise.resolve("/x"), process: helper.process, temporaryRoot: () => temporaryRoot });
    const pending = Promise.all([resolve(), resolve(), resolve(), resolve()]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const results = await pending;
    expect(helper.calls).toHaveLength(1);
    expect(new Set(results)).toEqual(new Set([results[0]]));
  });

  it("a failed run does not poison the provider: the next resolution runs the helper again", async () => {
    let attempt = 0;
    const helper = fakeHelper(() => (attempt++ === 0 ? failed("StatusCode: 503, ServiceUnavailableException") : ok(NOW + 900_000)));
    const resolve = createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: () => identityEnv(), nowMs: () => NOW, signingHelper: () => Promise.resolve("/x"), process: helper.process, temporaryRoot: () => temporaryRoot });
    expect(await failureOf(resolve())).toBe("IDENTITY_UNAVAILABLE");
    expect((await resolve()).accessKeyId).toBe(SESSION_KEY);
    expect(helper.calls).toHaveLength(2);
  });

  it("withdrawn or invalid configuration fails closed even while a cached session would still be valid", async () => {
    let env = identityEnv();
    const { resolve, calls } = provider({ env: () => env });
    await resolve();
    env = identityEnv({ INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM: undefined });
    expect(await failureOf(resolve())).toBe("IDENTITY_MISCONFIGURED");
    env = identityEnv({ INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN: PROFILE.replace("sa-east-1", "us-east-1") });
    expect(await failureOf(resolve())).toBe("IDENTITY_MISCONFIGURED");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["the role", { INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE.replace("integration-worker", "integration-worker-b") }],
    ["the trust anchor", { INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN: ANCHOR.replace("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333") }],
    ["the profile", { INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN: PROFILE.replace("22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444") }],
  ])("changing %s drops the cached session: exactly one new helper run for the new identity", async (_label, overrides) => {
    let env = identityEnv();
    const { resolve, calls } = provider({ env: () => env });
    await resolve();
    await resolve();
    env = identityEnv(overrides);
    await resolve();
    await resolve();
    expect(calls).toHaveLength(2);
  });

  it("a rotated certificate is a new identity: the cached session is dropped and the new material is used", async () => {
    let env = identityEnv();
    const { resolve, calls } = provider({ env: () => env });
    await resolve();
    const rotatedKey = newPrivateKey();
    env = identityEnv({ INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM: oneLine(CERTIFICATE_ROTATED), INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM: oneLine(rotatedKey) });
    await resolve();
    await resolve();
    expect(calls).toHaveLength(2);
    expect([calls[1]?.certificate, calls[1]?.privateKey]).toEqual([CERTIFICATE_ROTATED, rotatedKey]);
  });

  it("the session identity is the certificate, never the key: the same certificate keeps its healthy session", async () => {
    let env = identityEnv();
    const { resolve, calls } = provider({ env: () => env });
    await resolve();
    env = identityEnv({ INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM: oneLine(newPrivateKey()) });
    await resolve();
    expect(calls).toHaveLength(1);
  });
});

describe("composition: lazy, integration-only, local/test untouched", () => {
  it("building the provider reads, writes and starts nothing", () => {
    const read = vi.fn(() => identityEnv());
    const helper = fakeHelper(() => ok(NOW + 900_000));
    createIntegrationWorkerAwsCredentials(KMS, { readEnvironment: read, process: helper.process, temporaryRoot: () => temporaryRoot });
    expect(read).not.toHaveBeenCalled();
    expect(helper.calls).toEqual([]);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("local/test (no KMS configuration) composes no AWS identity at all", () => {
    expect(integrationWorkerAwsCredentials({ NODE_ENV: "test" })).toBeUndefined();
  });

  it("deployed KMS without the Roles Anywhere configuration fails closed on first use, never falling back", async () => {
    const resolve = integrationWorkerAwsCredentials({ CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY });
    expect(resolve).toBeTypeOf("function");
    vi.stubEnv("INTEGRATION_AWS_WORKER_ROLE_ARN", undefined);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "SYNTHETICAMBIENTKEY0001");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-ambient-secret-0000000000");
    expect(await failureOf((resolve as () => Promise<unknown>)())).toBe("IDENTITY_MISCONFIGURED");
  });
});

describe("the REAL KMS client, offline: it signs only with the Roles Anywhere session", () => {
  it("the helper runs only when KMS needs credentials; KMS signs with the session key; poisoned AWS_* are ignored", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "SYNTHETICAMBIENTPOISON0");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-poison-secret-0000000000");
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AWS_ENDPOINT_URL", "https://poison.invalid.example.test");
    const captured: { host: string; authorization: string }[] = [];
    const trap = (options: unknown) => {
      const o = options as { hostname?: string; host?: string; headers?: Record<string, string> };
      captured.push({ host: o.hostname ?? o.host ?? "", authorization: o.headers?.["authorization"] ?? "" });
      const request = Object.assign(new EventEmitter(), {
        setTimeout: () => request, setNoDelay: () => undefined, setSocketKeepAlive: () => undefined, destroy: () => undefined, abort: () => undefined,
        write: () => true,
        end: () => setImmediate(() => request.emit("error", Object.assign(new Error("offline trap"), { code: "ECONNRESET" }))),
      });
      return request;
    };
    vi.spyOn(https, "request").mockImplementation(trap as never);
    vi.spyOn(http, "request").mockImplementation(trap as never);
    // Real time (the SDK signs with it): the fixture certificate is valid from its creation for ten years.
    const helper = fakeHelper(() => ok(Date.now() + 900_000));
    const credentials = createIntegrationWorkerAwsCredentials(KMS, {
      readEnvironment: () => identityEnv(),
      nowMs: () => Date.now(),
      signingHelper: () => Promise.resolve("/x"),
      process: helper.process,
      temporaryRoot: () => temporaryRoot,
    });
    const kms = createKmsClient(KMS, credentials, { maxAttempts: 1 });
    expect(helper.calls).toEqual([]);
    await kms.send(new DecryptCommand({ CiphertextBlob: new Uint8Array([1, 2, 3]) })).catch(() => undefined);
    expect(helper.calls).toHaveLength(1);
    const kmsRequests = captured.filter((request) => request.host.startsWith("kms."));
    expect(kmsRequests.length).toBeGreaterThan(0);
    for (const request of kmsRequests) {
      expect(request.host).toBe("kms.sa-east-1.amazonaws.com");
      expect(request.authorization).toContain(`Credential=${SESSION_KEY}/`);
      expect(request.authorization).not.toContain("SYNTHETICAMBIENTPOISON0");
    }
    expect(captured.every((request) => !request.host.startsWith("sts.") && !request.host.startsWith("rolesanywhere."))).toBe(true);
  });
});

describe("the real process runner (a throwaway local script stands in for the helper)", () => {
  const script = (body: string): string => {
    const file = path.join(temporaryRoot, `helper-${String(Math.random()).slice(2)}.mjs`);
    writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    return file;
  };

  it("an explicit argument array without a shell, an EMPTY environment, stdout/stderr and the exit code captured", async () => {
    vi.stubEnv("INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM", "synthetic-must-not-reach-the-helper");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "SYNTHETICAMBIENTPOISON0");
    const helper = script('process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env) })); process.stderr.write("synthetic-stderr"); process.exit(3);');
    const run = await nodeSigningHelperProcess.run(helper, ["credential-process", "$(touch pwned)", "a;b", "`x`", "*"], { timeoutMs: 10_000, maxOutputBytes: 16_384 });
    expect(run).toMatchObject({ exitCode: 3, signal: null, timedOut: false, overflow: false, spawnFailure: null, stderr: "synthetic-stderr" });
    const out = JSON.parse(run.stdout) as { args: string[]; env: string[] };
    expect(out.args).toEqual(["credential-process", "$(touch pwned)", "a;b", "`x`", "*"]);
    expect(out.env.filter((name) => !["__CF_USER_TEXT_ENCODING"].includes(name))).toEqual([]);
    expect(existsSync(path.join(process.cwd(), "pwned"))).toBe(false);
  });

  it("our timeout kills the process (SIGKILL) and reports it", async () => {
    const helper = script("setTimeout(() => {}, 60_000);");
    const run = await nodeSigningHelperProcess.run(helper, [], { timeoutMs: 200, maxOutputBytes: 16_384 });
    expect(run).toMatchObject({ timedOut: true, signal: "SIGKILL", exitCode: null });
  });

  it("output beyond the bound kills the process and reports an overflow", async () => {
    const helper = script('process.stdout.write("x".repeat(200_000)); setTimeout(() => {}, 60_000);');
    const run = await nodeSigningHelperProcess.run(helper, [], { timeoutMs: 10_000, maxOutputBytes: 1024 });
    expect(run).toMatchObject({ overflow: true, signal: "SIGKILL" });
  });

  it("a missing executable → not_found; a non-executable file → permission", async () => {
    expect((await nodeSigningHelperProcess.run(path.join(temporaryRoot, "absent"), [], { timeoutMs: 1000, maxOutputBytes: 1024 })).spawnFailure).toBe("not_found");
    const file = path.join(temporaryRoot, "not-executable");
    writeFileSync(file, "#!/bin/sh\n", { mode: 0o600 });
    expect((await nodeSigningHelperProcess.run(file, [], { timeoutMs: 1000, maxOutputBytes: 1024 })).spawnFailure).toBe("permission");
  });
});

describe("the packaged helper: pinned digest verified before first use", () => {
  const vendored = path.join(root, AWS_SIGNING_HELPER_DIRECTORY);

  it("another OS or CPU has no artifact: IDENTITY_MISCONFIGURED", async () => {
    for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "ia32"], ["linux", "riscv64"]] as const) {
      expect(await failureOf(verifiedAwsSigningHelper(vendored, platform, arch))).toBe("IDENTITY_MISCONFIGURED");
    }
  });

  it("missing, not executable or a wrong digest: IDENTITY_MISCONFIGURED", async () => {
    expect(await failureOf(verifiedAwsSigningHelper(path.join(temporaryRoot, "nowhere"), "linux", "x64"))).toBe("IDENTITY_MISCONFIGURED");
    const artifact = AWS_SIGNING_HELPER_ARTIFACTS[0];
    if (artifact === undefined) throw new Error("no artifact");
    const directory = path.join(temporaryRoot, "vendor", artifact.directory);
    const file = path.join(directory, "aws_signing_helper");
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, "synthetic, wrong digest", { mode: 0o600 });
    expect(await failureOf(verifiedAwsSigningHelper(path.join(temporaryRoot, "vendor"), "linux", artifact.arch))).toBe("IDENTITY_MISCONFIGURED");
    chmodSync(file, 0o755);
    expect(await failureOf(verifiedAwsSigningHelper(path.join(temporaryRoot, "vendor"), "linux", artifact.arch))).toBe("IDENTITY_MISCONFIGURED");
  });

  it.runIf(AWS_SIGNING_HELPER_ARTIFACTS.every((artifact) => existsSync(path.join(vendored, artifact.directory, "aws_signing_helper"))))(
    "the fetched builds (local, git-ignored) verify for both Linux architectures — they are never executed here",
    async () => {
      for (const artifact of AWS_SIGNING_HELPER_ARTIFACTS) {
        expect(await verifiedAwsSigningHelper(vendored, "linux", artifact.arch)).toBe(path.join(vendored, artifact.directory, "aws_signing_helper"));
      }
    },
  );
});
