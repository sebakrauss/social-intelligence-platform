/**
 * CredentialSealer — the sealing half of the credential boundary (TA §39; ADR-64). The web deployment may
 * hold a sealer; it has no open/decrypt capability, by type and at runtime.
 *
 * seal(plaintext, context):
 *   1. validate the context (workspace_id + credential_id binding) and the plaintext bounds;
 *   2. obtain a FRESH 256-bit data key and its KEK-wrapped form, bound to header + context (AAD);
 *   3. AES-256-GCM-encrypt the plaintext with a random 96-bit IV, AAD = header + context;
 *   4. zero the data key (success or failure). The caller owns `plaintext` and should zero it afterwards.
 */
import { dekWrapAad, encrypt, payloadAad, zero } from "./aead";
import { parseCredentialContext, type CredentialContext } from "./context";
import {
  DEK_BYTES,
  ENVELOPE_ALGORITHM,
  ENVELOPE_CONTEXT_VERSION,
  ENVELOPE_FORMAT_VERSION,
  MAX_PLAINTEXT_BYTES,
  isKeyRef,
  type EnvelopeV1,
} from "./envelope";
import { CredentialCryptoError, isCredentialCryptoError } from "./errors";
import type { DataKeyGenerator } from "./keyring";

export interface CredentialSealer {
  seal(plaintext: Uint8Array, context: CredentialContext): Promise<EnvelopeV1>;
}

export function createCredentialSealer(generator: DataKeyGenerator): CredentialSealer {
  if (!isKeyRef(generator.keyRef)) throw new CredentialCryptoError("KEYRING_UNAVAILABLE");
  const header = { kekProvider: generator.kekProvider, keyRef: generator.keyRef };

  async function seal(plaintext: Uint8Array, context: CredentialContext): Promise<EnvelopeV1> {
    const checked = parseCredentialContext(context);
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength === 0 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new CredentialCryptoError("INVALID_PLAINTEXT");
    }
    let dek: Buffer | undefined;
    try {
      let generated;
      try {
        generated = await generator.generateDataKey(dekWrapAad(header, checked));
      } catch (error) {
        throw isCredentialCryptoError(error) ? error : new CredentialCryptoError("KEYRING_UNAVAILABLE");
      }
      dek = generated.dek;
      if (dek.byteLength !== DEK_BYTES) throw new CredentialCryptoError("KEYRING_UNAVAILABLE");
      const sealed = encrypt(dek, plaintext, payloadAad(header, checked));
      return Object.freeze({
        formatVersion: ENVELOPE_FORMAT_VERSION,
        algorithm: ENVELOPE_ALGORITHM,
        kekProvider: header.kekProvider,
        keyRef: header.keyRef,
        contextVersion: ENVELOPE_CONTEXT_VERSION,
        wrappedDek: new Uint8Array(generated.wrappedDek),
        iv: new Uint8Array(sealed.iv),
        ciphertext: new Uint8Array(sealed.ciphertext),
        authTag: new Uint8Array(sealed.authTag),
      });
    } finally {
      zero(dek);
    }
  }

  // Exactly one capability: the object exposes `seal` and nothing that can unwrap or decrypt.
  return Object.freeze({ seal });
}
