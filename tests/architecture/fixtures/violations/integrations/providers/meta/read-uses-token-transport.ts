/** Violation: Meta read code never reaches the authorization-code exchange or its App Secret path. */
import { createMetaTokenTransport } from "./oauth-transport";
export const leaked = createMetaTokenTransport;
