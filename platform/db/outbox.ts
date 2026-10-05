/**
 * PostgreSQL outbox writer (system.outbox). Appends inside the caller's scoped transaction, so the row
 * commits or rolls back with the state change it follows up. Web users and workers can append but not
 * read; only the system role reads delivery metadata (Step 3 relay).
 */
import { jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createOutboxMessage, type OutboxMessage, type OutboxWriter } from "@/platform/outbox";
import type { DatabaseTransaction } from "./scopes";

const system = pgSchema("system");

export const outbox = system.table("outbox", {
  id: uuid("id").primaryKey(),
  topic: text("topic").notNull(),
  organizationId: uuid("organization_id"),
  workspaceId: uuid("workspace_id"),
  subjectIds: jsonb("subject_ids").$type<Readonly<Record<string, string>>>().notNull(),
  correlationId: text("correlation_id").notNull(),
  initiatorType: text("initiator_type").notNull(),
  initiatorUserId: uuid("initiator_user_id"),
  dispatchKey: text("dispatch_key").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
});

export function createPostgresOutbox(tx: DatabaseTransaction): OutboxWriter {
  return {
    async append(input: OutboxMessage): Promise<void> {
      const message = createOutboxMessage(input);
      await tx.insert(outbox).values({
        id: message.id,
        topic: message.topic,
        organizationId: message.organizationId ?? null,
        workspaceId: message.workspaceId ?? null,
        subjectIds: message.subjectIds,
        correlationId: message.correlationId,
        initiatorType: message.initiator.type,
        initiatorUserId: message.initiator.type === "user" ? message.initiator.userId : null,
        dispatchKey: message.dispatchKey,
        status: "PENDING",
        createdAt: message.createdAt,
      });
    },
  };
}
