/**
 * Step 7E.2 — AWS runtime-identity source contract (TA §39, ADR-64). Offline: no AWS, Vercel or Trigger.dev call and
 * no token. Synthetic role ARNs use account 000000000000. The identity provider is a synthetic stand-in for the
 * future Vercel OIDC adapter (7E.3); it proves only the seam (explicit, lazy, request-time resolution).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AWS_IDENTITY_FAILURES, AWS_STS_OIDC_AUDIENCE, AwsIdentityError, isIamRoleArn, parseIamRoleArn, type AwsCredentialProvider } from "@/platform/aws/identity";
import { createKmsClient } from "@/platform/crypto/credentials/aws-kms-client";
import { kmsErrorCode } from "@/platform/crypto/credentials/aws-kms-common";
import { parseKmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";
import { kmsCredentialSealer } from "@/platform/crypto/credentials/aws-kms-sealer";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { CredentialCryptoError, isRetryableCredentialCryptoError, type CredentialCryptoErrorCode } from "@/platform/crypto/credentials/errors";
import { LOCAL_KEYRING_KEY_ENV } from "@/platform/crypto/credentials/local-sealer";
import { composeCredentialSealer } from "@/server/connections/credential-crypto";
import { composeWebAwsCredentials, readWebAwsIdentityConfig, type WebAwsIdentityFactory } from "@/server/connections/web-identity";

const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-web-encrypt";
const KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const SECRET = `synthetic-secret-${randomUUID()}`;

const kmsWebEnvironment = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  CREDENTIAL_CONTEXT_ENV: "dev",
  CREDENTIAL_KMS_KEY_ARN: KEY,
  CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY,
  CREDENTIAL_KMS_WEB_ROLE_ARN: ROLE,
  ...overrides,
});
const syntheticProvider = () => vi.fn<AwsCredentialProvider>(() => Promise.resolve({ accessKeyId: "SYNTHETICACCESSKEY", secretAccessKey: SECRET, sessionToken: "synthetic-session" }));

function cryptoCodeOf(fn: () => unknown): CredentialCryptoErrorCode {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialCryptoError);
    return (error as CredentialCryptoError).code;
  }
  throw new Error("expected a CredentialCryptoError");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("7E.2.3 · IAM role ARN", () => {
  it.each([
    ROLE,
    "arn:aws:iam::000000000000:role/service-role/sip/web-encrypt",
    "arn:aws-us-gov:iam::000000000000:role/web-encrypt",
    "arn:aws:iam::000000000000:role/a+b=c,d.e@f_g-h",
  ])("accepts a full role ARN: %s", (arn) => {
    expect(isIamRoleArn(arn)).toBe(true);
    expect(parseIamRoleArn(arn)).toBe(arn);
  });

  it.each([
    ["empty", ""],
    ["not a string", 42],
    ["user ARN", "arn:aws:iam::000000000000:user/sip-dev-worker-bootstrap"],
    ["assumed-role ARN", "arn:aws:sts::000000000000:assumed-role/web-encrypt/session"],
    ["root ARN", "arn:aws:iam::000000000000:root"],
    ["policy ARN", "arn:aws:iam::000000000000:policy/web-guard"],
    ["role with a region", "arn:aws:iam:sa-east-1:000000000000:role/web-encrypt"],
    ["short account", "arn:aws:iam::00000000:role/web-encrypt"],
    ["empty role name", "arn:aws:iam::000000000000:role/"],
    ["role name too long", `arn:aws:iam::000000000000:role/${"r".repeat(65)}`],
    ["role name with a space", "arn:aws:iam::000000000000:role/web encrypt"],
    ["role name only", "web-encrypt"],
    ["KMS key ARN", KEY],
  ])("refuses %s", (_label, value) => {
    expect(isIamRoleArn(value)).toBe(false);
    let caught: unknown;
    try {
      parseIamRoleArn(value);
    } catch (error) {
      caught = error;
    }
    expect((caught as AwsIdentityError).failure).toBe("IDENTITY_MISCONFIGURED");
    if (typeof value === "string" && value !== "") expect(`${String(caught)} ${JSON.stringify(caught)} ${inspect(caught)}`.includes(value)).toBe(false);
  });
});

describe("7E.2.4 · STS audience", () => {
  it("is exactly sts.amazonaws.com — never the https:// form", () => {
    expect(AWS_STS_OIDC_AUDIENCE).toBe("sts.amazonaws.com");
    expect(AWS_STS_OIDC_AUDIENCE).not.toBe("https://sts.amazonaws.com");
    expect(AWS_STS_OIDC_AUDIENCE.startsWith("https://")).toBe(false);
  });
});

describe("7E.2.5 · identity failures → keyring outcomes", () => {
  it.each([
    ["IDENTITY_UNAVAILABLE", "KEYRING_UNAVAILABLE", true],
    ["IDENTITY_ACCESS_DENIED", "KEYRING_ACCESS_DENIED", false],
    ["IDENTITY_MISCONFIGURED", "KEYRING_MISCONFIGURED", false],
  ] as const)("%s → %s (retryable: %s)", (failure, code, retryable) => {
    expect(kmsErrorCode(new AwsIdentityError(failure))).toBe(code);
    expect(isRetryableCredentialCryptoError(new CredentialCryptoError(code))).toBe(retryable);
  });

  it("identity errors are fixed, value-free and carry nothing underneath", () => {
    expect([...AWS_IDENTITY_FAILURES]).toEqual(["IDENTITY_UNAVAILABLE", "IDENTITY_ACCESS_DENIED", "IDENTITY_MISCONFIGURED"]);
    for (const failure of AWS_IDENTITY_FAILURES) {
      const error = new AwsIdentityError(failure);
      expect(error.message).toBe(`aws_identity_${failure.toLowerCase()}`);
      expect(JSON.stringify(error)).toBe(JSON.stringify({ failure }));
      expect(error.cause).toBeUndefined();
    }
  });

  it("an identity failure raised while a KMS operation resolves credentials surfaces as the keyring code only", async () => {
    const config = parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY, allowedKeyArns: KEY });
    const context = credentialContext({ purpose: "provider-credential", env: "dev", workspaceId: randomUUID(), credentialId: randomUUID() });
    for (const [failure, code] of [["IDENTITY_UNAVAILABLE", "KEYRING_UNAVAILABLE"], ["IDENTITY_ACCESS_DENIED", "KEYRING_ACCESS_DENIED"], ["IDENTITY_MISCONFIGURED", "KEYRING_MISCONFIGURED"]] as const) {
      // Like the SDK: `send` first resolves credentials; the identity adapter rejects with its normalized error.
      const provider: AwsCredentialProvider = () => Promise.reject(new AwsIdentityError(failure));
      const sender = { send: () => provider().then(() => Promise.reject(new Error("unreachable"))) };
      const error = await kmsCredentialSealer(sender, config).seal(new Uint8Array([1, 2, 3]), context).then(() => undefined, (e: unknown) => e);
      expect((error as CredentialCryptoError).code).toBe(code);
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/aws_identity|IDENTITY_/);
    }
  });
});

describe("7E.2.3/7E.2.6 · web identity seam", () => {
  it("reads the web role ARN: unset (or empty) → none; valid → role + the fixed audience; malformed → refused, never echoed", () => {
    expect(readWebAwsIdentityConfig({})).toBeUndefined();
    expect(readWebAwsIdentityConfig({ CREDENTIAL_KMS_WEB_ROLE_ARN: "" })).toBeUndefined();
    expect(readWebAwsIdentityConfig({ CREDENTIAL_KMS_WEB_ROLE_ARN: ROLE })).toEqual({ roleArn: ROLE, audience: "sts.amazonaws.com" });
    const bad = "arn:aws:iam::000000000000:user/not-a-role";
    let caught: unknown;
    try {
      readWebAwsIdentityConfig({ CREDENTIAL_KMS_WEB_ROLE_ARN: bad });
    } catch (error) {
      caught = error;
    }
    expect((caught as CredentialCryptoError).code).toBe("KEYRING_MISCONFIGURED");
    expect(`${String(caught)} ${JSON.stringify(caught)}`.includes(bad)).toBe(false);
  });

  it("the factory receives the configuration (STS region = the KMS key's region) and returns a provider; nothing is resolved", () => {
    const provider = syntheticProvider();
    const factory = vi.fn<WebAwsIdentityFactory>(() => provider);
    expect(composeWebAwsCredentials(kmsWebEnvironment(), factory)).toBe(provider);
    expect(factory).toHaveBeenCalledWith({ roleArn: ROLE, audience: "sts.amazonaws.com", stsRegion: "sa-east-1" });
    expect(provider).not.toHaveBeenCalled();
    expect(composeWebAwsCredentials(kmsWebEnvironment(), undefined)).toBeUndefined();
    expect(composeWebAwsCredentials(kmsWebEnvironment({ CREDENTIAL_KMS_WEB_ROLE_ARN: undefined }), factory)).toBeUndefined();
  });

  it("KMS-configured web sealing with an explicit identity composes a sealer (seal only) without resolving credentials", () => {
    const provider = syntheticProvider();
    const environment = kmsWebEnvironment();
    const composed = composeCredentialSealer(environment, composeWebAwsCredentials(environment, () => provider));
    expect(composed.contextEnv).toBe("dev");
    expect(Object.keys(composed.sealer)).toEqual(["seal"]);
    expect(provider).not.toHaveBeenCalled();
  });

  it("KMS-configured web sealing without an identity fails closed — no adapter, or no role ARN", () => {
    expect(cryptoCodeOf(() => composeCredentialSealer(kmsWebEnvironment(), composeWebAwsCredentials(kmsWebEnvironment(), undefined)))).toBe("KEYRING_MISCONFIGURED");
    const noRole = kmsWebEnvironment({ CREDENTIAL_KMS_WEB_ROLE_ARN: undefined });
    expect(cryptoCodeOf(() => composeCredentialSealer(noRole, composeWebAwsCredentials(noRole, () => syntheticProvider())))).toBe("KEYRING_MISCONFIGURED");
  });

  it("local/test sealing needs no AWS identity", () => {
    const environment = { NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: randomBytes(32).toString("base64url") };
    const composed = composeCredentialSealer(environment, composeWebAwsCredentials(environment, undefined));
    expect(composed.contextEnv).toBe("test");
    expect(Object.keys(composed.sealer)).toEqual(["seal"]);
  });
});

describe("7E.2.7 · credentials stay lazy until an AWS operation needs them", () => {
  const config = () => parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY, allowedKeyArns: KEY });

  it("constructing the KMS client does not resolve credentials; explicit resolution does, once", async () => {
    const provider = syntheticProvider();
    const client = createKmsClient(config(), provider);
    try {
      expect(provider).not.toHaveBeenCalled();
      expect((await client.config.credentials()).accessKeyId).toBe("SYNTHETICACCESSKEY");
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
    }
  });

  it("with a fake AWS operation, credentials are first resolved when the seal runs — not at composition", async () => {
    const provider = syntheticProvider();
    const sender = {
      async send() {
        await provider();
        throw new AwsIdentityError("IDENTITY_UNAVAILABLE");
      },
    };
    const sealer = kmsCredentialSealer(sender, config());
    expect(provider).not.toHaveBeenCalled();
    const context = credentialContext({ purpose: "provider-credential", env: "dev", workspaceId: randomUUID(), credentialId: randomUUID() });
    await sealer.seal(new Uint8Array([1]), context).catch(() => undefined);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
