/**
 * System scope (TA §9.3): the system login role, switched by fixed literal to app_system, which reaches
 * system tables only (outbox delivery metadata, run history, global switches) and no tenant content.
 *
 * Deliberately NOT exported from platform/db's index: only the named system jobs (platform/outbox relay
 * and sweepers, platform/jobs system wrapper) may import it, enforced by a dependency rule. There is no
 * generic privileged helper.
 */
import { sql } from "drizzle-orm";
import type { RuntimeDatabase } from "./pool";
import { assertKind, type DatabaseTransaction } from "./scopes";

export async function withSystemScope<T>(database: RuntimeDatabase<"system">, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  assertKind(database, "system");
  return database.db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_system`);
    return work(tx);
  });
}
