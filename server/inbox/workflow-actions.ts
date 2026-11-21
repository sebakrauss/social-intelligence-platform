"use server";
/**
 * Mark Done / Reopen (WORKFLOW-WF-2B): the one Server Action behind the Comments conversation's workflow control. POST
 * only (a Server Action, behind Next.js's Origin/Host check). It reads exactly the fields in WORKFLOW_FORM_FIELDS — the
 * routed workspace, the conversation, the version the page showed, the target state, an optional resolution and whether
 * this is an Undo — and runs the registered workflow command through the action pipeline, which re-validates the
 * session, the membership, `workflow.internal` and the input; the database boundary re-checks all of it again.
 *
 * Pilot scope: the control is drawn only on the Comments route, which is offered to allowlisted workspaces only; this
 * action answers exactly like an unknown conversation for any other workspace (the allowlist is not changed, and it
 * cannot be probed through here). No platform action follows: nothing is sent, hidden or replied at Meta.
 */
import { revalidatePath } from "next/cache";
import { isUuid, parseWorkspaceId } from "@/domain/ids";
import { isWorkItemResolution } from "@/modules/workflow";
import { createLogger, stdoutSink } from "@/platform/observability";
import { requestAuth } from "@/server/auth/request-auth";
import { markDoneCommand, reopenCommand } from "@/server/commands/workflow";
import { workspaceCommentsPath } from "@/server/routes";
import { commentsOfferedFor } from "./comments-access";
import { inboxPipeline } from "./runtime";
import type { WorkflowActionState, WorkflowBlockedCode } from "./workflow-state";

const log = createLogger({ sink: stdoutSink, base: { module: "server.inbox.workflow" } });
const BLOCKED: readonly WorkflowBlockedCode[] = ["PERMISSION_DENIED", "NOT_FOUND", "INVALID_INPUT"];

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function changeWorkflowStateAction(_previous: WorkflowActionState, form: FormData): Promise<WorkflowActionState> {
  const workspaceId = parseWorkspaceId(field(form, "workspaceId"));
  const conversationId = field(form, "conversationId");
  const expectedVersion = Number(field(form, "expectedVersion"));
  const to = field(form, "to");
  const resolution = field(form, "resolution");
  const undo = field(form, "undo") === "1";
  if (workspaceId === undefined || !isUuid(conversationId) || (to !== "done" && to !== "open")) return { kind: "blocked", code: "NOT_FOUND" };
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || (resolution !== "" && (to !== "done" || !isWorkItemResolution(resolution)))) return { kind: "blocked", code: "INVALID_INPUT" };
  // The pilot route's allowlist, unchanged: an unlisted workspace gets the answer of an unknown conversation.
  if (!commentsOfferedFor(workspaceId)) return { kind: "blocked", code: "NOT_FOUND" };
  const auth = await requestAuth();
  if (auth === undefined) return { kind: "signed_out" };
  try {
    const pipeline = inboxPipeline(auth);
    const result =
      to === "done"
        ? await pipeline.run(markDoneCommand, { workspaceId, input: { conversationId, expectedVersion, ...(resolution === "" ? {} : { resolution }) } })
        : await pipeline.run(reopenCommand, { workspaceId, input: { conversationId, expectedVersion } });
    if (result.status === "unauthenticated" || result.status === "verification_required") return { kind: "signed_out" };
    // Saved, unchanged or refused as stale: the Comments pages re-render from the database either way.
    const base = workspaceCommentsPath(workspaceId);
    if (base !== undefined) revalidatePath(base, "layout");
    if (result.status === "error") {
      const code = result.error.code;
      if (code === "CONFLICT") return { kind: "conflict" };
      return BLOCKED.includes(code as WorkflowBlockedCode) ? { kind: "blocked", code: code as WorkflowBlockedCode } : { kind: "unavailable" };
    }
    if (result.value.outcome === "unchanged") return { kind: "unchanged" };
    // Undo is offered once, right after a Mark Done (the reverse of an Undo is not offered again).
    return { kind: "saved", change: result.value.state === "DONE" ? "done" : "reopened", undoable: result.value.state === "DONE" && !undo, version: result.value.version };
  } catch {
    log.warn("inbox.workflow.unavailable", { outcome: "error" });
    return { kind: "unavailable" };
  }
}
