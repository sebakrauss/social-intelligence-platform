/**
 * CredentialOpener — the opening half of the credential boundary (TA §39; ADR-64). Job runtime only:
 * boundary rules keep it out of app/, ui/ and server/ (the web deployment never decrypts).
 *
 * open(envelope, context, use):
 *   1. validate the envelope (version, algorithm, lengths; fail closed) and the context;
 *   2. refuse envelopes from another KEK provider;
 *   3. unwrap the data key under the header + context binding — a wrong workspace_id or credential_id fails here;
 *   4. decrypt and authenticate the payload under AAD = header + context;
 *   5. hand the plaintext to `use` for the duration of the call, then zero it and the data key.
 * The plaintext never outlives `use` unless the callback copies it. Nothing is cached.
 */
import { decrypt, payloadAad, zero } from "./aead";
import { parseCredentialContext, type CredentialContext } from "./context";
import { DEK_BYTES, assertEnvelopeV1, type EnvelopeV1 } from "./envelope";
import { CredentialCryptoError, isCredentialCryptoError } from "./errors";
import type { DataKeyUnwrapper } from "./keyring";

export interface CredentialOpener {
  open<T>(envelope: EnvelopeV1, context: CredentialContext, use: (plaintext: Uint8Array) => T | Promise<T>): Promise<T>;
}

export function createCredentialOpener(unwrapper: DataKeyUnwrapper): CredentialOpener {
  async function open<T>(envelope: EnvelopeV1, context: CredentialContext, use: (plaintext: Uint8Array) => T | Promise<T>): Promise<T> {
    const e = assertEnvelopeV1(envelope);
    const checked = parseCredentialContext(context);
    if (e.kekProvider !== unwrapper.kekProvider) throw new CredentialCryptoError("KEYRING_MISMATCH");
    const header = Object.freeze({ kekProvider: e.kekProvider, keyRef: e.keyRef });
    let dek: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      try {
        dek = await unwrapper.unwrapDataKey({ header, context: checked, wrappedDek: e.wrappedDek });
      } catch (error) {
        throw isCredentialCryptoError(error) ? error : new CredentialCryptoError("KEYRING_UNAVAILABLE");
      }
      if (dek.byteLength !== DEK_BYTES) throw new CredentialCryptoError("INTEGRITY_FAILURE");
      plaintext = decrypt(dek, e, payloadAad(header, checked));
      zero(dek);
      dek = undefined;
      return await use(plaintext);
    } finally {
      zero(dek);
      zero(plaintext);
    }
  }

  return Object.freeze({ open });
}
