// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation: only platform/db creates database connections (raw driver).
import pg from "pg";

export const pool = new pg.Pool();