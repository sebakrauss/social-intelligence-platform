// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
// Allowed: database tests use the driver for bootstrap and the tooling to migrate.
import pg from "pg";
import { client } from "../../tools/db/migrate";

export const fixtures = { pg, client };