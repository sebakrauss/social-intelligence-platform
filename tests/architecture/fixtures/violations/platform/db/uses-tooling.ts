// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation: privileged migration tooling is never imported by runtime code.
import { migrate } from "../../tools/db/migrate";

export const run = migrate;