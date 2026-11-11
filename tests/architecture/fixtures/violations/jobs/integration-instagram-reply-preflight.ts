/**
 * Violation (Step 7B-14C1): the Instagram reply preflight diagnostic reads one account and one comment through the Meta
 * read-only preflight reader only — never the capability module, the mutation executor, the Meta mutation port, the
 * Graph transport directly, or the contract mutation port.
 */
import { capabilityApi } from "../modules/capability/index";
import { execute } from "../mutations/executor";
import { createMetaMutationPort } from "../integrations/providers/meta/mutation-port";
import { createMetaGraphTransport } from "../integrations/providers/meta/graph-transport";
import type { MutationPort } from "../integrations/providers/contract/mutation-port";
export const leaked: unknown[] = [capabilityApi, execute, createMetaMutationPort, createMetaGraphTransport];
export type Leaked = MutationPort;
