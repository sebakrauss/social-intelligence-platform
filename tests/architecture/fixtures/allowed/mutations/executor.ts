// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import type { MutationPort } from "../integrations/providers/contract/mutation-port";
export const execute = (port: MutationPort): void => { port.hide(); };
