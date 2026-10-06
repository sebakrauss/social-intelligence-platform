/**
 * Keyring ports (TA-Q-07): the two halves of key management are separate capabilities, mirroring the
 * validated KMS split (web principal: GenerateDataKey only; integration principal: Decrypt).
 *
 *   DataKeyGenerator  fresh 256-bit data key + the same key wrapped by the KEK (sealing side)
 *   DataKeyUnwrapper  wrapped data key → data key (opening side; job runtime only)
 *
 * Both bind the wrapping to the caller's AAD (header + credential context). Implementations: the local
 * keyring (local/test only) now; the AWS KMS adapter later (slice 5I).
 */
import type { KekProvider } from "./envelope";

export interface GeneratedDataKey {
  /** Plaintext data key; the caller owns it and zeroes it after use. */
  readonly dek: Buffer;
  readonly wrappedDek: Uint8Array;
}

export interface DataKeyGenerator {
  readonly kekProvider: KekProvider;
  readonly keyRef: string;
  generateDataKey(additionalData: Uint8Array): Promise<GeneratedDataKey>;
}

export interface DataKeyUnwrapper {
  readonly kekProvider: KekProvider;
  /** Returns the plaintext data key; the caller owns it and zeroes it after use. */
  unwrapDataKey(input: { readonly keyRef: string; readonly wrappedDek: Uint8Array; readonly additionalData: Uint8Array }): Promise<Buffer>;
}
