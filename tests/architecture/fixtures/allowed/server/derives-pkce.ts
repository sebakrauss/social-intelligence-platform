/** Allowed: the web composition derives PKCE statelessly (Step 5D, B1). */
import { pkceDeriver } from "../platform/crypto/oauth";
export const composed = pkceDeriver;
