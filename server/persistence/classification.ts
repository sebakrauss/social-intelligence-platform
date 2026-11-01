/**
 * Classification runtime composition (Steps H7-B, H7-D1d): the classification and intelligence stores, the interactions
 * module's read-only understanding reader and the content module's reported source, all bound to ONE workspace-scoped
 * job transaction (app_worker) — MAIN for the deterministic stage, dispatch and recovery; INTELLIGENCE for the task.
 */
import { UNDERSTAND_AI_KILL_QUALIFIER, type ClassificationScope, type IntelligenceScope } from "@/modules/classification";
import { createPostgresClassificationStore, createPostgresIntelligenceStore } from "@/modules/classification/persistence";
import { createPostgresContentItemStore } from "@/modules/content/persistence";
import { createPostgresInteractionTextReader } from "@/modules/interactions/persistence";
import { readSwitchRows, type DatabaseTransaction } from "@/platform/db";
import { resolveSwitch } from "@/platform/flags";
import type { TenantJobScope } from "@/platform/jobs";

export function classificationScope(scope: Pick<TenantJobScope, "tx">): ClassificationScope {
  return { texts: createPostgresInteractionTextReader(scope.tx), store: createPostgresClassificationStore(scope.tx) };
}

export function intelligenceScope(scope: Pick<TenantJobScope, "tx" | "noteOutbox">): IntelligenceScope {
  const contents = createPostgresContentItemStore(scope.tx);
  return {
    texts: createPostgresInteractionTextReader(scope.tx),
    contents: { reportedSource: async (contentItemId) => (await contents.findById(contentItemId))?.reportedSource },
    store: createPostgresClassificationStore(scope.tx),
    intelligence: createPostgresIntelligenceStore(scope.tx, scope.noteOutbox),
    aiTaskKilled: () => aiTaskKilled(scope.tx),
  };
}

/** `ai.task_kill` for the understanding task; unreadable or invalid ⇒ the switch's fail-safe (killed). */
async function aiTaskKilled(tx: DatabaseTransaction): Promise<boolean> {
  try {
    return resolveSwitch(await readSwitchRows(tx), "ai.task_kill", { qualifier: UNDERSTAND_AI_KILL_QUALIFIER }).value.active;
  } catch {
    return true;
  }
}
