/** Violation: the AWS identity contract never depends on credential crypto (or KMS, Vercel, STS, any package). */
import { seal } from "../crypto/credentials/seal";
export const leaked = seal;
