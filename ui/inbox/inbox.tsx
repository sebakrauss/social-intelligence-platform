/**
 * Inbox structure (UI-4): the presentational pieces the Inbox pages compose — the two panes, a conversation row, a
 * thread member, a coverage account block, the empty state. Structure and CSS only: every text arrives translated,
 * every value already shaped by the Step 7A view models, and nothing here decides, reads or acts. Native elements:
 * a row is one <a>, a time is <time>, lists are lists. Server components.
 */
import type { ReactNode } from "react";
import styles from "./inbox.module.css";

const join = (...classes: readonly (string | undefined | false)[]): string => classes.filter((value): value is string => typeof value === "string" && value !== "").join(" ");

/** The two panes. `selected` tells the one-screen layout which pane is on screen; the skip link is for two panes. */
export function InboxPanes({ list, detail, selected, skipToDetail }: { readonly list: ReactNode; readonly detail: ReactNode; readonly selected: boolean; readonly skipToDetail?: { readonly href: string; readonly label: string } }) {
  return (
    <div className={styles["panes"]} data-selected={selected ? "true" : "false"}>
      {skipToDetail === undefined ? null : (
        <a href={skipToDetail.href} className={styles["skipToDetail"]}>
          {skipToDetail.label}
        </a>
      )}
      <div className={styles["listPane"]}>{list}</div>
      <div className={styles["detailPane"]}>{detail}</div>
    </div>
  );
}

export function DetailPlaceholder({ children }: { readonly children: ReactNode }) {
  return <p className={styles["placeholder"]}>{children}</p>;
}

/** The list header; `level` 2 when the page's h1 is the conversation beside it. */
export function InboxHeader({ title, subtitle, level = 1 }: { readonly title: string; readonly subtitle: string; readonly level?: 1 | 2 }) {
  return (
    <header className={styles["header"]}>
      {level === 1 ? <h1 className={styles["title"]}>{title}</h1> : <h2 className={styles["title"]}>{title}</h2>}
      <p className={styles["subtitle"]}>{subtitle}</p>
    </header>
  );
}

export function ConversationList({ children }: { readonly children: ReactNode }) {
  return <ol className={styles["list"]}>{children}</ol>;
}

/** One conversation: the whole row is the link. `excerptMuted` renders the excerpt slot in the secondary color. */
export function ConversationRow({ id, href, current, origin, author, time, excerpt, excerptMuted = false, meta }: {
  readonly id: string;
  readonly href: string;
  readonly current: boolean;
  readonly origin: ReactNode;
  readonly author: string;
  readonly time: { readonly iso: string; readonly label: string };
  readonly excerpt: string;
  readonly excerptMuted?: boolean;
  readonly meta?: ReactNode;
}) {
  return (
    <li id={id}>
      <a href={href} className={styles["row"]} {...(current ? { "aria-current": "page" } : {})}>
        <div className={styles["rowHead"]}>
          {origin}
          <span className={styles["rowAuthor"]}>{author}</span>
          <time className={styles["time"]} dateTime={time.iso}>
            {time.label}
          </time>
        </div>
        <p className={join(styles["rowExcerpt"], excerptMuted ? styles["rowMuted"] : undefined)}>{excerpt}</p>
        {meta === undefined || meta === null ? null : <div className={styles["rowMeta"]}>{meta}</div>}
      </a>
    </li>
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

export function CoverageSummaryLabel({ title, meta, incomplete }: { readonly title: string; readonly meta?: string; readonly incomplete?: string }) {
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

export function CoverageAccount({ head, kinds }: { readonly head: ReactNode; readonly kinds: readonly { readonly key: string; readonly pill: ReactNode; readonly captions: readonly string[]; readonly until?: string }[] }) {
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

export function ConversationDetail({ back, title, context, children }: { readonly back?: ReactNode; readonly title: string; readonly context: ReactNode; readonly children: ReactNode }) {
  return (
    <div className={styles["detail"]} id="conversation">
      {back === undefined || back === null ? null : <div className={styles["backLink"]}>{back}</div>}
      <h1 className={styles["detailTitle"]}>{title}</h1>
      <div className={styles["context"]}>{context}</div>
      {children}
    </div>
  );
}

export function SectionLabel({ children, id }: { readonly children: string; readonly id?: string }) {
  return (
    <h2 className={styles["sectionLabel"]} {...(id === undefined ? {} : { id })}>
      {children}
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

/** One comment or reply. `nested` indents one level (a reply); `own` marks the brand's own message. */
export function ThreadMember({ nested, own, author, kind, time, presence, text, textMuted = false, times, versions, facts }: {
  readonly nested: boolean;
  readonly own: boolean;
  readonly author: string;
  readonly kind: string;
  readonly time?: { readonly iso: string; readonly label: string };
  readonly presence?: ReactNode;
  readonly text: string;
  readonly textMuted?: boolean;
  readonly times: readonly string[];
  readonly versions?: ReactNode;
  readonly facts?: ReactNode;
}) {
  return (
    <li className={join(styles["member"], nested ? styles["nested"] : undefined, own ? styles["own"] : undefined)}>
      <div className={styles["memberHead"]}>
        <span className={styles["memberAuthor"]}>{author}</span>
        <span className={styles["memberKind"]}>· {kind}</span>
        {time === undefined ? null : (
          <time className={styles["time"]} dateTime={time.iso}>
            {time.label}
          </time>
        )}
        {presence}
      </div>
      <p className={join(styles["memberText"], textMuted ? styles["memberTextMuted"] : undefined)}>{text}</p>
      {times.length === 0 ? null : (
        <p className={styles["memberTimes"]}>
          {times.map((entry) => (
            <span key={entry}>{entry}</span>
          ))}
        </p>
      )}
      {versions}
      {facts}
    </li>
  );
}

export function VersionList({ children, notice }: { readonly children: ReactNode; readonly notice?: ReactNode }) {
  return (
    <div className={styles["versions"]}>
      {notice}
      <ol className={styles["versionList"]}>{children}</ol>
    </div>
  );
}

export function Version({ time, text }: { readonly time: { readonly iso: string; readonly label: string }; readonly text: string }) {
  return (
    <li className={styles["version"]}>
      <time className={styles["time"]} dateTime={time.iso}>
        {time.label}
      </time>
      <p className={styles["memberText"]}>{text}</p>
    </li>
  );
}

export function Facts({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={styles["facts"]}>
      <p className={styles["caption"]}>{label}</p>
      <div className={styles["factList"]}>{children}</div>
    </div>
  );
}
