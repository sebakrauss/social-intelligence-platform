/**
 * Inbox read access to persisted deterministic signals (Step 7A; migration 0024). Runs inside the caller's USER-scoped
 * transaction: 0024's member_read policy admits the bound workspace's non-guest members only. Reads the signal kinds of
 * the given interactions and nothing else — no spans (they index into text), no watch-term identity, no assessment.
 */
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import type { PersistedSignalRow, SignalReadStore } from "../application/ports";

/** Canonical UUID shape (the persistence layer may import nothing but drizzle, platform/db and its own module). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createPostgresSignalReadStore(tx: DatabaseTransaction): SignalReadStore {
  return {
    async forInteractions(interactionIds) {
      // One bound parameter per id (the driver would serialize a JS array as text, not as a uuid[]); ids are canonical UUIDs.
      const ids = [...new Set(interactionIds)].filter((id) => UUID.test(id)).slice(0, 500);
      if (ids.length === 0) return [];
      const result = await tx.execute<{ interaction_id: string; source_text_version_id: string; kind: string }>(sql`
        select distinct interaction_id, source_text_version_id, kind
          from classification.signals
         where interaction_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
         order by interaction_id, source_text_version_id, kind`);
      return result.rows.map((row): PersistedSignalRow => ({ interactionId: row.interaction_id, sourceTextVersionId: row.source_text_version_id, kind: row.kind }));
    },
  };
}
