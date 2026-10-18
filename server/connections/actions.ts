"use server";
/**
 * Connect Meta (Step 7G-F4): the permanent Server Action behind Workspace Settings › Connections. POST only (Server
 * Actions, behind Next.js's Origin/Host check). The form contributes ONE value, the routed workspace id, which is
 * parsed and then resolved live by the pipeline; the provider is fixed here to "meta", the identity is the session's,
 * and connections.manage is enforced by the pipeline. No form field chooses a destination: the only external redirect
 * is the authorization URL the orchestration has already matched to Meta's exact dialog endpoint; every other
 * outcome returns to a fixed internal path built from the parsed workspace id. Nothing internal is logged or returned.
 */
import { redirect } from "next/navigation";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { workspaceConnectionsPath } from "@/server/routes";
import { connectionAuthorizationRuntime } from "./runtime";
import { connectMeta, type ConnectOutcome } from "./settings";

const log = createLogger({ sink: stdoutSink, base: { module: "server.connections" } });

async function run(workspaceId: WorkspaceId): Promise<ConnectOutcome> {
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "status", status: "unavailable" };
  try {
    return await connectMeta(connectionAuthorizationRuntime(auth), workspaceId);
  } catch {
    log.warn("connections.connect_meta.unavailable", { outcome: "error" });
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
  redirect(destination(await run(workspaceId), workspaceId));
}
