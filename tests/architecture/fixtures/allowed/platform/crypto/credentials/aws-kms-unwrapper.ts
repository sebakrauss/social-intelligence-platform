/** Allowed fixture stand-in for platform/crypto/credentials/aws-kms-unwrapper.ts: the KMS SDK is its to import. */
import { DecryptCommand } from "@aws-sdk/client-kms";
export const kms_unwrapper = DecryptCommand;
