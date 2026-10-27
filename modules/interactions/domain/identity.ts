/**
 * Canonical interaction identity and authority conflicts (Step H6-A1; TA §18.1). Pure.
 *
 * Uniqueness: (workspace, platform, provider interaction id). The same provider object may legitimately exist in
 * several organizations' workspaces (TA §8, M-01 is per organization), so the workspace is part of the key; the
 * connected account, provider asset, content and parent are NOT — they are attributes, validated on every sighting.
 *
 * A known interaction seen again with a different account, asset, content, parent, kind or platform is an AUTHORITY
 * CONFLICT: ingestion must not move or rewrite its scope. The conflict is classified (closed codes) for audit and
 * alerting, and the fact is not applied. Re-attaching an interaction to another account (e.g. after a Remove and a
 * fresh connect of the same asset) is never silent: it needs its own explicit, audited path in a later gate.
 */
import type { WorkspaceId } from "@/domain/ids";
import type { PlatformKey } from "@/domain/platforms";
import type { ProviderId } from "@/domain/provider-identity";
import type { InteractionSourceFact } from "./source-fact";
import type { InteractionKind } from "./vocabulary";

export interface CanonicalInteractionKey {
  readonly workspaceId: WorkspaceId;
  readonly platform: PlatformKey;
  readonly interactionId: ProviderId;
}

/** The persisted scope of a known interaction: what every later sighting is validated against. */
export interface KnownInteractionScope extends CanonicalInteractionKey {
  readonly connectedAccountId: string;
  readonly providerAssetId: ProviderId;
  readonly contentId: ProviderId;
  readonly parentId: ProviderId | null;
  readonly kind: InteractionKind;
}

export const AUTHORITY_CONFLICTS = [
  "KEY_MISMATCH",
  "ACCOUNT_CHANGED",
  "ASSET_CHANGED",
  "CONTENT_CHANGED",
  "PARENT_CHANGED",
  "KIND_CHANGED",
] as const;
export type AuthorityConflict = (typeof AUTHORITY_CONFLICTS)[number];

export function canonicalInteractionKey(fact: InteractionSourceFact): CanonicalInteractionKey {
  return Object.freeze({ workspaceId: fact.scope.workspaceId, platform: fact.scope.platform, interactionId: fact.identity.interactionId });
}

/** A stable string form of the key (for maps and dedup inside one process; never a database key). */
export function canonicalKeyString(key: CanonicalInteractionKey): string {
  return `${key.workspaceId}|${key.platform}|${key.interactionId}`;
}

export function sameCanonicalKey(a: CanonicalInteractionKey, b: CanonicalInteractionKey): boolean {
  return a.workspaceId === b.workspaceId && a.platform === b.platform && a.interactionId === b.interactionId;
}

/** Every way a fact contradicts a known interaction's scope (empty = consistent). Never repairs anything. */
export function classifyAuthorityConflicts(known: KnownInteractionScope, fact: InteractionSourceFact): readonly AuthorityConflict[] {
  const out: AuthorityConflict[] = [];
  if (!sameCanonicalKey(known, canonicalInteractionKey(fact))) out.push("KEY_MISMATCH");
  if (known.connectedAccountId !== fact.scope.connectedAccountId) out.push("ACCOUNT_CHANGED");
  if (known.providerAssetId !== fact.scope.providerAssetId) out.push("ASSET_CHANGED");
  if (known.contentId !== fact.identity.contentId) out.push("CONTENT_CHANGED");
  if (known.parentId !== fact.identity.parentId) out.push("PARENT_CHANGED");
  if (known.kind !== fact.identity.kind) out.push("KIND_CHANGED");
  return out;
}

export type CanonicalAdmission =
  | { readonly kind: "create"; readonly key: CanonicalInteractionKey }
  | { readonly kind: "existing"; readonly key: CanonicalInteractionKey }
  | { readonly kind: "conflict"; readonly key: CanonicalInteractionKey; readonly conflicts: readonly AuthorityConflict[] };

/** Create, match or refuse: the first decision for every fact. `known` is the row found under the fact's key, if any. */
export function decideCanonicalAdmission(known: KnownInteractionScope | null, fact: InteractionSourceFact): CanonicalAdmission {
  const key = canonicalInteractionKey(fact);
  if (known === null) return { kind: "create", key };
  const conflicts = classifyAuthorityConflicts(known, fact);
  return conflicts.length === 0 ? { kind: "existing", key } : { kind: "conflict", key, conflicts };
}
