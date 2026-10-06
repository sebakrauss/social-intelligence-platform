/** Violation: provider adapters never touch credential crypto. */
import { seal } from "../../../platform/crypto/credentials/seal";
export const sealing = seal;
