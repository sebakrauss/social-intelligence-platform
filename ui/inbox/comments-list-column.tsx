"use client";
/**
 * COMMENTS-INT-03B-FIX (M-1) — the Comments list column. Opening a conversation is a new address, so the page is drawn
 * again (the framework mounts each conversation's page afresh) and the list with it; beside an open conversation the
 * list scrolls on its own (it stays on screen as the page scrolls).
 *
 * - Continuity: the list starts where THE SAME list (same workspace, same page of it) was left when the previous page
 *   was taken down — so a row that was on screen stays exactly where it was. The position is kept in this tab's memory
 *   only, for the one list last drawn: never stored, never sent, gone on reload.
 * - The selected row is then brought into view INSIDE THE LIST'S OWN SCROLL ONLY, and only when it is not already
 *   visible (a direct link, a reload, another page of the list) — never by scrolling the page, which the address places
 *   at the conversation's start.
 *
 * Nothing else: no reading, no React state, no listener, no timer.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Where the last list drawn in this tab was scrolled when its page was taken down (memory only). */
let lastPosition: { readonly list: string; readonly scrollTop: number } | undefined;

const scrolls = (column: HTMLElement): boolean => column.scrollHeight > column.clientHeight;

export function CommentsListColumn({ className, list, selected, children }: {
  readonly className: string | undefined;
  /** Which list this is (its workspace and page): a position is only ever given back to the same list. */
  readonly list: string;
  readonly selected: string | undefined;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const column = ref.current;
    if (column === null) return undefined;
    // One panel, or a list without a scroll of its own (nothing selected): the page itself is the list's scroll.
    if (scrolls(column)) {
      if (lastPosition?.list === list) column.scrollTop = lastPosition.scrollTop;
      const row = selected === undefined ? null : column.querySelector<HTMLElement>('[aria-current="page"]');
      if (row !== null) {
        const offset = row.getBoundingClientRect().y - column.getBoundingClientRect().y + column.scrollTop;
        const visible = offset >= column.scrollTop && offset + row.offsetHeight <= column.scrollTop + column.clientHeight;
        if (!visible) column.scrollTop = Math.max(0, offset - (column.clientHeight - row.offsetHeight) / 2);
      }
    }
    return () => {
      lastPosition = scrolls(column) ? { list, scrollTop: column.scrollTop } : undefined;
    };
  }, [list, selected]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
