import {
  AUTHOR_MESSAGES,
  CONVERSATION_STATE_MESSAGES,
  SOURCE_MESSAGES,
  platformName,
  type ConversationDetail as ConversationDetailModel,
  type OutboundReplyItem,
  REPLY_BLOCKED_MESSAGES,
  REPLY_REASON_MESSAGES,
  REPLY_REFUSAL_MESSAGES,
  type InboxConversationItem,
  type InboxListState,
  type InboxPage,
  type ThreadItem,
} from "@/server/inbox/inbox";
import { randomUUID } from "node:crypto";
import { publishReplyAction } from "@/server/inbox/actions";
import type { ReplyAction } from "@/server/inbox/reply-state";
import { t } from "@/server/i18n";
import { ReplyComposer, type ReplyComposerLabels, type ReplyOutcomeMessages } from "@/ui/inbox/reply-composer";
import { conversationRowId, workspaceConversationPath, workspaceConversationReplyPath, workspaceInboxPagePath, workspaceInboxPath } from "@/server/routes";
import { Icon } from "@/ui/icons/icon";
import {
  ConversationActions,
  ConversationDetail,
  ConversationList,
  ContextFact,
  ConversationNav,
  ConversationRow,
  InboxEmpty,
  InboxHeader,
  Pagination,
  QuietNote,
  ReplySlot,
  ReplyUnavailable,
  Thread,
  ThreadHeading,
  ThreadOutbound,
  UnavailableAction,
  UnavailableActions,
} from "@/ui/inbox/inbox";
import { DataTag } from "@/ui/primitives/data-tag";
import { Disclosure } from "@/ui/primitives/disclosure";
import { Notice } from "@/ui/primitives/notice";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { StatePill } from "@/ui/primitives/state-pill";
import { TextLink } from "@/ui/primitives/text-link";
import { authorOf, ClosedState, COVERAGE_TONES, CoverageSummary, kindOf, OutboundRow, parentLabeller, previousTimes, renderNow, shortTime, shown, threadEntries, ThreadMemberRecord, timed, type ThreadEntry, type Timing } from "./read-views";

// Read-only pieces live in ./read-views (no composer, no action); re-exported so every existing import keeps working.
export { ClosedState, COVERAGE_TONES, CoverageSummary, shortTime, threadEntries };
export type { ThreadEntry };

/**
 * Inbox views (UI-4; Step 7B-15B): how the Step 7A view models are drawn — the list, the coverage summary, the selected
 * conversation expanded in place inside its row — shared by the two pages and by the development-only reference. Reads
 * nothing, decides nothing: every value comes shaped from server/queries/inbox and every word from the catalog. The one
 * action is the existing public reply (Step 7B-3), under the comment it answers, with ONE composer per render. Audience
 * text is rendered as text, links in it stay inert, and nothing is interpreted: no label, priority, sentiment or risk.
 */


/**
 * The list for a ready page. `selectedId` marks the open conversation and `cursor` is the position being shown;
 * `expanded` (Step 7B-15B) is that conversation itself, drawn in place under its row.
 */
export function InboxListView({ workspaceId, page, cursor, selectedId, expanded }: { readonly workspaceId: string; readonly page: InboxPage; readonly cursor: string | undefined; readonly selectedId?: string; readonly expanded?: React.ReactNode }) {
  const empty = page.items.length === 0;
  const now = renderNow();
  return (
    <>
      <InboxHeader level={selectedId === undefined ? 1 : 2} title={t("inbox.heading")} subtitle={t("inbox.ordering")} noScriptNote={t("inbox.times.utc")} />
      <CoverageSummary page={page} open={empty && page.coverage.length > 0} />
      {empty ? (
        <InboxEmpty title={t("inbox.list.heading")}>{page.emptyReason === "nothing_read_yet" ? t("inbox.empty.nothing_read") : t("inbox.empty.no_conversations")}</InboxEmpty>
      ) : (
        <>
          <ConversationList>
            {page.items.map((item, index) => (
              <Row
                key={item.conversationId}
                workspaceId={workspaceId}
                item={item}
                cursor={cursor}
                now={now}
                current={item.conversationId === selectedId}
                {...(item.conversationId === selectedId && expanded !== undefined ? { expanded, nav: <RowNav workspaceId={workspaceId} page={page} index={index} cursor={cursor} /> } : {})}
              />
            ))}
          </ConversationList>
          <Pagination>
            {page.nextCursor === null ? (
              t("inbox.pagination.end")
            ) : (
              <OlderLink workspaceId={workspaceId} cursor={page.nextCursor} />
            )}
          </Pagination>
        </>
      )}
    </>
  );
}

/**
 * Step 7B-15O — from the open conversation to the one before or after it among the rows on screen (the same addresses
 * the rows themselves link to), and Close: the list at the same position. Navigation only.
 */
function RowNav({ workspaceId, page, index, cursor }: { readonly workspaceId: string; readonly page: InboxPage; readonly index: number; readonly cursor: string | undefined }) {
  const hrefAt = (at: number): string | undefined => {
    const item = page.items[at];
    return item === undefined ? undefined : workspaceConversationPath(workspaceId, item.conversationId, cursor);
  };
  const current = page.items[index];
  const list = cursor === undefined ? workspaceInboxPath(workspaceId) : workspaceInboxPagePath(workspaceId, cursor);
  // Step 7B-15S (15P/15R P3): "n of N" only when N is everything; with newer or older pages it is "n of N on this page",
  // and the last row of a page that has older conversations leads to them (the existing "Older conversations" address)
  // instead of a dead end.
  const paged = cursor !== undefined || page.nextCursor !== null;
  const positionKey = paged ? "inbox.nav.position_page" : "inbox.nav.position";
  const older = page.nextCursor === null ? undefined : workspaceInboxPagePath(workspaceId, page.nextCursor);
  const nextHref = hrefAt(index + 1);
  return (
    <ConversationNav
      label={t("inbox.nav.label")}
      position={t(positionKey, { index: String(index + 1), count: String(page.items.length) })}
      previous={{ label: t("inbox.nav.previous"), href: hrefAt(index - 1) }}
      next={nextHref === undefined && older !== undefined ? { label: t("inbox.pagination.older"), href: older } : { label: t("inbox.nav.next"), href: nextHref }}
      close={list === undefined || current === undefined ? undefined : { label: t("inbox.nav.close"), href: `${list}#${conversationRowId(current.conversationId)}` }}
    />
  );
}

function OlderLink({ workspaceId, cursor }: { readonly workspaceId: string; readonly cursor: string }) {
  const href = workspaceInboxPagePath(workspaceId, cursor);
  return href === undefined ? null : <TextLink href={href}>{t("inbox.pagination.older")}</TextLink>;
}

function Row({ workspaceId, item, cursor, now, current, expanded, nav }: { readonly workspaceId: string; readonly item: InboxConversationItem; readonly cursor: string | undefined; readonly now: Date; readonly current: boolean; readonly expanded?: React.ReactNode; readonly nav?: React.ReactNode }) {
  const href = workspaceConversationPath(workspaceId, item.conversationId, cursor);
  if (href === undefined) return null;
  const platform = platformName(item.platform);
  const platformText = platform ?? t("inbox.platform.unknown");
  const author = item.anchor.observed ? (item.anchor.author === "own_account" ? t(AUTHOR_MESSAGES.own_account) : item.anchor.author === "unknown" ? t(AUTHOR_MESSAGES.unknown) : (item.anchor.authorLabel ?? t("inbox.author.unnamed"))) : t("inbox.author.unknown");
  const meta: React.ReactNode[] = [];
  if (item.contentKind !== null) meta.push(<DataTag key="kind">{kindOf(item.contentKind)}</DataTag>);
  if (item.source === "mixed") meta.push(<DataTag key="source">{t("inbox.source.mixed_short")}</DataTag>);
  // Comments 2.1 (Step 7B-17R): an unknown source is not a chip on every row — it stays stated in the conversation's
  // details ("Organic or paid: not known"); nothing is ever inferred to be organic or paid.
  if (item.workflowState !== "open") meta.push(<StatePill key="state">{t(CONVERSATION_STATE_MESSAGES[item.workflowState])}</StatePill>);
  if (item.observedCount > 1) meta.push(<DataTag key="read" icon="conv-thread" mono srLabel={t("inbox.item.read_count", { count: String(item.observedCount) })}>{t("inbox.item.read_count_short", { count: String(item.observedCount) })}</DataTag>);
  if (item.notYetReadCount > 0) meta.push(<DataTag key="unread" mono>{t("inbox.item.not_yet_read_count", { count: String(item.notYetReadCount) })}</DataTag>);
  if (item.anchor.observed && item.anchor.presence === "hidden") meta.push(<DataTag key="hidden" icon="estado-lock">{t("inbox.presence.hidden")}</DataTag>);
  else if (item.anyHidden) meta.push(<DataTag key="hidden" icon="estado-lock">{t("inbox.presence.hidden")}</DataTag>);
  if (item.anyRemovedAtSource || (item.anchor.observed && item.anchor.presence === "removed_at_source")) meta.push(<DataTag key="removed">{t("inbox.presence.removed", { platform: platformText })}</DataTag>);
  if (item.anchor.observed && item.anchor.presence === "unknown") meta.push(<DataTag key="presence">{t("inbox.presence.unknown")}</DataTag>);
  return (
    <ConversationRow
      id={conversationRowId(item.conversationId)}
      href={href}
      current={current}
      origin={<OriginMark platform={item.platform} name={platformText} paid={item.source === "paid"} paidLabel={t("inbox.source.paid")} />}
      author={author}
      named={item.anchor.observed && item.anchor.author === "audience" && item.anchor.authorLabel !== null}
      time={shown(item.latestActivityAt, now)}
      excerpt={item.anchor.observed ? (item.anchor.excerpt ?? t("inbox.item.excerpt_none")) : t("inbox.item.anchor_not_read")}
      excerptMuted={!item.anchor.observed || item.anchor.excerpt === null}
      meta={meta.length === 0 ? undefined : meta}
      {...(expanded === undefined ? {} : { expanded })}
      {...(nav === undefined ? {} : { nav })}
    />
  );
}

/**
 * Step 7B-15B — ONE composer per render: the comment the reply composer is drawn under. The address may name it
 * (`?reply=`); a name that is not an eligible comment of this conversation is ignored. Otherwise it is the first
 * comment that can be answered (for a validation reply: the first one the live authorization covers). Presentation
 * only: it never makes a comment answerable — the request command re-checks the target, and the server decided `reply`.
 */
export function replyTargetOf(detail: ConversationDetailModel, requested: string | undefined): string | undefined {
  const reply = detail.reply;
  if (reply.kind !== "available" && reply.kind !== "validation") return undefined;
  const inFlight = repliesInFlight(detail);
  const candidates = detail.thread.filter((item) => replyEligible(item, detail.platform) && !inFlight.has(item.interactionId) && (reply.kind === "available" || reply.targets.some((target) => target.targetInteractionId === item.interactionId)));
  return (candidates.find((item) => item.interactionId === requested) ?? candidates[0])?.interactionId;
}

/**
 * Step 7B-15J — the comments whose reply is still on its way or being checked, as the database says on THIS render
 * (any initiator: another tab, another session, a teammate). While one is, the comment gets no composer and no link
 * that places one: a reply that may already exist never becomes a second, independently publishable request because a
 * page was reloaded, a tab opened or a new form key issued. Sent, failed and blocked replies are settled: a new reply can
 * be written. Presentation only — the request command decides admission on its own.
 */
const IN_FLIGHT: ReadonlySet<OutboundReplyItem["state"]> = new Set(["sending", "checking"]);
export function repliesInFlight(detail: ConversationDetailModel): ReadonlySet<string> {
  return new Set(detail.outbound.filter((item) => IN_FLIGHT.has(item.state)).map((item) => item.parentInteractionId));
}

/**
 * The selected conversation, drawn in place under its row. The back link returns to the list at the same position
 * (and is the only way out on one-screen layouts). `replyTo` is the address's `?reply=` value, if any.
 */
export function ConversationView({ workspaceId, detail, cursor, replyTo, draftScope, replyPath, replyAction = publishReplyAction, replyOutcomes }: {
  readonly workspaceId: string;
  readonly detail: ConversationDetailModel;
  readonly cursor: string | undefined;
  readonly replyTo?: string;
  /** Step 7B-15F: the verified person's opaque draft scope; without it the composer keeps no draft. */
  readonly draftScope?: string;
  /** Development reference only: where "reply to this comment" leads (production: the conversation's own address). */
  readonly replyPath?: (memberId: string) => string | undefined;
  readonly replyAction?: ReplyAction;
  readonly replyOutcomes?: ReplyOutcomeMessages;
}) {
  const platform = platformName(detail.platform);
  const platformText = platform ?? t("inbox.platform.unknown");
  const list = cursor === undefined ? workspaceInboxPath(workspaceId) : workspaceInboxPagePath(workspaceId, cursor);
  const back = list === undefined ? undefined : `${list}#${conversationRowId(detail.conversationId)}`;
  const replyTarget = replyTargetOf(detail, replyTo);
  // Chosen by the address: the composer opens ready to write. By default it waits behind its "Reply" button.
  const replyOpen = replyTarget !== undefined && replyTarget === replyTo;
  const entries = threadEntries(detail);
  // Step 7B-15S/15U — short times: the year unless it is the current UTC year, the date only when it changes
  // from the time shown just above (reading order). Exact forms stay on the page (TimeStamp, the "Exact times" record).
  const now = renderNow();
  const previousOf = previousTimes(entries);
  const parentLabel = parentLabeller(detail, now);
  return (
    <ConversationDetail
      back={back === undefined ? undefined : <TextLink href={back}>{t("inbox.back")}</TextLink>}
      title={t("inbox.conversation.heading")}
      context={
        <>
          <OriginMark platform={detail.platform} name={platformText} showName paid={detail.source === "paid"} paidLabel={t("inbox.source.paid")} />
          <DataTag>{kindOf(detail.contentKind)}</DataTag>
          <ContextFact>
            <DataTag>{t(SOURCE_MESSAGES[detail.source])}</DataTag>
          </ContextFact>
          <StatePill>{t(CONVERSATION_STATE_MESSAGES[detail.workflowState])}</StatePill>
        </>
      }
      contextLabel={t("inbox.context.heading")}
      contextNote={t("inbox.context.post_unavailable")}
    >
      <QuietNote>{t("inbox.understanding_pending")}</QuietNote>
      <ThreadHeading id="thread" label={t("inbox.thread.heading")} />
      {/* Comments 2.1 (Step 7B-17R): once per conversation. "Not available yet" in Wrenkind is one sentence; a reason of
          this workspace, account, connection or platform keeps its label and its own words. */}
      {detail.reply.kind === "unavailable" ? (
        detail.reply.reason === "platform_unavailable" ? (
          <ReplyUnavailable reason={t(REPLY_REASON_MESSAGES[detail.reply.reason])} />
        ) : (
          <ReplyUnavailable label={t("inbox.reply.unavailable_label")} reason={t(REPLY_REASON_MESSAGES[detail.reply.reason])} />
        )
      ) : null}
      <Thread labelledBy="thread">
        {entries.map((entry) =>
          entry.kind === "member" ? (
            <Member key={entry.item.interactionId} item={entry.item} platformText={platformText} detail={detail} workspaceId={workspaceId} cursor={cursor} replyTarget={replyTarget} replyOpen={replyOpen} draftScope={draftScope} replyPath={replyPath} replyAction={replyAction} outcomes={replyOutcomes ?? replyOutcomeMessages()} {...(entry.replyingTo === undefined ? {} : { replyingTo: parentLabel(entry.replyingTo) })} detached={entry.detached === true} timing={{ now, previous: previousOf.get(entry.item.interactionId) }} />
          ) : (
            <ThreadOutbound key={entry.item.intentId}>
              <OutboundRow item={entry.item} {...(entry.replyingTo === undefined ? {} : { replyingTo: parentLabel(entry.replyingTo) })} timing={{ now, previous: previousOf.get(entry.item.intentId) }} />
            </ThreadOutbound>
          ),
        )}
      </Thread>
      {detail.truncated ? (
        <Notice tone="info" live="off">
          {t("inbox.thread.truncated", { count: String(detail.thread.length) })}
        </Notice>
      ) : null}
      <SecondaryActions detail={detail} />
    </ConversationDetail>
  );
}

/**
 * Step 7B-3: which members may receive a public reply. The brand's own messages, placeholders never read, and
 * comments hidden or gone from the platform offer nothing; on Instagram, only top-level comments do (replies attach to
 * the top-level comment, PD/Meta documented restriction). The server re-checks every one of these at request time.
 */
export function replyEligible(item: Pick<ThreadItem, "observed" | "presence" | "author" | "parentInteractionId">, platform: ConversationDetailModel["platform"]): boolean {
  if (!item.observed || item.presence !== "present" || item.author === "own_account") return false;
  if (platform === "instagram" && item.parentInteractionId !== null) return false;
  return true;
}

/**
 * Step 7B-15B — the secondary actions, under the thread. Wrenkind can perform none of them yet, so each is listed with
 * its one reason (IA §8.1, §8.3: visible, never a dead control, never hidden for a platform or product limit). Shown
 * only to a member the server gave the reply affordance to (IA §18: a role limit hides); the reason is the workspace
 * mode when that is what blocks, the product's own state otherwise. No destructive action exists, so none is drawn.
 */
function SecondaryActions({ detail }: { readonly detail: ConversationDetailModel }) {
  if (detail.reply.kind === "hidden") return null;
  const reason = t(detail.reply.kind === "unavailable" && detail.reply.reason === "monitor_only" ? REPLY_REASON_MESSAGES.monitor_only : "inbox.actions.reason.not_yet");
  return (
    <ConversationActions label={t("inbox.actions.heading")}>
      <Disclosure summary={t("inbox.actions.more")}>
        <UnavailableActions>
          <UnavailableAction name={t("inbox.actions.reply_private")} reason={reason} />
          <UnavailableAction name={t("inbox.actions.hide")} reason={reason} />
        </UnavailableActions>
      </Disclosure>
    </ConversationActions>
  );
}

function composerLabels(platformText: string, author: string, maxChars: number, instagramTopLevel: boolean): ReplyComposerLabels {
  return {
    open: t("inbox.reply.action"),
    heading: t("inbox.reply.heading"),
    to: t("inbox.reply.to", { author }),
    as: t("inbox.reply.as", { platform: platformText }),
    ...(instagramTopLevel ? { note: t("inbox.reply.instagram_top_level") } : {}),
    fieldLabel: t("inbox.reply.field_label"),
    fieldHelp: t("inbox.reply.field_help", { max: String(maxChars) }),
    // Templates: the client fills `{count}` as the person types (functions never cross the server → client boundary).
    remaining: t("inbox.reply.remaining", { count: "{count}" }),
    overLimit: t("inbox.reply.over_limit", { count: "{count}" }),
    empty: t("inbox.reply.empty"),
    cancel: t("inbox.reply.cancel"),
    review: t("inbox.reply.review"),
    edit: t("inbox.reply.edit"),
    reviewHeading: t("inbox.reply.review_heading"),
    reviewTextLabel: t("inbox.reply.review_text_label"),
    reviewNote: t("inbox.reply.review_note"),
    publish: t("inbox.reply.publish"),
    publishing: t("inbox.reply.publishing"),
    restored: t("inbox.reply.draft_restored"),
  };
}

/** Every closed outcome the action can answer, translated on the server (the client holds no catalog). */
export function replyOutcomeMessages(): ReplyOutcomeMessages {
  return {
    requested: t("inbox.reply.requested"),
    existing: t("inbox.reply.existing"),
    unavailable: t("inbox.reply.unavailable"),
    signed_out: t("inbox.reply.signed_out"),
    ...Object.fromEntries(Object.entries(REPLY_REFUSAL_MESSAGES).map(([reason, key]) => [`refused.${reason}`, t(key)])),
    ...Object.fromEntries(Object.entries(REPLY_BLOCKED_MESSAGES).map(([code, key]) => [`blocked.${code}`, t(key)])),
  };
}

/** The server-issued key of ONE composer render: unique per form, bound to its target by the command's reuse check. */
export function replyFormKey(): string {
  return `rk-${randomUUID()}`;
}

function Member({ item, platformText, detail, workspaceId, cursor, replyTarget, replyOpen, draftScope, replyPath, replyAction, outcomes, replyingTo, detached, timing }: {
  readonly item: ThreadItem;
  readonly platformText: string;
  readonly detail: ConversationDetailModel;
  readonly workspaceId: string;
  readonly cursor: string | undefined;
  readonly replyTarget: string | undefined;
  readonly replyOpen: boolean;
  readonly draftScope: string | undefined;
  readonly replyPath: ((memberId: string) => string | undefined) | undefined;
  readonly replyAction: ReplyAction;
  readonly outcomes: ReplyOutcomeMessages;
  /** Step 7B-15Q: "Replying to …" for the member this one answers, when that is not the comment heading its block. */
  readonly replyingTo?: string;
  /** Step 7B-15Q: a reply whose own parent was not read — drawn apart, under no one. */
  readonly detached: boolean;
  readonly timing: Timing;
}) {
  const author = authorOf(item);
  // Step 7B-14I2: the exceptional validation composer appears ONLY under the exact comment a live authorization naming this
  // member covers; it sends no identifier — the server resolves the authorization itself.
  const validationTarget = detail.reply.kind === "validation" ? detail.reply.targets.find((target) => target.targetInteractionId === item.interactionId) : undefined;
  // Step 7B-15B: ONE composer per render — under the reply target only. Every other comment that can be answered offers
  // a LINK that moves the composer there (navigation; nothing is posted, and no second composer ever exists).
  const here = item.interactionId === replyTarget;
  // Step 7B-15J: a comment whose reply is still sending or being checked offers no way to write another one yet.
  const answerable = replyEligible(item, detail.platform) && (detail.reply.kind === "available" || validationTarget !== undefined);
  const inFlight = answerable && repliesInFlight(detail).has(item.interactionId);
  const elsewhere = !here && !inFlight && replyTarget !== undefined && answerable;
  const replyHere = elsewhere ? (replyPath === undefined ? workspaceConversationReplyPath(workspaceId, detail.conversationId, item.interactionId, cursor) : replyPath(item.interactionId)) : undefined;
  const stage = replyOpen ? ({ initialStage: "write" } as const) : {};
  // Step 7B-15F: the composer keeps this person's unsent text in the tab's memory (never the server, never storage).
  const drafts = draftScope === undefined ? {} : { draftScope };
  const composer = inFlight ? (
    <ReplyUnavailable label={t("inbox.reply.unavailable_label")} reason={t("inbox.reply.in_flight")} />
  ) : !here ? (
    replyHere === undefined ? undefined : (
      <ReplySlot>
        {/* In-app navigation (Step 7B-15F): moving the composer keeps the page, so an unsent draft elsewhere survives. */}
        <TextLink href={replyHere} inPage>
          <Icon name="conv-reply" size={16} />
          {t("inbox.reply.here")}
        </TextLink>
      </ReplySlot>
    )
  ) : detail.reply.kind === "available" && replyEligible(item, detail.platform) ? (
      <ReplyComposer
        action={replyAction}
        fields={{ workspaceId, conversationId: detail.conversationId, targetInteractionId: item.interactionId, idempotencyKey: replyFormKey() }}
        maxChars={detail.reply.maxChars}
        labels={composerLabels(platformText, author, detail.reply.maxChars, detail.platform === "instagram")}
        outcomes={outcomes}
        {...stage}
        {...drafts}
      />
    ) : detail.reply.kind === "validation" && validationTarget !== undefined && replyEligible(item, detail.platform) ? (
      <ReplyComposer
        action={replyAction}
        fields={{ workspaceId, conversationId: detail.conversationId, targetInteractionId: item.interactionId, idempotencyKey: replyFormKey(), validation: true }}
        maxChars={detail.reply.maxChars}
        labels={{ ...composerLabels(platformText, author, detail.reply.maxChars, detail.platform === "instagram"), validationNotice: timed("inbox.reply.validation_notice", validationTarget.expiresAt, "full") }}
        outcomes={outcomes}
        {...stage}
        {...drafts}
      />
    ) : undefined;
  return <ThreadMemberRecord item={item} platformText={platformText} {...(replyingTo === undefined ? {} : { replyingTo })} detached={detached} timing={timing} {...(composer === undefined ? {} : { actions: composer })} />;
}


/** The whole list content for a list state (ready or closed); `expanded` is the open conversation, drawn in its row. */
export function ListPaneFor({ state, cursor, selectedId, expanded }: { readonly state: InboxListState | undefined; readonly cursor: string | undefined; readonly selectedId?: string; readonly expanded?: React.ReactNode }) {
  if (state === undefined || state.kind === "signed_out") return null;
  if (state.kind === "ready") return <InboxListView workspaceId={state.workspaceId} page={state.page} cursor={cursor} {...(selectedId === undefined ? {} : { selectedId })} {...(expanded === undefined ? {} : { expanded })} />;
  return <ClosedState kind={state.kind} />;
}

/** Step 7B-15B: whether the list being shown has this conversation's row (so it can be drawn in place, inside it). */
export function listShows(state: InboxListState | undefined, conversationId: string): boolean {
  return state?.kind === "ready" && state.page.items.some((item) => item.conversationId === conversationId);
}
