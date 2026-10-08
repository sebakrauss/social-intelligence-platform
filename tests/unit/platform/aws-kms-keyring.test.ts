/**
 * Step 7C — AWS KMS keyring adapter (TA §39, ADR-64). No AWS access: every KMS call goes to an in-memory fake that
 * behaves like symmetric KMS (the physical key travels inside the ciphertext blob; the encryption context
 * authenticates the data key; Decrypt needs no KeyId). The real SDK is used only for its command classes and
 * exception classes — no client is constructed, and no credentials, region or endpoint exist in this test.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import * as kmsSdk from "@aws-sdk/client-kms";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  InvalidCiphertextException,
  KMSServiceException,
  type DecryptCommandOutput,
  type GenerateDataKeyCommandOutput,
  type KMSClient,
} from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/platform/crypto/credentials/aead";
import { isKmsKeyArn, kmsEncryptionContext, kmsErrorCode } from "@/platform/crypto/credentials/aws-kms-common";
import { createKmsDataKeyGenerator, type KmsGenerateDataKeySender } from "@/platform/crypto/credentials/aws-kms-generator";
import { createKmsDataKeyUnwrapper, type KmsDecryptSender } from "@/platform/crypto/credentials/aws-kms-unwrapper";
import { CREDENTIAL_CONTEXT_FIELDS, credentialContext, type CredentialContext } from "@/platform/crypto/credentials/context";
import { encodeEnvelope, type EnvelopeV1 } from "@/platform/crypto/credentials/envelope";
import { CREDENTIAL_CRYPTO_ERROR_CODES, CREDENTIAL_CRYPTO_RETRYABLE, CredentialCryptoError, isRetryableCredentialCryptoError, type CredentialCryptoErrorCode } from "@/platform/crypto/credentials/errors";
import type { DataKeyBinding } from "@/platform/crypto/credentials/keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";

const LOGICAL = "kms-provider-credentials-v1";
const ARN_OLD = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const ARN_NEW = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000bb";
const ARN_FOREIGN = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000cc";
const SECRET = `raw-aws-detail-${randomUUID()}`;
const MARKER = `SIP-SYNTHETIC-KMS-CREDENTIAL-${randomUUID()}`;
const WORKSPACE = randomUUID();
const CREDENTIAL = randomUUID();

const ctx = (overrides: Partial<{ workspaceId: string; credentialId: string; env: string }> = {}): CredentialContext =>
  credentialContext({ purpose: "provider-credential", env: overrides.env ?? "dev", workspaceId: overrides.workspaceId ?? WORKSPACE, credentialId: overrides.credentialId ?? CREDENTIAL });
const markerBytes = (): Uint8Array => new Uint8Array(Buffer.from(MARKER, "utf8"));
const KMS_HEADER = { kekProvider: "aws-kms", keyRef: LOGICAL } as const;

async function codeOf(promise: Promise<unknown>): Promise<CredentialCryptoErrorCode | "no-error"> {
  const error = await promise.then(() => "no-error" as const, (e: unknown) => e);
  if (error === "no-error") return error;
  expect(error).toBeInstanceOf(CredentialCryptoError);
  return (error as CredentialCryptoError).code;
}

function codeOfSync(fn: () => unknown): CredentialCryptoErrorCode {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialCryptoError);
    return (error as CredentialCryptoError).code;
  }
  throw new Error("expected a CredentialCryptoError");
}

/**
 * A symmetric-KMS fake: each physical key is 32 random bytes; the blob is [arn length][arn][iv|ct|tag] of the data
 * key under AES-GCM with the canonical encryption context as AAD. Decrypt reads the physical key from the blob and
 * refuses a request that names a KeyId (the adapter must never send one).
 */
function fakeKms() {
  const physical = new Map<string, Buffer>([[ARN_OLD, randomBytes(32)], [ARN_NEW, randomBytes(32)], [ARN_FOREIGN, randomBytes(32)]]);
  const sent: (GenerateDataKeyCommand | DecryptCommand)[] = [];
  const handedOut: Uint8Array[] = [];
  const aad = (context: Record<string, string> | undefined): Buffer => Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()), "utf8");
  const wrap = (arn: string, dek: Uint8Array, context: Record<string, string> | undefined): Uint8Array => {
    const sealed = encrypt(physical.get(arn) ?? Buffer.alloc(0), dek, aad(context));
    const id = Buffer.from(arn, "ascii");
    return new Uint8Array(Buffer.concat([Buffer.from([id.length]), id, sealed.iv, sealed.ciphertext, sealed.authTag]));
  };
  const unwrap = (blob: Uint8Array, context: Record<string, string> | undefined): { arn: string; dek: Buffer } => {
    const bytes = Buffer.from(blob);
    const arn = bytes.toString("ascii", 1, 1 + (bytes[0] ?? 0));
    const body = bytes.subarray(1 + (bytes[0] ?? 0));
    const key = physical.get(arn);
    try {
      if (key === undefined || body.length !== 60) throw new Error("bad blob");
      return { arn, dek: decrypt(key, { iv: body.subarray(0, 12), ciphertext: body.subarray(12, 44), authTag: body.subarray(44) }, aad(context)) };
    } catch {
      throw new InvalidCiphertextException({ message: `${SECRET} context mismatch`, $metadata: { httpStatusCode: 400 } });
    }
  };
  const generate: KmsGenerateDataKeySender = {
    send(command) {
      sent.push(command);
      const input = command.input;
      const arn = input.KeyId ?? "";
      if (!physical.has(arn)) return Promise.reject(new kmsSdk.NotFoundException({ message: SECRET, $metadata: {} }));
      const dek = new Uint8Array(randomBytes(32));
      handedOut.push(dek);
      return Promise.resolve({ Plaintext: dek, CiphertextBlob: wrap(arn, dek, input.EncryptionContext), KeyId: arn, $metadata: {} });
    },
  };
  const decryptSender: KmsDecryptSender = {
    send(command) {
      sent.push(command);
      const input = command.input;
      return Promise.resolve().then(() => {
        if ("KeyId" in input) throw new Error("a symmetric Decrypt must not name a KeyId");
        const { arn, dek } = unwrap(input.CiphertextBlob ?? new Uint8Array(0), input.EncryptionContext);
        const plaintext = new Uint8Array(dek);
        dek.fill(0);
        handedOut.push(plaintext);
        return { Plaintext: plaintext, KeyId: arn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" as const, $metadata: {} };
      });
    },
  };
  /** Operator-only re-wrap (ReEncrypt-like), same context on both sides. */
  const reWrap = (blob: Uint8Array, context: Record<string, string>, to: string): Uint8Array => {
    const { dek } = unwrap(blob, context);
    try {
      return wrap(to, dek, context);
    } finally {
      dek.fill(0);
    }
  };
  return { generate, decryptSender, sent, handedOut, reWrap };
}

/** A sender that answers with a fixed (possibly malformed) output, recording what it was asked. */
function scripted<Out>(output: () => Out) {
  const sent: unknown[] = [];
  const outputs: Out[] = [];
  return {
    sent,
    outputs,
    send(command: unknown): Promise<Out> {
      sent.push(command);
      const value = output();
      outputs.push(value);
      return Promise.resolve(value);
    },
  };
}

/** A sender that fails with exactly `error` — including non-Error values, to prove fail-closed normalization. */
const failing = (error: unknown) => ({
  send: (): Promise<never> =>
    Promise.resolve().then(() => {
      throw error;
    }),
});
const zeroed = (bytes: Uint8Array | undefined): boolean => bytes !== undefined && bytes.every((b) => b === 0);

describe("7C.5 · exact encryption context", () => {
  it("the six context fields, as strings, in canonical order — nothing else", () => {
    const map = kmsEncryptionContext(ctx());
    expect(map).toEqual({ app: "social-intelligence-platform", purpose: "provider-credential", env: "dev", v: "1", workspace_id: WORKSPACE, credential_id: CREDENTIAL });
    expect(Object.keys(map)).toEqual([...CREDENTIAL_CONTEXT_FIELDS]);
    expect(Object.values(map).every((value) => typeof value === "string")).toBe(true);
    expect(Object.isFrozen(map)).toBe(true);
  });

  it("an invalid or widened context is refused before any mapping", () => {
    expect(codeOfSync(() => kmsEncryptionContext({ ...ctx(), key_ref: LOGICAL } as unknown as CredentialContext))).toBe("INVALID_CONTEXT");
    expect(codeOfSync(() => kmsEncryptionContext({ ...ctx(), env: "prod" } as unknown as CredentialContext))).toBe("INVALID_CONTEXT");
  });

  it("physical keys are full KMS key ARNs only", () => {
    for (const arn of [ARN_OLD, `arn:aws:kms:us-east-1:000000000000:key/mrk-${"a".repeat(32)}`, "arn:aws-us-gov:kms:us-gov-west-1:000000000000:key/00000000-0000-4000-8000-0000000000aa"]) {
      expect(isKmsKeyArn(arn), arn).toBe(true);
    }
    for (const id of ["alias/social-intelligence-platform-dev-provider-credentials", "arn:aws:kms:sa-east-1:000000000000:alias/x", "00000000-0000-4000-8000-0000000000aa", LOGICAL, "", 42]) {
      expect(isKmsKeyArn(id), String(id)).toBe(false);
    }
  });
});

describe("7C.6 · GenerateDataKey (generator)", () => {
  it("sends exactly KeyId = current ARN, KeySpec = AES_256 and the six-field context", async () => {
    const kms = fakeKms();
    const generator = createKmsDataKeyGenerator(kms.generate, { keyRef: LOGICAL, currentKeyArn: ARN_OLD });
    await createCredentialSealer(generator).seal(markerBytes(), ctx());
    expect(kms.sent).toHaveLength(1);
    const command = kms.sent[0];
    expect(command).toBeInstanceOf(GenerateDataKeyCommand);
    expect(command?.input).toEqual({ KeyId: ARN_OLD, KeySpec: "AES_256", EncryptionContext: kmsEncryptionContext(ctx()) });
    expect(Object.keys(command?.input ?? {}).sort()).toEqual(["EncryptionContext", "KeyId", "KeySpec"]);
    expect(Object.keys((command?.input as { EncryptionContext: object }).EncryptionContext)).toEqual([...CREDENTIAL_CONTEXT_FIELDS]);
  });

  it("the envelope carries the LOGICAL keyRef and the ciphertext blob; never the physical ARN", async () => {
    const kms = fakeKms();
    const envelope = await createCredentialSealer(createKmsDataKeyGenerator(kms.generate, { keyRef: LOGICAL, currentKeyArn: ARN_OLD })).seal(markerBytes(), ctx());
    expect(envelope).toMatchObject({ kekProvider: "aws-kms", keyRef: LOGICAL });
    const text = Buffer.from(encodeEnvelope(envelope)).toString("latin1");
    expect(text.includes(LOGICAL)).toBe(true);
    // The fake's own blob embeds the ARN to model KMS metadata; the HEADER and context never do.
    expect(Object.values(envelope).filter((value) => typeof value === "string").some((value) => value.includes("arn:"))).toBe(false);
  });

  it("hands the data key over without a copy: the sealer's zeroing reaches the SDK's own bytes", async () => {
    const kms = fakeKms();
    await createCredentialSealer(createKmsDataKeyGenerator(kms.generate, { keyRef: LOGICAL, currentKeyArn: ARN_OLD })).seal(markerBytes(), ctx());
    expect(kms.handedOut).toHaveLength(1);
    expect(zeroed(kms.handedOut[0])).toBe(true);
  });

  it.each([
    ["missing Plaintext", (): GenerateDataKeyCommandOutput => ({ CiphertextBlob: new Uint8Array(8).fill(1), KeyId: ARN_OLD, $metadata: {} })],
    ["31-byte Plaintext", (): GenerateDataKeyCommandOutput => ({ Plaintext: new Uint8Array(31).fill(7), CiphertextBlob: new Uint8Array(8).fill(1), KeyId: ARN_OLD, $metadata: {} })],
    ["33-byte Plaintext", (): GenerateDataKeyCommandOutput => ({ Plaintext: new Uint8Array(33).fill(7), CiphertextBlob: new Uint8Array(8).fill(1), KeyId: ARN_OLD, $metadata: {} })],
    ["missing CiphertextBlob", (): GenerateDataKeyCommandOutput => ({ Plaintext: new Uint8Array(32).fill(7), KeyId: ARN_OLD, $metadata: {} })],
    ["empty CiphertextBlob", (): GenerateDataKeyCommandOutput => ({ Plaintext: new Uint8Array(32).fill(7), CiphertextBlob: new Uint8Array(0), KeyId: ARN_OLD, $metadata: {} })],
    ["missing KeyId", (): GenerateDataKeyCommandOutput => ({ Plaintext: new Uint8Array(32).fill(7), CiphertextBlob: new Uint8Array(8).fill(1), $metadata: {} })],
    ["another key's KeyId", (): GenerateDataKeyCommandOutput => ({ Plaintext: new Uint8Array(32).fill(7), CiphertextBlob: new Uint8Array(8).fill(1), KeyId: ARN_NEW, $metadata: {} })],
  ])("%s → KEYRING_MISCONFIGURED, returned plaintext zeroed", async (_label, output) => {
    const sender = scripted(output);
    const generator = createKmsDataKeyGenerator(sender, { keyRef: LOGICAL, currentKeyArn: ARN_OLD });
    expect(await codeOf(generator.generateDataKey({ header: KMS_HEADER, context: ctx() }))).toBe("KEYRING_MISCONFIGURED");
    const plaintext = sender.outputs[0]?.Plaintext;
    if (plaintext !== undefined) expect(zeroed(plaintext)).toBe(true);
  });

  it("a header that isn't this keyring's is refused before KMS is asked", async () => {
    const sender = scripted(() => ({ $metadata: {} }));
    const generator = createKmsDataKeyGenerator(sender, { keyRef: LOGICAL, currentKeyArn: ARN_OLD });
    for (const header of [{ kekProvider: "local", keyRef: LOGICAL }, { kekProvider: "aws-kms", keyRef: "kms-provider-credentials-v2" }] as const) {
      expect(await codeOf(generator.generateDataKey({ header, context: ctx() }))).toBe("KEYRING_MISMATCH");
    }
    expect(sender.sent).toEqual([]);
  });

  it("configuration: the keyRef must be logical and the current key a full key ARN", () => {
    const sender = scripted(() => ({ $metadata: {} }));
    for (const config of [
      { keyRef: ARN_OLD, currentKeyArn: ARN_OLD },
      { keyRef: "alias/x", currentKeyArn: ARN_OLD },
      { keyRef: LOGICAL, currentKeyArn: "alias/social-intelligence-platform-dev-provider-credentials" },
      { keyRef: LOGICAL, currentKeyArn: "00000000-0000-4000-8000-0000000000aa" },
      { keyRef: LOGICAL, currentKeyArn: "" },
    ]) {
      expect(codeOfSync(() => createKmsDataKeyGenerator(sender, config))).toBe("KEYRING_MISCONFIGURED");
    }
    const generator = createKmsDataKeyGenerator(sender, { keyRef: LOGICAL, currentKeyArn: ARN_OLD });
    expect(Object.keys(generator).sort()).toEqual(["generateDataKey", "kekProvider", "keyRef"]);
    expect(generator.keyRef).toBe(LOGICAL);
  });
});

describe("7C.7 · Decrypt (unwrapper)", () => {
  async function sealedWith(kms: ReturnType<typeof fakeKms>, context = ctx()): Promise<EnvelopeV1> {
    return createCredentialSealer(createKmsDataKeyGenerator(kms.generate, { keyRef: LOGICAL, currentKeyArn: ARN_OLD })).seal(markerBytes(), context);
  }

  it("sends exactly the wrapped blob and the six-field context — and NO KeyId", async () => {
    const kms = fakeKms();
    const envelope = await sealedWith(kms);
    const opener = createCredentialOpener(createKmsDataKeyUnwrapper(kms.decryptSender, { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD] }));
    expect(await opener.open(envelope, ctx(), (p) => Buffer.from(p).toString("utf8"))).toBe(MARKER);
    const command = kms.sent[1];
    expect(command).toBeInstanceOf(DecryptCommand);
    const input = command?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["CiphertextBlob", "EncryptionContext"]);
    expect("KeyId" in input).toBe(false);
    expect(Buffer.from(input["CiphertextBlob"] as Uint8Array).equals(Buffer.from(envelope.wrappedDek))).toBe(true);
    expect(input["EncryptionContext"]).toEqual(kmsEncryptionContext(ctx()));
    expect(Object.keys(input["EncryptionContext"] as object)).toEqual([...CREDENTIAL_CONTEXT_FIELDS]);
  });

  it("old and new physical keys both open while allowed; the logical keyRef never changes; then old is refused", async () => {
    const kms = fakeKms();
    const original = await sealedWith(kms);
    const migrated = { ...original, wrappedDek: kms.reWrap(original.wrappedDek, { ...kmsEncryptionContext(ctx()) }, ARN_NEW) };
    expect(migrated.keyRef).toBe(LOGICAL);
    const both = createCredentialOpener(createKmsDataKeyUnwrapper(kms.decryptSender, { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD, ARN_NEW] }));
    for (const envelope of [original, migrated]) expect(await both.open(envelope, ctx(), (p) => Buffer.from(p).toString("utf8"))).toBe(MARKER);
    const newOnly = createCredentialOpener(createKmsDataKeyUnwrapper(kms.decryptSender, { keyRef: LOGICAL, allowedKeyArns: [ARN_NEW] }));
    expect(await codeOf(newOnly.open(original, ctx(), () => 0))).toBe("KEYRING_MISCONFIGURED");
    expect(zeroed(kms.handedOut.at(-1))).toBe(true);
    expect(await newOnly.open(migrated, ctx(), (p) => Buffer.from(p).toString("utf8"))).toBe(MARKER);
  });

  it("a ciphertext wrapped by a key outside the allowlist is refused and its plaintext zeroed", async () => {
    const kms = fakeKms();
    const foreign = { ...(await sealedWith(kms)) };
    const envelope = { ...foreign, wrappedDek: kms.reWrap(foreign.wrappedDek, { ...kmsEncryptionContext(ctx()) }, ARN_FOREIGN) };
    const opener = createCredentialOpener(createKmsDataKeyUnwrapper(kms.decryptSender, { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD, ARN_NEW] }));
    expect(await codeOf(opener.open(envelope, ctx(), () => 0))).toBe("KEYRING_MISCONFIGURED");
    expect(zeroed(kms.handedOut.at(-1))).toBe(true);
  });

  it.each([
    ["missing Plaintext", (): DecryptCommandOutput => ({ KeyId: ARN_OLD, $metadata: {} })],
    ["31-byte Plaintext", (): DecryptCommandOutput => ({ Plaintext: new Uint8Array(31).fill(7), KeyId: ARN_OLD, $metadata: {} })],
    ["missing KeyId", (): DecryptCommandOutput => ({ Plaintext: new Uint8Array(32).fill(7), $metadata: {} })],
    ["unexpected algorithm", (): DecryptCommandOutput => ({ Plaintext: new Uint8Array(32).fill(7), KeyId: ARN_OLD, EncryptionAlgorithm: "RSAES_OAEP_SHA_256", $metadata: {} })],
  ])("%s → KEYRING_MISCONFIGURED, returned plaintext zeroed", async (_label, output) => {
    const sender = scripted(output);
    const unwrapper = createKmsDataKeyUnwrapper(sender, { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD] });
    expect(await codeOf(unwrapper.unwrapDataKey({ header: KMS_HEADER, context: ctx(), wrappedDek: new Uint8Array(8).fill(1) }))).toBe("KEYRING_MISCONFIGURED");
    const plaintext = sender.outputs[0]?.Plaintext;
    if (plaintext !== undefined) expect(zeroed(plaintext)).toBe(true);
  });

  it("a wrong logical keyRef or another KEK provider is refused before KMS is asked", async () => {
    const kms = fakeKms();
    const envelope = await sealedWith(kms);
    const sentBefore = kms.sent.length;
    const unwrapper = createKmsDataKeyUnwrapper(kms.decryptSender, { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD] });
    expect(await codeOf(unwrapper.unwrapDataKey({ header: { kekProvider: "aws-kms", keyRef: "kms-provider-credentials-v2" }, context: ctx(), wrappedDek: envelope.wrappedDek }))).toBe("KEYRING_MISMATCH");
    expect(await codeOf(unwrapper.unwrapDataKey({ header: { kekProvider: "local", keyRef: LOGICAL }, context: ctx(), wrappedDek: envelope.wrappedDek }))).toBe("KEYRING_MISMATCH");
    expect(await codeOf(createCredentialOpener(unwrapper).open({ ...envelope, kekProvider: "local" }, ctx(), () => 0))).toBe("KEYRING_MISMATCH");
    expect(kms.sent.length).toBe(sentBefore);
  });

  it.each([
    ["workspace", () => ctx({ workspaceId: randomUUID() })],
    ["credential", () => ctx({ credentialId: randomUUID() })],
    ["environment", () => ctx({ env: "test" })],
  ])("a %s mismatch reaches KMS as the CALLER's context and fails as INTEGRITY_FAILURE", async (_label, wrong) => {
    const kms = fakeKms();
    const envelope = await sealedWith(kms);
    const context = wrong();
    const opener = createCredentialOpener(createKmsDataKeyUnwrapper(kms.decryptSender, { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD] }));
    expect(await codeOf(opener.open(envelope, context, () => 0))).toBe("INTEGRITY_FAILURE");
    expect((kms.sent.at(-1)?.input as { EncryptionContext: unknown }).EncryptionContext).toEqual(kmsEncryptionContext(context));
  });

  it("configuration: a logical keyRef and a non-empty set of distinct key ARNs", () => {
    const sender = scripted(() => ({ $metadata: {} }));
    for (const config of [
      { keyRef: ARN_OLD, allowedKeyArns: [ARN_OLD] },
      { keyRef: LOGICAL, allowedKeyArns: [] },
      { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD, ARN_OLD] },
      { keyRef: LOGICAL, allowedKeyArns: ["alias/x"] },
      { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD, "00000000-0000-4000-8000-0000000000bb"] },
    ]) {
      expect(codeOfSync(() => createKmsDataKeyUnwrapper(sender, config))).toBe("KEYRING_MISCONFIGURED");
    }
    expect(Object.keys(createKmsDataKeyUnwrapper(sender, { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD] })).sort()).toEqual(["kekProvider", "unwrapDataKey"]);
  });
});

describe("7C.9 · error normalization", () => {
  const modeled = (name: string): Error => {
    const Exception = (kmsSdk as unknown as Record<string, new (options: object) => Error>)[name];
    if (Exception === undefined) throw new Error(`@aws-sdk/client-kms has no export ${name}`);
    return new Exception({ message: SECRET, $metadata: { httpStatusCode: 400 } });
  };
  // Like the SDK's deserializer: construct the base service exception, then attach $fault/$retryable traits.
  const service = (name: string, extra: object = {}): Error =>
    Object.assign(new KMSServiceException({ name, $fault: "client", message: SECRET, $metadata: { httpStatusCode: 400 } }), extra);

  // Every exception @aws-sdk/client-kms 3.1146.0 documents for GenerateDataKey and Decrypt is mapped explicitly.
  const DOCUMENTED: readonly (readonly [string, CredentialCryptoErrorCode])[] = [
    ["InvalidCiphertextException", "INTEGRITY_FAILURE"],
    ["IncorrectKeyException", "INTEGRITY_FAILURE"],
    ["DisabledException", "KEYRING_MISCONFIGURED"],
    ["NotFoundException", "KEYRING_MISCONFIGURED"],
    ["KMSInvalidStateException", "KEYRING_MISCONFIGURED"],
    ["InvalidKeyUsageException", "KEYRING_MISCONFIGURED"],
    ["InvalidGrantTokenException", "KEYRING_MISCONFIGURED"],
    ["DryRunOperationException", "KEYRING_MISCONFIGURED"],
    ["InvalidArnException", "KEYRING_MISCONFIGURED"],
    ["KMSInternalException", "KEYRING_UNAVAILABLE"],
    ["DependencyTimeoutException", "KEYRING_UNAVAILABLE"],
    ["KeyUnavailableException", "KEYRING_UNAVAILABLE"],
  ];

  it.each(DOCUMENTED)("modeled %s → %s", (name, expected) => {
    expect(kmsErrorCode(modeled(name))).toBe(expected);
  });

  it.each([
    ["AccessDeniedException", {}, "KEYRING_ACCESS_DENIED"],
    ["UnrecognizedClientException", {}, "KEYRING_ACCESS_DENIED"],
    ["ExpiredTokenException", {}, "KEYRING_ACCESS_DENIED"],
    ["InvalidSignatureException", {}, "KEYRING_ACCESS_DENIED"],
    ["ValidationException", {}, "KEYRING_MISCONFIGURED"],
    ["ThrottlingException", { $retryable: { throttling: true } }, "KEYRING_UNAVAILABLE"],
    ["SomeFutureClientException", {}, "KEYRING_MISCONFIGURED"],
    ["SomeFutureServerException", { $fault: "server" }, "KEYRING_UNAVAILABLE"],
    ["SomeFutureRetryableException", { $retryable: {} }, "KEYRING_UNAVAILABLE"],
  ] as const)("service-level %s %j → %s", (name, extra, expected) => {
    expect(kmsErrorCode(service(name, extra))).toBe(expected);
  });

  it.each([
    ["connection reset", Object.assign(new Error(SECRET), { code: "ECONNRESET" }), "KEYRING_UNAVAILABLE"],
    ["DNS failure", Object.assign(new Error(SECRET), { code: "ENOTFOUND" }), "KEYRING_UNAVAILABLE"],
    ["SDK timeout", Object.assign(new Error(SECRET), { name: "TimeoutError" }), "KEYRING_UNAVAILABLE"],
    ["no credentials configured", Object.assign(new Error(SECRET), { name: "CredentialsProviderError" }), "KEYRING_MISCONFIGURED"],
    ["a programming error", new TypeError(SECRET), "KEYRING_MISCONFIGURED"],
    ["a thrown string", SECRET, "KEYRING_MISCONFIGURED"],
    ["null", null, "KEYRING_MISCONFIGURED"],
  ] as const)("transport/unknown: %s → %s (fails closed)", (_label, error, expected) => {
    expect(kmsErrorCode(error)).toBe(expected);
  });

  it("every documented name is a real export of the installed SDK", () => {
    for (const [name] of DOCUMENTED) expect(typeof (kmsSdk as unknown as Record<string, unknown>)[name], name).toBe("function");
  });

  it("through both capabilities: the normalized code surfaces; no raw message, name or field survives", async () => {
    for (const [raw, expected] of [
      [service("AccessDeniedException"), "KEYRING_ACCESS_DENIED"],
      [modeled("DisabledException"), "KEYRING_MISCONFIGURED"],
      [service("ThrottlingException", { $retryable: { throttling: true } }), "KEYRING_UNAVAILABLE"],
      [modeled("InvalidCiphertextException"), "INTEGRITY_FAILURE"],
      [new TypeError(SECRET), "KEYRING_MISCONFIGURED"],
    ] as const) {
      const sealer = createCredentialSealer(createKmsDataKeyGenerator(failing(raw), { keyRef: LOGICAL, currentKeyArn: ARN_OLD }));
      const unwrapper = createKmsDataKeyUnwrapper(failing(raw), { keyRef: LOGICAL, allowedKeyArns: [ARN_OLD] });
      const envelope: EnvelopeV1 = { formatVersion: 1, algorithm: "AES-256-GCM", kekProvider: "aws-kms", keyRef: LOGICAL, contextVersion: 1, wrappedDek: new Uint8Array(8).fill(1), iv: new Uint8Array(12), ciphertext: new Uint8Array(4), authTag: new Uint8Array(16) };
      for (const attempt of [sealer.seal(markerBytes(), ctx()), createCredentialOpener(unwrapper).open(envelope, ctx(), () => 0)]) {
        const error = await attempt.then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(CredentialCryptoError);
        expect((error as CredentialCryptoError).code).toBe(expected);
        expect((error as Error).cause).toBeUndefined();
        const rendered = `${String(error)} ${JSON.stringify(error)} ${inspect(error, { depth: 5 })} ${(error as Error).stack ?? ""}`;
        expect(rendered.includes(SECRET)).toBe(false);
        expect(/Exception|ThrottlingException|TypeError/.test(rendered.replace("CredentialCryptoError", ""))).toBe(false);
        expect(isRetryableCredentialCryptoError(error)).toBe(expected === "KEYRING_UNAVAILABLE");
      }
    }
  });

  it("the Step 7B retryability table is unchanged: only KEYRING_UNAVAILABLE retries", () => {
    expect(CREDENTIAL_CRYPTO_ERROR_CODES.filter((code) => CREDENTIAL_CRYPTO_RETRYABLE[code])).toEqual(["KEYRING_UNAVAILABLE"]);
  });
});

describe("7C.4 · injected client contract", () => {
  it("a real KMSClient satisfies both narrow senders (type-level only; no client is constructed)", () => {
    const asGenerator = (client: KMSClient): KmsGenerateDataKeySender => client;
    const asUnwrapper = (client: KMSClient): KmsDecryptSender => client;
    expect([typeof asGenerator, typeof asUnwrapper]).toEqual(["function", "function"]);
  });

  it("the binding reaches the KMS adapter structurally, never as serialized bytes", async () => {
    const kms = fakeKms();
    const generator = createKmsDataKeyGenerator(kms.generate, { keyRef: LOGICAL, currentKeyArn: ARN_OLD });
    const binding: DataKeyBinding = { header: KMS_HEADER, context: ctx() };
    const generated = await generator.generateDataKey(binding);
    generated.dek.fill(0);
    expect((kms.sent[0]?.input as { EncryptionContext: unknown }).EncryptionContext).toEqual(kmsEncryptionContext(binding.context));
  });
});
