/**
 * Drizzle mapping of audit.audit_events (db/migrations/0003_audit.sql). Append-only: runtime roles hold
 * INSERT only. Owned by the audit module.
 */
import { jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AuditChange } from "../domain/audit-event";

const audit = pgSchema("audit");

export const auditEvents = audit.table("audit_events", {
  id: uuid("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  action: text("action").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id"),
  organizationId: uuid("organization_id"),
  workspaceId: uuid("workspace_id"),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  requestId: text("request_id"),
  outcome: text("outcome").notNull(),
  change: jsonb("change").$type<AuditChange>(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});
