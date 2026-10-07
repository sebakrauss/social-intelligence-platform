/** Violation: modules get the OAuthSecrets port, never the key-bearing module. */
import { pkceDeriver } from "../../../platform/crypto/oauth";
export const leaked = pkceDeriver;
