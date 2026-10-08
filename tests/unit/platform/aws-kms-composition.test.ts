/**
 * Step 7D — KMS runtime composition and configuration contract (TA §39, ADR-64). Offline: no request is sent to
 * AWS. A KMSClient is constructed only to prove its configuration (region from the key ARN, the injected identity,
 * no default credential chain, no configured endpoint override); `send` is never called on it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { inspect } from "node:util";
import type { DecryptCommand, DecryptCommandOutput, GenerateDataKeyCommand, GenerateDataKeyCommandOutput } from "@aws-sdk/client-kms";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialCodecError, CredentialUnreadableError } from "@/modules/connections";
import { NonRetryableJobError } from "@/platform/jobs";
import { decrypt, encrypt } from "@/platform/crypto/credentials/aead";
import { createKmsClient } from "@/platform/crypto/credentials/aws-kms-client";
import { KMS_PROVIDER_CREDENTIALS_KEY_REF, kmsKeyArnRegion, parseKmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";
import { kmsCredentialOpener } from "@/platform/crypto/credentials/aws-kms-opener";
import { kmsCredentialSealer } from "@/platform/crypto/credentials/aws-kms-sealer";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { encodeEnvelope } from "@/platform/crypto/credentials/envelope";
import { CREDENTIAL_CRYPTO_ERROR_CODES, CredentialCryptoError, type CredentialCryptoErrorCode } from "@/platform/crypto/credentials/errors";
import { isLogicalKeyRef } from "@/platform/crypto/credentials/key-ref";
import { LOCAL_KEYRING_KEY_ENV } from "@/platform/crypto/credentials/local-sealer";
import type { CredentialOpener } from "@/platform/crypto/credentials/open";
import { composeCredentialOpener, createCredentialAccess, credentialAccessFailure } from "@/jobs/connections";
import { composeCredentialSealer } from "@/server/connections/credential-crypto";
import { credentialEnvironmentLabel, readKmsKeyringConfig, selectCredentialCrypto } from "@/server/connections/environment";

const KEY_A = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const KEY_B = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000bb";
const KEY_OTHER_REGION = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-4000-8000-0000000000cc";
const SECRET = `synthetic-secret-${randomUUID()}`;
const WORKSPACE = randomUUID();
const CREDENTIAL = randomUUID();

const kmsEnvironment = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  CREDENTIAL_CONTEXT_ENV: "dev",
  CREDENTIAL_KMS_KEY_ARN: KEY_A,
  CREDENTIAL_KMS_ALLOWED_KEY_ARNS: `${KEY_A}, ${KEY_B}`,
  ...overrides,
});
const syntheticIdentity = () => vi.fn(() => Promise.resolve({ accessKeyId: "SYNTHETICACCESSKEY", secretAccessKey: SECRET }));

function codeOf(fn: () => unknown): CredentialCryptoErrorCode {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialCryptoError);
    return (error as CredentialCryptoError).code;
  }
  throw new Error("expected a CredentialCryptoError");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("7D.2 · KMS keyring configuration (pure)", () => {
  it("a valid dev configuration: logical keyRef constant, region from the ARN, immutable allowlist", () => {
    const config = parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY_A, allowedKeyArns: ` ${KEY_A} ,${KEY_B}` });
    expect(config).toMatchObject({ contextEnv: "dev", logicalKeyRef: "kms-provider-credentials-v1", currentKeyArn: KEY_A, region: "sa-east-1" });
    expect([...config.allowedKeyArns]).toEqual([KEY_A, KEY_B]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => (config.allowedKeyArns as Set<string>).add(KEY_OTHER_REGION)).toThrow();
    expect(() => (config.allowedKeyArns as Set<string>).delete(KEY_A)).toThrow();
    expect(KMS_PROVIDER_CREDENTIALS_KEY_REF).toBe("kms-provider-credentials-v1");
    expect(isLogicalKeyRef(KMS_PROVIDER_CREDENTIALS_KEY_REF)).toBe(true);
  });

  it("the region is derived from a full key ARN only", () => {
    expect(kmsKeyArnRegion(KEY_A)).toBe("sa-east-1");
    expect(kmsKeyArnRegion(KEY_OTHER_REGION)).toBe("us-east-1");
    for (const bad of ["alias/x", "arn:aws:kms:sa-east-1:000000000000:alias/x", "00000000-0000-4000-8000-0000000000aa", "", undefined]) {
      expect(codeOf(() => kmsKeyArnRegion(bad))).toBe("KEYRING_MISCONFIGURED");
    }
  });

  it.each([
    ["malformed current ARN", { currentKeyArn: "arn:aws:kms:sa-east-1:000000000000:key/not-a-key" }],
    ["alias as current key", { currentKeyArn: "alias/social-intelligence-platform-dev-provider-credentials" }],
    ["bare key ID as current key", { currentKeyArn: "00000000-0000-4000-8000-0000000000aa", allowedKeyArns: "00000000-0000-4000-8000-0000000000aa" }],
    ["empty allowlist", { allowedKeyArns: "" }],
    ["empty allowlist entry", { allowedKeyArns: `${KEY_A},,${KEY_B}` }],
    ["trailing comma", { allowedKeyArns: `${KEY_A},` }],
    ["duplicate allowlist entry", { allowedKeyArns: `${KEY_A}, ${KEY_A}` }],
    ["current key not allowed", { allowedKeyArns: KEY_B }],
    ["allowed key in another region", { allowedKeyArns: `${KEY_A},${KEY_OTHER_REGION}` }],
    ["alias in the allowlist", { allowedKeyArns: `${KEY_A},alias/x` }],
    ["local context env", { contextEnv: "local" }],
    ["test context env", { contextEnv: "test" }],
    ["unknown context env", { contextEnv: "prod" }],
    ["missing context env", { contextEnv: undefined }],
  ])("%s → KEYRING_MISCONFIGURED, no configured value in the error", (_label, patch) => {
    let caught: unknown;
    try {
      parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY_A, allowedKeyArns: `${KEY_A},${KEY_B}`, ...patch });
    } catch (error) {
      caught = error;
    }
    expect((caught as CredentialCryptoError).code).toBe("KEYRING_MISCONFIGURED");
    const rendered = `${String(caught)} ${JSON.stringify(caught)} ${inspect(caught)}`;
    for (const value of [KEY_A, KEY_B, KEY_OTHER_REGION, "000000000000", "sa-east-1", "alias/"]) expect(rendered.includes(value), value).toBe(false);
  });
});

describe("7D.3 · composition-boundary reader", () => {
  it("all three present → the parsed configuration; none (or all empty) → not configured", () => {
    expect(readKmsKeyringConfig(kmsEnvironment())?.currentKeyArn).toBe(KEY_A);
    expect(readKmsKeyringConfig({ NODE_ENV: "production" })).toBeUndefined();
    expect(readKmsKeyringConfig({ CREDENTIAL_CONTEXT_ENV: "", CREDENTIAL_KMS_KEY_ARN: "", CREDENTIAL_KMS_ALLOWED_KEY_ARNS: "" })).toBeUndefined();
  });

  it.each(["CREDENTIAL_CONTEXT_ENV", "CREDENTIAL_KMS_KEY_ARN", "CREDENTIAL_KMS_ALLOWED_KEY_ARNS"])("%s missing (or empty) while the others are set → incomplete, refused", (name) => {
    expect(codeOf(() => readKmsKeyringConfig(kmsEnvironment({ [name]: undefined })))).toBe("KEYRING_MISCONFIGURED");
    expect(codeOf(() => readKmsKeyringConfig(kmsEnvironment({ [name]: "" })))).toBe("KEYRING_MISCONFIGURED");
  });

  it("no AWS_REGION and no AWS credential variable is consulted", () => {
    const ambient = { AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AMBIENTKEY", AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: SECRET, AWS_PROFILE: "ambient" };
    expect(readKmsKeyringConfig(kmsEnvironment(ambient))).toEqual(readKmsKeyringConfig(kmsEnvironment()));
    expect(readKmsKeyringConfig(kmsEnvironment(ambient))?.region).toBe("sa-east-1");
  });
});

describe("7D.6 · local vs deployed selection", () => {
  const localKey = (): string => randomBytes(32).toString("base64url");

  it("test and development without KMS configuration keep the local keyring", () => {
    expect(selectCredentialCrypto({ NODE_ENV: "test" })).toEqual({ kind: "local", contextEnv: "test" });
    expect(selectCredentialCrypto({ NODE_ENV: "development" })).toEqual({ kind: "local", contextEnv: "local" });
    expect(credentialEnvironmentLabel({ NODE_ENV: "test" })).toBe("test");
  });

  it("a deployed runtime without KMS configuration is refused — never the local keyring, even if a local key is present", () => {
    for (const environment of [{ NODE_ENV: "production" }, {}, { NODE_ENV: "staging" }, { NODE_ENV: "production", [LOCAL_KEYRING_KEY_ENV]: localKey() }, { NODE_ENV: "production", APP_DEPLOYMENT_ENV: "preview" }]) {
      expect(codeOf(() => selectCredentialCrypto(environment))).toBe("KEYRING_MISCONFIGURED");
    }
  });

  it("KMS configuration selects KMS (context env dev) wherever it is complete; a local key alongside it is refused", () => {
    const selection = selectCredentialCrypto(kmsEnvironment());
    expect(selection.kind).toBe("kms");
    expect(credentialEnvironmentLabel(kmsEnvironment())).toBe("dev");
    expect(selectCredentialCrypto(kmsEnvironment({ NODE_ENV: "development" })).kind).toBe("kms");
    expect(codeOf(() => selectCredentialCrypto(kmsEnvironment({ [LOCAL_KEYRING_KEY_ENV]: localKey() })))).toBe("KEYRING_MISCONFIGURED");
    expect(codeOf(() => selectCredentialCrypto(kmsEnvironment({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: localKey() })))).toBe("KEYRING_MISCONFIGURED");
  });
});

describe("7D.4 · KMS client factory (offline)", () => {
  const config = () => parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY_A, allowedKeyArns: `${KEY_A},${KEY_B}` });

  it("region from the key ARN; the injected identity reaches the client; ambient AWS variables are ignored; no request", async () => {
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AMBIENTACCESSKEY");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
    vi.stubEnv("AWS_ENDPOINT_URL_KMS", "https://kms.invalid.example.test");
    const requests = [vi.spyOn(http, "request"), vi.spyOn(https, "request"), vi.spyOn(globalThis, "fetch")];
    const identity = syntheticIdentity();
    const client = createKmsClient(config(), identity);
    try {
      expect(identity).not.toHaveBeenCalled();
      expect(await client.config.region()).toBe("sa-east-1");
      expect((await client.config.credentials()).accessKeyId).toBe("SYNTHETICACCESSKEY");
      expect(identity).toHaveBeenCalledTimes(1);
      expect(client.config.ignoreConfiguredEndpointUrls).toBe(true);
      for (const request of requests) expect(request).not.toHaveBeenCalled();
    } finally {
      client.destroy();
    }
  });

  it("without an explicitly supplied identity, or with a forged region, no client is built", () => {
    expect(codeOf(() => createKmsClient(config(), undefined))).toBe("KEYRING_MISCONFIGURED");
    expect(codeOf(() => createKmsClient({ ...config(), region: "us-east-1" }, syntheticIdentity()))).toBe("KEYRING_MISCONFIGURED");
  });
});

describe("7D.5 · credential-crypto composition", () => {
  it("web/seal side: the local sealer in test; a KMS sealer (seal only) where KMS is configured", () => {
    const local = composeCredentialSealer({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: randomBytes(32).toString("base64url") });
    expect(local.contextEnv).toBe("test");
    expect(Object.keys(local.sealer)).toEqual(["seal"]);
    const kms = composeCredentialSealer(kmsEnvironment(), syntheticIdentity());
    expect(kms.contextEnv).toBe("dev");
    expect(Object.keys(kms.sealer)).toEqual(["seal"]);
    expect(Object.keys(kms).sort()).toEqual(["contextEnv", "sealer"]);
  });

  it("integration worker: the local opener in test; a KMS opener where KMS is configured", () => {
    const local = composeCredentialOpener({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: randomBytes(32).toString("base64url") });
    expect(local.contextEnv).toBe("test");
    expect(Object.keys(local.opener)).toEqual(["open"]);
    const kms = composeCredentialOpener(kmsEnvironment(), syntheticIdentity());
    expect(kms.contextEnv).toBe("dev");
    expect(Object.keys(kms.opener)).toEqual(["open"]);
  });

  it("KMS-configured composition without an AWS identity fails closed (none exists before 7E); never a local fallback", () => {
    const withLocalKeyAbsent = kmsEnvironment();
    expect(codeOf(() => composeCredentialSealer(withLocalKeyAbsent))).toBe("KEYRING_MISCONFIGURED");
    expect(codeOf(() => composeCredentialOpener(withLocalKeyAbsent))).toBe("KEYRING_MISCONFIGURED");
    expect(codeOf(() => composeCredentialSealer({ NODE_ENV: "production" }, syntheticIdentity()))).toBe("KEYRING_MISCONFIGURED");
    expect(codeOf(() => composeCredentialOpener({ NODE_ENV: "production" }, syntheticIdentity()))).toBe("KEYRING_MISCONFIGURED");
  });

  it("KMS sealer and opener interoperate through injected senders (no client): same logical keyRef, context env dev", async () => {
    const physical = randomBytes(32);
    const aad = (context: Record<string, string> | undefined): Buffer => Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()), "utf8");
    const generate = {
      send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput> {
        const dek = new Uint8Array(randomBytes(32));
        const sealed = encrypt(physical, dek, aad(command.input.EncryptionContext));
        return Promise.resolve({ Plaintext: dek, CiphertextBlob: new Uint8Array(Buffer.concat([sealed.iv, sealed.ciphertext, sealed.authTag])), KeyId: KEY_A, $metadata: {} });
      },
    };
    const decryptSender = {
      send(command: DecryptCommand): Promise<DecryptCommandOutput> {
        const blob = Buffer.from(command.input.CiphertextBlob ?? new Uint8Array(0));
        const dek = decrypt(physical, { iv: blob.subarray(0, 12), ciphertext: blob.subarray(12, 44), authTag: blob.subarray(44) }, aad(command.input.EncryptionContext));
        return Promise.resolve({ Plaintext: new Uint8Array(dek), KeyId: KEY_A, $metadata: {} });
      },
    };
    const config = parseKmsKeyringConfig({ contextEnv: "dev", currentKeyArn: KEY_A, allowedKeyArns: KEY_A });
    const context = credentialContext({ purpose: "provider-credential", env: config.contextEnv, workspaceId: WORKSPACE, credentialId: CREDENTIAL });
    const envelope = await kmsCredentialSealer(generate, config).seal(new Uint8Array(Buffer.from("SIP-7D-SYNTHETIC", "utf8")), context);
    expect(envelope).toMatchObject({ kekProvider: "aws-kms", keyRef: "kms-provider-credentials-v1" });
    expect(Buffer.from(encodeEnvelope(envelope)).toString("latin1").includes(KEY_A)).toBe(false);
    expect(await kmsCredentialOpener(decryptSender, config).open(envelope, context, (p) => Buffer.from(p).toString("utf8"))).toBe("SIP-7D-SYNTHETIC");
  });
});

describe("7D.8 · job credential-access failures", () => {
  const failingOpener = (error: unknown): CredentialOpener => ({ open: () => Promise.reject(error instanceof Error ? error : new Error("unexpected")) });
  const envelopeBytes = (): Uint8Array =>
    encodeEnvelope({ formatVersion: 1, algorithm: "AES-256-GCM", kekProvider: "local", keyRef: "local-v1", contextVersion: 1, wrappedDek: new Uint8Array(60).fill(1), iv: new Uint8Array(12), ciphertext: new Uint8Array(4), authTag: new Uint8Array(16) });

  it.each([
    ["KEYRING_UNAVAILABLE", "retryable"],
    ["KEYRING_ACCESS_DENIED", "operational:credential_keyring_access_denied"],
    ["KEYRING_MISCONFIGURED", "operational:credential_keyring_misconfigured"],
    ["INTEGRITY_FAILURE", "unreadable"],
    ["KEYRING_MISMATCH", "unreadable"],
    ["MALFORMED_ENVELOPE", "unreadable"],
    ["UNSUPPORTED_ENVELOPE_VERSION", "unreadable"],
    ["LOCAL_KEYRING_FORBIDDEN", "operational:credential_keyring_misconfigured"],
    ["INVALID_LOCAL_KEY_CONFIGURATION", "operational:credential_keyring_misconfigured"],
  ] as const)("%s → %s", async (code, expected) => {
    const access = createCredentialAccess(failingOpener(new CredentialCryptoError(code)), "test");
    const error = await access.withCredential({ workspaceId: WORKSPACE as never, credentialId: CREDENTIAL, envelope: envelopeBytes() }, () => Promise.resolve(0)).then(() => undefined, (e: unknown) => e);
    if (expected === "retryable") {
      expect(error).toBeInstanceOf(CredentialCryptoError);
      expect(error).not.toBeInstanceOf(NonRetryableJobError);
    } else if (expected === "unreadable") {
      expect(error).toBeInstanceOf(CredentialUnreadableError);
    } else {
      expect(error).toBeInstanceOf(NonRetryableJobError);
      expect((error as NonRetryableJobError).failureClass).toBe(expected.slice("operational:".length));
    }
    expect(`${String(error)} ${JSON.stringify(error)}`.includes(SECRET)).toBe(false);
  });

  it("every credential-crypto code has a decided disposition; access denied and misconfiguration are never 'unreadable'", () => {
    for (const code of CREDENTIAL_CRYPTO_ERROR_CODES) {
      const mapped = credentialAccessFailure(new CredentialCryptoError(code));
      expect(mapped instanceof CredentialCryptoError || mapped instanceof CredentialUnreadableError || mapped instanceof NonRetryableJobError, code).toBe(true);
    }
    for (const code of ["KEYRING_ACCESS_DENIED", "KEYRING_MISCONFIGURED"] as const) {
      expect(credentialAccessFailure(new CredentialCryptoError(code))).not.toBeInstanceOf(CredentialUnreadableError);
    }
  });

  it("codec failures stay unreadable; anything that isn't a credential-crypto error passes through untouched", () => {
    expect(credentialAccessFailure(new CredentialCodecError())).toBeInstanceOf(CredentialUnreadableError);
    const other = new Error(SECRET);
    expect(credentialAccessFailure(other)).toBe(other);
  });
});
