"use client";
/**
 * In-app navigation for the authenticated surfaces (Step 7B-17K): the Inbox rows, the open conversation's previous /
 * next / close, and the shell's destinations. Still one native <a href> (keyboard, middle-click, "open in new tab",
 * copy link and no-script all behave as before); a plain click moves through the framework's router instead of
 * reloading the whole document, and the page on screen stays until the next one is ready.
 *
 * - Feedback: while the move it started is under way, `pendingClassName` marks a small signal inside the link
 *   (data-pending="true"); the consumer's stylesheet draws it. Nothing is announced and nothing is guessed.
 * - Never prefetched: a prefetch of these per-person, per-request pages would run their reads for links nobody chose.
 * - Unsent reply drafts (UX-20): while this tab keeps one, every AppLink is a plain link again, so leaving is a full
 *   navigation guarded by the browser's own leave confirmation — exactly as before this step. Which conversation may
 *   keep a draft is decided by ui/inbox/reply-drafts-scope.tsx, not here.
 * - Focus: after an in-app move, the link whose `focusKey` is the destination's anchor (the part after #) takes the
 *   focus, so it never falls back to the top of the page when the link that was used disappears.
 *
 * It decides nothing: every href was authorized and built on the server, and the server authorizes the next page again.
 */
import Link, { useLinkStatus } from "next/link";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { hasReplyDrafts, subscribeReplyDrafts } from "@/ui/inbox/reply-drafts";

/** The anchor the last in-app move went to (set when it starts; taken by the link that carries it as `focusKey`). */
let focusAfterMove: string | undefined;

const anchorOf = (href: string): string | undefined => {
  const at = href.indexOf("#");
  return at < 0 || at === href.length - 1 ? undefined : href.slice(at + 1);
};

const noDrafts = (): boolean => false;

/** The small "on its way" signal inside a link; drawn by the consumer's stylesheet from data-pending. */
function PendingSignal({ className }: { readonly className: string }) {
  const { pending } = useLinkStatus();
  return <span className={className} data-pending={pending ? "true" : "false"} aria-hidden="true" />;
}

export interface AppLinkProps {
  readonly href: string;
  readonly className?: string | undefined;
  /** The class of the pending signal; without it the link shows none. */
  readonly pendingClassName?: string | undefined;
  readonly current?: boolean;
  /** The id this link stands for (a row's anchor): after an in-app move to `#focusKey`, this link takes the focus. */
  readonly focusKey?: string | undefined;
  readonly children: ReactNode;
}

export function AppLink({ href, className, pendingClassName, current = false, focusKey, children }: AppLinkProps) {
  const draftsKept = useSyncExternalStore(subscribeReplyDrafts, hasReplyDrafts, noDrafts);
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (focusKey === undefined || focusAfterMove !== focusKey) return;
    const link = ref.current;
    if (link === null) return;
    link.focus({ preventScroll: true });
    // Taken only by a link that really received the focus: one that is not drawn at this width (a list row behind the
    // open conversation on a small screen) leaves it to the next link standing for the same anchor (COMMENTS-INT-03A-FIX).
    if (link.ownerDocument.activeElement === link) focusAfterMove = undefined;
  }, [focusKey, current]);
  const ariaCurrent = current ? { "aria-current": "page" as const } : {};

  if (draftsKept) {
    return (
      <a ref={ref} href={href} className={className} {...ariaCurrent}>
        {children}
      </a>
    );
  }
  return (
    <Link
      ref={ref}
      href={href}
      prefetch={false}
      className={className}
      onNavigate={() => {
        focusAfterMove = anchorOf(href);
      }}
      {...ariaCurrent}
    >
      {pendingClassName === undefined ? null : <PendingSignal className={pendingClassName} />}
      {children}
    </Link>
  );
}
