/**
 * Keyring ports (TA-Q-07; refined in Step 7B): the two halves of key management are separate capabilities,
 * mirroring the validated KMS split (web principal: GenerateDataKey only; integration principal: Decrypt).
 *
 *   DataKeyGenerator  fresh 256-bit data key + the same key wrapped by the KEK (sealing side)
 *   DataKeyUnwrapper  wrapped data key → data key (opening side; job runtime only)
 *
 * Both receive the STRUCTURED binding — the envelope header and the validated six-field CredentialContext — never
 * pre-serialized bytes, so each implementation binds the wrapping its own way:
 *   - the local keyring derives its AES-GCM wrap AAD from header + context (dekWrapAad);
 *   - a key-service adapter passes exactly the six context fields as the service's encryption context and adds
 *     nothing. The context always comes from the caller (the credential row's location), never from the envelope.
 *
 * The header's keyRef is LOGICAL (key-ref.ts). An unwrapper doesn't derive a physical key from it: a KMS adapter sends
 * the wrapped key and the context, lets the service identify the physical key from the ciphertext, and accepts the
 * answer only if the returned key is in its configured allowlist — so old and new physical keys both work during a
 * re-wrap migration while every envelope header stays unchanged.
 *
 * Implementations fail with CredentialCryptoError only (normalized codes, errors.ts).
 */
import type { CredentialContext } from "./context";
import type { EnvelopeHeader, KekProvider } from "./envelope";

/** What binds one data key to one credential: the authenticated header and the caller's validated context. */
export interface DataKeyBinding {
  readonly header: EnvelopeHeader;
  readonly context: CredentialContext;
}

export interface GeneratedDataKey {
  /** Plaintext data key; the caller owns it and zeroes it after use. */
  readonly dek: Buffer;
  readonly wrappedDek: Uint8Array;
}

export interface DataKeyGenerator {
  readonly kekProvider: KekProvider;
  /** The logical KEK reference written into every header this generator seals. */
  readonly keyRef: string;
  generateDataKey(binding: DataKeyBinding): Promise<GeneratedDataKey>;
}

export interface DataKeyUnwrapRequest extends DataKeyBinding {
  readonly wrappedDek: Uint8Array;
}

export interface DataKeyUnwrapper {
  readonly kekProvider: KekProvider;
  /** Returns the plaintext data key; the caller owns it and zeroes it after use. */
  unwrapDataKey(request: DataKeyUnwrapRequest): Promise<Buffer>;
}
