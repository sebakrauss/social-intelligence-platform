"use server";
/**
 * Connect Meta (Step 7G-F4) and Remove Meta (Step 7G-F4C): the permanent Server Actions behind Workspace Settings ›
 * Connections. POST only (Server Actions, behind Next.js's Origin/Host check). The identity is the session's, the
 * provider is fixed here to "meta", and connections.manage is enforced by the pipeline (and RLS).
 *
 *   connect   reads ONE value, the routed workspace id. The only external redirect is the authorization URL the
 *             orchestration has already matched to Meta's exact dialog endpoint.
 *   reconnect reads the routed workspace id and ONE connection id (Step 7G-H5.5-P12-C0-R2): the same start as connect,
 *             with that connection as the reconnect target. The only external redirect is the same validated Meta dialog.
 *   remove    reads the routed workspace id, the connection id and the visible acknowledgement. No external redirect.
 *   accounts  reads the routed workspace id, the connection id and the checked discovered-asset ids. No external
 *             redirect; no provider, KMS or job is reached.
 *   recheck   reads the routed workspace id and ONE connected account id (Step 7G-H5.5-P2-B2): it requests a capability
 *             re-evaluation through the registered command. No external redirect; no provider, KMS, job or outbox write
 *             of its own; the evaluation itself is never awaited.
 *   sync      reads the routed workspace id and ONE connected account id (Step H6-C4): it requests a reconciliation
 *             through the registered command, whose 0019 boundary writes the run, its audit event and its planner row.
 *             No budget, time or topic is read from the form; no provider, KMS, job or outbox write of its own; the
 *             reconciliation itself is never awaited.
 *
 * No form field chooses a destination: every other outcome returns to a fixed internal path built from the parsed
 * workspace id. Nothing internal is logged or returned, and no form payload is logged.
 */
import { redirect } from "next/navigation";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import type { IdentityPort } from "@/platform/auth/port";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { workspaceConnectionsPath } from "@/server/routes";
import { connectionAuthorizationRuntime } from "./runtime";
import { connectMeta, reconnectMeta, removeMeta, requestCapabilityRecheck, requestInteractionsSync, saveManagedAccounts, type ConnectOutcome } from "./settings";
import { connectionSettingsPipeline } from "./settings-runtime";

const log = createLogger({ sink: stdoutSink, base: { module: "server.connections" } });

async function run(operation: string, work: (identity: IdentityPort) => Promise<ConnectOutcome>): Promise<ConnectOutcome> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "status", status: "unavailable" };
  try {
    return await work(auth);
  } catch {
    log.warn(`connections.${operation}.unavailable`, { outcome: "error" });
    return { kind: "status", status: "unavailable" };
  }
}

function destination(outcome: ConnectOutcome, workspaceId: WorkspaceId): string {
  switch (outcome.kind) {
    case "authorize":
      return outcome.url;
    case "signed_out":
      return "/sign-in";
    case "verification_required":
      return "/sign-in?status=verification_required";
    case "status":
      return `${workspaceConnectionsPath(workspaceId)}?status=${outcome.status}`;
  }
}

export async function startMetaConnectionAction(form: FormData): Promise<void> {
  const workspaceId = parseWorkspaceId(form.get("workspaceId"));
  // Not a workspace id at all: nothing to route to, nothing reflected.
  if (workspaceId === undefined) redirect("/onboarding");
  redirect(destination(await run("connect_meta", (auth) => connectMeta(connectionAuthorizationRuntime(auth), workspaceId)), workspaceId));
}

export async function reconnectMetaConnectionAction(form: FormData): Promise<void> {
  const workspaceId = parseWorkspaceId(form.get("workspaceId"));
  if (workspaceId === undefined) redirect("/onboarding");
  const connectionId = form.get("connectionId");
  redirect(destination(await run("reconnect_meta", (auth) => reconnectMeta(connectionAuthorizationRuntime(auth), { workspaceId, connectionId })), workspaceId));
}

export async function removeMetaConnectionAction(form: FormData): Promise<void> {
  const workspaceId = parseWorkspaceId(form.get("workspaceId"));
  if (workspaceId === undefined) redirect("/onboarding");
  const connectionId = form.get("connectionId");
  const acknowledgement = form.get("acknowledgement");
  // Removal needs no OAuth secret, sealer or provider: the plain settings pipeline (web unit of work) runs it.
  redirect(destination(await run("remove_meta", (auth) => removeMeta(connectionSettingsPipeline(auth), { workspaceId, connectionId, acknowledgement })), workspaceId));
}

export async function saveManagedAccountsAction(form: FormData): Promise<void> {
  const workspaceId = parseWorkspaceId(form.get("workspaceId"));
  if (workspaceId === undefined) redirect("/onboarding");
  const connectionId = form.get("connectionId");
  const discoveredAssetIds = form.getAll("discoveredAssetId");
  // Selection is local configuration: the plain settings pipeline (web unit of work) runs it.
  redirect(
    destination(await run("save_managed_accounts", (auth) => saveManagedAccounts(connectionSettingsPipeline(auth), { workspaceId, connectionId, discoveredAssetIds })), workspaceId),
  );
}

export async function requestCapabilityRecheckAction(form: FormData): Promise<void> {
  const workspaceId = parseWorkspaceId(form.get("workspaceId"));
  if (workspaceId === undefined) redirect("/onboarding");
  const connectedAccountId = form.get("connectedAccountId");
  // A request, not a platform mutation: the plain settings pipeline (web unit of work) runs it; the redirect re-renders the page.
  redirect(destination(await run("request_capability_recheck", (auth) => requestCapabilityRecheck(connectionSettingsPipeline(auth), { workspaceId, connectedAccountId })), workspaceId));
}

export async function requestInteractionsSyncAction(form: FormData): Promise<void> {
  const workspaceId = parseWorkspaceId(form.get("workspaceId"));
  if (workspaceId === undefined) redirect("/onboarding");
  const connectedAccountId = form.get("connectedAccountId");
  // A request, not a platform mutation: the plain settings pipeline (web unit of work) runs it; the redirect re-renders the page.
  redirect(destination(await run("request_interactions_sync", (auth) => requestInteractionsSync(connectionSettingsPipeline(auth), { workspaceId, connectedAccountId })), workspaceId));
}
