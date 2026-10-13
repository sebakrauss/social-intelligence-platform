/**
 * Allowed (Step 7E.7-B/-R4): the KMS worker-auth diagnostic module opens through the integration composition and reads
 * exactly the two server/connections configuration modules it needs.
 */
import { open } from "./connections";
import { selectCredentialCrypto } from "../server/connections/environment";
import { PROVIDER_MODE_VARIABLES } from "../server/connections/provider-mode";
export const diagnostic: unknown[] = [open, selectCredentialCrypto, PROVIDER_MODE_VARIABLES];
