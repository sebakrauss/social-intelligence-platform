/** Violation: the hosted web never composes the Meta read port (integration worker only). */
import { createMetaReadPort } from "../integrations/providers/meta/read-port";
export const leaked = createMetaReadPort;
