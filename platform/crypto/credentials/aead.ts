/**
 * AES-256-GCM primitives shared by the credential envelope and the local keyring (internal to
 * platform/crypto/credentials). 96-bit IVs and 128-bit tags only. Every failure surfaces as a normalized
 * INTEGRITY_FAILURE; crypto-library messages never escape. Buffers holding secrets are zeroed by callers.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canonicalContextBytes, type CredentialContext } from "./context";
import { DEK_BYTES, IV_BYTES, TAG_BYTES, headerBytes, type EnvelopeHeader } from "./envelope";
import { CredentialCryptoError } from "./errors";

const CIPHER = "aes-256-gcm";
const PAYLOAD_DOMAIN = Buffer.from("sip.credential.payload.v1\n", "utf8");
const DEK_WRAP_DOMAIN = Buffer.from("sip.credential.dek-wrap.v1\n", "utf8");
const SEPARATOR = Buffer.from("\n", "utf8");

/** Best effort: zeroes a mutable buffer we own. (JS strings are immutable and can't be erased.) */
export function zero(buffer: Uint8Array | undefined): void {
  buffer?.fill(0);
}

function aad(domain: Buffer, header: EnvelopeHeader, context: CredentialContext): Buffer {
  return Buffer.concat([domain, headerBytes(header), SEPARATOR, canonicalContextBytes(context)]);
}

/** AAD binding the encrypted payload to header + context. */
export const payloadAad = (header: EnvelopeHeader, context: CredentialContext): Buffer => aad(PAYLOAD_DOMAIN, header, context);
/** AAD binding the wrapped data key to header + context (domain-separated from the payload AAD). */
export const dekWrapAad = (header: EnvelopeHeader, context: CredentialContext): Buffer => aad(DEK_WRAP_DOMAIN, header, context);

export function newDataKey(): Buffer {
  return randomBytes(DEK_BYTES);
}

export interface Sealed {
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

export function encrypt(key: Uint8Array, plaintext: Uint8Array, additionalData: Uint8Array): Sealed {
  if (key.byteLength !== DEK_BYTES) throw new CredentialCryptoError("KEYRING_UNAVAILABLE");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
}

/** Returns a fresh Buffer the caller owns and must zero. Any authentication failure → INTEGRITY_FAILURE. */
export function decrypt(key: Uint8Array, sealed: { readonly iv: Uint8Array; readonly ciphertext: Uint8Array; readonly authTag: Uint8Array }, additionalData: Uint8Array): Buffer {
  if (key.byteLength !== DEK_BYTES || sealed.iv.byteLength !== IV_BYTES || sealed.authTag.byteLength !== TAG_BYTES) {
    throw new CredentialCryptoError("INTEGRITY_FAILURE");
  }
  let head: Buffer | undefined;
  let tail: Buffer | undefined;
  try {
    const decipher = createDecipheriv(CIPHER, key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData);
    decipher.setAuthTag(sealed.authTag);
    head = decipher.update(sealed.ciphertext);
    tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch {
    throw new CredentialCryptoError("INTEGRITY_FAILURE");
  } finally {
    zero(head);
    zero(tail);
  }
}
