/** Allowed (Step 7B-14C1): the read-only preflight reader reaches the Graph READ transport and the fixed endpoints. */
import { createMetaGraphTransport } from "./graph-transport";
import { META_DIALOG_URL } from "./endpoints";
export const createInstagramReplyPreflight: unknown[] = [createMetaGraphTransport, META_DIALOG_URL];
export interface InstagramReplyPreflight { readonly inspect: unknown }
