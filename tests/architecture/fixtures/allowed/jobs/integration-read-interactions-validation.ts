/**
 * Allowed (Step 7G-H5.5-P12-B2): the read_interactions validation diagnostic composes through the integration
 * composition (which builds the Meta read port), reads the two server/connections configuration modules and the Meta
 * endpoints.
 */
import { composed } from "./connections";
import { selectCredentialCrypto } from "../server/connections/environment";
import { PROVIDER_MODE_VARIABLES } from "../server/connections/provider-mode";
import { META_DIALOG_URL } from "../integrations/providers/meta/endpoints";
export const diagnostic: unknown[] = [composed, selectCredentialCrypto, PROVIDER_MODE_VARIABLES, META_DIALOG_URL];
