// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
// Allowed: migration tooling uses the driver and the connection guards directly.
import pg from "pg";

export const client = new pg.Client();