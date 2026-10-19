/**
 * Connected Account linking (Step 5F; PD D-50 M-01; TA §8). Web side, one transaction bound to the destination
 * workspace, Owner/Admin (connections.manage) — enforced by the pipeline AND by RLS.
 *
 *   link     an asset discovered by one of this workspace's ACTIVE Connections becomes ACTIVE here: the existing
 *            INACTIVE row is reactivated when there is one, otherwise a row is inserted. Idempotent: an asset already
 *            active here is returned as is. Identity always comes from the local discovered asset, never the caller.
 *   unlink   ACTIVE → INACTIVE (UNLINKED). Explicit user intent: no credential is shredded and no data is deleted;
 *            the M-01 / TA-Q-02 slot is freed. Idempotent.
 *   select   (Step 7G-H5) the desired set of managed accounts for ONE Connection, converged in one transaction from
 *            link/unlink above: activation is an explicit Wrenkind decision, never a side effect of discovery.
 *
 * M-01 (LOCKED) and the TEMPORARY TA-Q-02 ad-account restriction are decided by the database's two named unique
 * indexes; connections.locate_active_link only lets the application explain the refusal (same organization only).
 * No provider I/O happens here: capability evaluation is enqueued by the caller after activation.
 */
import { AppError } from "@/domain/errors";
import type { WorkspaceId } from "@/domain/ids";
import { singleWorkspaceRule, type ConnectedAccount, type ConnectionProvider, type DiscoveredAsset, type SingleWorkspaceRule } from "../domain/model";
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

/**
 * The local discovered asset and its Connection, which must be ACTIVE (a degraded/failed one can't link). The
 * Connection is read FOR SHARE (Step 7G-F4C): a concurrent removal either commits first — this read then sees REMOVED
 * and refuses — or waits for this transaction and then deactivates what it activated. ACTIVE account under REMOVED
 * Connection can't be committed.
 */
export async function loadLinkableAsset(store: ConnectionStore, discoveredAssetId: string): Promise<DiscoveredAsset> {
  const asset = await store.discoveredAssets.get(discoveredAssetId);
  if (asset === undefined) throw new AppError("NOT_FOUND", {});
  const connection = await store.connections.getForShare(asset.connectionId);
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

// ── Managed-account selection (Step 7G-H5) ────────────────────────────────────────────────────────────────────

/** The discovered assets a workspace can choose to manage: content-bearing Facebook Pages and Instagram accounts. */
export function isManageableAsset(asset: Pick<DiscoveredAsset, "assetClass" | "platform">): boolean {
  return asset.assetClass === "content_bearing" && (asset.platform === "facebook" || asset.platform === "instagram");
}

export interface SelectionOutput {
  /** Connected accounts this save activated (linked or reactivated) or deactivated (unlinked); empty when unchanged. */
  readonly activated: readonly string[];
  readonly deactivated: readonly string[];
  /** The discovered assets managed by this Connection after the save. */
  readonly managed: readonly string[];
}

/**
 * Converges the managed accounts of ONE Connection to exactly `discoveredAssetIds`, in the caller's single transaction.
 * Every fact comes from the database, never from the request: the Connection is read FOR UPDATE in the bound workspace
 * (RLS; another workspace's or a removed one is NOT_FOUND / STALE_STATE), it must be the expected provider and ACTIVE,
 * and every id must be one of ITS manageable discovered assets (anything else is NOT_FOUND, with nothing changed).
 *
 * The row lock serializes this with a concurrent save of the same Connection (the later one re-reads the committed
 * state: identical saves are no-ops, different ones end as the last committed) and with a removal, which locks the
 * same row: a removal that commits first makes this a STALE_STATE refusal; one that waits deactivates what this
 * activated. Deactivation is the existing unlink (INACTIVE, UNLINKED; the row keeps its identity), activation the
 * existing link (reactivating that row, or inserting the first one). An asset active in another workspace of the
 * organization (M-01 / TA-Q-02) refuses the whole save (CONFLICT) — partial selections are never committed. No
 * provider, KMS or job call: this is local Wrenkind state built only from the persisted discovery.
 */
export async function saveManagedSelection(
  store: ConnectionStore,
  input: {
    readonly scope: WorkspaceScope;
    readonly connectionId: string;
    readonly expectedProvider: ConnectionProvider;
    readonly discoveredAssetIds: readonly string[];
    readonly now: Date;
    readonly newId: () => string;
  },
): Promise<SelectionOutput> {
  const connection = await store.connections.lockForUpdate(input.connectionId);
  if (connection === undefined || connection.provider !== input.expectedProvider) throw new AppError("NOT_FOUND", {});
  if (connection.status !== "ACTIVE") throw new AppError("STALE_STATE", {});

  const manageable = new Map((await store.discoveredAssets.list(connection.id)).filter(isManageableAsset).map((asset) => [asset.id, asset]));
  const desired = new Map<string, DiscoveredAsset>();
  for (const id of input.discoveredAssetIds) {
    const asset = manageable.get(id);
    if (asset === undefined) throw new AppError("NOT_FOUND", {});
    desired.set(`${asset.platform}:${asset.providerAssetId}`, asset);
  }

  const active = (await store.connectedAccounts.list()).filter((account) => account.connectionId === connection.id && account.status === "ACTIVE");
  const activeKeys = new Set(active.map((account) => `${account.platform}:${account.providerAssetId}`));
  const deactivated: string[] = [];
  for (const account of active) {
    if (desired.has(`${account.platform}:${account.providerAssetId}`)) continue;
    if ((await unlinkAccount(store, { scope: input.scope, connectedAccountId: account.id, now: input.now, newId: input.newId })).changed) deactivated.push(account.id);
  }
  const activated: string[] = [];
  for (const [key, asset] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
    if (activeKeys.has(key)) continue;
    const linked = await linkAccount(store, { scope: input.scope, discoveredAssetId: asset.id, now: input.now, newId: input.newId });
    if (linked.kind === "active_elsewhere") throw new AppError("CONFLICT", {});
    if (linked.kind === "linked") activated.push(linked.account.id);
  }
  return { activated, deactivated, managed: [...desired.values()].map((asset) => asset.id).sort() };
}
