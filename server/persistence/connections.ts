/**
 * Job-side composition of the connections worker store (Step 5D). jobs/ may not reach module persistence
 * directly (jobs-no-business-logic), so the job runtime obtains the store from here, over the step's
 * worker-scoped transaction and its R6 effect claim.
 */
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import type { CapabilityProfileStore } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { CapabilityReconcileStore, ConnectionWorkerStore } from "@/modules/connections";
import { createPostgresCapabilityReconcileStore, createPostgresConnectionWorkerStore } from "@/modules/connections/persistence";
import { appendOutboxOnce, createPostgresOutbox } from "@/platform/db";
import type { TenantJobScope } from "@/platform/jobs";
import type { OutboxWriter } from "@/platform/outbox";

/** The job's outbox writer: every appended or definer-routed row is reported for the post-commit relay wake-up. */
function jobOutbox(scope: TenantJobScope): OutboxWriter {
  const base = createPostgresOutbox(scope.tx);
  return {
    async append(message) {
      await base.append(message);
      scope.noteOutbox(message);
    },
    routed(notice) {
      base.routed(notice);
      scope.noteOutbox(notice);
    },
  };
}

export function connectionWorkerStore(scope: TenantJobScope): ConnectionWorkerStore {
  return createPostgresConnectionWorkerStore(scope.tx, {
    audit: createPostgresAuditLog(scope.tx),
    outbox: jobOutbox(scope),
    claimEffect: scope.claimEffect,
  });
}

/** Stores for a capability refresh step (Step 5E): the connections worker store and the capability profile store. */
export function capabilityRefreshStores(scope: TenantJobScope): { readonly connections: ConnectionWorkerStore; readonly capability: CapabilityProfileStore } {
  return { connections: connectionWorkerStore(scope), capability: createPostgresCapabilityStore(scope.tx) };
}

/**
 * Stores for capability reconciliation (Step 7G-H5.5): ACTIVE accounts and their latest activation (connections),
 * profile headers (capability), and requests appended at most once per dispatch key, each newly appended row reported
 * for the post-commit relay wake-up. No credential, no provider: this runs on any worker plane.
 */
export function capabilityReconcileStores(scope: TenantJobScope): { readonly accounts: CapabilityReconcileStore; readonly capability: CapabilityProfileStore } {
  return {
    accounts: createPostgresCapabilityReconcileStore(scope.tx, {
      async requestOnce(message) {
        const outcome = await appendOutboxOnce(scope.tx, message);
        if (outcome === "appended") scope.noteOutbox(message);
        return outcome;
      },
    }),
    capability: createPostgresCapabilityStore(scope.tx),
  };
}
