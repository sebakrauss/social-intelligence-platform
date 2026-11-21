"use server";
/**
 * Comments Workflow harness action — DEVELOPMENT ONLY. Simulates the REAL action's closed contract
 * (server/inbox/workflow-actions.ts → workflow.change_state) over the harness's in-memory store: the same fields, the same
 * validation, the role's `workflow.internal` from the REAL permission catalog, compare-and-set on the version shown
 * (stale → conflict, nothing changed), the same state → unchanged, Undo offered once after Mark done. No session,
 * database, pipeline, provider or job is reached; outside development it answers `unavailable` and does nothing else.
 */
import { revalidatePath } from "next/cache";
import { isWorkItemResolution } from "@/domain/workflow";
import { WORKSPACE_ROLE_PERMISSIONS } from "@/platform/permissions/catalog";
import type { WorkflowActionState } from "@/server/inbox/workflow-state";
import { HARNESS_PATH, HARNESS_WORKSPACE, harnessState } from "./store";

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function simulateWorkflowAction(_previous: WorkflowActionState, form: FormData): Promise<WorkflowActionState> {
  if (!IS_DEVELOPMENT) return { kind: "unavailable" };
  const conversationId = field(form, "conversationId");
  const expectedVersion = Number(field(form, "expectedVersion"));
  const to = field(form, "to");
  const resolution = field(form, "resolution");
  const undo = field(form, "undo") === "1";
  if (field(form, "workspaceId") !== HARNESS_WORKSPACE || !UUID.test(conversationId) || (to !== "done" && to !== "open")) return { kind: "blocked", code: "NOT_FOUND" };
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || (resolution !== "" && (to !== "done" || !isWorkItemResolution(resolution)))) return { kind: "blocked", code: "INVALID_INPUT" };
  const state = harnessState();
  // A visible delay so the pending state (and a second click during it) can be observed; longer in `slow` mode.
  await new Promise((resolve) => setTimeout(resolve, state.mode === "slow" ? 1500 : 400));
  if (state.mode === "fail-once") {
    state.mode = "normal";
    return { kind: "unavailable" };
  }
  if (!WORKSPACE_ROLE_PERMISSIONS[state.role].has("workflow.internal")) return { kind: "blocked", code: "PERMISSION_DENIED" };
  const item = state.items.find((candidate) => candidate.id === conversationId);
  if (item === undefined) return { kind: "blocked", code: "NOT_FOUND" };
  revalidatePath(HARNESS_PATH);
  if (item.version !== expectedVersion) return { kind: "conflict" };
  const target = to === "done" ? "DONE" : "OPEN";
  const nextResolution = to === "done" && resolution !== "" && isWorkItemResolution(resolution) ? resolution : null;
  if (item.state === target && item.resolution === nextResolution) return { kind: "unchanged" };
  item.state = target;
  item.resolution = nextResolution;
  item.version += 1;
  return { kind: "saved", change: target === "DONE" ? "done" : "reopened", undoable: target === "DONE" && !undo, version: item.version };
}
