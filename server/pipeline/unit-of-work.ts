/**
 * Unit-of-work port for the action pipeline (TA §10.6 steps 6–7; §13.1).
 * One unit covers tenant resolution, execution and the audit record: it commits only if the work
 * resolves and rolls back if it rejects. The tenant-scoped PostgreSQL transaction that implements
 * this (RLS context, sealed workspace binding) is Step 2; until then only test adapters exist.
 */
import type { AuditLog } from "@/modules/audit";
import type { TenancyStore } from "@/modules/tenancy";

export interface Transaction {
  readonly tenancy: TenancyStore;
  readonly audit: AuditLog;
}

export interface UnitOfWork {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
