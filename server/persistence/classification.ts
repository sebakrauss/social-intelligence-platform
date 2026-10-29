/**
 * Classification runtime composition (Step H7-B): the classification store and the interactions module's read-only
 * analysis-text reader, both bound to ONE workspace-scoped job transaction (MAIN plane, app_worker).
 */
import type { ClassificationScope } from "@/modules/classification";
import { createPostgresClassificationStore } from "@/modules/classification/persistence";
import { createPostgresInteractionTextReader } from "@/modules/interactions/persistence";
import type { TenantJobScope } from "@/platform/jobs";

export function classificationScope(scope: Pick<TenantJobScope, "tx">): ClassificationScope {
  return { texts: createPostgresInteractionTextReader(scope.tx), store: createPostgresClassificationStore(scope.tx) };
}
