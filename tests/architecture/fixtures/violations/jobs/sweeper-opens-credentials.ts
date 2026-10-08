/** Violation: a system job (relay, sweeper) is job runtime, but never the integration composition that opens credentials. */
import { kms_opener } from "../platform/crypto/credentials/aws-kms-opener";
import { kms_unwrapper } from "../platform/crypto/credentials/aws-kms-unwrapper";
import { local_opener } from "../platform/crypto/credentials/local-opener";
import { open } from "../platform/crypto/credentials/open";
export const leaked = [kms_opener, kms_unwrapper, local_opener, open];
