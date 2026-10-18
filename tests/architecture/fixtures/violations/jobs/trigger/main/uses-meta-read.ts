/** Violation: the MAIN plane never reaches the Meta read port or its Graph transport. */
import { createMetaReadPort } from "../../../integrations/providers/meta/read-port";
import { createMetaGraphTransport } from "../../../integrations/providers/meta/graph-transport";
export const leaked = [createMetaReadPort, createMetaGraphTransport];
