/**
 * Violation (Step 7G-H5.5-P5-B): the read_content validation diagnostic reads one account and calls the Meta READ port
 * only — never the capability module, the Move saga, the mutation executor, the OAuth transport or the mutation port.
 */
import { capabilityApi } from "../modules/capability/index";
import { leaked as moves } from "./moves";
import { execute } from "../mutations/executor";
import { createMetaTokenTransport } from "../integrations/providers/meta/oauth-transport";
import type { MutationPort } from "../integrations/providers/contract/mutation-port";
export const leaked: unknown[] = [capabilityApi, moves, execute, createMetaTokenTransport];
export type Leaked = MutationPort;
