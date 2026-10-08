/** Allowed fixture stand-in for platform/crypto/credentials/aws-kms-generator.ts: the KMS SDK is its to import. */
import { GenerateDataKeyCommand } from "@aws-sdk/client-kms";
export const kms_generator = GenerateDataKeyCommand;
