/**
 * Step 5A — credential crypto boundary (TA §39, TA-Q-07 / ADR-64). Synthetic material only.
 * Covers: round trip, fresh data keys, context binding of BOTH the wrapped key and the payload, envelope
 * tampering (each field), local-keyring configuration and environment guard, the sealer/opener split,
 * zeroization of owned buffers, and absence of secret material from outputs, errors and logs.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, dekWrapAad, payloadAad } from "@/platform/crypto/credentials/aead";
import {
  CREDENTIAL_CONTEXT_FIELDS,
  canonicalContextBytes,
  credentialContext,
  parseCredentialContext,
  type CredentialContext,
} from "@/platform/crypto/credentials/context";
import { assertEnvelopeV1, decodeEnvelope, encodeEnvelope, type EnvelopeV1 } from "@/platform/crypto/credentials/envelope";
import { CredentialCryptoError, type CredentialCryptoErrorCode } from "@/platform/crypto/credentials/errors";
import type { DataKeyGenerator, DataKeyUnwrapper } from "@/platform/crypto/credentials/keyring";
import {
  LOCAL_KEYRING_KEY_ENV,
  assertNoLocalKeyringOutsideLocal,
  createLocalKeyring,
  localKeyringFromEnvironment,
  parseLocalKeyringKey,
  type LocalKeyring,
} from "@/platform/crypto/credentials/local-keyring";
import { localCredentialOpenerFromEnvironment } from "@/platform/crypto/credentials/local-opener";
import { localCredentialSealerFromEnvironment } from "@/platform/crypto/credentials/local-sealer";
import { createCredentialOpener, type CredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer, type CredentialSealer } from "@/platform/crypto/credentials/seal";

const TEST_ENV = { NODE_ENV: "test" } as const;
const MARKER = `SIP-SYNTHETIC-CREDENTIAL-${randomUUID()}`;
const markerBytes = (): Uint8Array => new Uint8Array(Buffer.from(MARKER, "utf8"));

const ctx = (overrides: Partial<{ workspaceId: string; credentialId: string; env: string }> = {}): CredentialContext =>
  credentialContext({
    purpose: "provider-credential",
    env: overrides.env ?? "test",
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    credentialId: overrides.credentialId ?? CREDENTIAL,
  });

const WORKSPACE = randomUUID();
const CREDENTIAL = randomUUID();

async function failsWith(promise: Promise<unknown>, code: CredentialCryptoErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CredentialCryptoError);
  expect((error as CredentialCryptoError).code).toBe(code);
}

function throwsCode(fn: () => unknown, code: CredentialCryptoErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CredentialCryptoError);
  expect((caught as CredentialCryptoError).code).toBe(code);
}

let keyring: LocalKeyring;
let sealer: CredentialSealer;
let opener: CredentialOpener;

beforeEach(() => {
  const key = randomBytes(32);
  keyring = createLocalKeyring(key, TEST_ENV);
  key.fill(0);
  sealer = createCredentialSealer(keyring.generator);
  opener = createCredentialOpener(keyring.unwrapper);
});

afterEach(() => {
  keyring.destroy();
});

const openToBuffer = (envelope: EnvelopeV1, context: CredentialContext): Promise<Buffer> =>
  opener.open(envelope, context, (plaintext) => Buffer.from(plaintext));

const flip = (bytes: Uint8Array, index: number): Uint8Array => {
  const copy = new Uint8Array(bytes);
  const at = index < 0 ? copy.length + index : index;
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
};

describe("A. happy path", () => {
  it("seal → open returns the identical synthetic credential bytes", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    expect((await openToBuffer(envelope, ctx())).equals(Buffer.from(MARKER, "utf8"))).toBe(true);
  });

  it("envelope v1 shape: AES-256-GCM, 96-bit IV, 128-bit tag, local KEK, no plaintext", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    expect(envelope).toMatchObject({ formatVersion: 1, algorithm: "AES-256-GCM", kekProvider: "local", keyRef: "local-v1", contextVersion: 1 });
    expect(envelope.iv.byteLength).toBe(12);
    expect(envelope.authTag.byteLength).toBe(16);
    expect(envelope.wrappedDek.byteLength).toBe(12 + 32 + 16);
    expect(Object.keys(envelope).sort()).toEqual(["algorithm", "authTag", "ciphertext", "contextVersion", "formatVersion", "iv", "kekProvider", "keyRef", "wrappedDek"]);
  });

  it("every seal uses a fresh data key and IV (non-identical envelopes)", async () => {
    const deks: Buffer[] = [];
    const spy: DataKeyGenerator = {
      ...keyring.generator,
      async generateDataKey(aad) {
        const generated = await keyring.generator.generateDataKey(aad);
        deks.push(Buffer.from(generated.dek));
        return generated;
      },
    };
    const spySealer = createCredentialSealer(spy);
    const a = await spySealer.seal(markerBytes(), ctx());
    const b = await spySealer.seal(markerBytes(), ctx());
    expect(deks[0]?.equals(deks[1] ?? Buffer.alloc(0))).toBe(false);
    expect(Buffer.from(a.wrappedDek).equals(Buffer.from(b.wrappedDek))).toBe(false);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
    for (const dek of deks) dek.fill(0);
  });

  it("binary encoding round-trips exactly", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    const decoded = decodeEnvelope(encodeEnvelope(envelope));
    expect(Buffer.from(encodeEnvelope(decoded)).equals(Buffer.from(encodeEnvelope(envelope)))).toBe(true);
    expect((await openToBuffer(decoded, ctx())).toString("utf8")).toBe(MARKER);
  });
});

describe("B. authenticated context", () => {
  it("wrong workspace_id fails", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    await failsWith(openToBuffer(envelope, ctx({ workspaceId: randomUUID() })), "INTEGRITY_FAILURE");
  });

  it("wrong credential_id fails", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    await failsWith(openToBuffer(envelope, ctx({ credentialId: randomUUID() })), "INTEGRITY_FAILURE");
  });

  it("wrong environment label fails", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    await failsWith(openToBuffer(envelope, ctx({ env: "local" })), "INTEGRITY_FAILURE");
  });

  it("purpose is a closed value: anything else is rejected", () => {
    throwsCode(() => credentialContext({ purpose: "pkce-verifier" as never, env: "test", workspaceId: WORKSPACE, credentialId: CREDENTIAL }), "INVALID_CONTEXT");
    throwsCode(() => parseCredentialContext({ ...ctx(), purpose: "pkce-verifier" }), "INVALID_CONTEXT");
  });

  it("malformed UUIDs and labels are rejected", () => {
    for (const workspaceId of ["not-a-uuid", WORKSPACE.toUpperCase(), "", `${WORKSPACE} `]) {
      throwsCode(() => ctx({ workspaceId }), "INVALID_CONTEXT");
    }
    throwsCode(() => ctx({ credentialId: "123" }), "INVALID_CONTEXT");
    for (const env of ["", "Prod", "has space", "x".repeat(40)]) throwsCode(() => ctx({ env }), "INVALID_CONTEXT");
  });

  it("extra or missing fields fail closed (also when handed to seal/open)", async () => {
    const good = { ...ctx() };
    throwsCode(() => parseCredentialContext({ ...good, note: "x" }), "INVALID_CONTEXT");
    const missing = Object.fromEntries(Object.entries(good).filter(([field]) => field !== "credential_id"));
    throwsCode(() => parseCredentialContext(missing), "INVALID_CONTEXT");
    throwsCode(() => parseCredentialContext({ ...good, v: "2" }), "INVALID_CONTEXT");
    throwsCode(() => parseCredentialContext({ ...good, app: "other-app" }), "INVALID_CONTEXT");
    await failsWith(sealer.seal(markerBytes(), { ...good, note: "x" } as unknown as CredentialContext), "INVALID_CONTEXT");
    const envelope = await sealer.seal(markerBytes(), ctx());
    await failsWith(openToBuffer(envelope, missing as unknown as CredentialContext), "INVALID_CONTEXT");
  });

  it("canonical encoding is deterministic and independent of field order", () => {
    const built = ctx();
    const reordered = Object.fromEntries([...CREDENTIAL_CONTEXT_FIELDS].reverse().map((field) => [field, built[field]]));
    expect(Buffer.from(canonicalContextBytes(parseCredentialContext(reordered))).equals(canonicalContextBytes(built))).toBe(true);
    expect(canonicalContextBytes(built).toString("utf8")).toBe(
      JSON.stringify([
        ["app", "social-intelligence-platform"],
        ["purpose", "provider-credential"],
        ["env", "test"],
        ["v", "1"],
        ["workspace_id", WORKSPACE],
        ["credential_id", CREDENTIAL],
      ]),
    );
  });

  it("the context binds BOTH the wrapped data key and the payload", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    const header = { kekProvider: envelope.kekProvider, keyRef: envelope.keyRef };
    const other = ctx({ credentialId: randomUUID() });
    // Wrapped key: the right context unwraps, another context does not.
    await failsWith(keyring.unwrapper.unwrapDataKey({ keyRef: envelope.keyRef, wrappedDek: envelope.wrappedDek, additionalData: dekWrapAad(header, other) }), "INTEGRITY_FAILURE");
    const dek = await keyring.unwrapper.unwrapDataKey({ keyRef: envelope.keyRef, wrappedDek: envelope.wrappedDek, additionalData: dekWrapAad(header, ctx()) });
    try {
      // Payload: even with the correct data key, another context's AAD fails.
      throwsCode(() => decrypt(dek, envelope, payloadAad(header, other)), "INTEGRITY_FAILURE");
      const plaintext = decrypt(dek, envelope, payloadAad(header, ctx()));
      expect(plaintext.toString("utf8")).toBe(MARKER);
      plaintext.fill(0);
      // Domain separation: payload AAD ≠ wrap AAD for the same header and context.
      expect(payloadAad(header, ctx()).equals(dekWrapAad(header, ctx()))).toBe(false);
    } finally {
      dek.fill(0);
    }
  });
});

describe("C. envelope tampering fails closed", () => {
  let envelope: EnvelopeV1;
  beforeEach(async () => {
    envelope = await sealer.seal(markerBytes(), ctx());
  });
  const tampered = (patch: Record<string, unknown>): EnvelopeV1 => Object.assign({}, envelope, patch);

  it.each([
    ["ciphertext", () => ({ ciphertext: flip(envelope.ciphertext, 0) })],
    ["content IV", () => ({ iv: flip(envelope.iv, 0) })],
    ["authentication tag", () => ({ authTag: flip(envelope.authTag, -1) })],
    ["wrapped DEK body", () => ({ wrappedDek: flip(envelope.wrappedDek, 20) })],
    ["wrapped-DEK IV (local wrap authentication material)", () => ({ wrappedDek: flip(envelope.wrappedDek, 0) })],
    ["wrapped-DEK tag (local wrap authentication material)", () => ({ wrappedDek: flip(envelope.wrappedDek, -1) })],
    ["wrapped DEK truncated", () => ({ wrappedDek: envelope.wrappedDek.subarray(0, 59) })],
  ])("%s → INTEGRITY_FAILURE", async (_label, patch) => {
    await failsWith(openToBuffer(tampered(patch()), ctx()), "INTEGRITY_FAILURE");
  });

  it.each([
    ["format version", { formatVersion: 2 }, "UNSUPPORTED_ENVELOPE_VERSION"],
    ["context version", { contextVersion: 2 }, "UNSUPPORTED_ENVELOPE_VERSION"],
    ["format version (wrong type)", { formatVersion: "1" }, "MALFORMED_ENVELOPE"],
    ["algorithm", { algorithm: "AES-128-GCM" }, "MALFORMED_ENVELOPE"],
    ["kek provider (other known provider)", { kekProvider: "aws-kms" }, "KEYRING_MISMATCH"],
    ["kek provider (unknown)", { kekProvider: "plaintext" }, "MALFORMED_ENVELOPE"],
    ["key reference", { keyRef: "local-v2" }, "KEYRING_MISMATCH"],
    ["IV length", { iv: new Uint8Array(16) }, "MALFORMED_ENVELOPE"],
    ["tag length", { authTag: new Uint8Array(12) }, "MALFORMED_ENVELOPE"],
    ["empty ciphertext", { ciphertext: new Uint8Array(0) }, "MALFORMED_ENVELOPE"],
    ["extra metadata field", { note: "x" }, "MALFORMED_ENVELOPE"],
  ] as const)("%s → %s", async (_label, patch, code) => {
    await failsWith(openToBuffer(tampered(patch), ctx()), code);
  });

  it("the header is authenticated: a keyring that ignores keyRef still fails on a changed header", async () => {
    const lenient: DataKeyUnwrapper = { kekProvider: "local", unwrapDataKey: (input) => keyring.unwrapper.unwrapDataKey({ ...input, keyRef: "local-v1" }) };
    await failsWith(createCredentialOpener(lenient).open(tampered({ keyRef: "local-v9" }), ctx(), () => 0), "INTEGRITY_FAILURE");
  });

  it("binary form: version, algorithm, provider, context version, magic, truncation and trailing bytes", async () => {
    const encoded = Buffer.from(encodeEnvelope(envelope));
    const at = (offset: number, value: number): Uint8Array => {
      const copy = Buffer.from(encoded);
      copy[offset] = value;
      return new Uint8Array(copy);
    };
    throwsCode(() => decodeEnvelope(at(4, 2)), "UNSUPPORTED_ENVELOPE_VERSION");
    throwsCode(() => decodeEnvelope(at(5, 9)), "MALFORMED_ENVELOPE");
    throwsCode(() => decodeEnvelope(at(6, 9)), "MALFORMED_ENVELOPE");
    throwsCode(() => decodeEnvelope(at(7, 2)), "UNSUPPORTED_ENVELOPE_VERSION");
    throwsCode(() => decodeEnvelope(at(0, 0x58)), "MALFORMED_ENVELOPE");
    throwsCode(() => decodeEnvelope(new Uint8Array(encoded.subarray(0, encoded.length - 1))), "MALFORMED_ENVELOPE");
    throwsCode(() => decodeEnvelope(new Uint8Array(Buffer.concat([encoded, Buffer.from([0])]))), "MALFORMED_ENVELOPE");
    await failsWith(openToBuffer(decodeEnvelope(at(6, 2)), ctx()), "KEYRING_MISMATCH");
  });

  it("structural validation rejects non-objects", () => {
    for (const value of [null, "envelope", 42, [], { ...envelope, wrappedDek: "AAAA" }]) throwsCode(() => assertEnvelopeV1(value), "MALFORMED_ENVELOPE");
  });
});

describe("D. local keyring configuration and environment guard", () => {
  const valid = (): string => randomBytes(32).toString("base64url");

  it("accepts exactly 32 bytes as 43 unpadded base64url characters", () => {
    const text = valid();
    expect(text).toHaveLength(43);
    const key = parseLocalKeyringKey(text);
    expect(key.byteLength).toBe(32);
    key.fill(0);
  });

  it("rejects 31 and 33 bytes, padding, standard base64, garbage and non-canonical encodings", () => {
    const text = valid();
    const lastIndex = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(text.at(-1) ?? "A");
    const nonCanonical = `${text.slice(0, 42)}${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[lastIndex ^ 0x01] ?? "B"}`;
    for (const candidate of [
      randomBytes(31).toString("base64url"),
      randomBytes(33).toString("base64url"),
      `${text}=`,
      randomBytes(32).toString("base64"),
      "!".repeat(43),
      nonCanonical,
      "",
      undefined,
      42,
    ]) {
      throwsCode(() => parseLocalKeyringKey(candidate), "INVALID_LOCAL_KEY_CONFIGURATION");
    }
  });

  it("requires the key when the local keyring is used, and only in local/test", () => {
    throwsCode(() => localKeyringFromEnvironment({ NODE_ENV: "test" }), "INVALID_LOCAL_KEY_CONFIGURATION");
    throwsCode(() => localKeyringFromEnvironment({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: "" }), "INVALID_LOCAL_KEY_CONFIGURATION");
    throwsCode(() => localKeyringFromEnvironment({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: "short" }), "INVALID_LOCAL_KEY_CONFIGURATION");
    for (const NODE_ENV of ["production", "staging", "", undefined]) {
      throwsCode(() => localKeyringFromEnvironment({ NODE_ENV, [LOCAL_KEYRING_KEY_ENV]: valid() }), "LOCAL_KEYRING_FORBIDDEN");
      throwsCode(() => createLocalKeyring(randomBytes(32), { NODE_ENV }), "LOCAL_KEYRING_FORBIDDEN");
    }
    throwsCode(() => createLocalKeyring(randomBytes(31), TEST_ENV), "INVALID_LOCAL_KEY_CONFIGURATION");
    const development = localKeyringFromEnvironment({ NODE_ENV: "development", [LOCAL_KEYRING_KEY_ENV]: valid() });
    development.destroy();
  });

  it("startup guard: local key material present outside local/test is refused", () => {
    throwsCode(() => {
      assertNoLocalKeyringOutsideLocal({ NODE_ENV: "production", [LOCAL_KEYRING_KEY_ENV]: valid() });
    }, "LOCAL_KEYRING_FORBIDDEN");
    expect(() => {
      assertNoLocalKeyringOutsideLocal({ NODE_ENV: "production" });
    }).not.toThrow();
    expect(() => {
      assertNoLocalKeyringOutsideLocal({ NODE_ENV: "development", [LOCAL_KEYRING_KEY_ENV]: valid() });
    }).not.toThrow();
  });

  it("environment-composed sealer and opener interoperate only with the same key", async () => {
    const key = valid();
    const sealed = await localCredentialSealerFromEnvironment({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: key }).seal(markerBytes(), ctx());
    const sameKey = localCredentialOpenerFromEnvironment({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: key });
    expect(await sameKey.open(sealed, ctx(), (p) => Buffer.from(p).toString("utf8"))).toBe(MARKER);
    const otherKey = localCredentialOpenerFromEnvironment({ NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: valid() });
    await failsWith(otherKey.open(sealed, ctx(), () => 0), "INTEGRITY_FAILURE");
  });

  it("a destroyed keyring is unavailable", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    keyring.destroy();
    await failsWith(sealer.seal(markerBytes(), ctx()), "KEYRING_UNAVAILABLE");
    await failsWith(openToBuffer(envelope, ctx()), "KEYRING_UNAVAILABLE");
  });
});

describe("E. sealer / opener separation", () => {
  it("the sealer exposes only seal: no open, decrypt or unwrap capability", () => {
    expect(Object.keys(sealer)).toEqual(["seal"]);
    expect(Object.isFrozen(sealer)).toBe(true);
    const names = new Set<string>();
    for (let proto: object | null = sealer; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    }
    expect([...names].filter((name) => /open|decrypt|unwrap/i.test(name))).toEqual([]);
    // Type level: CredentialSealer has no open member.
    const hasOpen: "open" extends keyof CredentialSealer ? true : false = false;
    expect(hasOpen).toBe(false);
  });

  it("the opener exposes only open", () => {
    expect(Object.keys(opener)).toEqual(["open"]);
    expect(Object.isFrozen(opener)).toBe(true);
  });
});

describe("F. zeroization and secret leakage", () => {
  it("zeroes the generated data key after a successful seal and after a failed one", async () => {
    const seen: Buffer[] = [];
    const recording: DataKeyGenerator = {
      ...keyring.generator,
      async generateDataKey(aad) {
        const generated = await keyring.generator.generateDataKey(aad);
        seen.push(generated.dek);
        return generated;
      },
    };
    await createCredentialSealer(recording).seal(markerBytes(), ctx());
    const shortKey: DataKeyGenerator = {
      ...keyring.generator,
      generateDataKey() {
        const dek = randomBytes(31);
        seen.push(dek);
        return Promise.resolve({ dek, wrappedDek: new Uint8Array(60) });
      },
    };
    await failsWith(createCredentialSealer(shortKey).seal(markerBytes(), ctx()), "KEYRING_UNAVAILABLE");
    expect(seen).toHaveLength(2);
    for (const dek of seen) expect(dek.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes the unwrapped data key and the plaintext after use, after a failing callback and after a payload failure", async () => {
    const envelope = await sealer.seal(markerBytes(), ctx());
    const deks: Buffer[] = [];
    const recording: DataKeyUnwrapper = {
      kekProvider: "local",
      async unwrapDataKey(input) {
        const dek = await keyring.unwrapper.unwrapDataKey(input);
        deks.push(dek);
        return dek;
      },
    };
    const recordingOpener = createCredentialOpener(recording);
    let held: Uint8Array | undefined;
    expect(await recordingOpener.open(envelope, ctx(), (plaintext) => ((held = plaintext), plaintext.byteLength))).toBe(Buffer.byteLength(MARKER));
    expect(held?.every((byte) => byte === 0)).toBe(true);

    const own = new Error("caller failure");
    await expect(recordingOpener.open(envelope, ctx(), (plaintext) => ((held = plaintext), Promise.reject(own)))).rejects.toBe(own);
    expect(held?.every((byte) => byte === 0)).toBe(true);

    await failsWith(recordingOpener.open({ ...envelope, ciphertext: flip(envelope.ciphertext, 0) }, ctx(), () => 0), "INTEGRITY_FAILURE");
    expect(deks).toHaveLength(3);
    for (const dek of deks) expect(dek.every((byte) => byte === 0)).toBe(true);
  });

  it("no plaintext, key or envelope material appears in outputs, errors or logs", async () => {
    const kekText = randomBytes(32).toString("base64url");
    const environment = { NODE_ENV: "test", [LOCAL_KEYRING_KEY_ENV]: kekText };
    const writes: string[] = [];
    const capture = (...args: unknown[]): void => {
      writes.push(args.map((a) => inspect(a)).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "info").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(console, "debug").mockImplementation(capture),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (writes.push(String(chunk)), true)),
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (writes.push(String(chunk)), true)),
    ];
    const outputs: string[] = [];
    try {
      const envSealer = localCredentialSealerFromEnvironment(environment);
      const envOpener = localCredentialOpenerFromEnvironment(environment);
      const envelope = await envSealer.seal(markerBytes(), ctx());
      const encoded = Buffer.from(encodeEnvelope(envelope));
      outputs.push(encoded.toString("latin1"), encoded.toString("base64"), JSON.stringify(envelope), inspect(envelope, { depth: 5 }));
      const failures: unknown[] = [];
      for (const attempt of [
        () => envOpener.open({ ...envelope, ciphertext: flip(envelope.ciphertext, 0) }, ctx(), () => 0),
        () => envOpener.open(envelope, ctx({ workspaceId: randomUUID() }), () => 0),
        () => envOpener.open({ ...envelope, formatVersion: 3 } as unknown as EnvelopeV1, ctx(), () => 0),
        () => Promise.resolve().then(() => localKeyringFromEnvironment({ NODE_ENV: "production", [LOCAL_KEYRING_KEY_ENV]: kekText })),
        () => Promise.resolve().then(() => parseLocalKeyringKey(`${kekText}=`)),
      ]) {
        failures.push(await attempt().then(() => "no-error", (e: unknown) => e));
      }
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(CredentialCryptoError);
        const error = failure as CredentialCryptoError;
        expect(error.cause).toBeUndefined();
        outputs.push(error.message, String(error), JSON.stringify(error), inspect(error, { depth: 5 }), error.stack ?? "");
      }
      await envOpener.open(envelope, ctx(), () => undefined);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const haystack = [...outputs, ...writes].join("\n");
    expect(writes).toEqual([]);
    expect(haystack.includes(MARKER)).toBe(false);
    expect(haystack.includes(Buffer.from(MARKER).toString("base64"))).toBe(false);
    expect(haystack.includes(kekText)).toBe(false);
    expect(haystack.includes(Buffer.from(kekText, "base64url").toString("hex"))).toBe(false);
  });
});
