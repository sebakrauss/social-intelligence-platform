/**
 * Workspace Settings › Connections and the permanent Connect Meta start (Step 7G-F4).
 *
 *   - The page reads one command, connections.settings.view (connections.manage): Owner/Admin only, per IA §18. Reading
 *     never mutates: no stale-attempt recovery, no authorization start.
 *   - Connect Meta runs the atomic start with the provider FIXED to "meta". The browser routes only the workspace id
 *     (untrusted; the pipeline resolves it live). Whether a fresh Meta connect is open is decided by that start under
 *     its lock; the page's view of it is UX only.
 *   - Remove Meta (Step 7G-F4C) runs connections.connection.remove with the expected provider FIXED to "meta", only
 *     after the visible acknowledgement; it is a LOCAL removal: Wrenkind deletes its stored credential and deactivates
 *     the connection's accounts. It does NOT revoke the authorization inside Meta.
 *   - Manage accounts (Step 7G-H5) saves which of an ACTIVE Meta connection's discovered Facebook Pages and Instagram
 *     professional accounts this workspace manages: connections.account.save_selection, the whole desired set at once,
 *     with the expected provider FIXED to "meta". Local only: no provider, KMS or job.
 *   - Re-check capabilities (Step 7G-H5.5-P2-B2) REQUESTS a new capability evaluation of one managed account:
 *     connections.account.request_capability_reevaluation, with the routed account id as its only input. Whether the
 *     page offers it is presentation (the read model's re-check offer); the command decides again under the account's
 *     row lock (permission, lifecycle, profile, cooldown). It never waits for, polls or promises the evaluation.
 *   - Outcomes are closed codes: nothing from an error, a provider or the database reaches a URL or the page. A
 *     workspace that doesn't exist, isn't the caller's, or isn't a UUID is the same `workspace_not_found`; a connection
 *     that doesn't exist, isn't this workspace's, isn't Meta's or isn't a UUID is the same `connection_not_found`.
 */
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import type { MessageKey } from "@/domain/i18n/message-keys";
import type { ConnectionProvider, ConnectionSettings, ConnectionSummary, ReevaluationOfferReason, ReevaluationRefusal } from "@/modules/connections";
import type { ConnectionStatus } from "@/domain/connections";
import { SELECTION_MAX_ASSETS, connectedAccountSelectionCommand, createConnectedAccountCommands } from "@/server/commands/connected-accounts";
import { connectionRemoveCommand, connectionSettingsViewCommand } from "@/server/commands/connections";
import type { ActionPipeline } from "@/server/pipeline";
import { startConnectionAuthorization, type ConnectionAuthorizationDependencies, type StartResult } from "./authorization";

export type ConnectionSettingsState =
  | { readonly kind: "signed_out" }
  | { readonly kind: "verification_required" }
  | { readonly kind: "workspace_not_found" }
  | { readonly kind: "not_allowed" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      /** The routed id as the pipeline resolved it (a canonical UUID of a workspace the caller manages). */
      readonly workspaceId: WorkspaceId;
      readonly connections: readonly ConnectionSummary[];
      readonly metaConnect: ConnectionSettings["metaConnect"];
      readonly manageableAssets: ConnectionSettings["manageableAssets"];
    };

export const CONNECT_STATUSES = [
  "workspace_not_found",
  "not_allowed",
  "provider_unavailable",
  "existing_connection",
  "authorization_in_progress",
  "authorization_start_failed",
  "removed",
  "remove_not_confirmed",
  "connection_not_found",
  "accounts_saved",
  "accounts_not_found",
  "accounts_conflict",
  "connection_not_ready",
  "capability_recheck_requested",
  "capability_recheck_too_soon",
  "capability_recheck_not_needed",
  "capability_recheck_newer_version",
  "capability_recheck_account_inactive",
  "capability_recheck_connection_not_active",
  "capability_recheck_not_found",
  "unavailable",
] as const;
export type ConnectStatus = (typeof CONNECT_STATUSES)[number];

export const CONNECT_STATUS_MESSAGES: { readonly [S in ConnectStatus]: MessageKey } = {
  workspace_not_found: "connections.settings.workspace_not_found",
  not_allowed: "connections.settings.not_allowed",
  provider_unavailable: "connections.status.provider_unavailable",
  existing_connection: "connections.meta.existing",
  authorization_in_progress: "connections.status.authorization_in_progress",
  authorization_start_failed: "connections.status.authorization_start_failed",
  removed: "connections.status.removed",
  remove_not_confirmed: "connections.status.remove_not_confirmed",
  connection_not_found: "connections.status.connection_not_found",
  accounts_saved: "connections.status.accounts_saved",
  accounts_not_found: "connections.status.accounts_not_found",
  accounts_conflict: "connections.status.accounts_conflict",
  connection_not_ready: "connections.status.connection_not_ready",
  capability_recheck_requested: "connections.status.capability_recheck_requested",
  capability_recheck_too_soon: "connections.status.capability_recheck_too_soon",
  capability_recheck_not_needed: "connections.status.capability_recheck_not_needed",
  capability_recheck_newer_version: "connections.status.capability_recheck_newer_version",
  capability_recheck_account_inactive: "connections.status.capability_recheck_account_inactive",
  capability_recheck_connection_not_active: "connections.status.capability_recheck_connection_not_active",
  capability_recheck_not_found: "connections.status.capability_recheck_not_found",
  unavailable: "connections.settings.unavailable",
};

export const CONNECTION_STATUS_MESSAGES: { readonly [S in ConnectionStatus]: MessageKey } = {
  CONNECTING: "connections.connection.status.connecting",
  ACTIVE: "connections.connection.status.active",
  DEGRADED: "connections.connection.status.degraded",
  FAILED: "connections.connection.status.failed",
  DISCONNECTED: "connections.connection.status.disconnected",
  REMOVED: "connections.connection.status.removed",
};

export const CONNECTION_PROVIDER_MESSAGES: { readonly [P in ConnectionProvider]: MessageKey } = {
  meta: "connections.provider.meta",
  tiktok: "connections.provider.tiktok",
  simulator: "connections.provider.simulator",
};

/** One discovered asset the page may offer, as the read model carries it (persisted discovery only). */
export type ManageableAssetView = ConnectionSettings["manageableAssets"][number];

export const ASSET_PLATFORM_MESSAGES: { readonly [P in ManageableAssetView["platform"]]: MessageKey } = {
  facebook: "connections.accounts.platform.facebook",
  instagram: "connections.accounts.platform.instagram",
  tiktok: "connections.accounts.platform.tiktok",
};

/** Why a managed account is offered a re-check (or was re-checked recently): presentation copy only. */
export const CAPABILITY_RECHECK_OFFER_MESSAGES: { readonly [R in ReevaluationOfferReason | "REEVALUATION_TOO_SOON"]: MessageKey } = {
  PROFILE_NOT_EVALUATED: "connections.recheck.reason.not_evaluated",
  PROFILE_STALE: "connections.recheck.reason.stale",
  ACCOUNT_FACTS_UNAVAILABLE: "connections.recheck.reason.facts_unavailable",
  ACCOUNT_PERMISSION_MISSING: "connections.recheck.reason.not_authorized",
  REEVALUATION_TOO_SOON: "connections.recheck.reason.too_soon",
};

export function parseConnectStatus(value: unknown): ConnectStatus | undefined {
  return typeof value === "string" && (CONNECT_STATUSES as readonly string[]).includes(value) ? (value as ConnectStatus) : undefined;
}

/** The caller's view of one workspace's connections. Read only: one connections.settings.view query. */
export async function resolveConnectionSettings(pipeline: ActionPipeline, workspaceId: unknown): Promise<ConnectionSettingsState> {
  const result = await pipeline.run(connectionSettingsViewCommand, { workspaceId, input: {} });
  if (result.status === "unauthenticated") return { kind: "signed_out" };
  if (result.status === "verification_required") return { kind: "verification_required" };
  if (result.status === "error") {
    if (result.error.code === "NOT_FOUND") return { kind: "workspace_not_found" };
    if (result.error.code === "PERMISSION_DENIED") return { kind: "not_allowed" };
    return { kind: "unavailable" };
  }
  const resolved = parseWorkspaceId(workspaceId);
  if (resolved === undefined) return { kind: "workspace_not_found" };
  return { kind: "ready", workspaceId: resolved, connections: result.value.connections, metaConnect: result.value.metaConnect, manageableAssets: result.value.manageableAssets };
}

export type ConnectOutcome =
  | { readonly kind: "authorize"; readonly url: string }
  | { readonly kind: "signed_out" }
  | { readonly kind: "verification_required" }
  | { readonly kind: "status"; readonly status: ConnectStatus };

/** Start results → closed outcomes. Only `ok` carries a URL, and only one the orchestration already validated. */
export function connectOutcome(result: StartResult): ConnectOutcome {
  switch (result.status) {
    case "ok":
      return { kind: "authorize", url: result.authorizationUrl };
    case "existing_connection":
    case "authorization_in_progress":
      return { kind: "status", status: result.status };
    case "unauthenticated":
      return { kind: "signed_out" };
    case "verification_required":
      return { kind: "verification_required" };
    case "error":
      if (result.code === "NOT_FOUND") return { kind: "status", status: "workspace_not_found" };
      if (result.code === "PERMISSION_DENIED") return { kind: "status", status: "not_allowed" };
      // The provider's adapter isn't composed (its app configuration is absent): no other provider stands in.
      if (result.code === "INVALID_INPUT") return { kind: "status", status: "provider_unavailable" };
      if (result.code === "PROVIDER_PERMANENT") return { kind: "status", status: "authorization_start_failed" };
      // Anything else — including a serialization wait past its bound (CONFLICT) — proves nothing: plain unavailable.
      return { kind: "status", status: "unavailable" };
  }
}

/** The fresh Meta start. The provider is this constant; nothing else from the browser but the routed workspace id. */
export async function connectMeta(deps: ConnectionAuthorizationDependencies, workspaceId: unknown): Promise<ConnectOutcome> {
  return connectOutcome(await startConnectionAuthorization(deps, { workspaceId, provider: "meta" }));
}

/** The one acknowledgement value the Remove form submits. UX intent only: authorization is the pipeline's. */
export const REMOVE_ACKNOWLEDGEMENT = "remove-local-meta-connection";

/**
 * Remove a Meta connection. The acknowledgement must be exactly the form's value, or nothing runs. The provider is this
 * constant; the browser routes only the workspace and connection ids (untrusted; parsed here, resolved live by the
 * pipeline and RLS). Already removed is still `removed` (idempotent).
 */
export async function removeMeta(pipeline: ActionPipeline, input: { readonly workspaceId: unknown; readonly connectionId: unknown; readonly acknowledgement: unknown }): Promise<RemoveOutcome> {
  if (input.acknowledgement !== REMOVE_ACKNOWLEDGEMENT) return { kind: "status", status: "remove_not_confirmed" };
  if (!isUuid(input.connectionId)) return { kind: "status", status: "connection_not_found" };
  const result = await pipeline.run(connectionRemoveCommand, { workspaceId: input.workspaceId, input: { connectionId: input.connectionId, expectedProvider: "meta" } });
  switch (result.status) {
    case "ok":
      return { kind: "status", status: "removed" };
    case "unauthenticated":
      return { kind: "signed_out" };
    case "verification_required":
      return { kind: "verification_required" };
    case "error":
      if (result.error.code === "NOT_FOUND" || result.error.code === "INVALID_INPUT") return { kind: "status", status: "connection_not_found" };
      if (result.error.code === "PERMISSION_DENIED") return { kind: "status", status: "not_allowed" };
      // CONFLICT (including a serialization wait past its bound) or anything else: nothing was removed.
      return { kind: "status", status: "unavailable" };
  }
}

/** A removal never leaves the app: every outcome is a fixed internal destination. */
export type RemoveOutcome = Exclude<ConnectOutcome, { readonly kind: "authorize" }>;

/**
 * Save the managed accounts of one Meta connection. The browser routes the workspace and connection ids and the checked
 * discovered-asset ids (all untrusted: parsed here, resolved live by the pipeline and RLS); the provider is this
 * constant. Nothing is saved unless the whole set is: an unknown, foreign or unmanageable asset, a connection that
 * isn't ACTIVE, or an account already managed in another workspace refuses the save as one closed status.
 */
export async function saveManagedAccounts(
  pipeline: ActionPipeline,
  input: { readonly workspaceId: unknown; readonly connectionId: unknown; readonly discoveredAssetIds: readonly unknown[] },
): Promise<RemoveOutcome> {
  if (!isUuid(input.connectionId)) return { kind: "status", status: "connection_not_found" };
  if (input.discoveredAssetIds.length > SELECTION_MAX_ASSETS || !input.discoveredAssetIds.every(isUuid)) return { kind: "status", status: "accounts_not_found" };
  // A repeated checkbox value is the same choice, not a second one.
  const discoveredAssetIds = [...new Set(input.discoveredAssetIds)];
  const result = await pipeline.run(connectedAccountSelectionCommand, {
    workspaceId: input.workspaceId,
    input: { connectionId: input.connectionId, expectedProvider: "meta", discoveredAssetIds },
  });
  switch (result.status) {
    case "ok":
      return { kind: "status", status: "accounts_saved" };
    case "unauthenticated":
      return { kind: "signed_out" };
    case "verification_required":
      return { kind: "verification_required" };
    case "error":
      if (result.error.code === "NOT_FOUND" || result.error.code === "INVALID_INPUT") return { kind: "status", status: "accounts_not_found" };
      if (result.error.code === "PERMISSION_DENIED") return { kind: "status", status: "not_allowed" };
      // The connection isn't ACTIVE (any more): checked under the row lock, and again by each activation.
      if (result.error.code === "STALE_STATE" || result.error.code === "CONNECTION_PROBLEM") return { kind: "status", status: "connection_not_ready" };
      if (result.error.code === "CONFLICT") return { kind: "status", status: "accounts_conflict" };
      return { kind: "status", status: "unavailable" };
  }
}

/** The registered command (B1), from its registry: this surface never reaches the recovery service directly. */
const { requestCapabilityReevaluation } = createConnectedAccountCommands();

/** Typed refusals of the command → closed page statuses (none reads as success; nothing internal is carried). */
export const CAPABILITY_RECHECK_REFUSALS: { readonly [R in ReevaluationRefusal]: ConnectStatus } = {
  REEVALUATION_TOO_SOON: "capability_recheck_too_soon",
  PROFILE_CURRENT: "capability_recheck_not_needed",
  PROFILE_NEWER_THAN_CODE: "capability_recheck_newer_version",
  ACCOUNT_INACTIVE: "capability_recheck_account_inactive",
  CONNECTION_NOT_ACTIVE: "capability_recheck_connection_not_active",
};

/**
 * Request a capability re-check of one Connected Account. The browser routes the workspace id and the account id
 * (untrusted: parsed here, resolved live by the pipeline and RLS); nothing else is sent — no provider, eligibility,
 * cooldown or key. Exactly one command run; a refusal (including REEVALUATION_TOO_SOON after a race) is shown, never
 * retried. Success means REQUESTED: the evaluation runs later in the job runtime and is not awaited.
 */
export async function requestCapabilityRecheck(pipeline: ActionPipeline, input: { readonly workspaceId: unknown; readonly connectedAccountId: unknown }): Promise<RemoveOutcome> {
  if (!isUuid(input.connectedAccountId)) return { kind: "status", status: "capability_recheck_not_found" };
  const result = await pipeline.run(requestCapabilityReevaluation, { workspaceId: input.workspaceId, input: { connectedAccountId: input.connectedAccountId } });
  switch (result.status) {
    case "ok":
      return { kind: "status", status: result.value.requested ? "capability_recheck_requested" : CAPABILITY_RECHECK_REFUSALS[result.value.reason] };
    case "unauthenticated":
      return { kind: "signed_out" };
    case "verification_required":
      return { kind: "verification_required" };
    case "error":
      if (result.error.code === "NOT_FOUND" || result.error.code === "INVALID_INPUT") return { kind: "status", status: "capability_recheck_not_found" };
      if (result.error.code === "PERMISSION_DENIED") return { kind: "status", status: "not_allowed" };
      return { kind: "status", status: "unavailable" };
  }
}
