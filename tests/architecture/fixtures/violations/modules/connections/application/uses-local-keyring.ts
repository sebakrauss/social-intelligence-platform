/** Violation: modules never select the local keyring (composition roots do). */
import { local_sealer } from "../../../platform/crypto/credentials/local-sealer";
export const selected = local_sealer;
