/**
 * Deterministic byte form of a normalized ProviderCredential, sealed as provider-credential plaintext (TA §39):
 *
 *   0x01 · u8 idLength · id (ASCII, 1–128) · secret (UTF-8, ≥ 1 byte)
 *
 * The secret is turned into a mutable byte buffer straight from the adapter's SecretValue (one UTF-8 encode; no
 * intermediate string copies); the encoded buffer belongs to the caller, who seals it and zeroes it at once.
 * Decoding happens only inside the job-side credential-access function, on the opener's plaintext buffer, which
 * the opener zeroes after use. The SecretValue it rebuilds is string-based by the Step 4/5C contract.
 */
import { providerCredential, type ProviderCredential } from "@/integrations/providers/contract";

export const CREDENTIAL_CODEC_VERSION = 0x01;
const MAX_ID_BYTES = 128;

export class CredentialCodecError extends Error {
  override readonly name = "CredentialCodecError";
  constructor() {
    super("credential_codec_malformed");
  }
}

/** Mutable bytes the caller must zero after sealing. */
export function encodeProviderCredential(credential: ProviderCredential): Uint8Array {
  const id = new TextEncoder().encode(credential.id);
  const secret = new TextEncoder().encode(credential.secret.expose());
  try {
    if (id.byteLength === 0 || id.byteLength > MAX_ID_BYTES || secret.byteLength === 0) throw new CredentialCodecError();
    const out = new Uint8Array(2 + id.byteLength + secret.byteLength);
    out[0] = CREDENTIAL_CODEC_VERSION;
    out[1] = id.byteLength;
    out.set(id, 2);
    out.set(secret, 2 + id.byteLength);
    return out;
  } finally {
    secret.fill(0);
  }
}

export function decodeProviderCredential(bytes: Uint8Array): ProviderCredential {
  const idLength = bytes[1] ?? 0;
  if (bytes[0] !== CREDENTIAL_CODEC_VERSION || idLength === 0 || idLength > MAX_ID_BYTES || bytes.byteLength <= 2 + idLength) {
    throw new CredentialCodecError();
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return providerCredential(decoder.decode(bytes.subarray(2, 2 + idLength)), decoder.decode(bytes.subarray(2 + idLength)));
  } catch {
    throw new CredentialCodecError();
  }
}
