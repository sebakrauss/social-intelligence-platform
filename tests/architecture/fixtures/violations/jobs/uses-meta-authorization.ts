/** Violation: the job runtime never composes the Meta authorization adapter or its token transport (App Secret path). */
import { createMetaAuthorizationPort } from "../integrations/providers/meta/authorization";
import { createMetaTokenTransport } from "../integrations/providers/meta/oauth-transport";
export const leaked = [createMetaAuthorizationPort, createMetaTokenTransport];
