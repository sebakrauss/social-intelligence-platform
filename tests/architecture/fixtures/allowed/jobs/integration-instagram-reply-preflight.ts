/**
 * Allowed (Step 7B-14C1): the Instagram reply preflight diagnostic composes through the integration composition, reads
 * the two server/connections configuration modules and its own read-only lookup, and types the Meta preflight reader.
 */
import { composed } from "./connections";
import { selectCredentialCrypto } from "../server/connections/environment";
import { PROVIDER_MODE_VARIABLES } from "../server/connections/provider-mode";
import { instagramReplyPreflightLookup } from "../server/persistence/instagram-reply-preflight";
import type { InstagramReplyPreflight } from "../integrations/providers/meta/instagram-reply-preflight";
import { META_DIALOG_URL } from "../integrations/providers/meta/endpoints";
export const diagnostic: unknown[] = [composed, selectCredentialCrypto, PROVIDER_MODE_VARIABLES, instagramReplyPreflightLookup, META_DIALOG_URL];
export type Reader = InstagramReplyPreflight;
