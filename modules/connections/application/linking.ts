/**
 * Connected Account linking (Step 5F; PD D-50 M-01; TA §8). Web side, one transaction bound to the destination
 * workspace, Owner/Admin (connections.manage) — enforced by the pipeline AND by RLS.
 *
 *   link     an asset discovered by one of this workspace's ACTIVE Connections becomes ACTIVE here: the existing
 *            INACTIVE row is reactivated when there is one, otherwise a row is inserted. Idempotent: an asset already
 *            active here is returned as is. Identity always comes from the local discovered asset, never the caller.
 *   unlink   ACTIVE → INACTIVE (UNLINKED). Explicit user intent: no credential is shredded and no data is deleted;
 *            the M-01 / TA-Q-02 slot is freed. Idempotent.
 *
 * M-01 (LOCKED) and the TEMPORARY TA-Q-02 ad-account restriction are decided by the database's two named unique
 * indexes; connections.locate_active_link only lets the application explain the refusal (same organization only).
 * No provider I/O happens here: capability evaluation is enqueued by the caller after activation.
 */
import { AppError } from "@/domain/errors";
import type { WorkspaceId } from "@/domain/ids";
import { singleWorkspaceRule, type ConnectedAccount, type DiscoveredAsset, type SingleWorkspaceRule } from "../domain/model";
import type { WorkspaceScope } from "./authorization";
import type { ConnectionStore } from "./ports";

/** The asset is active in another workspace of this organization (never another organization: that is invisible). */
export interface ActiveElsewhere {
  readonly kind: "active_elsewhere";
  readonly rule: SingleWorkspaceRule;
  /** Identifier only; whether the user may see it identified is decided by the caller (M-01 presentation). */
  readonly workspaceId: WorkspaceId | null;
}

export type LinkOutput =
  | { readonly kind: "linked"; readonly account: ConnectedAccount; readonly reactivated: boolean }
  | { readonly kind: "already_linked"; readonly account: ConnectedAccount }
  | ActiveElsewhere;

/** The local discovered asset and its Connection, which must be ACTIVE (a degraded/failed one can't link). */
export async function loadLinkableAsset(store: ConnectionStore, discoveredAssetId: string): Promise<DiscoveredAsset> {
  const asset = await store.discoveredAssets.get(discoveredAssetId);
  if (asset === undefined) throw new AppError("NOT_FOUND", {});
  const connection = await store.connections.get(asset.connectionId);
  if (connection === undefined) throw new AppError("NOT_FOUND", {});
  if (connection.status !== "ACTIVE") throw new AppError("CONNECTION_PROBLEM", { platform: asset.platform });
  return asset;
}

/** Where the asset is active in this organization: here (with the account), elsewhere, or nowhere. */
async function locate(store: ConnectionStore, asset: DiscoveredAsset, scope: WorkspaceScope): Promise<LinkOutput | undefined> {
  const located = await store.links.locateActive(asset.id);
  if (located === undefined) return undefined;
  if (located.workspaceId === scope.workspaceId) {
    const account = await store.connectedAccounts.get(located.connectedAccountId);
    if (account !== undefined) return { kind: "already_linked", account };
  }
  return { kind: "active_elsewhere", rule: singleWorkspaceRule(asset.assetClass), workspaceId: located.workspaceId };
}

export async function linkAccount(
  store: ConnectionStore,
  input: { readonly scope: WorkspaceScope; readonly discoveredAssetId: string; readonly now: Date; readonly newId: () => string },
): Promise<LinkOutput> {
  const asset = await loadLinkableAsset(store, input.discoveredAssetId);
  const current = await locate(store, asset, input.scope);
  if (current !== undefined) return current;

  const existing = await store.connectedAccounts.findForAsset(asset.connectionId, asset.platform, asset.providerAssetId);
  const outcome = await store.connectedAccounts.activate({
    newId: input.newId(),
    reactivateId: existing?.status === "INACTIVE" ? existing.id : null,
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    connectionId: asset.connectionId,
    platform: asset.platform,
    providerAssetId: asset.providerAssetId,
    assetClass: asset.assetClass,
    now: input.now,
  });
  if (outcome.kind === "conflict") {
    // Lost a race: the database refused. Explain it when the winner is visible; never guess a workspace.
    return (await locate(store, asset, input.scope)) ?? { kind: "active_elsewhere", rule: outcome.rule, workspaceId: null };
  }
  await store.accountEvents.append({
    id: input.newId(),
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    connectedAccountId: outcome.account.id,
    eventType: "LINKED",
    moveId: null,
    reasonCode: "USER_LINKED",
    actor: { type: "user", userId: input.scope.userId },
    occurredAt: input.now,
  });
  return { kind: "linked", account: outcome.account, reactivated: outcome.reactivated };
}

export type UnlinkOutput = { readonly changed: false; readonly connectedAccountId: string } | { readonly changed: true; readonly connectedAccountId: string };

export async function unlinkAccount(
  store: ConnectionStore,
  input: { readonly scope: WorkspaceScope; readonly connectedAccountId: string; readonly now: Date; readonly newId: () => string },
): Promise<UnlinkOutput> {
  const account = await store.connectedAccounts.get(input.connectedAccountId);
  if (account === undefined) throw new AppError("NOT_FOUND", {});
  if (account.status !== "ACTIVE" || !(await store.connectedAccounts.unlink(account.id, input.now))) {
    return { changed: false, connectedAccountId: account.id };
  }
  await store.accountEvents.append({
    id: input.newId(),
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    connectedAccountId: account.id,
    eventType: "UNLINKED",
    moveId: null,
    reasonCode: "USER_UNLINKED",
    actor: { type: "user", userId: input.scope.userId },
    occurredAt: input.now,
  });
  return { changed: true, connectedAccountId: account.id };
}

/** What a member may see about a Connected Account: identifiers, dimensions and status only. */
export interface ConnectedAccountSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly platform: ConnectedAccount["platform"];
  readonly providerAssetId: string;
  readonly assetClass: ConnectedAccount["assetClass"];
  readonly status: ConnectedAccount["status"];
  readonly deactivationReason: ConnectedAccount["deactivationReason"];
}

export async function listConnectedAccounts(store: ConnectionStore): Promise<readonly ConnectedAccountSummary[]> {
  return (await store.connectedAccounts.list()).map(({ id, connectionId, platform, providerAssetId, assetClass, status, deactivationReason }) => ({
    id,
    connectionId,
    platform,
    providerAssetId,
    assetClass,
    status,
    deactivationReason,
  }));
}
