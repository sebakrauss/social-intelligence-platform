/** Allowed: the web composition root seals — with the local sealer, or (later) the KMS data-key generator. */
import { kms_generator } from "../platform/crypto/credentials/aws-kms-generator";
import { local_sealer } from "../platform/crypto/credentials/local-sealer";
import { seal } from "../platform/crypto/credentials/seal";
export const composed = [kms_generator, local_sealer, seal];
