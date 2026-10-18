/** Violation: Meta authorization code never reaches the Graph read transport. */
import { createMetaGraphTransport } from "./graph-transport";
export const leaked = createMetaGraphTransport;
