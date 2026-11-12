/**
 * The Instagram reply preflight/observe diagnostic's READ-ONLY lookup (Step 7B-14C1) over ONE worker transaction bound to
 * the payload's workspace: the account, its connection and active credential envelope (the read diagnostics' lookup,
 * whose write dependencies refuse) and the canonical target interaction as the interactions module issues it (the same
 * row the executor's reply target reads — identifiers, provenance and last observed state, never its text). A row of
 * another workspace, or an unknown id, is simply absent (RLS + the bound workspace). The lookup writes nothing; Step
 * 7B-14I2 adds exactly ONE write, separate from it: the completed preflight's own evidence row (0029 definer).
 */
import { loadInteractionReplyTarget, type InteractionReplyTargetRow } from "@/modules/interactions/persistence";
import { recordValidationPreflight, type ValidationPreflightEvidence } from "@/mutations/persistence/validation-preflights";
import type { DatabaseTransaction } from "@/platform/db";
import { readContentValidationLookup, type ReadContentValidationLookup } from "./connections";

export type { InteractionReplyTargetRow, ValidationPreflightEvidence };

/**
 * Step 7B-14I2 — the ONE write of the preflight diagnostic: its own evidence row, through the bound worker's definer
 * (0029), in a transaction bound to the evidence's workspace. Identifiers and closed counts only.
 */
export function recordInstagramReplyPreflightEvidence(tx: DatabaseTransaction, evidence: ValidationPreflightEvidence): Promise<Date> {
  return recordValidationPreflight(tx, evidence);
}

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
