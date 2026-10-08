/** Violation: the web deployment never composes the KMS opener (it seals only). */
import { kms_opener } from "../platform/crypto/credentials/aws-kms-opener";
export const leaked = kms_opener;
