/**
 * Job-side composition of the connections worker store (Step 5D). jobs/ may not reach module persistence
 * directly (jobs-no-business-logic), so the job runtime obtains the store from here, over the step's
 * worker-scoped transaction and its R6 effect claim.
 */
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import type { CapabilityProfileStore } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { ConnectionWorkerStore } from "@/modules/connections";
import { createPostgresConnectionWorkerStore } from "@/modules/connections/persistence";
import type { TenantJobScope } from "@/platform/jobs";

export function connectionWorkerStore(scope: TenantJobScope): ConnectionWorkerStore {
  return createPostgresConnectionWorkerStore(scope.tx, { audit: createPostgresAuditLog(scope.tx), claimEffect: scope.claimEffect });
}

/** Stores for a capability refresh step (Step 5E): the connections worker store and the capability profile store. */
export function capabilityRefreshStores(scope: TenantJobScope): { readonly connections: ConnectionWorkerStore; readonly capability: CapabilityProfileStore } {
  return { connections: connectionWorkerStore(scope), capability: createPostgresCapabilityStore(scope.tx) };
}
