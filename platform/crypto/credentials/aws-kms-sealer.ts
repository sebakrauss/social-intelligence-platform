/**
 * KMS composition of the SEALING half only (Step 7D): GenerateDataKey generator → CredentialSealer. Web and
 * integration-worker composition roots may use it; it returns nothing that can unwrap or decrypt.
 */
import type { KmsKeyringConfig } from "./aws-kms-config";
import { createKmsDataKeyGenerator, type KmsGenerateDataKeySender } from "./aws-kms-generator";
import { createCredentialSealer, type CredentialSealer } from "./seal";

export function kmsCredentialSealer(sender: KmsGenerateDataKeySender, config: KmsKeyringConfig): CredentialSealer {
  return createCredentialSealer(createKmsDataKeyGenerator(sender, { keyRef: config.logicalKeyRef, currentKeyArn: config.currentKeyArn }));
}
