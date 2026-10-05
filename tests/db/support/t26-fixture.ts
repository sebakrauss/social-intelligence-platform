import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

/** Applies the idempotent, test-only T-26 fixture (tests/db/support/t26-fixture.sql) as the migration role. */
export function applyT26Fixture(client: pg.Client): Promise<unknown> {
  return client.query(readFileSync(path.join(import.meta.dirname, "t26-fixture.sql"), "utf8"));
}
