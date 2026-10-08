/**
 * AWS KMS data-key UNWRAPPER — the opening half of the KMS keyring (Step 7C; TA §39, ADR-64). Job runtime only, and
 * there only the integration composition (boundary rules): the web deployment and system jobs never decrypt.
 *
 *   request   CiphertextBlob = the wrapped data key · EncryptionContext = the six context fields from the CALLER
 *             (the credential row's location). NO KeyId: for a symmetric ciphertext KMS identifies the physical key
 *             from the blob itself; nothing is derived from the logical keyRef.
 *   response  Plaintext of exactly 32 bytes, and a KeyId that is an exact member of the configured allowlist.
 *
 * The allowlist is what lets envelopes wrapped by an old and a new physical key coexist while a controlled
 * ReEncrypt migration runs, with the envelope's logical keyRef unchanged. A key outside the allowlist (or an
 * unexpected algorithm) is refused after zeroing the returned plaintext. The sender is injected; no client is
 * built here.
 */
import { DecryptCommand, type DecryptCommandOutput } from "@aws-sdk/client-kms";
import {
  KMS_KEK_PROVIDER,
  assertOwnHeader,
  checkedKeyArns,
  checkedLogicalKeyRef,
  kmsEncryptionContext,
  normalizedKmsFailure,
  takeDataKey,
  zeroBytes,
} from "./aws-kms-common";
import { CredentialCryptoError } from "./errors";
import type { DataKeyUnwrapRequest, DataKeyUnwrapper } from "./keyring";

/** The one KMS operation this capability needs. A KMSClient satisfies it; tests inject a fake. */
export interface KmsDecryptSender {
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

export interface KmsDataKeyUnwrapperConfig {
  /** The logical KEK reference this keyring opens (envelope header). */
  readonly keyRef: string;
  /** Physical KMS key ARNs whose ciphertexts are accepted (current + not-yet-migrated). Never in an envelope. */
  readonly allowedKeyArns: readonly string[];
}

export function createKmsDataKeyUnwrapper(sender: KmsDecryptSender, config: KmsDataKeyUnwrapperConfig): DataKeyUnwrapper {
  const keyRef = checkedLogicalKeyRef(config.keyRef);
  const allowed = checkedKeyArns(config.allowedKeyArns);

  async function unwrapDataKey(request: DataKeyUnwrapRequest): Promise<Buffer> {
    assertOwnHeader(request.header, keyRef);
    const encryptionContext = kmsEncryptionContext(request.context);
    if (!(request.wrappedDek instanceof Uint8Array) || request.wrappedDek.byteLength === 0) throw new CredentialCryptoError("INTEGRITY_FAILURE");
    const command = new DecryptCommand({ CiphertextBlob: request.wrappedDek, EncryptionContext: { ...encryptionContext } });
    let output: DecryptCommandOutput;
    try {
      output = await sender.send(command);
    } catch (error) {
      throw normalizedKmsFailure(error);
    }
    try {
      if (typeof output.KeyId !== "string" || !allowed.has(output.KeyId)) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
      if (output.EncryptionAlgorithm !== undefined && output.EncryptionAlgorithm !== "SYMMETRIC_DEFAULT") throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
      return takeDataKey(output.Plaintext);
    } catch (error) {
      zeroBytes(output.Plaintext);
      throw normalizedKmsFailure(error);
    }
  }

  return Object.freeze({ kekProvider: KMS_KEK_PROVIDER, unwrapDataKey });
}
