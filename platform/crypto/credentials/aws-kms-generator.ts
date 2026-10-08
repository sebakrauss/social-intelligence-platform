/**
 * AWS KMS data-key GENERATOR — the sealing half of the KMS keyring (Step 7C; TA §39, ADR-64). It can only ask KMS
 * for a fresh data key (GenerateDataKey) under the configured CURRENT physical key; it has no decrypt or unwrap
 * capability, so it may be composed into the web deployment (seal-only principal) as well as the worker.
 *
 *   request   KeyId = current key ARN · KeySpec = AES_256 · EncryptionContext = the six context fields, nothing else
 *   response  Plaintext of exactly 32 bytes · a non-empty CiphertextBlob · KeyId equal to the current key ARN
 *   envelope  receives the LOGICAL keyRef (header) and the CiphertextBlob (wrapped data key) — never the ARN
 *
 * The plaintext data key is handed to the sealer as a Buffer view over the SDK's own bytes (no copy); the sealer
 * zeroes it. Any failure after KMS answered zeroes it here first. The sender is injected; no client is built here.
 */
import { GenerateDataKeyCommand, type GenerateDataKeyCommandOutput } from "@aws-sdk/client-kms";
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
import type { DataKeyBinding, DataKeyGenerator, GeneratedDataKey } from "./keyring";

/** The one KMS operation this capability needs. A KMSClient satisfies it; tests inject a fake. */
export interface KmsGenerateDataKeySender {
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
}

export interface KmsDataKeyGeneratorConfig {
  /** Logical KEK reference written into every envelope header (key-ref.ts). */
  readonly keyRef: string;
  /** The physical KMS key ARN new data keys are generated under. Never written into an envelope. */
  readonly currentKeyArn: string;
}

export function createKmsDataKeyGenerator(sender: KmsGenerateDataKeySender, config: KmsDataKeyGeneratorConfig): DataKeyGenerator {
  const keyRef = checkedLogicalKeyRef(config.keyRef);
  const [currentKeyArn] = checkedKeyArns([config.currentKeyArn]);
  if (currentKeyArn === undefined) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");

  async function generateDataKey(binding: DataKeyBinding): Promise<GeneratedDataKey> {
    assertOwnHeader(binding.header, keyRef);
    const command = new GenerateDataKeyCommand({ KeyId: currentKeyArn, KeySpec: "AES_256", EncryptionContext: { ...kmsEncryptionContext(binding.context) } });
    let output: GenerateDataKeyCommandOutput;
    try {
      output = await sender.send(command);
    } catch (error) {
      throw normalizedKmsFailure(error);
    }
    try {
      if (output.KeyId !== currentKeyArn) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
      const blob = output.CiphertextBlob;
      if (!(blob instanceof Uint8Array) || blob.byteLength === 0) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
      return { dek: takeDataKey(output.Plaintext), wrappedDek: new Uint8Array(blob) };
    } catch (error) {
      zeroBytes(output.Plaintext);
      throw normalizedKmsFailure(error);
    }
  }

  return Object.freeze({ kekProvider: KMS_KEK_PROVIDER, keyRef, generateDataKey });
}
