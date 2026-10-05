/**
 * Unit-of-work port for the action pipeline (TA §10.6 steps 6–8; §13.1).
 * One unit covers tenant resolution, execution, the audit record and any outbox rows: it commits only if
 * the work resolves and rolls back if it rejects. The production implementation is the tenant-scoped
 * PostgreSQL transaction (server/persistence): web login role, fixed-literal role switch, transaction-local
 * claims and, for workspace commands, the sealed workspace binding. Tests also use in-memory adapters.
 */
import type { UserId, WorkspaceId } from "@/domain/ids";
import type { AuditLog } from "@/modules/audit";
import type { TenancyStore } from "@/modules/tenancy";
import type { OutboxWriter } from "@/platform/outbox";

export interface Transaction {
  readonly tenancy: TenancyStore;
  readonly audit: AuditLog;
  readonly outbox: OutboxWriter;
}

/**
 * Who the transaction runs for. The user comes from the server-validated session; the workspace (for
 * workspace commands) is the routed one, bound before any query and verified by live membership inside.
 */
export interface TransactionScope {
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
}

export interface UnitOfWork {
  run<T>(scope: TransactionScope, work: (tx: Transaction) => Promise<T>): Promise<T>;
}
