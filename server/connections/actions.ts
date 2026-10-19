"use server";
/**
 * Connect Meta (Step 7G-F4) and Remove Meta (Step 7G-F4C): the permanent Server Actions behind Workspace Settings ›
 * Connections. POST only (Server Actions, behind Next.js's Origin/Host check). The identity is the session's, the
 * provider is fixed here to "meta", and connections.manage is enforced by the pipeline (and RLS).
 *
 *   connect   reads ONE value, the routed workspace id. The only external redirect is the authorization URL the
 *             orchestration has already matched to Meta's exact dialog endpoint.
 *   remove    reads the routed workspace id, the connection id and the visible acknowledgement. No external redirect.
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
import { connectMeta, removeMeta, type ConnectOutcome } from "./settings";
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

export async function removeMetaConnectionAction(form: FormData): Promise<void> {
  const workspaceId = parseWorkspaceId(form.get("workspaceId"));
  if (workspaceId === undefined) redirect("/onboarding");
  const connectionId = form.get("connectionId");
  const acknowledgement = form.get("acknowledgement");
  // Removal needs no OAuth secret, sealer or provider: the plain settings pipeline (web unit of work) runs it.
  redirect(destination(await run("remove_meta", (auth) => removeMeta(connectionSettingsPipeline(auth), { workspaceId, connectionId, acknowledgement })), workspaceId));
}
