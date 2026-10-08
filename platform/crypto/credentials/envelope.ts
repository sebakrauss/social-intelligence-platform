/**
 * Envelope format v1 (TA §39; ADR-64). An envelope carries only what is needed to reopen it:
 * format version, algorithm, KEK provider and key reference, context version, the wrapped data key, the
 * content IV, the ciphertext and the authentication tag. Never the plaintext, never the context values
 * (they are re-supplied by the caller from its sealed scope), and no free-form metadata.
 *
 * The header (version, algorithm, provider, key reference, context version) is itself authenticated: it is
 * part of the AAD of both the data-key wrapping and the payload, so tampering with any field fails closed.
 *
 * Binary encoding (big-endian), for single-column storage or transport:
 *   "SIPE" | format u8 | algorithm u8 | kek u8 | context version u8 | keyRef len u8 | keyRef (ASCII)
 *   | wrappedDek len u16 | wrappedDek | iv (12) | tag (16) | ciphertext len u32 | ciphertext
 */
import { CredentialCryptoError } from "./errors";
import { isLogicalKeyRef } from "./key-ref";

export const ENVELOPE_FORMAT_VERSION = 1;
export const ENVELOPE_CONTEXT_VERSION = 1;
export const ENVELOPE_ALGORITHM = "AES-256-GCM";
export const KEK_PROVIDERS = ["local", "aws-kms"] as const;
export type KekProvider = (typeof KEK_PROVIDERS)[number];

export const DEK_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const MAX_WRAPPED_DEK_BYTES = 1024;
export const MAX_PLAINTEXT_BYTES = 64 * 1024;

export interface EnvelopeV1 {
  readonly formatVersion: typeof ENVELOPE_FORMAT_VERSION;
  readonly algorithm: typeof ENVELOPE_ALGORITHM;
  readonly kekProvider: KekProvider;
  readonly keyRef: string;
  readonly contextVersion: typeof ENVELOPE_CONTEXT_VERSION;
  readonly wrappedDek: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
}

/** The authenticated, non-secret header of an envelope. */
export interface EnvelopeHeader {
  readonly kekProvider: KekProvider;
  readonly keyRef: string;
}

const ENVELOPE_FIELDS = ["formatVersion", "algorithm", "kekProvider", "keyRef", "contextVersion", "wrappedDek", "iv", "ciphertext", "authTag"];

const malformed = (): never => {
  throw new CredentialCryptoError("MALFORMED_ENVELOPE");
};

/** An envelope's key reference is a LOGICAL KEK label, never a physical key identifier (see key-ref.ts). */
export function isKeyRef(value: unknown): value is string {
  return isLogicalKeyRef(value);
}

function bytes(value: unknown, min: number, max: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max) return malformed();
  return value;
}

/** Validates an untrusted envelope (e.g. loaded from storage). Unknown or extra fields fail closed. */
export function assertEnvelopeV1(value: unknown): EnvelopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ENVELOPE_FIELDS.length || !keys.every((key) => ENVELOPE_FIELDS.includes(key))) return malformed();
  const formatVersion = record["formatVersion"];
  if (formatVersion !== ENVELOPE_FORMAT_VERSION) {
    throw new CredentialCryptoError(typeof formatVersion === "number" ? "UNSUPPORTED_ENVELOPE_VERSION" : "MALFORMED_ENVELOPE");
  }
  const contextVersion = record["contextVersion"];
  if (contextVersion !== ENVELOPE_CONTEXT_VERSION) {
    throw new CredentialCryptoError(typeof contextVersion === "number" ? "UNSUPPORTED_ENVELOPE_VERSION" : "MALFORMED_ENVELOPE");
  }
  if (record["algorithm"] !== ENVELOPE_ALGORITHM) return malformed();
  const kekProvider = record["kekProvider"];
  if (!(KEK_PROVIDERS as readonly unknown[]).includes(kekProvider)) return malformed();
  if (!isKeyRef(record["keyRef"])) return malformed();
  return {
    formatVersion: ENVELOPE_FORMAT_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    kekProvider: kekProvider as KekProvider,
    keyRef: record["keyRef"],
    contextVersion: ENVELOPE_CONTEXT_VERSION,
    wrappedDek: bytes(record["wrappedDek"], 1, MAX_WRAPPED_DEK_BYTES),
    iv: bytes(record["iv"], IV_BYTES, IV_BYTES),
    ciphertext: bytes(record["ciphertext"], 1, MAX_PLAINTEXT_BYTES),
    authTag: bytes(record["authTag"], TAG_BYTES, TAG_BYTES),
  };
}

/** Deterministic header bytes (part of every AAD). */
export function headerBytes(header: EnvelopeHeader): Buffer {
  if (!(KEK_PROVIDERS as readonly unknown[]).includes(header.kekProvider) || !isKeyRef(header.keyRef)) return malformed();
  return Buffer.from(
    JSON.stringify([
      ["format", ENVELOPE_FORMAT_VERSION],
      ["alg", ENVELOPE_ALGORITHM],
      ["kek", header.kekProvider],
      ["key_ref", header.keyRef],
      ["ctx_v", ENVELOPE_CONTEXT_VERSION],
    ]),
    "utf8",
  );
}

const MAGIC = Buffer.from("SIPE", "ascii");
const ALGORITHM_CODES: Readonly<Record<typeof ENVELOPE_ALGORITHM, number>> = { "AES-256-GCM": 1 };
const KEK_CODES: Readonly<Record<KekProvider, number>> = { local: 1, "aws-kms": 2 };

export function encodeEnvelope(envelope: EnvelopeV1): Uint8Array {
  const e = assertEnvelopeV1(envelope);
  const keyRef = Buffer.from(e.keyRef, "ascii");
  const out = Buffer.alloc(MAGIC.length + 5 + keyRef.length + 2 + e.wrappedDek.byteLength + IV_BYTES + TAG_BYTES + 4 + e.ciphertext.byteLength);
  let at = MAGIC.copy(out, 0);
  at = out.writeUInt8(e.formatVersion, at);
  at = out.writeUInt8(ALGORITHM_CODES[e.algorithm], at);
  at = out.writeUInt8(KEK_CODES[e.kekProvider], at);
  at = out.writeUInt8(e.contextVersion, at);
  at = out.writeUInt8(keyRef.length, at);
  at += keyRef.copy(out, at);
  at = out.writeUInt16BE(e.wrappedDek.byteLength, at);
  at += Buffer.from(e.wrappedDek).copy(out, at);
  at += Buffer.from(e.iv).copy(out, at);
  at += Buffer.from(e.authTag).copy(out, at);
  at = out.writeUInt32BE(e.ciphertext.byteLength, at);
  Buffer.from(e.ciphertext).copy(out, at);
  return new Uint8Array(out);
}

export function decodeEnvelope(encoded: Uint8Array): EnvelopeV1 {
  if (!(encoded instanceof Uint8Array)) return malformed();
  const input = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  let at = 0;
  const need = (n: number): void => {
    if (at + n > input.length) malformed();
  };
  need(MAGIC.length + 5);
  if (!input.subarray(0, MAGIC.length).equals(MAGIC)) malformed();
  at = MAGIC.length;
  const formatVersion = input.readUInt8(at++);
  if (formatVersion !== ENVELOPE_FORMAT_VERSION) throw new CredentialCryptoError("UNSUPPORTED_ENVELOPE_VERSION");
  const algorithmCode = input.readUInt8(at++);
  const kekCode = input.readUInt8(at++);
  const contextVersion = input.readUInt8(at++);
  if (contextVersion !== ENVELOPE_CONTEXT_VERSION) throw new CredentialCryptoError("UNSUPPORTED_ENVELOPE_VERSION");
  const algorithm = (Object.keys(ALGORITHM_CODES) as (typeof ENVELOPE_ALGORITHM)[]).find((a) => ALGORITHM_CODES[a] === algorithmCode);
  const kekProvider = KEK_PROVIDERS.find((k) => KEK_CODES[k] === kekCode);
  if (algorithm === undefined || kekProvider === undefined) return malformed();
  const keyRefLength = input.readUInt8(at++);
  need(keyRefLength);
  const keyRef = input.toString("ascii", at, at + keyRefLength);
  at += keyRefLength;
  need(2);
  const wrappedLength = input.readUInt16BE(at);
  at += 2;
  need(wrappedLength + IV_BYTES + TAG_BYTES + 4);
  const wrappedDek = new Uint8Array(input.subarray(at, (at += wrappedLength)));
  const iv = new Uint8Array(input.subarray(at, (at += IV_BYTES)));
  const authTag = new Uint8Array(input.subarray(at, (at += TAG_BYTES)));
  const ciphertextLength = input.readUInt32BE(at);
  at += 4;
  if (at + ciphertextLength !== input.length) malformed();
  const ciphertext = new Uint8Array(input.subarray(at, at + ciphertextLength));
  return assertEnvelopeV1({ formatVersion, algorithm, kekProvider, keyRef, contextVersion, wrappedDek, iv, ciphertext, authTag });
}
