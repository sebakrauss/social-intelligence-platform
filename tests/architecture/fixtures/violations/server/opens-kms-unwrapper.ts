/** Violation: the web deployment never holds the KMS unwrapper (it seals only). */
import { kms_unwrapper } from "../platform/crypto/credentials/aws-kms-unwrapper";
export const leaked = kms_unwrapper;
