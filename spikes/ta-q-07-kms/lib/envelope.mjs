/**
 * Local half of the envelope: AES-256-GCM with a 96-bit random IV, a 128-bit tag and the canonical
 * encryption context as AAD (defense in depth on top of the KMS context binding). Buffers only, never
 * strings, so plaintext and DEKs can be zeroed after use.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const TAG_LENGTH = 16;

export function named(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** Stable serialization: keys sorted, values as given. */
export function canonicalContext(context) {
  return JSON.stringify(Object.keys(context).sort().map((key) => [key, context[key]]));
}

/** Shares memory with the SDK's Uint8Array, so zeroing one zeroes both. */
export function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function zero(buffer) {
  buffer.fill(0);
  return buffer.every((byte) => byte === 0);
}

/** In-memory comparison aid only; never printed or persisted. */
export function fingerprint(buffer) {
  return createHash("sha256").update(buffer).digest();
}

export function seal(dek, plaintext, context) {
  if (dek.length !== 32) throw named("InvalidDekLength");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(canonicalContext(context), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

/** Returns the plaintext Buffer; any authentication failure surfaces as `AuthenticationFailed`. */
export function open(dek, envelope, context) {
  try {
    const decipher = createDecipheriv(ALGORITHM, dek, envelope.iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(Buffer.from(canonicalContext(context), "utf8"));
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  } catch {
    throw named("AuthenticationFailed");
  }
}

/** Copy of the envelope with one bit flipped in the named field. */
export function tamper(envelope, field) {
  const copy = { iv: Buffer.from(envelope.iv), ciphertext: Buffer.from(envelope.ciphertext), tag: Buffer.from(envelope.tag) };
  copy[field][0] ^= 0x01;
  return copy;
}
