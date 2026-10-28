/**
 * Stores for canonical ingestion (Step H6-B): the owning modules' persistence (content, interactions, conversations,
 * coverage) and the ingestion event store, all bound to ONE workspace-scoped job transaction. Each appended
 * `interactions.observed` outbox row is reported for the post-commit relay wake-up.
 *
 * Step H6-C3: `reconciliationScope` adds the reconciliation store and the READ-ONLY authority reads reconciliation
 * re-checks before every provider operation — the account, its connection (share-locked when asked), the stored
 * credential envelope (opened only by the integration plane's credential access, never here), the capability profile
 * and the operational switches. Its connections store refuses every write: reconciliation never changes a connection,
 * an account or a capability profile. `isolated` runs one fact in a savepoint so a refused fact rolls back alone.
 * Step H6-E: the authority reads also issue a canonical interaction's STORED provenance (the interactions persistence
 * layer's issuer) for the stored-interaction confirmation.
 */
import { createPostgresContentItemStore } from "@/modules/content/persistence";
import { createPostgresConversationStore } from "@/modules/conversations/persistence";
import { createPostgresCoverageStore } from "@/modules/coverage/persistence";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import { createPostgresConnectionWorkerStore } from "@/modules/connections/persistence";
import type { IngestionStores, ProviderEventStore, ReconciliationAuthorityStore, ReconciliationScope } from "@/modules/ingestion";
import { createPostgresIngestionEventStore, createPostgresProviderEventStore, createPostgresReconciliationStore, createPostgresSignalMarkStore } from "@/modules/ingestion/persistence";
import { createPostgresInteractionStore, loadStoredInteractionAuthority } from "@/modules/interactions/persistence";
import { boundWorkspaceOrganization } from "@/modules/tenancy/persistence";
import { readSwitchRows, type DatabaseTransaction } from "@/platform/db";
import type { TenantJobScope } from "@/platform/jobs";

export function ingestionStores(scope: Pick<TenantJobScope, "tx" | "noteOutbox">): IngestionStores {
  const { tx } = scope;
  let organization: string | undefined;
  return {
    async organizationId() {
      if (organization !== undefined) return organization;
      const value = await boundWorkspaceOrganization(tx);
      // No bound workspace (or an unknown one): fail closed — nothing is ingested outside a workspace.
      if (value === undefined) throw new Error("ingestion_workspace_unbound");
      organization = value;
      return value;
    },
    content: createPostgresContentItemStore(tx),
    interactions: createPostgresInteractionStore(tx),
    conversations: createPostgresConversationStore(tx),
    events: createPostgresIngestionEventStore(tx, scope.noteOutbox),
    coverage: createPostgresCoverageStore(tx),
  };
}

const refuseWrite = (): never => {
  throw new Error("reconciliation authority reads are read-only");
};

/** The account, connection, credential envelope, capability and switch reads of one transaction (no write path). */
function reconciliationAuthority(tx: DatabaseTransaction): ReconciliationAuthorityStore {
  const connections = createPostgresConnectionWorkerStore(tx, {
    audit: { append: refuseWrite },
    outbox: { append: refuseWrite, routed: refuseWrite },
    claimEffect: refuseWrite,
    capabilityRequests: { requestOnce: refuseWrite },
  });
  return {
    account: (id) => connections.connectedAccounts.get(id),
    connection: (id) => connections.connections.get(id),
    connectionForShare: (id) => connections.connections.getForShare(id),
    credential: (id) => connections.credentials.load(id),
    capability: createPostgresCapabilityStore(tx),
    switches: () => readSwitchRows(tx),
    // Step H6-E: stored provenance, issued only by the interactions persistence layer from the canonical row.
    storedInteraction: (workspaceId, platform, providerInteractionId) => loadStoredInteractionAuthority(tx, workspaceId, platform, providerInteractionId),
  };
}

export function reconciliationScope(scope: Pick<TenantJobScope, "tx" | "noteOutbox">): ReconciliationScope {
  return {
    reconciliation: createPostgresReconciliationStore(scope.tx, scope.noteOutbox),
    authority: reconciliationAuthority(scope.tx),
    ingestion: ingestionStores(scope),
    // Step H6-F4: the bound workspace's signal marks (0022); RLS keeps every other workspace's invisible.
    signals: createPostgresSignalMarkStore(scope.tx),
    isolated: (work) => scope.tx.transaction((savepoint) => work(ingestionStores({ tx: savepoint, noteOutbox: scope.noteOutbox }))),
  };
}

/**
 * Step H6-F3: the provider-event inbox store of the MAIN system tasks, over a SYSTEM-scope transaction (the caller,
 * jobs/provider-events.ts, opens it). Identifier-only hints, the 0022 routing and purge definers — never a body.
 */
export function providerEventStore(tx: DatabaseTransaction): ProviderEventStore {
  return createPostgresProviderEventStore(tx);
}
