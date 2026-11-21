/**
 * The closed, serializable result of the workflow Server Action (WORKFLOW-WF-2B), shared by the action and the client
 * control. Outcome language only: never an internal error, a version detail beyond the one the page needs, or an echo.
 */
export type WorkflowBlockedCode = "PERMISSION_DENIED" | "NOT_FOUND" | "INVALID_INPUT";

export type WorkflowActionState =
  | { readonly kind: "idle" }
  /** Saved: the state and version now current (the page re-renders from the database as well). */
  | { readonly kind: "saved"; readonly change: "done" | "reopened"; readonly undoable: boolean; readonly version: number }
  /** Nothing to do: it already was in that state. */
  | { readonly kind: "unchanged" }
  /** Someone (or a new audience comment) changed it after the page was drawn: nothing was written; the page refreshes. */
  | { readonly kind: "conflict" }
  | { readonly kind: "blocked"; readonly code: WorkflowBlockedCode }
  | { readonly kind: "unavailable" }
  | { readonly kind: "signed_out" };

export type WorkflowAction = (previous: WorkflowActionState, formData: FormData) => Promise<WorkflowActionState>;

/** The only fields the control posts. */
export const WORKFLOW_FORM_FIELDS = ["workspaceId", "conversationId", "expectedVersion", "to", "resolution", "undo"] as const;
