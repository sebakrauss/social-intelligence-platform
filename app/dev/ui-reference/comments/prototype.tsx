/**
 * Comments prototype (Step 7B-15N) — DEVELOPMENT ONLY. Server components that draw the proposed Inbox › Comments
 * experience from the synthetic fixtures beside this file, in two visual directions:
 *
 * - "focus" (A, recommended): a calm reading list; the selected conversation opens in place with the post beside the
 *   thread only while it is open (never a permanent column), and one composer under the comment it answers.
 * - "triage" (B): a dense one-line scanning list; the open conversation spans the row and its post opens in a drawer.
 *
 * Everything is navigation (links carry the state in the address) and native disclosure: no client code is added. The
 * one interactive client piece is the existing, unchanged ReplyComposer, posting to the development-only simulated
 * action of the reply harness — nothing here reaches a pipeline, a database or a platform.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/ui/icons/icon";
import { DataTag, Notice, OriginMark, StatePill, type StateTone } from "@/ui/primitives";
import { ReplyComposer, type ReplyComposerLabels, type ReplyOutcomeMessages } from "@/ui/inbox/reply-composer";
import type { ReplyAction } from "@/server/inbox/reply-state";
import { ACCOUNTS, AS_OF, CONVERSATIONS, POSTS, type Account, type Conversation, type Message, type Outbound, type OutboundState, type Post } from "./fixtures";
import styles from "./prototype.module.css";

const BASE = "/dev/ui-reference/comments";

export type Direction = "focus" | "triage";
export type DataLevel = "now" | "planned" | "demo";
export type ListView = "open" | "done" | "all";
export type PlatformFilter = "all" | "instagram" | "facebook";

/** The whole prototype state, read from the address. */
export interface PrototypeQuery {
  readonly d: Direction;
  readonly data: DataLevel;
  readonly view: ListView;
  readonly p: PlatformFilter;
  readonly c: string | undefined;
  readonly reply: string | undefined;
  readonly monitor: boolean;
  readonly ctx: boolean;
}

const DEFAULTS: PrototypeQuery = { d: "focus", data: "planned", view: "open", p: "all", c: undefined, reply: undefined, monitor: false, ctx: false };

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);
const one = (value: string | string[] | undefined): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export function readQuery(raw: Readonly<Record<string, string | string[] | undefined>>): PrototypeQuery {
  const c = one(raw["c"]);
  return {
    d: pick(raw["d"], ["focus", "triage"], DEFAULTS.d),
    data: pick(raw["data"], ["now", "planned", "demo"], DEFAULTS.data),
    view: pick(raw["view"], ["open", "done", "all"], DEFAULTS.view),
    p: pick(raw["p"], ["all", "instagram", "facebook"], DEFAULTS.p),
    c: CONVERSATIONS.some((conversation) => conversation.id === c) ? c : undefined,
    reply: one(raw["reply"]),
    monitor: raw["monitor"] === "1",
    ctx: raw["ctx"] === "1",
  };
}

/** The address of a prototype state (only what differs from the defaults), with an optional fragment. */
export function hrefOf(query: PrototypeQuery, patch: Partial<PrototypeQuery> = {}, fragment?: string): string {
  const next: PrototypeQuery = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.d !== DEFAULTS.d) params.set("d", next.d);
  if (next.data !== DEFAULTS.data) params.set("data", next.data);
  if (next.view !== DEFAULTS.view) params.set("view", next.view);
  if (next.p !== DEFAULTS.p) params.set("p", next.p);
  if (next.c !== undefined) params.set("c", next.c);
  if (next.reply !== undefined) params.set("reply", next.reply);
  if (next.monitor) params.set("monitor", "1");
  if (next.ctx) params.set("ctx", "1");
  const search = params.toString();
  return `${BASE}${search === "" ? "" : `?${search}`}${fragment === undefined ? "" : `#${fragment}`}`;
}

/* ───────────────────────── data helpers ───────────────────────── */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const pad = (value: number): string => String(value).padStart(2, "0");
/** Compact time: the hour today (relative to the synthetic "as of"), the day otherwise. Always UTC (no workspace zone yet). */
function shortTime(iso: string): string {
  const date = new Date(iso);
  const asOf = new Date(AS_OF);
  const sameDay = date.getUTCFullYear() === asOf.getUTCFullYear() && date.getUTCMonth() === asOf.getUTCMonth() && date.getUTCDate() === asOf.getUTCDate();
  return sameDay ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}
function fullTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""} ${String(date.getUTCFullYear())} · ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
function TimeOf({ iso, className }: { readonly iso: string; readonly className?: string | undefined }) {
  return (
    <time dateTime={iso} title={fullTime(iso)} className={className ?? styles["time"]}>
      {shortTime(iso)}
    </time>
  );
}

const PLATFORM_NAME: Readonly<Record<Account["platform"], string>> = { instagram: "Instagram", facebook: "Facebook" };
const postOf = (conversation: Conversation): Post | undefined => POSTS.find((post) => post.id === conversation.postId);
const accountOf = (post: Post | undefined): Account | undefined => (post === undefined ? undefined : ACCOUNTS.find((account) => account.id === post.accountId));
const anchorOf = (conversation: Conversation): Message | undefined => conversation.messages.find((message) => message.parentId === null);
const authorName = (message: Message | undefined): string => (message === undefined ? "Unknown" : message.author.kind === "own" ? "Your account" : message.author.kind === "unknown" ? "Author not known yet" : (message.author.name ?? "Name not shown"));
const initials = (name: string): string =>
  name
    .replace(/^@/, "")
    .split(/[\s._]+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

/** Demo only: the order a future priority would give these conversations (IA §7.2), shown as reasons — never a score. */
const DEMO_ORDER = ["c6", "c1", "c7", "c3", "c5", "c2", "c4", "c8", "c9"];

function visible(query: PrototypeQuery): readonly Conversation[] {
  const filtered = CONVERSATIONS.filter((conversation) => (query.view === "all" ? true : conversation.status === query.view)).filter((conversation) => {
    if (query.p === "all") return true;
    return accountOf(postOf(conversation))?.platform === query.p;
  });
  return query.data === "demo" ? [...filtered].sort((a, b) => DEMO_ORDER.indexOf(a.id) - DEMO_ORDER.indexOf(b.id)) : filtered;
}

/** Instagram replies attach to the top-level comment; hidden, removed, unread and own messages offer no reply. */
const eligible = (message: Message, platform: Account["platform"] | undefined): boolean => message.parentId === null && message.author.kind === "audience" && message.presence === "present" && message.text !== null && platform !== undefined;
const IN_FLIGHT: ReadonlySet<OutboundState> = new Set(["sending", "checking"]);
const inFlight = (conversation: Conversation, messageId: string): boolean => conversation.outbound.some((item) => item.parentId === messageId && IN_FLIGHT.has(item.state));

/* ───────────────────────── page frame ───────────────────────── */

/** The development-only control strip: never product UI, always labeled as such. */
export function PrototypeBar({ query }: { readonly query: PrototypeQuery }) {
  const option = (label: string, patch: Partial<PrototypeQuery>, current: boolean) => (
    <Link href={hrefOf(query, patch)} prefetch={false} className={styles["barOption"]} {...(current ? { "aria-current": "true" } : {})}>
      {label}
    </Link>
  );
  return (
    <div className={styles["bar"]} role="region" aria-label="Prototype controls">
      <p className={styles["barTitle"]}>
        <span className={styles["barBadge"]}>Prototype</span> Synthetic data · nothing is read or sent
      </p>
      <div className={styles["barGroups"]}>
        <div className={styles["barGroup"]}>
          <span className={styles["barLabel"]}>Direction</span>
          {option("A · Focus", { d: "focus", ctx: false }, query.d === "focus")}
          {option("B · Triage", { d: "triage" }, query.d === "triage")}
        </div>
        <div className={styles["barGroup"]}>
          <span className={styles["barLabel"]}>Data</span>
          {option("Today", { data: "now" }, query.data === "now")}
          {option("+ Planned", { data: "planned" }, query.data === "planned")}
          {option("+ Demo AI", { data: "demo" }, query.data === "demo")}
        </div>
        <div className={styles["barGroup"]}>
          <span className={styles["barLabel"]}>Workspace</span>
          {option("Standard", { monitor: false }, !query.monitor)}
          {option("Monitor-only", { monitor: true, reply: undefined }, query.monitor)}
        </div>
      </div>
    </div>
  );
}

/** Which accounts this screen covers, always on screen (the workspace itself is in the shell). */
function AccountScope({ query }: { readonly query: PrototypeQuery }) {
  return (
    <div className={styles["scope"]}>
      <span className={styles["scopeLabel"]}>Accounts</span>
      <ul className={styles["scopeList"]}>
        {ACCOUNTS.map((account) => (
          <li key={account.id} className={styles["scopeItem"]}>
            <OriginMark platform={account.platform} name={PLATFORM_NAME[account.platform]} />
            <span>{query.data === "now" ? PLATFORM_NAME[account.platform] : account.label}</span>
          </li>
        ))}
      </ul>
      <span className={styles["scopeRead"]}>
        Read until <TimeOf iso={AS_OF} className={styles["mono"]} /> UTC
      </span>
    </div>
  );
}

function Toolbar({ query }: { readonly query: PrototypeQuery }) {
  const count = (view: ListView): number => CONVERSATIONS.filter((conversation) => view === "all" || conversation.status === view).length;
  const tab = (view: ListView, label: string) => (
    <Link href={hrefOf(query, { view, c: undefined, reply: undefined, ctx: false })} prefetch={false} className={styles["tab"]} {...(query.view === view ? { "aria-current": "page" } : {})}>
      {label}
      <span className={styles["tabCount"]}>{count(view)}</span>
    </Link>
  );
  const platform = (p: PlatformFilter, label: string) => (
    <Link href={hrefOf(query, { p, c: undefined, reply: undefined, ctx: false })} prefetch={false} className={styles["chip"]} {...(query.p === p ? { "aria-current": "true" } : {})}>
      {label}
    </Link>
  );
  return (
    <div className={styles["toolbar"]}>
      <nav className={styles["tabs"]} aria-label="Comment views">
        {tab("open", "Open")}
        {tab("done", "Done")}
        {tab("all", "All")}
      </nav>
      <div className={styles["chips"]} role="group" aria-label="Platform">
        {platform("all", "All platforms")}
        {platform("instagram", "Instagram")}
        {platform("facebook", "Facebook")}
      </div>
      <p className={styles["order"]}>
        <Icon name="util-sort" size={16} />
        {query.data === "demo" ? "Priority first (demo)" : "Newest activity first"}
      </p>
    </div>
  );
}

/* ───────────────────────── the list ───────────────────────── */

const ROW_STATE: Readonly<Record<OutboundState, { readonly label: string; readonly tone: StateTone; readonly icon?: Parameters<typeof Icon>[0]["name"] }>> = {
  sending: { label: "Reply sending", tone: "neutral", icon: "estado-sync" },
  sent: { label: "Replied", tone: "success", icon: "decision-approve" },
  checking: { label: "Reply being checked", tone: "warning" },
  failed: { label: "Reply not published", tone: "danger" },
  blocked: { label: "Reply stopped", tone: "warning" },
};

function rowState(conversation: Conversation): ReactNode {
  if (conversation.status === "done") return <StatePill>Done</StatePill>;
  const latest = [...conversation.outbound].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  if (latest === undefined) return conversation.messages.some((message) => message.author.kind === "own") ? <StatePill>Replied on platform</StatePill> : null;
  const state = ROW_STATE[latest.state];
  return (
    <StatePill tone={state.tone} {...(state.icon === undefined ? {} : { icon: state.icon })}>
      {state.label}
    </StatePill>
  );
}

function DemoMark() {
  return (
    <span className={styles["demoMark"]} title="Demonstration data: Wrenkind does not produce this yet">
      Demo
    </span>
  );
}

export function CommentsList({ query, expanded }: { readonly query: PrototypeQuery; readonly expanded: ReactNode }) {
  const items = visible(query);
  if (items.length === 0) {
    return (
      <div className={styles["empty"]}>
        <p className={styles["emptyTitle"]}>Nothing here</p>
        <p>No conversations match this view and platform. Coverage is complete for both accounts, so this is a real zero.</p>
      </div>
    );
  }
  return (
    <ol className={styles["list"]} aria-label="Conversations">
      {items.map((conversation) => (
        <Row key={conversation.id} conversation={conversation} query={query} expanded={conversation.id === query.c ? expanded : undefined} />
      ))}
    </ol>
  );
}

function Row({ conversation, query, expanded }: { readonly conversation: Conversation; readonly query: PrototypeQuery; readonly expanded: ReactNode }) {
  const planned = query.data !== "now";
  const demo = query.data === "demo" ? conversation.demo : undefined;
  const anchor = anchorOf(conversation);
  const post = postOf(conversation);
  const account = accountOf(post);
  const author = authorName(anchor);
  const open = expanded !== undefined;
  const replies = conversation.messages.filter((message) => message.parentId !== null).length + conversation.outbound.length;
  const read = anchor !== undefined && anchor.text !== null;
  const hidden = conversation.messages.some((message) => message.presence === "hidden");
  const removed = anchor?.presence === "removed";
  const href = open ? hrefOf(query, { c: undefined, reply: undefined, ctx: false }, `row-${conversation.id}`) : hrefOf(query, { c: conversation.id, reply: undefined, ctx: false }, "conversation");
  return (
    <li id={`row-${conversation.id}`} className={styles["item"]} data-open={open ? "true" : "false"}>
      <Link href={href} prefetch={false} className={styles["row"]} {...(open ? { "aria-current": "true", "aria-expanded": true } : { "aria-expanded": false })}>
        <span className={styles["avatar"]} aria-hidden="true">
          {anchor?.author.kind === "audience" ? initials(author) : "–"}
        </span>
        <span className={styles["who"]}>
          <span className={styles["author"]}>{author}</span>
          {account === undefined ? null : <OriginMark platform={account.platform} name={PLATFORM_NAME[account.platform]} paid={post?.source === "paid"} paidLabel="Paid" />}
        </span>
        <span className={styles["post"]}>{post === undefined ? null : planned && post.title !== null ? `on ${post.title}` : `on ${post.kind === "Ad" ? "an ad" : `a ${post.kind.toLowerCase()}`}`}</span>
        <span className={read ? styles["excerpt"] : `${styles["excerpt"] ?? ""} ${styles["muted"] ?? ""}`}>{read ? anchor.text : "Not read yet — Wrenkind knows this comment exists but hasn't read its text."}</span>
        <span className={styles["meta"]}>
          {demo === undefined ? null : (
            <span className={styles["why"]}>
              <DataTag {...(demo.needsReview === true ? { icon: "decision-review" as const } : {})}>{demo.label}</DataTag>
              <span className={styles["whyText"]}>{demo.reason}</span>
              <DemoMark />
            </span>
          )}
          {planned ? rowState(conversation) : conversation.status === "done" ? <StatePill>Done</StatePill> : null}
          {replies > 0 ? (
            <DataTag mono icon="conv-thread" srLabel={`${String(replies)} replies in this conversation`}>
              {String(replies)}
            </DataTag>
          ) : null}
          {hidden ? <DataTag icon="estado-lock">Hidden reply</DataTag> : null}
          {removed ? <DataTag>{`No longer on ${account === undefined ? "the platform" : PLATFORM_NAME[account.platform]}`}</DataTag> : null}
          {conversation.notYetRead === undefined ? null : <DataTag mono>{`${String(conversation.notYetRead)} not read yet`}</DataTag>}
        </span>
        <TimeOf iso={conversation.latestAt} />
      </Link>
      {open ? expanded : null}
    </li>
  );
}

/* ───────────────────────── the open conversation ───────────────────────── */

export interface ComposerWiring {
  readonly action: ReplyAction;
  readonly outcomes: ReplyOutcomeMessages;
  readonly formKey: () => string;
}

export function OpenConversation({ query, wiring }: { readonly query: PrototypeQuery; readonly wiring: ComposerWiring }) {
  const conversation = CONVERSATIONS.find((item) => item.id === query.c);
  if (conversation === undefined) return null;
  const items = visible(query);
  const index = items.findIndex((item) => item.id === conversation.id);
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;
  const post = postOf(conversation);
  const account = accountOf(post);
  const author = authorName(anchorOf(conversation));
  const planned = query.data !== "now";
  const demo = query.data === "demo" ? conversation.demo : undefined;

  // ONE composer per render (production invariant, Step 7B-15B/J): the address may name the comment; otherwise the
  // first eligible top-level comment whose reply is not on its way or being checked. The prototype never passes a start
  // stage (production's only authorized caller of `initialStage` stays the Inbox view): the composer opens on "Reply".
  const candidates = conversation.messages.filter((message) => eligible(message, account?.platform) && !inFlight(conversation, message.id));
  const target = query.monitor ? undefined : (candidates.find((message) => message.id === query.reply) ?? candidates[0]);

  const close = hrefOf(query, { c: undefined, reply: undefined, ctx: false }, `row-${conversation.id}`);
  const move = (to: Conversation | undefined, label: string) =>
    to === undefined ? (
      <span className={styles["moveDisabled"]} aria-disabled="true">
        {label}
      </span>
    ) : (
      <Link href={hrefOf(query, { c: to.id, reply: undefined, ctx: false }, "conversation")} prefetch={false} className={styles["move"]}>
        {label}
      </Link>
    );

  return (
    <section className={styles["open"]} id="conversation" aria-label={`Conversation with ${author}`} tabIndex={-1}>
      <div className={styles["openBar"]}>
        <Link href={close} prefetch={false} className={styles["backToList"]}>
          <span aria-hidden="true">←</span> Comments
        </Link>
        <span className={styles["position"]}>
          {index + 1} of {items.length}
        </span>
        <nav className={styles["moves"]} aria-label="Move between conversations">
          {move(previous, "Previous")}
          {move(next, "Next")}
        </nav>
        {query.d === "triage" ? (
          <Link href={hrefOf(query, { ctx: true }, "post-context")} prefetch={false} className={styles["contextButton"]}>
            <Icon name="conv-post" size={16} />
            Post
          </Link>
        ) : null}
        <Link href={close} prefetch={false} className={styles["close"]} aria-label="Close this conversation">
          <Icon name="util-close" size={16} />
          <span className={styles["closeText"]}>Close</span>
        </Link>
      </div>

      <div className={styles["openGrid"]}>
        <div className={styles["threadColumn"]}>
          {query.d === "focus" ? (
            <details className={styles["contextStrip"]}>
              <summary className={styles["contextStripSummary"]}>
                <Icon name="conv-post" size={16} />
                <span>{post === undefined || post.title === null || !planned ? "Post" : post.title}</span>
                {account === undefined ? null : <OriginMark platform={account.platform} name={PLATFORM_NAME[account.platform]} paid={post?.source === "paid"} paidLabel="Paid" />}
              </summary>
              <PostContext conversation={conversation} query={query} headingLevel={3} />
            </details>
          ) : (
            <p className={styles["contextLine"]}>
              {account === undefined ? null : <OriginMark platform={account.platform} name={PLATFORM_NAME[account.platform]} paid={post?.source === "paid"} paidLabel="Paid" />}
              <span>{post === undefined ? "Post not known yet" : planned && post.title !== null ? post.title : post.kind}</span>
              {planned && account !== undefined ? <span className={styles["subtle"]}>· {account.label}</span> : null}
            </p>
          )}

          {demo === undefined ? null : (
            <section className={styles["whyCard"]} aria-label="Why it's here">
              <p className={styles["whyHead"]}>
                <DataTag {...(demo.needsReview === true ? { icon: "decision-review" as const } : {})}>{demo.label}</DataTag>
                <span className={styles["whyTitle"]}>Why it&apos;s here</span>
                <DemoMark />
              </p>
              <ul className={styles["factors"]}>
                {demo.factors.map((factor) => (
                  <li key={factor}>{factor}</li>
                ))}
              </ul>
            </section>
          )}

          <ol className={styles["thread"]} aria-label="Comments and replies">
            {conversation.messages
              .filter((message) => message.parentId === null)
              .map((message) => (
                <TopLevel key={message.id} conversation={conversation} message={message} query={query} account={account} target={target} wiring={wiring} />
              ))}
          </ol>
        </div>

        {query.d === "focus" ? (
          <aside className={styles["side"]} aria-label="About this conversation">
            <PostContext conversation={conversation} query={query} headingLevel={3} />
            <MoreActions query={query} />
          </aside>
        ) : null}
      </div>
      {query.d === "triage" ? <MoreActions query={query} /> : null}
    </section>
  );
}

type Child = { readonly kind: "message"; readonly at: string; readonly message: Message } | { readonly kind: "outbound"; readonly at: string; readonly outbound: Outbound };

function TopLevel({ conversation, message, query, account, target, wiring }: {
  readonly conversation: Conversation;
  readonly message: Message;
  readonly query: PrototypeQuery;
  readonly account: Account | undefined;
  readonly target: Message | undefined;
  readonly wiring: ComposerWiring;
}) {
  // Chronology (diagnosis D6): the platform's replies and the replies requested from Wrenkind, in one time order.
  const children: Child[] = [
    ...conversation.messages.filter((child) => child.parentId === message.id).map((child): Child => ({ kind: "message", at: child.at ?? "9999", message: child })),
    ...conversation.outbound.filter((item) => item.parentId === message.id).map((item): Child => ({ kind: "outbound", at: item.requestedAt, outbound: item })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const demo = query.data === "demo" ? conversation.demo : undefined;
  return (
    <li className={styles["topLevel"]} id={`m-${message.id}`}>
      <MessageView message={message} account={account} />
      {children.length === 0 ? null : (
        <ol className={styles["replies"]} aria-label={`Replies to ${authorName(message)}`}>
          {children.map((child) => (child.kind === "message" ? <li key={child.message.id}><MessageView message={child.message} account={account} nested /></li> : <li key={child.outbound.id}><OutboundView outbound={child.outbound} account={account} query={query} /></li>))}
        </ol>
      )}
      <Affordance conversation={conversation} message={message} query={query} account={account} target={target} wiring={wiring} suggestion={demo?.suggestion} />
    </li>
  );
}

function MessageView({ message, account, nested = false }: { readonly message: Message; readonly account: Account | undefined; readonly nested?: boolean }) {
  const name = authorName(message);
  const own = message.author.kind === "own";
  const platform = account === undefined ? "the platform" : PLATFORM_NAME[account.platform];
  return (
    <article className={styles["message"]} data-own={own ? "true" : "false"} data-nested={nested ? "true" : "false"}>
      <span className={own ? `${styles["msgAvatar"] ?? ""} ${styles["msgAvatarOwn"] ?? ""}` : styles["msgAvatar"]} aria-hidden="true">
        {own ? "LC" : message.author.kind === "audience" ? initials(name) : "–"}
      </span>
      <div className={styles["msgBody"]}>
        <p className={styles["msgHead"]}>
          <span className={styles["msgAuthor"]}>{name}</span>
          {own ? <span className={styles["subtle"]}>· on {platform}</span> : null}
          {message.at === null ? null : <TimeOf iso={message.at} />}
          {message.editedAt === undefined ? null : (
            <span className={styles["subtle"]} title={`Edited on the platform ${fullTime(message.editedAt)}`}>
              · edited
            </span>
          )}
          {message.presence === "hidden" ? <StatePill icon="estado-lock">Hidden</StatePill> : null}
          {message.presence === "removed" ? <StatePill icon="estado-lock">{`No longer on ${platform}`}</StatePill> : null}
        </p>
        <p className={message.text === null || message.presence === "removed" ? `${styles["msgText"] ?? ""} ${styles["muted"] ?? ""}` : styles["msgText"]}>{message.text ?? "Not read yet — only its place in the conversation is known."}</p>
      </div>
    </article>
  );
}

const OUTBOUND_VIEW: Readonly<Record<OutboundState, { readonly pill: string; readonly tone: StateTone; readonly icon?: Parameters<typeof Icon>[0]["name"]; readonly line: (platform: string) => string }>> = {
  sending: { pill: "Sending", tone: "neutral", icon: "estado-sync", line: (platform) => `${platform} hasn't confirmed it yet.` },
  sent: { pill: "Published", tone: "success", icon: "decision-approve", line: () => "" },
  checking: { pill: "Checking", tone: "warning", line: (platform) => `We couldn't confirm it. It may already be public on ${platform} — look there before writing again.` },
  failed: { pill: "Not published", tone: "danger", line: (platform) => `${platform} didn't publish it.` },
  blocked: { pill: "Stopped", tone: "warning", line: () => "Stopped before publishing. Nothing was sent." },
};

function OutboundView({ outbound, account, query }: { readonly outbound: Outbound; readonly account: Account | undefined; readonly query: PrototypeQuery }) {
  const view = OUTBOUND_VIEW[outbound.state];
  const platform = account === undefined ? "The platform" : PLATFORM_NAME[account.platform];
  const line = view.line(platform);
  return (
    <article className={styles["message"]} data-own="true" data-nested="true" data-outbound={outbound.state}>
      <span className={`${styles["msgAvatar"] ?? ""} ${styles["msgAvatarOwn"] ?? ""}`} aria-hidden="true">
        LC
      </span>
      <div className={styles["msgBody"]}>
        <p className={styles["msgHead"]}>
          <span className={styles["msgAuthor"]}>{query.data === "now" || account === undefined ? "Your account" : account.label}</span>
          <span className={styles["subtle"]}>· from Wrenkind</span>
          <StatePill tone={view.tone} {...(view.icon === undefined ? {} : { icon: view.icon })}>
            {view.pill}
          </StatePill>
        </p>
        <p className={styles["msgText"]}>{outbound.text}</p>
        <p className={styles["msgStatus"]} data-state={outbound.state}>
          {outbound.confirmedAt === null ? (
            <>
              Requested <TimeOf iso={outbound.requestedAt} className={styles["mono"]} />
            </>
          ) : (
            <>
              Published <TimeOf iso={outbound.confirmedAt} className={styles["mono"]} />
            </>
          )}
          {line === "" ? null : <span> · {line}</span>}
        </p>
      </div>
    </article>
  );
}

function composerLabels(author: string, account: Account | undefined, query: PrototypeQuery): ReplyComposerLabels {
  const platform = account === undefined ? "the platform" : PLATFORM_NAME[account.platform];
  return {
    open: "Reply",
    heading: "Public reply",
    to: `To ${author}`,
    as: query.data === "now" || account === undefined ? `As your ${platform} account · visible to everyone` : `As ${account.label} on ${platform} · visible to everyone`,
    ...(account?.platform === "instagram" ? { note: "On Instagram, your reply sits under this top-level comment." } : {}),
    fieldLabel: "Your reply",
    fieldHelp: "Published exactly as written.",
    remaining: "{count} characters left",
    overLimit: "{count} characters over the limit",
    empty: "Write a reply first.",
    cancel: "Cancel",
    review: "Review",
    edit: "Edit",
    reviewHeading: "Check it before it goes public",
    reviewTextLabel: "This text will be published",
    reviewNote: "Wrenkind can't edit or remove a reply once it's published.",
    publish: "Publish reply",
    publishing: "Publishing…",
    restored: "Your unsent reply is back.",
  };
}

function Affordance({ conversation, message, query, account, target, wiring, suggestion }: {
  readonly conversation: Conversation;
  readonly message: Message;
  readonly query: PrototypeQuery;
  readonly account: Account | undefined;
  readonly target: Message | undefined;
  readonly wiring: ComposerWiring;
  readonly suggestion: { readonly text: string; readonly basedOn: string; readonly missing?: string } | undefined;
}) {
  if (!eligible(message, account?.platform)) return null;
  if (query.monitor) {
    return (
      <p className={styles["quietNote"]}>
        <Icon name="estado-lock" size={16} />
        This workspace is Monitor-only. Replies are made outside Wrenkind.
      </p>
    );
  }
  if (inFlight(conversation, message.id)) {
    return (
      <p className={styles["quietNote"]}>
        <Icon name="estado-sync" size={16} />
        A reply to this comment is on its way. You can write another once it&apos;s published or has failed.
      </p>
    );
  }
  const author = authorName(message);
  if (target?.id !== message.id) {
    return (
      <div className={styles["affordance"]}>
        <Link href={hrefOf(query, { reply: message.id }, `m-${message.id}`)} prefetch={false} className={styles["replyButton"]}>
          <Icon name="conv-reply" size={16} />
          Reply
        </Link>
      </div>
    );
  }
  return (
    <div className={styles["affordance"]}>
      {suggestion === undefined ? null : (
        <aside className={styles["suggestion"]} aria-label="Suggested starting point">
          <p className={styles["suggestionHead"]}>
            <Icon name="decision-draft" size={16} />
            Suggested starting point <DemoMark />
          </p>
          <p className={styles["suggestionText"]}>{suggestion.text}</p>
          <p className={styles["suggestionMeta"]}>
            Based on: {suggestion.basedOn}
            {suggestion.missing === undefined ? null : <span className={styles["suggestionMissing"]}> · Missing: {suggestion.missing}</span>}
          </p>
          <p className={styles["suggestionMeta"]}>A suggestion is never sent: you write or paste the reply and publish it yourself.</p>
        </aside>
      )}
      <div className={styles["composerSlot"]}>
        <ReplyComposer
          action={wiring.action}
          fields={{ workspaceId: "dev-comments-prototype", conversationId: conversation.id, targetInteractionId: message.id, idempotencyKey: wiring.formKey() }}
          maxChars={2200}
          labels={composerLabels(author, account, query)}
          outcomes={wiring.outcomes}
          draftScope="dev-comments-prototype"
        />
      </div>
    </div>
  );
}

/* ───────────────────────── context and secondary actions ───────────────────────── */

function PostContext({ conversation, query, headingLevel }: { readonly conversation: Conversation; readonly query: PrototypeQuery; readonly headingLevel: 2 | 3 }) {
  const post = postOf(conversation);
  const account = accountOf(post);
  const planned = query.data !== "now";
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const sourceText = post === undefined ? "" : post.source === "paid" ? "Paid" : post.source === "organic" ? "Organic" : post.source === "mixed" ? "Organic and paid" : "Organic or paid: not known";
  return (
    <section className={styles["postCard"]} aria-label="Post">
      <Heading className={styles["sideHeading"]}>Post</Heading>
      {post === undefined || account === undefined ? (
        <p className={styles["muted"]}>Wrenkind doesn&apos;t know which post this comment is on yet.</p>
      ) : (
        <>
          <p className={styles["postMeta"]}>
            <OriginMark platform={account.platform} name={PLATFORM_NAME[account.platform]} showName paid={post.source === "paid"} paidLabel="Paid" />
            <DataTag>{post.kind}</DataTag>
            <DataTag>{sourceText}</DataTag>
          </p>
          {planned ? <p className={styles["postAccount"]}>{account.label}</p> : null}
          {planned && post.caption !== null ? (
            <>
              <p className={styles["postCaption"]}>{post.caption}</p>
              {post.publishedAt === null ? null : (
                <p className={styles["subtle"]}>
                  Published <TimeOf iso={post.publishedAt} className={styles["mono"]} />
                </p>
              )}
              <p className={styles["postLink"]}>
                <Icon name="util-external" size={16} />
                Open on {PLATFORM_NAME[account.platform]} <span className={styles["subtle"]}>(not linked in the prototype)</span>
              </p>
            </>
          ) : (
            <p className={styles["muted"]}>{post.title === null ? "The post itself hasn't been read yet." : "The post's text and link aren't available in Wrenkind yet."}</p>
          )}
        </>
      )}
    </section>
  );
}

function MoreActions({ query }: { readonly query: PrototypeQuery }) {
  const reason = query.monitor ? "This workspace is Monitor-only" : "Not available yet";
  return (
    <details className={styles["more"]}>
      <summary className={styles["moreSummary"]}>
        <Icon name="util-more" size={16} />
        More actions
      </summary>
      <ul className={styles["moreList"]}>
        {["Reply privately", "Hide comment", "Mark done", "Assign"].map((name) => (
          <li key={name} className={styles["moreItem"]}>
            <span>{name}</span>
            <span className={styles["subtle"]}>{reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Direction B: the post opens in a drawer over the page (closing returns to the same conversation). */
export function ContextDrawer({ query }: { readonly query: PrototypeQuery }) {
  const conversation = CONVERSATIONS.find((item) => item.id === query.c);
  if (conversation === undefined || !query.ctx) return null;
  const close = hrefOf(query, { ctx: false }, "conversation");
  return (
    <>
      <Link href={close} prefetch={false} className={styles["scrim"]} aria-hidden="true" tabIndex={-1} />
      <aside className={styles["drawer"]} id="post-context" aria-label="Post context" tabIndex={-1}>
        <div className={styles["drawerHead"]}>
          <p className={styles["drawerTitle"]}>Post context</p>
          <Link href={close} prefetch={false} className={styles["close"]} aria-label="Close post context">
            <Icon name="util-close" size={16} />
            <span className={styles["closeText"]}>Close</span>
          </Link>
        </div>
        <PostContext conversation={conversation} query={query} headingLevel={2} />
        <p className={styles["subtle"]}>Other comments on this post: {CONVERSATIONS.filter((item) => item.postId === conversation.postId).length} conversations</p>
      </aside>
    </>
  );
}

export function ListIntro({ query }: { readonly query: PrototypeQuery }) {
  return (
    <>
      <AccountScope query={query} />
      {query.monitor ? (
        <Notice tone="warning" live="off" title="Monitor-only">
          You can read and review here. Replying and moderating happen outside Wrenkind.
        </Notice>
      ) : null}
      {query.data === "demo" ? (
        <p className={styles["demoBanner"]}>
          <DemoMark /> Labels, reasons, priority order and suggestions on this screen are demonstration data. Wrenkind doesn&apos;t produce them yet.
        </p>
      ) : (
        <p className={styles["quietLine"]}>Comments haven&apos;t been assessed for priority or safety yet, so the newest activity comes first.</p>
      )}
      <Toolbar query={query} />
    </>
  );
}
