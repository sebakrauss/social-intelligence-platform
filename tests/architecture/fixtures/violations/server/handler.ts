// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { value } from "../jobs/run";
import type { MutationPort } from "../integrations/providers/contract/mutation-port";
export const handled: [number, MutationPort | undefined] = [value, undefined];
