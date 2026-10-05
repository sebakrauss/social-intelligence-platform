// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { createHash } from "node:crypto";
export const digest: unknown = createHash;
