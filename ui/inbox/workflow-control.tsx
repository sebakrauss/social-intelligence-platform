"use client";
/**
 * The conversation's workflow control (WORKFLOW-WF-2B): Mark done (with an optional resolution) when it is Open,
 * Reopen when it is Done, and Undo right after a Mark done. Each is a POST of the page's own identifiers, the version the
 * page shows and the target state; the server decides (permission, version, state) and the page re-renders from the
 * database. Nothing is optimistic: the state shown beside the title changes only when the server's answer arrives, and
 * a conversation that changed meanwhile (another person, or a new audience comment) is refused and refreshed, never
 * overwritten. No platform action is implied: Done is internal to Wrenkind.
 *
 * Every label arrives translated from the server page (client components hold no catalog).
 */
import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";
import type { WorkflowAction, WorkflowActionState } from "@/server/inbox/workflow-state";
import { Button } from "@/ui/primitives/button";
import { Notice } from "@/ui/primitives/notice";
import styles from "./workflow-control.module.css";

export interface WorkflowControlLabels {
  readonly markDone: string;
  readonly marking: string;
  readonly reopen: string;
  readonly reopening: string;
  readonly resolution: string;
  readonly noResolution: string;
  readonly undo: string;
  readonly undoing: string;
  readonly outcomes: WorkflowOutcomeLabels;
}

/** Outcome copy, one field per closed state (no computed lookups in a client module). */
export interface WorkflowOutcomeLabels {
  readonly savedDone: string;
  readonly savedReopened: string;
  readonly unchanged: string;
  readonly conflict: string;
  readonly notPermitted: string;
  readonly notFound: string;
  readonly invalid: string;
  readonly unavailable: string;
  readonly signedOut: string;
}

export interface WorkflowControlProps {
  readonly action: WorkflowAction;
  readonly fields: { readonly workspaceId: string; readonly conversationId: string };
  readonly current: { readonly state: "open" | "done"; readonly version: number };
  readonly resolutions: readonly { readonly value: string; readonly label: string }[];
  readonly labels: WorkflowControlLabels;
}

function Submit({ label, pendingLabel, variant }: { readonly label: string; readonly pendingLabel: string; readonly variant: "primary" | "secondary" | "ghost" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" pending={pending} pendingLabel={pendingLabel}>
      {label}
    </Button>
  );
}

function messageOf(state: WorkflowActionState, outcomes: WorkflowOutcomeLabels): string | undefined {
  switch (state.kind) {
    case "idle":
      return undefined;
    case "saved":
      return state.change === "done" ? outcomes.savedDone : outcomes.savedReopened;
    case "unchanged":
      return outcomes.unchanged;
    case "conflict":
      return outcomes.conflict;
    case "blocked":
      return state.code === "PERMISSION_DENIED" ? outcomes.notPermitted : state.code === "NOT_FOUND" ? outcomes.notFound : outcomes.invalid;
    case "unavailable":
      return outcomes.unavailable;
    case "signed_out":
      return outcomes.signedOut;
  }
}

export function WorkflowControl({ action, fields, current, resolutions, labels }: WorkflowControlProps) {
  const [state, formAction] = useActionState(action, { kind: "idle" });
  const [undoState, undoAction] = useActionState(action, { kind: "idle" });
  const id = useId();
  const shown = undoState.kind === "idle" ? state : undoState;
  const message = messageOf(shown, labels.outcomes);
  // Undo: once, right after this page's own Mark done, while the page still shows it Done.
  const undo = state.kind === "saved" && state.undoable && undoState.kind === "idle" && current.state === "done" ? state : undefined;
  return (
    <div className={styles["control"]}>
      {current.state === "open" ? (
        <form action={formAction} className={styles["form"]}>
          <input type="hidden" name="workspaceId" value={fields.workspaceId} />
          <input type="hidden" name="conversationId" value={fields.conversationId} />
          <input type="hidden" name="expectedVersion" value={current.version} />
          <input type="hidden" name="to" value="done" />
          <label className={styles["resolution"]} htmlFor={`${id}-resolution`}>
            <span className={styles["resolutionLabel"]}>{labels.resolution}</span>
            <select id={`${id}-resolution`} name="resolution" defaultValue="" className={styles["select"]}>
              <option value="">{labels.noResolution}</option>
              {resolutions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Submit label={labels.markDone} pendingLabel={labels.marking} variant="primary" />
        </form>
      ) : (
        <form action={formAction} className={styles["form"]}>
          <input type="hidden" name="workspaceId" value={fields.workspaceId} />
          <input type="hidden" name="conversationId" value={fields.conversationId} />
          <input type="hidden" name="expectedVersion" value={current.version} />
          <input type="hidden" name="to" value="open" />
          <Submit label={labels.reopen} pendingLabel={labels.reopening} variant="secondary" />
        </form>
      )}
      <div className={styles["status"]} role="status" aria-live="polite">
        {message === undefined ? null : shown.kind === "conflict" || shown.kind === "blocked" || shown.kind === "unavailable" || shown.kind === "signed_out" ? (
          <Notice tone="warning" live="off">
            {message}
          </Notice>
        ) : (
          <span className={styles["outcome"]}>{message}</span>
        )}
        {undo !== undefined ? (
          <form action={undoAction} className={styles["undo"]}>
            <input type="hidden" name="workspaceId" value={fields.workspaceId} />
            <input type="hidden" name="conversationId" value={fields.conversationId} />
            <input type="hidden" name="expectedVersion" value={undo.version} />
            <input type="hidden" name="to" value="open" />
            <input type="hidden" name="undo" value="1" />
            <Submit label={labels.undo} pendingLabel={labels.undoing} variant="ghost" />
          </form>
        ) : null}
      </div>
    </div>
  );
}
