/**
 * Inbox structure (UI-4; Step 7B-15B): the presentational pieces the Inbox pages compose — the wide work surface, a
 * conversation row (expanded in place when selected), a thread member, a coverage account block, the empty state. Structure and CSS only: every text arrives translated,
 * every value already shaped by the Step 7A view models, and nothing here decides, reads or acts. Native elements:
 * a row is one <a>, a time is <time>, lists are lists. Server components. Step 7B-17K: the row and the open
 * conversation's previous / next / close are in-app links (ui/navigation/app-link.tsx) — still one <a href> each.
 */
import type { ReactNode } from "react";
import { Icon } from "@/ui/icons/icon";
import { AppLink } from "@/ui/navigation/app-link";
import { LocalTime, LocalTimeStamp } from "@/ui/time/local-time";
import styles from "./inbox.module.css";

/**
 * Step 7B-15S — a time as the page shows it: `label` is the short form people read (Manual §7 mono-s, "08 NOV 23:14"),
 * `full` the exact one ("08 NOV 2026 · 23:14 UTC"), `iso` the machine-readable instant. With `full`, assistive
 * technology reads the exact time and a pointer shows it on hover; the short form is only what the eye scans.
 */
export interface ShownTime {
  readonly iso: string;
  readonly label: string;
  readonly full?: string;
  /**
   * Comments 2.1 (Step 7B-17R): the instant shown just above, in reading order, so the short reading can leave out a
   * date the reader has just seen. `label` and `full` are the server's UTC readings — what the page says without
   * JavaScript; in the browser both are read in the browser's own time zone (ui/time/local-time.tsx).
   */
  readonly previous?: string;
}

/** A <time> with its short label for the eye and its exact form for assistive technology (never two readings). */
export function TimeStamp({ time, className }: { readonly time: ShownTime; readonly className?: string | undefined }) {
  if (time.full === undefined) {
    return (
      <time className={className} dateTime={time.iso}>
        <LocalTime iso={time.iso} form="short" fallback={time.label} previous={time.previous} />
      </time>
    );
  }
  return <LocalTimeStamp className={className} iso={time.iso} label={time.label} full={time.full} previous={time.previous} />;
}

/** Step 7B-15S — a sentence that carries a time ("Requested 23:20"): short for the eye, exact for assistive technology. */
export function TimedText({ short, full }: { readonly short: ReactNode; readonly full: ReactNode }) {
  return (
    <span>
      <span aria-hidden="true">{short}</span>
      <span className="wk-sr-only">{full}</span>
    </span>
  );
}

/** Up to two initials of a display name ("caro.m" → "CM"), for the decorative avatar; never an identifier. */
const initialsOf = (name: string): string =>
  name
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

const join = (...classes: readonly (string | undefined | false)[]): string => classes.filter((value): value is string => typeof value === "string" && value !== "").join(" ");

/**
 * The Inbox work surface (Step 7B-15B): ONE wide column — the list — with the selected conversation expanded in place,
 * inside its own row. No permanent second pane. `selected` tells the one-screen layout (small widths) that a
 * conversation is open, so only it is on screen; the skip link jumps over the rows before it.
 */
export function InboxWorkspace({ children, selected, skipToConversation }: { readonly children: ReactNode; readonly selected: boolean; readonly skipToConversation?: { readonly href: string; readonly label: string } }) {
  return (
    <div className={styles["workspace"]} data-selected={selected ? "true" : "false"}>
      {skipToConversation === undefined ? null : (
        <a href={skipToConversation.href} className={styles["skipToDetail"]}>
          {skipToConversation.label}
        </a>
      )}
      {children}
    </div>
  );
}

/** A conversation opened by its address that is not among the rows on screen: drawn on its own, above the list. */
export function StandaloneConversation({ children }: { readonly children: ReactNode }) {
  return <div className={styles["standalone"]}>{children}</div>;
}

/**
 * The list header; `level` 2 when the page's h1 is the conversation beside it. `noScriptNote` (Comments 2.1, Step
 * 7B-17R): how times read when the page runs without JavaScript (UTC); with JavaScript every time is in the reader's own
 * zone and no note is needed.
 */
export function InboxHeader({ title, subtitle, noScriptNote, level = 1 }: { readonly title: string; readonly subtitle: string; readonly noScriptNote?: string; readonly level?: 1 | 2 }) {
  return (
    <header className={styles["header"]}>
      {level === 1 ? <h1 className={styles["title"]}>{title}</h1> : <h2 className={styles["title"]}>{title}</h2>}
      <p className={styles["subtitle"]}>
        {subtitle}
        {noScriptNote === undefined ? null : (
          <noscript>
            <span className={styles["subtitleNote"]}>{noScriptNote}</span>
          </noscript>
        )}
      </p>
    </header>
  );
}

export function ConversationList({ children }: { readonly children: ReactNode }) {
  return <ol className={styles["list"]}>{children}</ol>;
}

/**
 * One conversation: the whole row is the link. `excerptMuted` renders the excerpt slot in the secondary color.
 * `expanded` (Step 7B-15B) is the selected conversation itself, drawn in place under its row — never beside the list.
 */
export function ConversationRow({ id, href, current, origin, author, named = true, time, excerpt, excerptMuted = false, meta, expanded, nav }: {
  readonly id: string;
  readonly href: string;
  readonly current: boolean;
  readonly origin: ReactNode;
  readonly author: string;
  /** False when `author` is a description ("Author not known", "Your account"), not a name: the avatar carries no initials. */
  readonly named?: boolean;
  readonly time: ShownTime;
  readonly excerpt: string;
  readonly excerptMuted?: boolean;
  readonly meta?: ReactNode;
  readonly expanded?: ReactNode;
  /** Step 7B-15O: the way to the previous / next conversation and back to the list, drawn above the open conversation. */
  readonly nav?: ReactNode;
}) {
  const open = expanded !== undefined && expanded !== null;
  return (
    <li id={id} className={open ? styles["expandedItem"] : undefined}>
      <AppLink href={href} className={styles["row"]} pendingClassName={styles["rowPending"]} current={current} focusKey={id}>
        <div className={styles["rowHead"]}>
          <span className={styles["avatar"]} aria-hidden="true">
            {named ? initialsOf(author) : ""}
          </span>
          <span className={styles["rowAuthor"]}>{author}</span>
          {origin}
          <TimeStamp time={time} className={styles["time"]} />
        </div>
        {/* Step 7B-15O: an open conversation shows its text once — in the thread — so its row is only the compact header. */}
        {open ? null : <p className={join(styles["rowExcerpt"], excerptMuted ? styles["rowMuted"] : undefined)}>{excerpt}</p>}
        {open || meta === undefined || meta === null ? null : <div className={styles["rowMeta"]}>{meta}</div>}
      </AppLink>
      {open ? (
        <div className={styles["expanded"]}>
          {nav}
          {expanded}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Step 7B-15O — moving out of the open conversation without going back to the list: its position among the rows on
 * screen, the previous and the next one, and Close (the list at the same position). Links only. Step 7B-15S: an end of
 * the list keeps its place in the bar (the layout does not jump) but is not announced as a control — a plain word is
 * not "disabled", and the position ("1 of 5") already says where the person is.
 */
export function ConversationNav({ label, position, previous, next, close }: {
  readonly label: string;
  readonly position: string;
  readonly previous: { readonly label: string; readonly href: string | undefined };
  readonly next: { readonly label: string; readonly href: string | undefined };
  readonly close: { readonly label: string; readonly href: string } | undefined;
}) {
  const move = (target: { readonly label: string; readonly href: string | undefined }, direction: "previous" | "next") =>
    target.href === undefined ? (
      <span className={join(styles["navLink"], styles["navEnd"])} aria-hidden="true">
        {direction === "previous" ? <span className={styles["navArrow"]}>‹</span> : null}
        <span className={styles["navWord"]}>{target.label}</span>
        {direction === "next" ? <span className={styles["navArrow"]}>›</span> : null}
      </span>
    ) : (
      <AppLink href={target.href} className={styles["navLink"]} pendingClassName={styles["navPending"]}>
        {direction === "previous" ? (
          <span className={styles["navArrow"]} aria-hidden="true">
            ‹
          </span>
        ) : null}
        {/* On a phone the word is read, not shown: the arrow is the 44px target and the name stays the same. */}
        <span className={styles["navWord"]}>{target.label}</span>
        {direction === "next" ? (
          <span className={styles["navArrow"]} aria-hidden="true">
            ›
          </span>
        ) : null}
      </AppLink>
    );
  return (
    <nav className={styles["conversationNav"]} aria-label={label}>
      <span className={styles["navPosition"]}>{position}</span>
      {move(previous, "previous")}
      {move(next, "next")}
      {close === undefined ? null : (
        <AppLink href={close.href} className={join(styles["navLink"], styles["navClose"])} pendingClassName={styles["navPending"]}>
          <Icon name="util-close" size={16} />
          <span className={styles["navWord"]}>{close.label}</span>
        </AppLink>
      )}
    </nav>
  );
}

export function Pagination({ children }: { readonly children: ReactNode }) {
  return <p className={styles["pagination"]}>{children}</p>;
}

export function InboxEmpty({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className={styles["empty"]}>
      <p className={styles["emptyTitle"]}>{title}</p>
      <div className={styles["emptyText"]}>{children}</div>
    </div>
  );
}

/** A closed state's message (not an error): neutral text in the pane. */
export function PaneMessage({ children }: { readonly children: ReactNode }) {
  return (
    <p className={styles["message"]} role="status">
      {children}
    </p>
  );
}

export function CoverageBlock({ children }: { readonly children: ReactNode }) {
  return <div className={styles["coverage"]}>{children}</div>;
}

export function CoverageSummaryLabel({ title, meta, incomplete }: { readonly title: string; readonly meta?: ReactNode; readonly incomplete?: string }) {
  return (
    <span className={styles["coverageSummary"]}>
      <span>{title}</span>
      {meta === undefined ? null : <span className={styles["captionMono"]}>{meta}</span>}
      {incomplete === undefined ? null : <span className={styles["coverageIncomplete"]}>{incomplete}</span>}
    </span>
  );
}

export function CoverageAccounts({ children }: { readonly children: ReactNode }) {
  return <div className={styles["coverageAccounts"]}>{children}</div>;
}

export function CoverageAccount({ head, kinds }: { readonly head: ReactNode; readonly kinds: readonly { readonly key: string; readonly pill: ReactNode; readonly captions: readonly string[]; readonly until?: ReactNode }[] }) {
  return (
    <div className={styles["coverageAccount"]}>
      <div className={styles["coverageAccountHead"]}>{head}</div>
      <div className={styles["coverageKinds"]}>
        {kinds.map((kind) => (
          <div key={kind.key} className={styles["coverageKind"]}>
            <div>{kind.pill}</div>
            {kind.captions.map((caption) => (
              <p key={caption} className={styles["caption"]}>
                {caption}
              </p>
            ))}
            {kind.until === undefined ? null : <p className={styles["captionMono"]}>{kind.until}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function NoticeSlot({ children }: { readonly children: ReactNode }) {
  return <div className={styles["notice"]}>{children}</div>;
}

/* Detail */

/**
 * The open conversation. Step 7B-15O: what is known about where it happens (`context`) is a disclosure — beside the
 * thread on wide screens, a compact line that opens above it otherwise — and never a permanent column. `contextNote`
 * says what Wrenkind does not have about the post, instead of leaving a gap.
 */
export function ConversationDetail({ back, title, context, contextLabel, contextNote, children }: {
  readonly back?: ReactNode;
  readonly title: string;
  readonly context: ReactNode;
  readonly contextLabel?: string;
  readonly contextNote?: string;
  readonly children: ReactNode;
}) {
  const body = (
    <>
      <div className={styles["context"]}>{context}</div>
      {contextNote === undefined ? null : <p className={styles["contextNote"]}>{contextNote}</p>}
    </>
  );
  return (
    <div className={styles["detail"]} id="conversation">
      {back === undefined || back === null ? null : <div className={styles["backLink"]}>{back}</div>}
      <h1 className={styles["detailTitle"]}>{title}</h1>
      <div className={styles["detailGrid"]}>
        {contextLabel === undefined ? (
          <div className={styles["context"]}>{context}</div>
        ) : (
          <>
            {/* Narrow, or a conversation drawn on its own: a disclosure that really opens and closes. */}
            <details className={styles["contextBox"]}>
              <summary className={styles["contextSummary"]}>{contextLabel}</summary>
              <div className={styles["contextBody"]}>{body}</div>
            </details>
            {/* Step 7B-15S — wide, in its row: the same facts simply shown beside the thread, under a heading. No control
                that toggles nothing; only one of the two is ever displayed (the other is display:none, so it is not read twice). */}
            <aside className={styles["contextAside"]} aria-labelledby="conversation-context">
              <h2 id="conversation-context" className={styles["contextHeading"]}>
                {contextLabel}
              </h2>
              {body}
            </aside>
          </>
        )}
        <div className={styles["detailMain"]}>{children}</div>
      </div>
    </div>
  );
}

/** Step 7B-15S: a fact about the place whose words may be long (the source): its tag may wrap inside the narrow column. */
export function ContextFact({ children }: { readonly children: ReactNode }) {
  return <span className={styles["contextFact"]}>{children}</span>;
}

/** Step 7B-15O: one quiet line of status for the whole conversation (not a boxed notice repeated in every row). */
export function QuietNote({ children }: { readonly children: string }) {
  return <p className={styles["quietNote"]}>{children}</p>;
}

/**
 * The thread's name. Comments 2.1 (Step 7B-17R): the comments under the post already read as a thread, so the name is
 * for assistive technology only (it still labels the list); times read in the reader's own zone, so no note either.
 */
export function ThreadHeading({ id, label }: { readonly id: string; readonly label: string }) {
  return (
    <h2 id={id} className="wk-sr-only">
      {label}
    </h2>
  );
}

export function Thread({ children, labelledBy }: { readonly children: ReactNode; readonly labelledBy: string }) {
  return (
    <ol className={styles["thread"]} aria-labelledby={labelledBy}>
      {children}
    </ol>
  );
}

/**
 * Step 7B-15S — a small native disclosure under a comment (its exact times, its earlier versions): the summary names
 * what is inside; `context` (screen readers only) says whose it is, so a list of several is never a row of identical names.
 */
export function MemberDisclosure({ summary, context, children }: { readonly summary: string; readonly context?: string; readonly children: ReactNode }) {
  return (
    <details className={styles["memberDetails"]}>
      <summary className={styles["memberDetailsSummary"]}>
        {summary}
        {context === undefined ? null : <span className="wk-sr-only">{context}</span>}
      </summary>
      <div className={styles["memberDetailsBody"]}>{children}</div>
    </details>
  );
}

/**
 * One comment or reply. `nested` indents one level (a reply); `own` marks the brand's own message. `actions` (Step
 * 7B-3) is the contextual reply affordance under the message.
 *
 * Step 7B-15S — reading order: who and when (one line; when it wraps it stays beside the avatar), whom it answers when
 * the indent cannot say it, the text, the facts observed about the text, then the record (exact times, earlier
 * versions) one small disclosure away, and last what can be done.
 */
export function ThreadMember({ id, nested, own, author, named = true, replyingTo, detached = false, kind, time, edited, presence, text, textMuted = false, times, timesLabel, timesContext, versions, facts, actions }: {
  readonly id?: string;
  readonly nested: boolean;
  readonly own: boolean;
  readonly author: string;
  readonly named?: boolean;
  /** Step 7B-15Q: "Replying to …" — said in words when this entry answers someone other than the comment heading its block. */
  readonly replyingTo?: string;
  /** Step 7B-15Q: a reply whose parent is not on the page: set apart from the block above it (it belongs to none shown). */
  readonly detached?: boolean;
  readonly kind: string;
  readonly time?: ShownTime;
  /** Step 7B-15S: a short word ("Edited") in the head when the platform reports an edit; the exact time is in the record. */
  readonly edited?: string;
  readonly presence?: ReactNode;
  readonly text: string;
  readonly textMuted?: boolean;
  readonly times: readonly ReactNode[];
  /** Step 7B-15O: with a label, the exact times sit behind a small disclosure (kept, not in the way). */
  readonly timesLabel?: string;
  /** Step 7B-15S: whose times these are, for screen readers ("Comment by caro.m, …"). */
  readonly timesContext?: string;
  readonly versions?: ReactNode;
  readonly facts?: ReactNode;
  readonly actions?: ReactNode;
}) {
  const record =
    times.length === 0 ? null : timesLabel === undefined ? (
      <p className={styles["memberTimes"]}>
        {times.map((entry, index) => (
          <span key={index}>{entry}</span>
        ))}
      </p>
    ) : (
      <MemberDisclosure summary={timesLabel} {...(timesContext === undefined ? {} : { context: timesContext })}>
        <p className={styles["memberTimes"]}>
          {times.map((entry, index) => (
            <span key={index}>{entry}</span>
          ))}
        </p>
      </MemberDisclosure>
    );
  return (
    <li {...(id === undefined ? {} : { id })} className={join(styles["member"], nested ? styles["nested"] : undefined, own ? styles["own"] : undefined, detached ? styles["detached"] : undefined)}>
      <div className={styles["memberHead"]}>
        <span className={join(styles["avatar"], own ? styles["avatarOwn"] : undefined)} aria-hidden="true">
          {named ? initialsOf(author) : ""}
        </span>
        <span className={styles["memberMeta"]}>
          <span className={styles["memberAuthor"]}>{author}</span>
          <span className={styles["memberKind"]}>· {kind}</span>
          {time === undefined ? null : <TimeStamp time={time} className={styles["time"]} />}
          {edited === undefined ? null : <span className={styles["memberKind"]}>· {edited}</span>}
          {presence}
        </span>
      </div>
      {replyingTo === undefined ? null : <p className={styles["replyingTo"]}>{replyingTo}</p>}
      <p className={join(styles["memberText"], textMuted ? styles["memberTextMuted"] : undefined)}>{text}</p>
      {facts}
      {record === null && (versions === undefined || versions === null) ? null : (
        <div className={styles["memberRecord"]}>
          {record}
          {versions}
        </div>
      )}
      {actions}
    </li>
  );
}

/**
 * An outbound reply requested from Wrenkind (Step 7B-3), under the comment it answers: the text as written, its REAL
 * state as a pill (round = state), when it was requested and, once the platform confirmed it, when. Never optimistic.
 * Step 7B-15S: Wrenkind's own record, not something read from the platform — a quiet framed entry, its state at the
 * end of its head line so states can be scanned down the thread.
 */
export function OutboundReply({ author, kind, state, text, times, note, replyingTo }: {
  readonly author: string;
  readonly kind: string;
  readonly state: ReactNode;
  readonly text: string;
  readonly times: readonly ReactNode[];
  readonly note?: string;
  readonly replyingTo?: string;
}) {
  return (
    <div className={styles["outbound"]}>
      <div className={styles["memberHead"]}>
        <span className={join(styles["avatar"], styles["avatarOwn"])} aria-hidden="true" />
        <span className={styles["memberMeta"]}>
          <span className={styles["memberAuthor"]}>{author}</span>
          <span className={styles["memberKind"]}>· {kind}</span>
        </span>
        <span className={styles["outboundState"]}>{state}</span>
      </div>
      {replyingTo === undefined ? null : <p className={styles["replyingTo"]}>{replyingTo}</p>}
      <p className={styles["memberText"]}>{text}</p>
      {times.length === 0 ? null : <p className={styles["memberTimes"]}>{times}</p>}
      {note === undefined ? null : <p className={styles["outboundNote"]}>{note}</p>}
    </div>
  );
}

/**
 * Step 7B-15O: an outbound reply as its own entry of the thread, among the replies to the comment it answers and in
 * time order with them — so the conversation reads in the order things happened.
 */
export function ThreadOutbound({ children }: { readonly children: ReactNode }) {
  return <li className={join(styles["member"], styles["nested"], styles["outboundItem"])}>{children}</li>;
}

export function VersionList({ children, notice }: { readonly children: ReactNode; readonly notice?: ReactNode }) {
  return (
    <div className={styles["versions"]}>
      {notice}
      <ol className={styles["versionList"]}>{children}</ol>
    </div>
  );
}

export function Version({ time, text }: { readonly time: { readonly iso: string; readonly label: ReactNode }; readonly text: string }) {
  return (
    <li className={styles["version"]}>
      <time className={styles["time"]} dateTime={time.iso}>
        {time.label}
      </time>
      <p className={styles["memberText"]}>{text}</p>
    </li>
  );
}

/** Observed facts about the text (S19: facts, never meaning), labelled as such — on one line with their label. */
export function Facts({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={styles["facts"]}>
      <p className={styles["factsLabel"]}>{label}</p>
      <div className={styles["factList"]}>{children}</div>
    </div>
  );
}

/**
 * Step 7B-3: replies are not available in this conversation — the one reason, in outcome language, never a dead control.
 * Comments 2.1 (Step 7B-17R): without `label`, the reason is the whole sentence (the product-wide "not available yet").
 */
export function ReplyUnavailable({ label, reason }: { readonly label?: string; readonly reason: string }) {
  return (
    <p className={styles["replyUnavailable"]}>
      {label === undefined ? null : <span className={styles["replyUnavailableLabel"]}>{label}</span>}
      <span>{reason}</span>
    </p>
  );
}

/** Step 7B-15B: the way to move the ONE reply composer under another comment — a link (navigation), never a second composer. */
export function ReplySlot({ children }: { readonly children: ReactNode }) {
  return <div className={styles["replySlot"]}>{children}</div>;
}

/**
 * Step 7B-15B: what else can be done in the conversation, under the thread. The primary action (replying) lives under
 * the comment it answers; this block holds the secondary ones. An action Wrenkind cannot perform is listed with its one
 * reason — visible, never a dead control.
 */
export function ConversationActions({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section className={styles["actions"]} aria-label={label}>
      {children}
    </section>
  );
}

export function UnavailableActions({ children }: { readonly children: ReactNode }) {
  return <ul className={styles["unavailableActions"]}>{children}</ul>;
}

export function UnavailableAction({ name, reason }: { readonly name: string; readonly reason: string }) {
  return (
    <li className={styles["unavailableAction"]}>
      <span className={styles["unavailableActionName"]}>{name}</span>
      <span className={styles["unavailableActionReason"]}>{reason}</span>
    </li>
  );
}
