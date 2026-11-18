/**
 * COMMENTS-INT-03A — the redesigned Comments list (Direction C: list on the left, conversation on the right), piloted
 * beside the Inbox. Server components only: every value is a prop already authorized and built on the server, and the
 * selected conversation lives in the address, so nothing here keeps state, reads or writes.
 *
 * This step draws the two-panel frame and the real conversation list. The conversation area is a plain placeholder:
 * no thread, no reply, no management control, nothing simulated.
 */
import type { ReactNode } from "react";
import { AppLink } from "@/ui/navigation/app-link";
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

/** The two panels: the list column and the conversation area. */
export function CommentsSplit({ list, pane }: { readonly list: ReactNode; readonly pane: ReactNode }) {
  return (
    <div className={styles["split"]}>
      <div className={styles["listColumn"]}>{list}</div>
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
      <AppLink href={href} className={styles["row"]} pendingClassName={styles["rowPending"]} current={current} focusKey={id}>
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
 * The conversation area. In this step it only says what it is: nothing is selected, or the selected conversation is
 * not drawn here yet (with the way to read it in the Inbox). `back` returns to the list where only one panel fits.
 */
export function CommentsPane({ label, back, children }: {
  readonly label: string;
  /**
   * The way back to the list where only one panel fits. An in-app link standing for the same anchor as the selected
   * row (`focusKey`): when the row is not drawn (small screens) this link takes the keyboard focus after the
   * conversation opens, and going back hands the focus to the row again — it never falls to the top of the page.
   */
  readonly back?: { readonly href: string; readonly label: string; readonly focusKey?: string | undefined } | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section id="conversation" className={styles["pane"]} aria-label={label}>
      {back === undefined ? null : (
        <div className={styles["paneBack"]}>
          <AppLink href={back.href} className={styles["backLink"]} focusKey={back.focusKey}>
            {back.label}
          </AppLink>
        </div>
      )}
      <div className={styles["paneMessage"]}>{children}</div>
    </section>
  );
}
