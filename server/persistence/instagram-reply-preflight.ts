/**
 * The Instagram reply preflight/observe diagnostic's READ-ONLY lookup (Step 7B-14C1) over ONE worker transaction bound to
 * the payload's workspace: the account, its connection and active credential envelope (the read diagnostics' lookup,
 * whose write dependencies refuse) and the canonical target interaction as the interactions module issues it (the same
 * row the executor's reply target reads — identifiers, provenance and last observed state, never its text). A row of
 * another workspace, or an unknown id, is simply absent (RLS + the bound workspace). Nothing here writes.
 */
import { loadInteractionReplyTarget, type InteractionReplyTargetRow } from "@/modules/interactions/persistence";
import type { DatabaseTransaction } from "@/platform/db";
import { readContentValidationLookup, type ReadContentValidationLookup } from "./connections";

export type { InteractionReplyTargetRow };

export interface InstagramReplyPreflightLookup extends ReadContentValidationLookup {
  readonly interaction: (interactionId: string) => Promise<InteractionReplyTargetRow | undefined>;
}

export function instagramReplyPreflightLookup(tx: DatabaseTransaction, workspaceId: string): InstagramReplyPreflightLookup {
  const connections = readContentValidationLookup(tx);
  return Object.freeze({
    ...connections,
    interaction: (interactionId: string) => loadInteractionReplyTarget(tx, workspaceId, interactionId),
  });
}
