/** Allowed: the web composition root seals with the local sealer. */
import { local_sealer } from "../platform/crypto/credentials/local-sealer";
import { seal } from "../platform/crypto/credentials/seal";
export const composed = [local_sealer, seal];
