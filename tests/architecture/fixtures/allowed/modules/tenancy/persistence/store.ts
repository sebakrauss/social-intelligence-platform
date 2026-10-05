// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
// Allowed: module persistence uses the query builder inside a scoped transaction from platform/db.
import { eq } from "drizzle-orm";
import { database } from "../../../platform/db/pool";

export const byId = { eq, database };