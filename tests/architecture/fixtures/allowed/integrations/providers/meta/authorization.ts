/** Allowed: the Meta authorization adapter reaches its own token transport, endpoints and the provider contract. */
import { createMetaTokenTransport } from "./oauth-transport";
import { META_DIALOG_URL } from "./endpoints";
export const createMetaAuthorizationPort = [createMetaTokenTransport, META_DIALOG_URL];
