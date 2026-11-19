/**
 * COMMENTS-INT-03A — the redesigned Comments list (Direction C: list on the left, conversation on the right), piloted
 * beside the Inbox. Server components only: every value is a prop already authorized and built on the server, and the
 * selected conversation lives in the address, so nothing here keeps state, reads or writes.
 *
 * COMMENTS-INT-03A drew the two-panel frame and the real conversation list. COMMENTS-INT-03B draws the selected
 * conversation in the pane, READ ONLY: its context and its real thread (the Inbox's own records). No reply, no
 * management control, nothing simulated — those stay in the Inbox.
 */
import type { ReactNode } from "react";
import { AppLink } from "@/ui/navigation/app-link";
import { CommentsListColumn } from "./comments-list-column";
import { CommentsPaneSection } from "./comments-pane-section";
import { TimeStamp, type ShownTime } from "./inbox";
import styles from "./comments.module.css";

const join = (...classes: readonly (string | undefined | false)[]): string => classes.filter((value): value is string => typeof value === "string" && value !== "").join(" ");

/** The page frame. `selected`: a conversation is selected by the address (below 1024 px only its panel is shown). */
export function CommentsWorkspace({ selected, children }: { readonly selected: boolean; readonly children: ReactNode }) {
  return (
    <div className={styles["workspace"]} data-selected={selected ? "true" : "false"}>
      {children}
    </div>
  );
}

export function CommentsHeader({ title, subtitle, note }: { readonly title: string; readonly subtitle: string; readonly note?: ReactNode }) {
  return (
    <header className={styles["header"]}>
      <div className={styles["headerMain"]}>
        <h1 className={styles["title"]}>{title}</h1>
        <p className={styles["subtitle"]}>{subtitle}</p>
      </div>
      {note === undefined ? null : <p className={styles["pilotNote"]}>{note}</p>}
    </header>
  );
}

/** Whatever sits between the header and the two panels (what has been read). */
export function CommentsAbove({ children }: { readonly children: ReactNode }) {
  return <div className={styles["above"]}>{children}</div>;
}

/**
 * The two panels: the list column and the conversation area. `listKey` names the list (its workspace and page), so the
 * column keeps its scroll across conversations of the same list; `selected` keeps that conversation's row in view.
 */
export function CommentsSplit({ list, listKey, pane, selected }: { readonly list: ReactNode; readonly listKey: string; readonly pane: ReactNode; readonly selected?: string | undefined }) {
  return (
    <div className={styles["split"]}>
      <CommentsListColumn className={styles["listColumn"]} list={listKey} selected={selected}>
        {list}
      </CommentsListColumn>
      {pane}
    </div>
  );
}

export function CommentsList({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <ol className={styles["list"]} aria-label={label}>
      {children}
    </ol>
  );
}

export function CommentsRow({ id, href, current, origin, author, time, excerpt, excerptMuted = false, meta }: {
  readonly id: string;
  readonly href: string;
  readonly current: boolean;
  readonly origin: ReactNode;
  readonly author: string;
  readonly time: ShownTime;
  readonly excerpt: string;
  readonly excerptMuted?: boolean;
  readonly meta?: ReactNode;
}) {
  return (
    <li id={id} className={styles["item"]}>
      {/* The selected row stands for the conversation's anchor (where links to a conversation go, COMMENTS-INT-03B-FIX):
          it takes the focus back once the conversation opens; every other row stands for its own anchor (the way back). */}
      <AppLink href={href} className={styles["row"]} pendingClassName={styles["rowPending"]} current={current} focusKey={current ? "conversation" : id}>
        <span className={styles["rowTop"]}>
          {origin}
          <span className={styles["rowAuthor"]}>{author}</span>
          <TimeStamp time={time} className={styles["rowTime"]} />
        </span>
        <span className={join(styles["rowExcerpt"], excerptMuted ? styles["rowMuted"] : undefined)}>{excerpt}</span>
        {meta === undefined || meta === null ? null : <span className={styles["rowMeta"]}>{meta}</span>}
      </AppLink>
    </li>
  );
}

export function CommentsListEnd({ children }: { readonly children: ReactNode }) {
  return <div className={styles["listEnd"]}>{children}</div>;
}

export function CommentsListMessage({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className={styles["listMessage"]}>
      <h2 className={styles["listMessageTitle"]}>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

/**
 * The conversation area: a short message (nothing selected, or a conversation that can't be read), or — COMMENTS-INT-03B,
 * `content="conversation"` — the selected conversation itself, which flows with the page. `back` returns to the list
 * where only one panel fits.
 */
export function CommentsPane({ label, back, content = "message", children }: {
  readonly label: string;
  readonly content?: "message" | "conversation";
  /**
   * The way back to the list where only one panel fits. An in-app link standing for the conversation's anchor
   * (`focusKey`): where the row is not drawn (small screens) this link takes the keyboard focus after the conversation
   * opens, and going back hands the focus to the row again — it never falls to the top of the page.
   */
  readonly back?: { readonly href: string; readonly label: string; readonly focusKey?: string | undefined } | undefined;
  readonly children: ReactNode;
}) {
  return (
    <CommentsPaneSection className={styles["pane"]} label={label} content={content}>
      {/* COMMENTS-INT-03C-1: where Previous / Next lead (server/routes COMMENTS_PREVIOUS_ANCHOR / COMMENTS_NEXT_ANCHOR) — the
          very start of the conversation area, as its own anchor is; empty and silent. */}
      {content === "conversation" ? (
        <>
          <span id="conversation-previous" className={styles["paneAnchor"]} aria-hidden="true" />
          <span id="conversation-next" className={styles["paneAnchor"]} aria-hidden="true" />
        </>
      ) : null}
      {back === undefined ? null : (
        <div className={styles["paneBack"]}>
          <AppLink href={back.href} className={styles["backLink"]} focusKey={back.focusKey}>
            {back.label}
          </AppLink>
        </div>
      )}
      <div className={styles[content === "conversation" ? "paneConversation" : "paneMessage"]}>{children}</div>
    </CommentsPaneSection>
  );
}

/** One Previous / Next control: a link, or — at the end of the loaded page — the same mark, not a link. */
export interface CommentsMove {
  readonly label: string;
  readonly href: string | undefined;
}

/**
 * COMMENTS-INT-03C-1 — the approved header's navigation zone: where this conversation is among the ones LOADED in the
 * list ("n of N", or "n of N on this page" when the list has other pages), and Previous / Next among them only — never
 * a conversation that was not read. Arrows move (↑ previous, ↓ next: the approved icon convention); at an end the arrow
 * stays, inert. 44px targets where one panel fits.
 *
 * Focus (the prototype's behavior): each control leads to its own anchor (`anchors`) and stands for it, so after a move
 * the control used keeps the keyboard focus; at an end of the page, the remaining control stands for the missing one.
 */
export function CommentsConversationNav({ label, position, previous, next, anchors }: {
  readonly label: string;
  readonly position: string;
  readonly previous: CommentsMove;
  readonly next: CommentsMove;
  readonly anchors: { readonly previous: string; readonly next: string };
}) {
  const move = (target: CommentsMove, glyph: string, focusKey: string) =>
    target.href === undefined ? (
      <span className={join(styles["navMove"], styles["navEnd"])} aria-hidden="true">
        {glyph}
      </span>
    ) : (
      <AppLink href={target.href} className={styles["navMove"]} pendingClassName={styles["navPending"]} focusKey={focusKey}>
        <span aria-hidden="true">{glyph}</span>
        <span className="wk-sr-only">{target.label}</span>
      </AppLink>
    );
  return (
    <nav className={styles["conversationNav"]} aria-label={label}>
      <span className={styles["navPosition"]}>{position}</span>
      {move(previous, "↑", next.href === undefined ? anchors.next : anchors.previous)}
      {move(next, "↓", previous.href === undefined ? anchors.previous : anchors.next)}
    </nav>
  );
}

/**
 * COMMENTS-INT-03B / 03C-1 — the selected conversation, read only, under the approved Direction C header. Its three
 * zones, from the authorized conversation answer only:
 * - identity and context: the platform and who started it (the title), its real workflow state, then what the read
 *   model has about where it happens and the Inbox's sentence for what it does not have about the post;
 * - management: no control that cannot act — only the real way to act on it today (viewing it in the Inbox);
 * - navigation: among the conversations loaded in the list (absent when this one is not among them).
 * Every value is built and authorized on the server.
 */
export function CommentsConversation({ title, origin, state, context, contextNote, manage, nav, children }: {
  readonly title: string;
  readonly origin: ReactNode;
  readonly state: ReactNode;
  readonly context: ReactNode;
  readonly contextNote: string;
  readonly manage?: ReactNode;
  readonly nav?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <article className={styles["conversation"]} aria-labelledby="conversation-title">
      <header className={styles["conversationHead"]}>
        <div className={styles["headTop"]}>
          <div className={styles["headIdentity"]}>
            {/* Escape hands the focus here where the row is not drawn (one panel). */}
            <h2 id="conversation-title" className={styles["conversationTitle"]} tabIndex={-1}>
              {origin}
              <span className={styles["titleName"]}>{title}</span>
            </h2>
            {state}
          </div>
          {nav}
        </div>
        <div className={styles["headLower"]}>
          <div className={styles["headContext"]}>
            <div className={styles["conversationContext"]}>{context}</div>
            <p className={styles["conversationNote"]}>{contextNote}</p>
          </div>
          {manage === undefined ? null : <div className={styles["headManage"]}>{manage}</div>}
        </div>
      </header>
      <div className={styles["conversationBody"]}>{children}</div>
    </article>
  );
}
