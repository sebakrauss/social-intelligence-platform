"use client";
/**
 * A form's submit button that is disabled, and says so, while its Server Action is in flight — so an obvious double
 * click doesn't post the same form twice. UX only: the server operation is idempotent and serialized regardless.
 * Labels arrive already translated from the server page.
 */
import { useFormStatus } from "react-dom";

export function PendingSubmitButton({ label, pendingLabel }: { readonly label: string; readonly pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}
