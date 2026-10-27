/**
 * Ingestion event persistence (Step H6-B; H6-A1 events contract). Each canonical change writes one append-only
 * `ingestion.ingestion_events` record (the closed facts: change, arrival, observed time, correlation, initiator) and
 * one IDs-only `interactions.observed` outbox row naming it — in the caller's transaction, so both commit or roll back
 * with the state they describe. The outbox row carries UUID subject ids only (H6-A1 `interactionsObservedOutboxRow`).
 */
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appendOutboxOnce, type DatabaseTransaction } from "@/platform/db";
import type { OutboxNotice } from "@/platform/outbox";
import type { IngestionEventStore } from "../application/ports";
import { interactionsObservedOutboxRow } from "../domain/events";

const ingestion = pgSchema("ingestion");
const at = (name: string) => timestamp(name, { withTimezone: true });

/** Drizzle mapping of ingestion.ingestion_events (db/migrations/0017; the SQL is the source of truth). */
export const ingestionEvents = ingestion.table("ingestion_events", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  interactionId: uuid("interaction_id").notNull(),
  conversationId: uuid("conversation_id"),
  sourceTextVersionId: uuid("source_text_version_id"),
  change: text("change").notNull(),
  arrival: text("arrival").notNull(),
  observedAt: at("observed_at").notNull(),
  correlationId: text("correlation_id").notNull(),
  initiator: text("initiator").notNull(),
  createdAt: at("created_at").notNull(),
});


/** `noteAppended` reports each appended outbox row for the post-commit relay wake-up (the job scope's `noteOutbox`). */
export function createPostgresIngestionEventStore(tx: DatabaseTransaction, noteAppended: (notice: OutboxNotice) => void): IngestionEventStore {
  return {
    async emit(record, organizationId, now, outboxId) {
      const outboxRow = interactionsObservedOutboxRow(record);
      await tx.insert(ingestionEvents).values({
        id: record.eventId,
        organizationId,
        workspaceId: record.workspaceId,
        interactionId: record.interactionId,
        conversationId: record.conversationId,
        sourceTextVersionId: record.sourceTextVersionId,
        change: record.change,
        arrival: record.arrival,
        observedAt: new Date(record.observedAt),
        correlationId: record.correlationId,
        initiator: record.initiator,
        createdAt: now,
      });
      const message = {
        id: outboxId,
        topic: outboxRow.topic,
        organizationId,
        workspaceId: outboxRow.workspaceId,
        subjectIds: outboxRow.subjectIds,
        correlationId: outboxRow.correlationId,
        initiator: { type: outboxRow.initiatorType },
        dispatchKey: outboxRow.dispatchKey,
        createdAt: now,
      };
      const appended = await appendOutboxOnce(tx, message);
      // The dispatch key is the fresh event id: an existing one would be a duplicated event, never a no-op.
      if (appended !== "appended") throw new Error("ingestion_event_dispatch_key_taken");
      noteAppended(message);
    },
  };
}
