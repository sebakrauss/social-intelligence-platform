/**
 * PostgreSQL audit log: appends validated events inside the caller's scoped transaction, so an event
 * commits or rolls back with the change it records (TA §41.1). There is no read, update or delete path.
 */
import type { DatabaseTransaction } from "@/platform/db";
import type { AuditLog } from "../application/ports";
import { createAuditEvent } from "../domain/audit-event";
import { auditEvents } from "./tables";

export function createPostgresAuditLog(tx: DatabaseTransaction): AuditLog {
  return {
    async append(input) {
      // Re-validated at the boundary: only declared, identifier-shaped, closed-vocabulary data is written.
      const event = createAuditEvent(input);
      await tx.insert(auditEvents).values({
        id: event.id,
        occurredAt: event.occurredAt,
        action: event.action,
        actorType: event.actorType,
        actorUserId: event.actorUserId ?? null,
        organizationId: event.organizationId ?? null,
        workspaceId: event.workspaceId ?? null,
        targetType: event.targetType,
        targetId: event.targetId,
        correlationId: event.correlationId,
        requestId: event.requestId ?? null,
        outcome: event.outcome,
        change: event.change ?? null,
      });
    },
  };
}
