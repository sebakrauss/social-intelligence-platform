/** Allowed: the job runtime's integration composition (jobs/connections.ts) opens credentials, locally or via KMS. */
import { kms_opener } from "../platform/crypto/credentials/aws-kms-opener";
import { kms_unwrapper } from "../platform/crypto/credentials/aws-kms-unwrapper";
import { local_opener } from "../platform/crypto/credentials/local-opener";
import { open } from "../platform/crypto/credentials/open";
export const composed = [kms_opener, kms_unwrapper, local_opener, open];
