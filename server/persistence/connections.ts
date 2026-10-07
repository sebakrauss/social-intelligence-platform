/**
 * Job-side composition of the connections worker store (Step 5D). jobs/ may not reach module persistence
 * directly (jobs-no-business-logic), so the job runtime obtains the store from here, over the step's
 * worker-scoped transaction and its R6 effect claim.
 */
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import type { ConnectionWorkerStore } from "@/modules/connections";
import { createPostgresConnectionWorkerStore } from "@/modules/connections/persistence";
import type { TenantJobScope } from "@/platform/jobs";

export function connectionWorkerStore(scope: TenantJobScope): ConnectionWorkerStore {
  return createPostgresConnectionWorkerStore(scope.tx, { audit: createPostgresAuditLog(scope.tx), claimEffect: scope.claimEffect });
}
