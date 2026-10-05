// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
// Allowed: platform/db is the only place connections are created.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export const database = drizzle(new pg.Pool());