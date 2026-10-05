// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation: module persistence receives scoped transactions; it never constructs a connection.
import { drizzle } from "drizzle-orm/node-postgres";

export const connect = drizzle;