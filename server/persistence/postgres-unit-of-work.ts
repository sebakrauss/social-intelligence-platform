/**
 * Production unit of work: one tenant-scoped PostgreSQL transaction per command (TA §9.3, §10.6, §11.6).
 * The web login role switches (fixed literal) to `authenticated`, the server-verified user id becomes the
 * transaction-local claims behind auth.uid(), and a workspace command's routed workspace is bound with the
 * sealed context function before any query. State, audit and outbox writes share the transaction, so they
 * commit or roll back together.
 *
 * Database refusals become normalized errors without leaking which layer refused:
 *   last-Owner invariant / uniqueness → CONFLICT; missing or foreign reference / RLS denial → NOT_FOUND.
 */
import { AppError } from "@/domain/errors";
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import { createPostgresTenancyStore } from "@/modules/tenancy/persistence";
import { classifyDatabaseError, createPostgresOutbox, withUserScope, type RuntimeDatabase } from "@/platform/db";
import type { Transaction, TransactionScope, UnitOfWork } from "@/server/pipeline";

export function normalizeDatabaseError(error: unknown): unknown {
  switch (classifyDatabaseError(error)) {
    case "last_owner":
    case "duplicate":
      return new AppError("CONFLICT", {});
    case "missing_reference":
    case "denied":
      return new AppError("NOT_FOUND", {});
    case undefined:
      return error;
  }
}

export function createPostgresUnitOfWork(database: RuntimeDatabase<"web">): UnitOfWork {
  return {
    async run<T>(scope: TransactionScope, work: (tx: Transaction) => Promise<T>): Promise<T> {
      try {
        return await withUserScope(database, { sub: scope.userId, role: "authenticated" }, scope.workspaceId, (tx) =>
          work({ tenancy: createPostgresTenancyStore(tx), audit: createPostgresAuditLog(tx), outbox: createPostgresOutbox(tx) }),
        );
      } catch (error) {
        throw normalizeDatabaseError(error);
      }
    },
  };
}
