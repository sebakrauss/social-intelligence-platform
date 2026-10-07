/** Violation: the PKCE derivation key is a web secret; the job runtime never reaches it. */
import { pkceDeriver } from "../platform/crypto/oauth";
export const leaked = pkceDeriver;
