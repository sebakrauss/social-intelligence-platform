// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import type { MutationPort } from "../contract/mutation-port";
export const adapter: MutationPort = { hide: () => undefined };
