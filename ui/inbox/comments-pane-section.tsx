"use client";
/**
 * COMMENTS-INT-03C-1 — the Comments conversation area, with the approved prototype's one keyboard behavior in it:
 * Escape (outside a text field, and not already handled) hands the focus back to the selected conversation's row in
 * the list; where that row is not drawn (one panel), to the conversation's title. It never navigates, never changes the
 * selection and never scrolls the page to the row (the row is kept in view inside the list's own scroll).
 *
 * Nothing else: no reading, no state, no listener of its own, no timer.
 */
import type { KeyboardEvent, ReactNode } from "react";

const TYPING = "input, textarea, select, [contenteditable]";

export function CommentsPaneSection({ className, label, content, children }: {
  readonly className: string | undefined;
  readonly label: string;
  readonly content: "message" | "conversation";
  readonly children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented || content !== "conversation") return;
    // Keys typed into a field stay the field's (the prototype's rule).
    if ((event.target as HTMLElement).closest(TYPING) !== null) return;
    const section = event.currentTarget;
    const row = section.parentElement?.querySelector<HTMLElement>('[id^="row-"] [aria-current="page"]') ?? null;
    row?.focus({ preventScroll: true });
    if (row === null || section.ownerDocument.activeElement !== row) section.querySelector<HTMLElement>("#conversation-title")?.focus();
    event.preventDefault();
  };
  // `conversation` is the anchor a link to a conversation goes to (server/routes COMMENTS_CONVERSATION_ANCHOR).
  return (
    <section id="conversation" className={className} aria-label={label} data-content={content} onKeyDown={onKeyDown}>
      {children}
    </section>
  );
}
