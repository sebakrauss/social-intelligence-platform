/** Violation: a system job (relay, sweeper) is job runtime, but never the integration composition that opens credentials. */
import { local_opener } from "../platform/crypto/credentials/local-opener";
import { open } from "../platform/crypto/credentials/open";
export const leaked = [local_opener, open];
