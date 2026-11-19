/**
 * COMMENTS-INT-03A — the redesigned Comments list drawn from the Inbox's own view model (InboxPage: the result of
 * inbox.conversations.list). No read, no action, no new field: every row shows exactly what the Inbox row shows —
 * platform, author, excerpt, latest activity, content kind, workflow state, what was read and what the platform hid or
 * removed — in the same order and with the same positions. What the read model does not carry (an account's name, a
 * post's caption, a total count) is not drawn. *
 * COMMENTS-INT-03B — the selected conversation, drawn in the pane from the Inbox's own conversation answer
 * (inbox.conversation.view → ConversationDetail), READ ONLY: its context and its real thread, with the SAME records,
 * order, "Replying to" and times as the Inbox (the shared read-only pieces of ../inbox/read-views). Replies requested
 * from Wrenkind show their real state. No composer, no action, no management control: those stay in the Inbox.
 */
import { t } from "@/server/i18n";
import { AUTHOR_MESSAGES, CONVERSATION_STATE_MESSAGES, displayTime, platformName, REPLY_REASON_MESSAGES, SOURCE_MESSAGES, when, type ConversationDetail, type InboxConversationItem, type InboxPage } from "@/server/inbox/inbox";
import { COMMENTS_CONVERSATION_ANCHOR, conversationRowId, workspaceCommentsConversationPath, workspaceCommentsPagePath, workspaceCommentsPath, workspaceConversationPath, workspaceInboxPath } from "@/server/routes";
import { CommentsAbove, CommentsConversation, CommentsHeader, CommentsList, CommentsListEnd, CommentsListMessage, CommentsPane, CommentsRow, CommentsSplit, CommentsWorkspace } from "@/ui/inbox/comments";
import { QuietNote, ReplyUnavailable, Thread, ThreadHeading, ThreadOutbound } from "@/ui/inbox/inbox";
import { DataTag } from "@/ui/primitives/data-tag";
import { Notice } from "@/ui/primitives/notice";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { StatePill } from "@/ui/primitives/state-pill";
import { TextLink } from "@/ui/primitives/text-link";
// The Inbox's read-only pieces only (audit M-1): never ../inbox/views, which carries the reply composer and its action.
import { authorOf, CoverageSummary, kindOf, OutboundRow, parentLabeller, previousTimes, renderNow, shortTime, threadEntries, ThreadMemberRecord } from "../inbox/read-views";

/** One row: the same facts, wording and conditions as the Inbox row (app/…/inbox/views.tsx), in the Direction C shape. */
function Row({ workspaceId, item, cursor, now, current }: { readonly workspaceId: string; readonly item: InboxConversationItem; readonly cursor: string | undefined; readonly now: Date; readonly current: boolean }) {
  const href = workspaceCommentsConversationPath(workspaceId, item.conversationId, cursor);
  if (href === undefined) return null;
  const platformText = platformName(item.platform) ?? t("inbox.platform.unknown");
  const author = item.anchor.observed ? (item.anchor.author === "own_account" ? t(AUTHOR_MESSAGES.own_account) : item.anchor.author === "unknown" ? t(AUTHOR_MESSAGES.unknown) : (item.anchor.authorLabel ?? t("inbox.author.unnamed"))) : t("inbox.author.unknown");
  const meta: React.ReactNode[] = [];
  if (item.contentKind !== null) meta.push(<DataTag key="kind">{kindOf(item.contentKind)}</DataTag>);
  if (item.source === "mixed") meta.push(<DataTag key="source">{t("inbox.source.mixed_short")}</DataTag>);
  // The real workflow state, as the Inbox shows it: Open is the ordinary case and says nothing; no transition exists here.
  if (item.workflowState !== "open") meta.push(<StatePill key="state">{t(CONVERSATION_STATE_MESSAGES[item.workflowState])}</StatePill>);
  if (item.observedCount > 1) meta.push(<DataTag key="read" icon="conv-thread" mono srLabel={t("inbox.item.read_count", { count: String(item.observedCount) })}>{t("inbox.item.read_count_short", { count: String(item.observedCount) })}</DataTag>);
  if (item.notYetReadCount > 0) meta.push(<DataTag key="unread" mono>{t("inbox.item.not_yet_read_count", { count: String(item.notYetReadCount) })}</DataTag>);
  if ((item.anchor.observed && item.anchor.presence === "hidden") || item.anyHidden) meta.push(<DataTag key="hidden" icon="estado-lock">{t("inbox.presence.hidden")}</DataTag>);
  if (item.anyRemovedAtSource || (item.anchor.observed && item.anchor.presence === "removed_at_source")) meta.push(<DataTag key="removed">{t("inbox.presence.removed", { platform: platformText })}</DataTag>);
  if (item.anchor.observed && item.anchor.presence === "unknown") meta.push(<DataTag key="presence">{t("inbox.presence.unknown")}</DataTag>);
  return (
    <CommentsRow
      id={conversationRowId(item.conversationId)}
      href={href}
      current={current}
      origin={<OriginMark platform={item.platform} name={platformText} paid={item.source === "paid"} paidLabel={t("inbox.source.paid")} />}
      author={author}
      time={{ iso: when(item.latestActivityAt), label: shortTime(item.latestActivityAt, now), full: displayTime(item.latestActivityAt) }}
      excerpt={item.anchor.observed ? (item.anchor.excerpt ?? t("inbox.item.excerpt_none")) : t("inbox.item.anchor_not_read")}
      excerptMuted={!item.anchor.observed || item.anchor.excerpt === null}
      meta={meta.length === 0 ? undefined : meta}
    />
  );
}

function ListColumn({ workspaceId, page, cursor, selectedId }: { readonly workspaceId: string; readonly page: InboxPage; readonly cursor: string | undefined; readonly selectedId: string | undefined }) {
  if (page.items.length === 0) {
    return <CommentsListMessage title={t("inbox.list.heading")}>{page.emptyReason === "nothing_read_yet" ? t("inbox.empty.nothing_read") : t("inbox.empty.no_conversations")}</CommentsListMessage>;
  }
  const now = renderNow();
  const older = page.nextCursor === null ? undefined : workspaceCommentsPagePath(workspaceId, page.nextCursor);
  return (
    <>
      <CommentsList label={t("inbox.list.heading")}>
        {page.items.map((item) => (
          <Row key={item.conversationId} workspaceId={workspaceId} item={item} cursor={cursor} now={now} current={item.conversationId === selectedId} />
        ))}
      </CommentsList>
      <CommentsListEnd>{older === undefined ? t("inbox.pagination.end") : <TextLink href={older}>{t("inbox.pagination.older")}</TextLink>}</CommentsListEnd>
    </>
  );
}

export type CommentsSelectionView =
  /** Nothing is selected. */
  | { readonly kind: "none" }
  /** A conversation of this workspace, selected by the address: the Inbox's own answer for it (authorized, RLS-scoped). */
  | { readonly kind: "conversation"; readonly detail: ConversationDetail }
  /** The address names no conversation of this workspace (or one that can't be read): the Inbox's own closed state. */
  | { readonly kind: "closed"; readonly message: React.ReactNode };

/**
 * COMMENTS-INT-03B — the selected conversation, read only. The title is who started it (as the Inbox names an author;
 * the conversation's own name when its first comment was not read). Context: only what the read model carries —
 * platform, paid, content kind, organic or paid, workflow state — and the Inbox's own sentence for what is not known
 * about the post, then a plain way to view it in the Inbox. The thread: the Inbox's review note and reply reason (on
 * the Inbox's conditions), its entries, records and times, without the composer; requests made from Wrenkind with their
 * real state (never optimistic); the Inbox's note when the thread has more members than were read.
 */
function Conversation({ workspaceId, detail }: { readonly workspaceId: string; readonly detail: ConversationDetail }) {
  const platformText = platformName(detail.platform) ?? t("inbox.platform.unknown");
  const entries = threadEntries(detail);
  const now = renderNow();
  const previousOf = previousTimes(entries);
  const parentLabel = parentLabeller(detail, now);
  const anchor = detail.thread.find((item) => item.interactionId === detail.anchorInteractionId);
  const inInbox = workspaceConversationPath(workspaceId, detail.conversationId);
  return (
    <CommentsConversation
      title={anchor !== undefined && anchor.observed ? authorOf(anchor) : t("inbox.conversation.heading")}
      context={
        <>
          <OriginMark platform={detail.platform} name={platformText} showName paid={detail.source === "paid"} paidLabel={t("inbox.source.paid")} />
          <DataTag>{kindOf(detail.contentKind)}</DataTag>
          <DataTag>{t(SOURCE_MESSAGES[detail.source])}</DataTag>
          <StatePill>{t(CONVERSATION_STATE_MESSAGES[detail.workflowState])}</StatePill>
        </>
      }
      contextNote={t("inbox.context.post_unavailable")}
      note={inInbox === undefined ? undefined : <TextLink href={inInbox}>{t("comments.pane.open_in_inbox")}</TextLink>}
    >
      {/* COMMENTS-INT-03B-FIX (L-2): the Inbox's own statements, on the same conditions. Its review note: the read model
          carries no assessment, so the Inbox says so on every conversation — and so does this pane. */}
      <QuietNote>{t("inbox.understanding_pending")}</QuietNote>
      <ThreadHeading id="thread" label={t("inbox.thread.heading")} />
      {/* A reply's verified reason for being unavailable, in the Inbox's words (once per conversation). Where the contract
          offers a reply, or hides it from this member, nothing is said here: this pane neither offers nor implies one. */}
      {detail.reply.kind === "unavailable" ? (
        detail.reply.reason === "platform_unavailable" ? (
          <ReplyUnavailable reason={t(REPLY_REASON_MESSAGES[detail.reply.reason])} />
        ) : (
          <ReplyUnavailable label={t("inbox.reply.unavailable_label")} reason={t(REPLY_REASON_MESSAGES[detail.reply.reason])} />
        )
      ) : null}
      {entries.length === 0 ? (
        <p>{t("comments.pane.thread_empty")}</p>
      ) : (
        <Thread labelledBy="thread">
          {entries.map((entry) =>
            entry.kind === "member" ? (
              <ThreadMemberRecord key={entry.item.interactionId} item={entry.item} platformText={platformText} {...(entry.replyingTo === undefined ? {} : { replyingTo: parentLabel(entry.replyingTo) })} detached={entry.detached === true} timing={{ now, previous: previousOf.get(entry.item.interactionId) }} />
            ) : (
              <ThreadOutbound key={entry.item.intentId}>
                <OutboundRow item={entry.item} {...(entry.replyingTo === undefined ? {} : { replyingTo: parentLabel(entry.replyingTo) })} timing={{ now, previous: previousOf.get(entry.item.intentId) }} />
              </ThreadOutbound>
            ),
          )}
        </Thread>
      )}
      {detail.truncated ? (
        <Notice tone="info" live="off">
          {t("inbox.thread.truncated", { count: String(detail.thread.length) })}
        </Notice>
      ) : null}
    </CommentsConversation>
  );
}

/**
 * The Comments page for a ready (authorized and offered) list. `selection` is what the address selects: nothing, a
 * conversation of this workspace (drawn read only in the pane), or the Inbox's own closed state for the address.
 */
export function CommentsListView({ workspaceId, page, cursor, selection }: { readonly workspaceId: string; readonly page: InboxPage; readonly cursor: string | undefined; readonly selection: CommentsSelectionView }) {
  const selectedId = selection.kind === "conversation" ? selection.detail.conversationId : undefined;
  const listHref = cursor === undefined ? workspaceCommentsPath(workspaceId) : workspaceCommentsPagePath(workspaceId, cursor);
  const inbox = workspaceInboxPath(workspaceId);
  const back =
    selection.kind === "none" || listHref === undefined
      ? undefined
      : selectedId === undefined
        ? { href: listHref, label: t("inbox.back") }
        : // Back to the list at the conversation's own row. It stands for the conversation's anchor (COMMENTS-INT-03B-FIX):
          // where the row is not drawn (one panel), this link takes the focus once the conversation opens.
          { href: `${listHref}#${conversationRowId(selectedId)}`, label: t("inbox.back"), focusKey: COMMENTS_CONVERSATION_ANCHOR };
  return (
    <CommentsWorkspace selected={selection.kind !== "none"}>
      <CommentsHeader
        title={t("inbox.heading")}
        subtitle={t("inbox.ordering")}
        note={
          <>
            {t("comments.pilot.note")} {inbox === undefined ? null : <TextLink href={inbox}>{t("comments.pilot.inbox_link")}</TextLink>}
          </>
        }
      />
      <CommentsAbove>
        <CoverageSummary page={page} open={page.items.length === 0 && page.coverage.length > 0} />
      </CommentsAbove>
      <CommentsSplit
        listKey={listHref ?? workspaceId}
        selected={selectedId}
        list={<ListColumn workspaceId={workspaceId} page={page} cursor={cursor} selectedId={selectedId} />}
        pane={
          <CommentsPane label={t("comments.pane.label")} back={back} content={selection.kind === "conversation" ? "conversation" : "message"}>
            {selection.kind === "none" ? <p>{t("comments.pane.empty")}</p> : selection.kind === "closed" ? selection.message : <Conversation workspaceId={workspaceId} detail={selection.detail} />}
          </CommentsPane>
        }
      />
    </CommentsWorkspace>
  );
}
