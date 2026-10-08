/**
 * KMS composition of the OPENING half (Step 7D): Decrypt unwrapper → CredentialOpener. Job runtime only, and there
 * only the integration composition (boundary rules), like the unwrapper and the local opener.
 */
import type { KmsKeyringConfig } from "./aws-kms-config";
import { createKmsDataKeyUnwrapper, type KmsDecryptSender } from "./aws-kms-unwrapper";
import { createCredentialOpener, type CredentialOpener } from "./open";

export function kmsCredentialOpener(sender: KmsDecryptSender, config: KmsKeyringConfig): CredentialOpener {
  return createCredentialOpener(createKmsDataKeyUnwrapper(sender, { keyRef: config.logicalKeyRef, allowedKeyArns: [...config.allowedKeyArns] }));
}
