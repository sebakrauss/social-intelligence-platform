/** Violation: core credential crypto (envelope, context, key-ref, shared KMS mapping) never imports the KMS SDK. */
import { DecryptCommand } from "@aws-sdk/client-kms";
export const leaked = DecryptCommand;
