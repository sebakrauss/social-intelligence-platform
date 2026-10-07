/** Violation: provider adapters never see OAuth state secrets or the PKCE key. */
import { pkceDeriver } from "../../../platform/crypto/oauth";
export const leaked = pkceDeriver;
