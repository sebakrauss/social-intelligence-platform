/**
 * Reconciliation of an unknown outcome (TA §18.3, §47; R6). An intent in OUTCOME_UNKNOWN — or one left EXECUTING by a
 * run that never recorded an outcome — may or may not have created a reply on the platform. The only safe move is to
 * LOOK: list what sits under the parent and search for our own reply. Exactly ONE unambiguous match whose provider
 * identity is linked to no other intent → CONFIRMED with that id. Everything else — nothing found, several candidates,
 * an identity already linked elsewhere, an unreadable, incomplete or failed listing — leaves the intent
 * OUTCOME_UNKNOWN: a negative lookup is not evidence of absence (eventual consistency, platforms that do not list
 * replies, normalized text), and "failed" would invite a duplicate. Never a resend, never an automatic FAILED.
 */
import { isPlatformKey } from "@/domain/platforms";
import { providerObjectRef } from "@/integrations/providers/contract/identity";
import type { MutationIntent } from "../domain/intent";
import type { CredentialUse, MutationClock, ReplyLookup } from "../ports";
import { settle, type ExecutorStores } from "./execute";

export interface ReconcileDependencies {
  readonly inScope: <T>(work: (stores: ExecutorStores) => Promise<T>) => Promise<T>;
  readonly credentials: CredentialUse;
  readonly lookup: ReplyLookup;
  readonly clock: MutationClock;
}

export const STILL_UNKNOWN_REASONS = ["not_found", "ambiguous", "identity_linked_elsewhere", "unreadable"] as const;
export type StillUnknownReason = (typeof STILL_UNKNOWN_REASONS)[number];

export type ReconcileResult =
  | { readonly kind: "confirmed"; readonly providerReplyId: string }
  /** The intent stays OUTCOME_UNKNOWN; `reason` is diagnostic only and never a transition. */
  | { readonly kind: "still_unknown"; readonly reason: StillUnknownReason }
  | { readonly kind: "noop"; readonly status: MutationIntent["status"] | "missing" };

export async function reconcileIntent(deps: ReconcileDependencies, input: { readonly workspaceId: string; readonly intentId: string; readonly runReference: string }): Promise<ReconcileResult> {
  const prepared = await deps.inScope(async (stores) => {
    const locked = await stores.intents.lock(input.workspaceId, input.intentId);
    if (locked === undefined) return { kind: "noop" as const, status: "missing" as const };
    let intent = locked;
    if (intent.status === "EXECUTING") {
      // Left EXECUTING without an outcome: the ambiguity is recorded first, then examined (never re-sent).
      await settle(stores, intent, "OUTCOME_UNKNOWN", "RUN_INTERRUPTED", intent.attempt, input.runReference, deps.clock, "reconciliation");
      intent = { ...intent, status: "OUTCOME_UNKNOWN", outcomeCode: "RUN_INTERRUPTED", runReference: input.runReference };
    }
    if (intent.status !== "OUTCOME_UNKNOWN") return { kind: "noop" as const, status: intent.status };
    const reply = await stores.replies.getByIntent(intent.workspaceId, intent.id);
    const target = await stores.targets.load(intent.targetInteractionId);
    if (reply === undefined || target === undefined || !isPlatformKey(target.platform)) return { kind: "unreadable" as const };
    return { kind: "look" as const, intent, reply, target: { ...target, platform: target.platform } };
  });
  if (prepared.kind === "noop") return prepared;
  if (prepared.kind === "unreadable") return { kind: "still_unknown", reason: "unreadable" };
  const { intent, reply, target } = prepared;

  let looked;
  try {
    looked = await deps.credentials.withAccess({ workspaceId: intent.workspaceId, connectedAccountId: intent.connectedAccountId }, (access) =>
      deps.lookup.findOwnReply(access, { parent: providerObjectRef(target.platform, "interaction", target.providerInteractionId), content: providerObjectRef(target.platform, "content", target.providerContentId) }, reply.text, intent.createdAt),
    );
  } catch {
    return { kind: "still_unknown", reason: "unreadable" };
  }
  if (looked.kind === "none") return { kind: "still_unknown", reason: "not_found" };
  if (looked.kind === "ambiguous") return { kind: "still_unknown", reason: "ambiguous" };
  const providerReplyId = looked.providerReplyId;

  return deps.inScope(async (stores) => {
    const current = await stores.intents.lock(intent.workspaceId, intent.id);
    if (current === undefined || current.status !== "OUTCOME_UNKNOWN") return { kind: "noop", status: current?.status ?? "missing" };
    const linked = await stores.replies.linkedIntent(intent.workspaceId, reply.platform, providerReplyId);
    if (linked !== undefined && linked !== intent.id) return { kind: "still_unknown", reason: "identity_linked_elsewhere" };
    await stores.replies.confirm(intent.workspaceId, intent.id, providerReplyId, deps.clock.now());
    await settle(stores, current, "CONFIRMED", null, current.attempt, input.runReference, deps.clock, "reconciliation");
    return { kind: "confirmed", providerReplyId };
  });
}
