/** Allowed: the job runtime opens credentials. */
import { local_opener } from "../platform/crypto/credentials/local-opener";
import { open } from "../platform/crypto/credentials/open";
export const composed = [local_opener, open];
