/**
 * Stores for canonical ingestion (Step H6-B): the owning modules' persistence (content, interactions, conversations,
 * coverage) and the ingestion event store, all bound to ONE workspace-scoped job transaction. Each appended
 * `interactions.observed` outbox row is reported for the post-commit relay wake-up.
 */
import { createPostgresContentItemStore } from "@/modules/content/persistence";
import { createPostgresConversationStore } from "@/modules/conversations/persistence";
import { createPostgresCoverageStore } from "@/modules/coverage/persistence";
import type { IngestionStores } from "@/modules/ingestion";
import { createPostgresIngestionEventStore } from "@/modules/ingestion/persistence";
import { createPostgresInteractionStore } from "@/modules/interactions/persistence";
import { boundWorkspaceOrganization } from "@/modules/tenancy/persistence";
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
