/**
 * Persistent `stored` provenance (Step H6-A1, TL decision 1; design for H6-E). Pure.
 *
 * P12's `listed` provenance is the exact DTO instance one port instance listed: ephemeral and process-local, so it
 * can't carry authority from a listing to a later re-read in another process. `stored` is the persistent counterpart:
 * the authority of a canonical interaction ALREADY PERSISTED by trusted ingestion (written only from a listed or
 * otherwise authoritative fact, workspace-scoped under RLS, with composite workspace keys).
 *
 * Construction path (fabrication made hard, in layers):
 *   1. Only `issueStoredInteractionAuthority` makes one. It is NOT exported from the module's public API
 *      (modules/interactions/index.ts); an architecture guard allows it to be imported only by the interactions
 *      persistence layer (which reads the canonical row in the caller's tenant scope) and by tests.
 *   2. It takes a `CanonicalInteractionRecord` — the persisted row: its internal UUID and persisted time included —
 *      never a provider id alone.
 *   3. Issued authorities are frozen and remembered in a process-local WeakSet: an object literal, a spread copy or a
 *      deserialized value is never one (`isStoredInteractionAuthority`). Across processes the authority is simply
 *      re-issued from the row; the database row is the durable authority, the object is its proof of origin.
 *
 * Re-read (H6-E; the provider contract gains the `stored` target kind then, not now): the adapter re-reads the
 * interaction and `verifyStoredReread` compares the answer with the authority — any mismatch of workspace, account,
 * platform, asset, interaction, content, parent or kind fails closed (no state is applied).
 */
import { isUuid, type WorkspaceId } from "@/domain/ids";
import { parseInstant, type Instant } from "@/domain/instant";
import type { PlatformKey } from "@/domain/platforms";
import type { ProviderId } from "@/domain/provider-identity";
import type { KnownInteractionScope } from "./identity";
import type { InteractionKind } from "./vocabulary";

/** A canonical interaction row as persistence reads it (the only input an authority may come from). */
export interface CanonicalInteractionRecord extends KnownInteractionScope {
  /** The internal identity (UUID) of the persisted row. */
  readonly canonicalId: string;
  readonly persistedAt: Instant;
}

declare const storedBrand: unique symbol;

export interface StoredInteractionAuthority {
  readonly [storedBrand]: true;
  readonly canonicalId: string;
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
  readonly platform: PlatformKey;
  readonly providerAssetId: ProviderId;
  readonly interactionId: ProviderId;
  readonly contentId: ProviderId;
  readonly parentId: ProviderId | null;
  readonly kind: InteractionKind;
}

const issued = new WeakSet<object>();

/** PERSISTENCE-ONLY (guard-tested). Refuses an incoherent record instead of issuing a partial authority. */
export function issueStoredInteractionAuthority(record: CanonicalInteractionRecord): StoredInteractionAuthority {
  const coherent = isUuid(record.canonicalId) && isUuid(record.connectedAccountId) && parseInstant(record.persistedAt) !== undefined
    && (record.kind === "reply") === (record.parentId !== null) && record.parentId !== record.interactionId;
  if (!coherent) throw new TypeError("stored_authority_record_incoherent");
  const authority = Object.freeze({
    canonicalId: record.canonicalId,
    workspaceId: record.workspaceId,
    connectedAccountId: record.connectedAccountId,
    platform: record.platform,
    providerAssetId: record.providerAssetId,
    interactionId: record.interactionId,
    contentId: record.contentId,
    parentId: record.parentId,
    kind: record.kind,
  }) as StoredInteractionAuthority;
  issued.add(authority);
  return authority;
}

/** True only for an authority this process issued from a persisted record (never a literal, copy or parse). */
export function isStoredInteractionAuthority(value: unknown): value is StoredInteractionAuthority {
  return typeof value === "object" && value !== null && issued.has(value);
}

export const STORED_REREAD_MISMATCHES = [
  "NOT_AN_ISSUED_AUTHORITY",
  "WORKSPACE_MISMATCH",
  "ACCOUNT_MISMATCH",
  "PLATFORM_MISMATCH",
  "ASSET_MISMATCH",
  "INTERACTION_MISMATCH",
  "CONTENT_MISMATCH",
  "PARENT_MISMATCH",
  "KIND_MISMATCH",
] as const;
export type StoredRereadMismatch = (typeof STORED_REREAD_MISMATCHES)[number];

export interface StoredRereadContext {
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
  readonly platform: PlatformKey;
  readonly providerAssetId: ProviderId;
}

export interface StoredRereadObservation {
  readonly interactionId: ProviderId;
  readonly contentId: ProviderId;
  readonly parentId: ProviderId | null;
  readonly kind: InteractionKind;
}

/** Every way a re-read contradicts its stored authority, or the caller's context (empty = the re-read may apply). */
export function verifyStoredReread(authority: unknown, context: StoredRereadContext, observed: StoredRereadObservation): readonly StoredRereadMismatch[] {
  if (!isStoredInteractionAuthority(authority)) return ["NOT_AN_ISSUED_AUTHORITY"];
  const out: StoredRereadMismatch[] = [];
  if (authority.workspaceId !== context.workspaceId) out.push("WORKSPACE_MISMATCH");
  if (authority.connectedAccountId !== context.connectedAccountId) out.push("ACCOUNT_MISMATCH");
  if (authority.platform !== context.platform) out.push("PLATFORM_MISMATCH");
  if (authority.providerAssetId !== context.providerAssetId) out.push("ASSET_MISMATCH");
  if (authority.interactionId !== observed.interactionId) out.push("INTERACTION_MISMATCH");
  if (authority.contentId !== observed.contentId) out.push("CONTENT_MISMATCH");
  if (authority.parentId !== observed.parentId) out.push("PARENT_MISMATCH");
  if (authority.kind !== observed.kind) out.push("KIND_MISMATCH");
  return out;
}
