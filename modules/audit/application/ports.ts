/**
 * Audit persistence port. Events are appended in the same unit of work as the change they record
 * (TA §41.1). The database implementation (append-only, no update/delete grants) arrives in Step 2.
 */
import type { AuditEvent } from "../domain/audit-event";

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}
