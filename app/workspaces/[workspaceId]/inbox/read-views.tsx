/**
 * The Inbox's read-only presentation pieces (extracted in COMMENTS-INT-03A-FIX, audit M-1): time readings, the closed
 * states and the "what has been read" block. NOTHING here imports the reply composer, its Server Action, the drafts
 * module or any command — so a page that only reads (the redesigned Comments route) can draw them without the
 * composer's action being registered for it. app/…/inbox/views.tsx imports these and re-exports them unchanged; the
 * rendering is byte-for-byte what it was. COMMENTS-INT-03B moved the thread's read-only drawing here the same way (its
 * order, its times, a member's record, an outbound reply's state): the Inbox adds only its composer to it.
 */
import { cache } from "react";
import type { MessageKey } from "@/domain/i18n/message-keys";
import { t } from "@/server/i18n";
import {
  AUTHOR_MESSAGES,
  CONTENT_KIND_FALLBACK,
  CONTENT_KIND_MESSAGES,
  COVERAGE_REASON_FALLBACK,
  COVERAGE_REASON_MESSAGES,
  COVERAGE_STATE_MESSAGES,
  displayTime,
  FACT_FALLBACK,
  FACT_MESSAGES,
  OUTBOUND_STATE_MESSAGES,
  PRESENCE_MESSAGES,
  platformName,
  when,
  type AccountCoverageView,
  type ConversationDetail as ConversationDetailModel,
  type ConversationViewState,
  type CoverageKindView,
  type InboxPage,
  type OutboundReplyItem,
  type ThreadItem,
} from "@/server/inbox/inbox";
import { threadMemberId } from "@/server/routes";
import type { IconName } from "@/ui/icons/icon";
import { CoverageAccount, CoverageAccounts, CoverageBlock, CoverageSummaryLabel, Facts, MemberDisclosure, NoticeSlot, OutboundReply, PaneMessage, ThreadMember, TimedText, Version, VersionList, type ShownTime } from "@/ui/inbox/inbox";
import { DataTag } from "@/ui/primitives/data-tag";
import { Disclosure } from "@/ui/primitives/disclosure";
import { Notice } from "@/ui/primitives/notice";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { StatePill, type StateTone } from "@/ui/primitives/state-pill";
import { LocalTime, type LocalTimeForm } from "@/ui/time/local-time";

const sameUtcDay = (a: Date, b: Date): boolean => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();

/**
 * Step 7B-15U — ONE render-time reference for "this year" (UTC), shared by everything drawn for the same request: the
 * list, the open conversation and every entry in it compare against the same instant, never each against its own clock
 * reading. (Outside a server render there is nothing to share, and it is simply the current time.)
 */
export const renderNow = cache((): Date => new Date());

/**
 * Step 7B-15S/15U — the short form of the SAME absolute UTC instant displayTime() shows ("08 NOV 2026 · 23:14 UTC"),
 * for reading (Manual §7 mono-s: "08 NOV 23:14"). Derived from displayTime itself, so the two never disagree. The year
 * is left out ONLY for a date in the current UTC calendar year (`now`: the render-time reference) — a date from any
 * other year always shows its year, even when everything on the page is from that year (Step 7B-15T P2: comparing
 * against the latest time on the page hid the year of a wholly historical conversation). The date is left out when
 * `previous` (the time shown just above, in reading order) already said the same UTC day — whose own label carries the
 * year whenever one is due. Never relative, never a local zone; the exact form stays available (TimeStamp / TimedText).
 */
export function shortTime(date: Date, now: Date, previous?: Date): string {
  const [day = "", month = "", year = "", , clock = ""] = displayTime(date).split(" ");
  if (previous !== undefined && sameUtcDay(date, previous)) return clock;
  if (now.getUTCFullYear() === date.getUTCFullYear()) return `${day} ${month} ${clock}`;
  return `${day} ${month} ${year} ${clock}`;
}

export const shown = (date: Date, now: Date, previous?: Date): ShownTime => ({ iso: when(date), label: shortTime(date, now, previous), full: displayTime(date), ...(previous === undefined ? {} : { previous: when(previous) }) });

/** Where a catalog sentence carries its time ("Published {time}"): split around it, so the time can be drawn on its own. */
const TIME_SLOT = "\u0000time\u0000";

/**
 * Comments 2.1 (Step 7B-17R) — a catalog sentence whose `{time}` is read in the reader's own time zone in the browser
 * (ui/time/local-time.tsx); the server's UTC reading is what the page says without JavaScript. `short` follows the
 * thread's short form (with `previous`: the time shown just above); `full` is the exact reading with its zone.
 * `values` fills the sentence's other slots ("{kind} by {author}, {time}").
 */
export function timed(key: MessageKey, date: Date, form: LocalTimeForm, timing?: { readonly now: Date; readonly previous?: Date | undefined }, values: Readonly<Record<string, string>> = {}): React.ReactNode {
  const [before = "", after = ""] = t(key, { ...values, time: TIME_SLOT }).split(TIME_SLOT);
  const fallback = form === "full" ? displayTime(date) : shortTime(date, timing?.now ?? renderNow(), timing?.previous);
  return (
    <>
      {before}
      <LocalTime iso={when(date)} form={form} fallback={fallback} previous={timing?.previous === undefined ? undefined : when(timing.previous)} />
      {after}
    </>
  );
}

export const kindOf = (contentKind: string | null): string => t(contentKind === null ? CONTENT_KIND_FALLBACK : (CONTENT_KIND_MESSAGES[contentKind] ?? CONTENT_KIND_FALLBACK));

/** Manual §7 tones for what has been read: success when complete, amber when partial, red when the last read failed. */
export const COVERAGE_TONES: { readonly [S in CoverageKindView["state"]]: { readonly tone: StateTone; readonly icon?: IconName } } = {
  complete: { tone: "success", icon: "decision-approve" },
  importing: { tone: "neutral", icon: "estado-sync" },
  partial: { tone: "warning" },
  failed: { tone: "danger", icon: "estado-alert" },
  unavailable: { tone: "neutral", icon: "estado-lock" },
  not_requested: { tone: "neutral", icon: "estado-lock" },
  unknown: { tone: "neutral" },
};

const CLOSED_MESSAGES: { readonly [K in Exclude<ConversationViewState["kind"], "ready" | "signed_out">]: MessageKey } = {
  verification_required: "auth.status.verification_required",
  workspace_not_found: "inbox.workspace_not_found",
  conversation_not_found: "inbox.conversation.not_found",
  not_allowed: "inbox.not_allowed",
  unavailable: "inbox.unavailable",
};

/** A closed state: a red notice when the Inbox could not be read, neutral text otherwise (not an error). */
export function ClosedState({ kind }: { readonly kind: keyof typeof CLOSED_MESSAGES }) {
  if (kind === "unavailable") {
    return (
      <NoticeSlot>
        <Notice tone="danger" live="assertive">
          {t(CLOSED_MESSAGES[kind])}
        </Notice>
      </NoticeSlot>
    );
  }
  if (kind === "verification_required") {
    return (
      <NoticeSlot>
        <Notice tone="info">{t(CLOSED_MESSAGES[kind])}</Notice>
      </NoticeSlot>
    );
  }
  return <PaneMessage>{t(CLOSED_MESSAGES[kind])}</PaneMessage>;
}
/** What has been read, per account and kind, as a disclosure (open when the list is empty). */
export function CoverageSummary({ page, open }: { readonly page: InboxPage; readonly open: boolean }) {
  const incomplete = page.coverage.some((account) => account.comments.state === "failed" || account.comments.state === "partial" || account.comments.state === "unknown");
  return (
    <CoverageBlock>
      <Disclosure
        open={open}
        summary={<CoverageSummaryLabel title={t("inbox.coverage.heading")} meta={page.asOf === null ? t("inbox.coverage.never") : timed("inbox.coverage.as_of", page.asOf, "full")} {...(incomplete ? { incomplete: t("inbox.coverage.incomplete") } : {})} />}
      >
        {page.coverageOmitted ? (
          <NoticeSlot>
            <Notice tone="info">{t("inbox.coverage.omitted")}</Notice>
          </NoticeSlot>
        ) : null}
        {page.coverage.length === 0 ? <p>{t("inbox.coverage.never")}</p> : <CoverageAccounts>{page.coverage.map((account) => <Account key={account.connectedAccountId} account={account} />)}</CoverageAccounts>}
      </Disclosure>
    </CoverageBlock>
  );
}

function Account({ account }: { readonly account: AccountCoverageView }) {
  const platform = platformName(account.platform);
  const name = platform === undefined ? t("inbox.coverage.account.unknown_platform") : t("inbox.coverage.account", { platform });
  return (
    <CoverageAccount
      head={
        <>
          <OriginMark platform={account.platform} name={name} showName />
          {account.active ? null : <DataTag>{t("inbox.coverage.inactive")}</DataTag>}
          {account.asOf === null ? null : <span className="wk-sr-only">{timed("inbox.coverage.as_of", account.asOf, "full")}</span>}
        </>
      }
      kinds={[kindView("comments", "inbox.coverage.comments", account.comments), kindView("replies", "inbox.coverage.replies", account.replies)]}
    />
  );
}

function kindView(key: string, messageKey: "inbox.coverage.comments" | "inbox.coverage.replies", view: CoverageKindView) {
  const { tone, icon } = COVERAGE_TONES[view.state];
  const captions: string[] = [];
  if (view.state !== "complete" && view.state !== "unknown" && view.reason !== null) captions.push(t(COVERAGE_REASON_MESSAGES[view.reason] ?? COVERAGE_REASON_FALLBACK));
  if (view.scope === "content") captions.push(t("inbox.coverage.content_scope"));
  return {
    key,
    pill: (
      <StatePill tone={tone} {...(icon === undefined ? {} : { icon })}>
        {t(messageKey, { state: t(COVERAGE_STATE_MESSAGES[view.state]) })}
      </StatePill>
    ),
    captions,
    ...(view.coveredUntil === null ? {} : { until: timed("inbox.coverage.until", view.coveredUntil, "full") }),
  };
}

/* ───── COMMENTS-INT-03B — the thread, read only (moved unchanged from ./views; the Inbox adds its composer on top) ───── */

/**
 * One entry of the drawn thread. `replyingTo` is set when the entry answers a member that is NOT the comment heading
 * its block (a reply to a reply): the entry then names its real parent in words, because its place in the list no
 * longer can. `detached` marks a reply whose own parent was not read: it heads a block of its own, under no one.
 */
export type ThreadEntry =
  | { readonly kind: "member"; readonly item: ThreadItem; readonly replyingTo?: ThreadItem; readonly detached?: true }
  | { readonly kind: "outbound"; readonly item: OutboundReplyItem; readonly replyingTo?: ThreadItem };

/**
 * Step 7B-15O/Q — the thread in the order things happened, from the data already read (no time is invented).
 *
 * The read model lists a conversation's members FLAT, oldest first by platform time (undated last). The page draws ONE
 * level of indentation, so order and indentation alone cannot say both "when" and "under whom" once a reply answers
 * another reply. The two are therefore kept apart:
 *
 *   - WHERE (association): every entry sits in the block of the top-level comment it descends from — never under
 *     another comment — and an entry whose parent is not that comment itself carries `replyingTo` (drawn as
 *     "Replying to …"). The parent ids are the read model's own; nothing is re-parented.
 *   - WHEN (chronology): inside a block the members keep the read model's order, and a reply requested from Wrenkind
 *     is placed before the first member of the block — at ANY depth — that the platform dates later than the request
 *     (and that comes after the request's own parent); otherwise at the end of the block.
 *
 * A member without a platform date never moves anything; equal times keep the platform's reply first; several requests
 * keep their request order, then their id — so the result does not depend on the order the requests arrive in. A reply
 * whose parent was not read heads its own (detached) block; a request whose comment is not in the thread is listed
 * last. Every member and every request is drawn exactly once.
 */
export function threadEntries(detail: ConversationDetailModel): readonly ThreadEntry[] {
  const thread = detail.thread;
  const byId = new Map(thread.map((item) => [item.interactionId, item]));
  const indexOf = new Map(thread.map((item, index) => [item.interactionId, index]));
  /**
   * The head of an item's block: its top-most ancestor that was read (itself, when it has no parent or its parent is
   * absent). Parent ids that loop (never expected) are not followed forever: the loop's first member in the read
   * model's order heads the block, so every member still belongs to exactly one.
   */
  const rootOf = (item: ThreadItem): ThreadItem => {
    const visited = [item];
    let current = item;
    for (;;) {
      const parent = current.parentInteractionId === null ? undefined : byId.get(current.parentInteractionId);
      if (parent === undefined) return current;
      const loopStart = visited.indexOf(parent);
      if (loopStart !== -1) return visited.slice(loopStart).reduce((first, member) => ((indexOf.get(member.interactionId) ?? 0) < (indexOf.get(first.interactionId) ?? 0) ? member : first));
      visited.push(parent);
      current = parent;
    }
  };
  // Blocks in the order their heads appear; inside a block, the head first and then its members in the read model's order.
  const blocks = new Map<string, ThreadItem[]>();
  for (const item of thread) if (rootOf(item) === item) blocks.set(item.interactionId, [item]);
  for (const item of thread) {
    const root = rootOf(item);
    if (root !== item) blocks.get(root.interactionId)?.push(item);
  }
  const outbound = [...detail.outbound].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.intentId.localeCompare(b.intentId));
  /** Per block, the requests drawn just before the member at an index (index = block length: after the last one). */
  const placed = new Map<string, Map<number, OutboundReplyItem[]>>();
  const unplaced: OutboundReplyItem[] = [];
  for (const request of outbound) {
    const parent = byId.get(request.parentInteractionId);
    const block = parent === undefined ? undefined : blocks.get(rootOf(parent).interactionId);
    if (parent === undefined || block === undefined) {
      unplaced.push(request);
      continue;
    }
    let position = block.indexOf(parent) + 1;
    while (position < block.length) {
      const at = block[position]?.providerCreatedAt ?? null;
      if (at !== null && at.getTime() > request.createdAt.getTime()) break;
      position += 1;
    }
    const slots = placed.get(block[0]?.interactionId ?? "") ?? new Map<number, OutboundReplyItem[]>();
    slots.set(position, [...(slots.get(position) ?? []), request]);
    placed.set(block[0]?.interactionId ?? "", slots);
  }
  const entries: ThreadEntry[] = [];
  for (const [rootId, block] of blocks) {
    const slots = placed.get(rootId);
    const naming = (parentId: string | null): { readonly replyingTo?: ThreadItem } => {
      const parent = parentId === null || parentId === rootId ? undefined : byId.get(parentId);
      return parent === undefined ? {} : { replyingTo: parent };
    };
    block.forEach((item, index) => {
      for (const request of slots?.get(index) ?? []) entries.push({ kind: "outbound", item: request, ...naming(request.parentInteractionId) });
      entries.push({ kind: "member", item, ...(index === 0 ? (item.parentInteractionId === null ? {} : { detached: true as const }) : naming(item.parentInteractionId)) });
    });
    for (const request of slots?.get(block.length) ?? []) entries.push({ kind: "outbound", item: request, ...naming(request.parentInteractionId) });
  }
  for (const request of unplaced) entries.push({ kind: "outbound", item: request });
  return entries;
}

/**
 * Step 7B-15S/15U — per entry, the time shown just above it in reading order (short times then show the date only when
 * it changes). Moved unchanged from the Inbox's conversation view (COMMENTS-INT-03B).
 */
export function previousTimes(entries: readonly ThreadEntry[]): ReadonlyMap<string, Date | undefined> {
  const previousOf = new Map<string, Date | undefined>();
  let shownAbove: Date | undefined;
  for (const entry of entries) {
    const at = entry.kind === "member" ? entry.item.providerCreatedAt : entry.item.createdAt;
    previousOf.set(entry.kind === "member" ? entry.item.interactionId : entry.item.intentId, shownAbove);
    if (at !== null) shownAbove = entry.kind === "outbound" && entry.item.confirmedAt !== null ? entry.item.confirmedAt : at;
  }
  return previousOf;
}

/** "Replying to …": when that author wrote more than one entry here, it also says when the parent was written (which of theirs). */
export function parentLabeller(detail: ConversationDetailModel, now: Date): (parent: ThreadItem) => string {
  const written = new Map<string, number>();
  for (const item of detail.thread) written.set(authorOf(item), (written.get(authorOf(item)) ?? 0) + 1);
  return (parent) =>
    (written.get(authorOf(parent)) ?? 0) > 1 && parent.providerCreatedAt !== null ? t("inbox.reply.to_at", { author: authorOf(parent), time: shortTime(parent.providerCreatedAt, now) }) : t("inbox.reply.to", { author: authorOf(parent) });
}

const OUTBOUND_TONES: { readonly [S in OutboundReplyItem["state"]]: StateTone } = { sending: "neutral", sent: "success", failed: "danger", checking: "warning", blocked: "warning" };
/** Never color alone (manual §11): the two settled-or-moving states carry an icon; the others keep the dot and their word. */
const OUTBOUND_ICONS: { readonly [S in OutboundReplyItem["state"]]: IconName | undefined } = { sending: "estado-sync", sent: "decision-approve", failed: undefined, checking: undefined, blocked: undefined };

/** How a member is named wherever the page refers to them (the thread's author line and "Replying to …"). */
export const authorOf = (item: Pick<ThreadItem, "author" | "authorLabel">): string => (item.author === "own_account" ? t(AUTHOR_MESSAGES.own_account) : item.author === "unknown" ? t(AUTHOR_MESSAGES.unknown) : (item.authorLabel ?? t("inbox.author.unnamed")));

/** Step 7B-15S/15U: where a time is drawn in the thread — the render-time reference and the time shown just above it. */
export interface Timing {
  readonly now: Date;
  readonly previous: Date | undefined;
}

export function OutboundRow({ item, replyingTo, timing }: { readonly item: OutboundReplyItem; readonly replyingTo?: string; readonly timing: Timing }) {
  const times = [<TimedText key="requested" short={timed("inbox.outbound.requested_at", item.createdAt, "short", timing)} full={timed("inbox.outbound.requested_at", item.createdAt, "full")} />];
  if (item.confirmedAt !== null) times.push(<TimedText key="confirmed" short={timed("inbox.outbound.confirmed_at", item.confirmedAt, "short", { now: timing.now, previous: item.createdAt })} full={timed("inbox.outbound.confirmed_at", item.confirmedAt, "full")} />);
  const icon = OUTBOUND_ICONS[item.state];
  const note = item.state === "checking" ? t("inbox.outbound.checking_note") : item.state === "failed" ? t("inbox.outbound.failed_note") : item.state === "blocked" ? t("inbox.outbound.blocked_note") : undefined;
  return (
    <OutboundReply
      author={t("inbox.outbound.author")}
      kind={t("inbox.outbound.kind")}
      state={
        <StatePill tone={OUTBOUND_TONES[item.state]} {...(icon === undefined ? {} : { icon })}>
          {t(OUTBOUND_STATE_MESSAGES[item.state])}
        </StatePill>
      }
      text={item.text}
      times={times}
      {...(note === undefined ? {} : { note })}
      {...(replyingTo === undefined ? {} : { replyingTo })}
    />
  );
}

/**
 * COMMENTS-INT-03B — one member of the thread as a record, read only: who wrote it, when, its text exactly as retained,
 * its platform state, its exact times and earlier versions, and the observed facts about its current text. Moved
 * unchanged from the Inbox's member (./views), which adds only its reply composer as `actions`; a page that only reads
 * (the Comments route) draws it without one.
 */
export function ThreadMemberRecord({ item, platformText, replyingTo, detached, timing, actions }: {
  readonly item: ThreadItem;
  readonly platformText: string;
  /** Step 7B-15Q: "Replying to …" for the member this one answers, when that is not the comment heading its block. */
  readonly replyingTo?: string | undefined;
  /** Step 7B-15Q: a reply whose own parent was not read — drawn apart, under no one. */
  readonly detached: boolean;
  readonly timing: Timing;
  readonly actions?: React.ReactNode;
}) {
  const author = authorOf(item);
  const kind = t(item.kind === "reply" ? "inbox.thread.reply" : "inbox.thread.comment");
  // Step 7B-15S: the record — every exact time, one small disclosure away (when it was written, edited, read).
  // Comments 2.1 (Step 7B-17R): in the reader's own zone, with the zone named; UTC without JavaScript.
  const times: React.ReactNode[] = [];
  if (item.providerCreatedAt !== null) times.push(timed("inbox.thread.posted", item.providerCreatedAt, "full"));
  if (item.providerEditedAt !== null) times.push(timed("inbox.thread.edited", item.providerEditedAt, "full"));
  if (item.textObservedAt !== null) times.push(timed("inbox.thread.text_read", item.textObservedAt, "full"));
  // Comments 2.1 (Step 7B-17T): the screen-reader name of this entry's disclosures reads its time in the same zone as
  // every other time on the page (UTC without JavaScript).
  const entryLabel = item.providerCreatedAt === null ? t("inbox.thread.entry_label_undated", { kind, author }) : timed("inbox.thread.entry_label", item.providerCreatedAt, "full", undefined, { kind, author });
  const removed = item.observed && item.presence === "removed_at_source";
  // "Written by your account" repeats what the author line already says on the brand's own messages: the fact stays in
  // the data (nothing is removed from the view model) and is simply not drawn twice.
  const facts = item.facts.filter((fact) => !(fact === "author_own_brand" && item.author === "own_account"));
  return (
    <ThreadMember
      id={threadMemberId(item.interactionId)}
      nested={item.parentInteractionId !== null}
      own={item.author === "own_account"}
      author={author}
      named={item.author === "audience" && item.authorLabel !== null}
      detached={detached}
      {...(replyingTo === undefined ? (detached ? { replyingTo: t("inbox.thread.parent_not_shown") } : {}) : { replyingTo })}
      kind={kind}
      {...(item.providerCreatedAt === null ? {} : { time: shown(item.providerCreatedAt, timing.now, timing.previous) })}
      {...(item.providerEditedAt === null ? {} : { edited: t("inbox.thread.edited_short") })}
      {...(item.observed && item.presence !== "present"
        ? { presence: <StatePill icon="estado-lock">{t(PRESENCE_MESSAGES[item.presence], { platform: platformText })}</StatePill> }
        : {})}
      text={item.observed ? (item.text ?? t("inbox.thread.no_text")) : t("inbox.thread.not_read")}
      textMuted={!item.observed || item.text === null || removed}
      times={times}
      timesLabel={t("inbox.thread.details")}
      timesContext={entryLabel}
      {...(item.earlierVersions.length === 0
        ? {}
        : {
            versions: (
              <MemberDisclosure summary={t(item.olderVersionsOmitted ? "inbox.thread.versions_recent" : "inbox.thread.versions", { count: String(item.earlierVersions.length) })} context={entryLabel}>
                <VersionList
                  {...(item.olderVersionsOmitted
                    ? {
                        notice: (
                          <Notice tone="info" live="off">
                            {t("inbox.thread.versions_omitted")}
                          </Notice>
                        ),
                      }
                    : {})}
                >
                  {item.earlierVersions.map((version, index) => (
                    <Version key={`${version.observedAt.toISOString()}-${String(index)}`} time={{ iso: when(version.observedAt), label: timed("inbox.thread.version_read", version.observedAt, "full") }} text={version.text} />
                  ))}
                </VersionList>
              </MemberDisclosure>
            ),
          })}
      {...(facts.length === 0
        ? {}
        : {
            facts: (
              <Facts label={t("inbox.facts.heading")}>
                {facts.map((fact) => (
                  <DataTag key={fact} {...(fact === "link_present" ? { icon: "conv-link" as const } : fact === "watch_term_match" ? { icon: "util-tag" as const } : {})}>
                    {t(FACT_MESSAGES[fact] ?? FACT_FALLBACK)}
                  </DataTag>
                ))}
              </Facts>
            ),
          })}
      {...(actions === undefined ? {} : { actions })}
    />
  );
}
