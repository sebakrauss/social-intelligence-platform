"use client";
/**
 * W12-AUTH-FIX-01 — an auth form that submits its Server Action at most once at a time.
 *
 * Without it, a second submit event during the 2–3 s the first one is in flight (a repeated click, Enter then a click,
 * or a programmatic `requestSubmit(button)`, which ignores a disabled button) is queued by the App Router and posted
 * right after the first returns — to the URL the first one redirected to. On sign-up that duplicate re-asks Supabase
 * for a confirmation email seconds after the first was sent, is rate-limited, and its redirect replaces the "check
 * your email" screen with an error (DEV, 2026-11-24, W12-AUTH-DIAG-01).
 *
 * The guard is the submit event itself (the same pattern as the Workflow control, ui/inbox/workflow-control.tsx):
 * while a submission is in flight, `preventDefault()` — and React then never invokes the action (react-dom's form
 * action plugin skips a default-prevented submit). Each accepted submit also
 * bumps `attempt`, which re-renders the form in the same batch as React's own pending state; the guard is released
 * when that pending state settles (an error redirect re-renders this same page and the person may try again) or, if
 * the submission never became pending at all (e.g. another listener cancelled it), at once — so the form can never
 * stay locked. A successful redirect
 * leaves the page. The visible pending state is the PendingSubmitButton inside the form. Nothing else changes: the
 * same Server Action, the same fields, the same redirects; no storage, timer or network of its own.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { useFormStatus } from "react-dom";

export function SingleSubmitForm({ action, children }: { readonly action: (form: FormData) => Promise<void>; readonly children: ReactNode }) {
  const inFlight = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const release = useCallback(() => {
    inFlight.current = false;
  }, []);
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    if (inFlight.current) {
      event.preventDefault();
      return;
    }
    inFlight.current = true;
    setAttempt((n) => n + 1);
  };
  return (
    <form action={action} onSubmit={onSubmit}>
      {children}
      <ReleaseWhenSettled attempt={attempt} release={release} />
    </form>
  );
}

/** Releases the guard once the form's submission is no longer pending (or never became pending). */
function ReleaseWhenSettled({ attempt, release }: { readonly attempt: number; readonly release: () => void }): null {
  const { pending } = useFormStatus();
  useEffect(() => {
    if (!pending) release();
  }, [pending, attempt, release]);
  return null;
}
