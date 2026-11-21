"use client";
/**
 * The conversation's workflow control (WORKFLOW-WF-2B): Mark done (with an optional resolution) when it is Open,
 * Reopen when it is Done, and Undo right after a Mark done. Each is a POST of the page's own identifiers, the version the
 * page shows and the target state; the server decides (permission, version, state) and the page re-renders from the
 * database. Nothing is optimistic: the state shown beside the title changes only when the server's answer arrives, and
 * a conversation that changed meanwhile (another person, or a new audience comment) is refused and refreshed, never
 * overwritten. No platform action is implied: Done is internal to Wrenkind.
 *
 * WORKFLOW-WF-2E (the three WF-2D browser findings):
 * - B-1: the three forms share ONE action state, so the outcome shown is always the last submission's own — a Mark done
 *   after an Undo says "Marked done." and offers Undo again (never the stale "Reopened.").
 * - B-3: one submission at a time. A submit made while an earlier one has not yet come back (a second press in the same
 *   tick, before the button could be disabled) is dropped in the browser: it never reaches the server, so it cannot
 *   turn the person's own change into a "conflict". The server's version check is unchanged and still refuses a change
 *   made elsewhere (another tab, a new audience comment).
 * - B-2: the pressed button is disabled while pending and the form is replaced after a save, which dropped the keyboard
 *   focus to the page. When the focus was inside this control at submit time, it is put back — once, when the answer is
 *   shown — on the control's state button (Mark done or Reopen, whichever the page now offers). A press that never
 *   focused the control (a pointer on a browser that does not focus buttons) moves nothing.
 *
 * Every label arrives translated from the server page (client components hold no catalog).
 */
import { useActionState, useCallback, useId, useRef, type SyntheticEvent } from "react";
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

/** The last answer and how many answers this control has shown (0: none yet). Each answer is a new `answered`. */
interface Settled {
  readonly outcome: WorkflowActionState;
  readonly answered: number;
}

const INITIAL: Settled = { outcome: { kind: "idle" }, answered: 0 };

function Submit({ label, pendingLabel, variant, busy }: { readonly label: string; readonly pendingLabel: string; readonly variant: "primary" | "secondary" | "ghost"; readonly busy: boolean }) {
  const { pending } = useFormStatus();
  // Its own form pending: the pending label. Another of this control's forms pending: simply not pressable.
  return (
    <Button type="submit" variant={variant} size="sm" pending={pending} pendingLabel={pendingLabel} disabled={busy}>
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
  const [settled, formAction, busy] = useActionState(async (previous: Settled, form: FormData): Promise<Settled> => ({ outcome: await action(previous.outcome, form), answered: previous.answered + 1 }), INITIAL);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  // The answer count a submission was made from: while it is still the one shown, that submission has not come back.
  const sentFrom = useRef(-1);
  const focusBack = useRef(false);
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    if (sentFrom.current === settled.answered) {
      event.preventDefault();
      return;
    }
    sentFrom.current = settled.answered;
    const control = root.current;
    focusBack.current = control !== null && control.contains(control.ownerDocument.activeElement);
  };
  // Runs when the state form is attached, and again each time a new answer is shown (its identity follows the count).
  const stateForm = useCallback(
    (form: HTMLFormElement | null) => {
      if (form === null || settled.answered === 0 || !focusBack.current) return;
      focusBack.current = false;
      form.querySelector("button")?.focus({ preventScroll: true });
    },
    [settled.answered],
  );
  const shown = settled.outcome;
  const message = messageOf(shown, labels.outcomes);
  // Undo: once, right after this page's own Mark done, while the page still shows that very version Done.
  const undo = shown.kind === "saved" && shown.undoable && current.state === "done" && shown.version === current.version ? shown : undefined;
  return (
    <div className={styles["control"]} ref={root}>
      {current.state === "open" ? (
        <form action={formAction} onSubmit={onSubmit} ref={stateForm} className={styles["form"]}>
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
          <Submit label={labels.markDone} pendingLabel={labels.marking} variant="primary" busy={busy} />
        </form>
      ) : (
        <form action={formAction} onSubmit={onSubmit} ref={stateForm} className={styles["form"]}>
          <input type="hidden" name="workspaceId" value={fields.workspaceId} />
          <input type="hidden" name="conversationId" value={fields.conversationId} />
          <input type="hidden" name="expectedVersion" value={current.version} />
          <input type="hidden" name="to" value="open" />
          <Submit label={labels.reopen} pendingLabel={labels.reopening} variant="secondary" busy={busy} />
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
          <form action={formAction} onSubmit={onSubmit} className={styles["undo"]}>
            <input type="hidden" name="workspaceId" value={fields.workspaceId} />
            <input type="hidden" name="conversationId" value={fields.conversationId} />
            <input type="hidden" name="expectedVersion" value={undo.version} />
            <input type="hidden" name="to" value="open" />
            <input type="hidden" name="undo" value="1" />
            <Submit label={labels.undo} pendingLabel={labels.undoing} variant="ghost" busy={busy} />
          </form>
        ) : null}
      </div>
    </div>
  );
}
