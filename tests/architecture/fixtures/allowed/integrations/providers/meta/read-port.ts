/** Allowed: the Meta read port reaches its Graph transport and the fixed endpoints. */
import { createMetaGraphTransport } from "./graph-transport";
import { META_DIALOG_URL } from "./endpoints";
export const createMetaReadPort = [createMetaGraphTransport, META_DIALOG_URL];
