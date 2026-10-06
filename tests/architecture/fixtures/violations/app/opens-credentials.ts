/** Violation: app/ must never open credentials (nor pick the local keyring). */
import { local_opener } from "../platform/crypto/credentials/local-opener";
export const leaked = local_opener;
