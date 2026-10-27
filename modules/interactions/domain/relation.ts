/**
 * Comment → reply relation and kind admission (Step H6-A1; Model §10–§11). Pure.
 *
 *   top-level comment   parent null; anchors a Conversation (conversations module).
 *   reply               references its canonical parent, in the SAME content scope (same workspace, platform, account,
 *                       content). A known parent in another scope is an authority conflict, never a re-parenting.
 *   reply before parent the parent is not invented: a MINIMAL placeholder identity is created — the parent's provider id
 *                       and the reply's content scope, marked never-observed — and nothing else (no text, author, state,
 *                       times). The real parent fills it in when it is observed.
 *
 * Kind admission: a fact is admitted only for a kind its capability coverage includes (coverage module →
 * `coveredInteractionKinds`). Under Instagram r5 (AVAILABLE_WITH_LIMITATION / REPLIES_NOT_READ) only `comment` is
 * covered, so an Instagram reply is refused — never stored as a canonical interaction.
 */
import type { WorkspaceId } from "@/domain/ids";
import type { PlatformKey } from "@/domain/platforms";
import type { ProviderId } from "@/domain/provider-identity";
import type { KnownInteractionScope } from "./identity";
import type { InteractionSourceFact } from "./source-fact";
import type { InteractionKind } from "./vocabulary";

/** A referenced-but-never-observed parent: identity and content scope only. */
export interface ParentPlaceholder {
  readonly workspaceId: WorkspaceId;
  readonly platform: PlatformKey;
  readonly connectedAccountId: string;
  readonly providerAssetId: ProviderId;
  readonly interactionId: ProviderId;
  /** The content of the reply that referenced it (a reply and its parent share one content). */
  readonly contentId: ProviderId;
  readonly observed: false;
}

export type RelationDecision =
  | { readonly kind: "top_level" }
  | { readonly kind: "reply_to_known_parent"; readonly parentId: ProviderId }
  | { readonly kind: "reply_with_placeholder_parent"; readonly placeholder: ParentPlaceholder }
  | { readonly kind: "reply_scope_conflict"; readonly reasons: readonly ("PARENT_OTHER_CONTENT" | "PARENT_OTHER_ACCOUNT" | "PARENT_OTHER_WORKSPACE" | "PARENT_OTHER_PLATFORM")[] };

export function decideRelation(fact: InteractionSourceFact, knownParent: KnownInteractionScope | null): RelationDecision {
  const parentId = fact.identity.parentId;
  if (parentId === null) return { kind: "top_level" };
  if (knownParent === null) {
    return {
      kind: "reply_with_placeholder_parent",
      placeholder: Object.freeze({
        workspaceId: fact.scope.workspaceId,
        platform: fact.scope.platform,
        connectedAccountId: fact.scope.connectedAccountId,
        providerAssetId: fact.scope.providerAssetId,
        interactionId: parentId,
        contentId: fact.identity.contentId,
        observed: false as const,
      }),
    };
  }
  const reasons: ("PARENT_OTHER_CONTENT" | "PARENT_OTHER_ACCOUNT" | "PARENT_OTHER_WORKSPACE" | "PARENT_OTHER_PLATFORM")[] = [];
  if (knownParent.workspaceId !== fact.scope.workspaceId) reasons.push("PARENT_OTHER_WORKSPACE");
  if (knownParent.platform !== fact.scope.platform) reasons.push("PARENT_OTHER_PLATFORM");
  if (knownParent.connectedAccountId !== fact.scope.connectedAccountId) reasons.push("PARENT_OTHER_ACCOUNT");
  if (knownParent.contentId !== fact.identity.contentId) reasons.push("PARENT_OTHER_CONTENT");
  if (knownParent.interactionId !== parentId) throw new TypeError("known_parent_is_not_the_referenced_parent");
  return reasons.length === 0 ? { kind: "reply_to_known_parent", parentId } : { kind: "reply_scope_conflict", reasons };
}

export type KindAdmission = { readonly admitted: true } | { readonly admitted: false; readonly reason: "KIND_NOT_COVERED" };

/** Admit a fact only for a kind the current capability coverage includes (never inferred from the data seen). */
export function admitInteractionKind(kind: InteractionKind, coveredKinds: readonly InteractionKind[]): KindAdmission {
  return coveredKinds.includes(kind) ? { admitted: true } : { admitted: false, reason: "KIND_NOT_COVERED" };
}
