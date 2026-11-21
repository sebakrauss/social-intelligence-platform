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
import { AUTHOR_MESSAGES, CONVERSATION_STATE_MESSAGES, displayTime, OFFERED_RESOLUTIONS, platformName, REPLY_REASON_MESSAGES, RESOLUTION_MESSAGES, SOURCE_MESSAGES, when, type ConversationDetail, type InboxConversationItem, type InboxPage } from "@/server/inbox/inbox";
import type { MessageKey } from "@/domain/i18n/message-keys";
import { COMMENTS_CONVERSATION_ANCHOR, COMMENTS_NEXT_ANCHOR, COMMENTS_PREVIOUS_ANCHOR, conversationRowId, workspaceCommentsConversationPath, workspaceCommentsViewPath, workspaceConversationPath, workspaceInboxPath, type CommentsView } from "@/server/routes";
import { CommentsAbove, CommentsConversation, CommentsConversationNav, CommentsHeader, CommentsList, CommentsListEnd, CommentsListMessage, CommentsPane, CommentsRow, CommentsSplit, CommentsWorkspace } from "@/ui/inbox/comments";
import { QuietNote, ReplyUnavailable, Thread, ThreadHeading, ThreadOutbound } from "@/ui/inbox/inbox";
import { DataTag } from "@/ui/primitives/data-tag";
import { Notice } from "@/ui/primitives/notice";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { StatePill } from "@/ui/primitives/state-pill";
import { TextLink } from "@/ui/primitives/text-link";
import { WorkflowControl, type WorkflowControlLabels } from "@/ui/inbox/workflow-control";
import { changeWorkflowStateAction } from "@/server/inbox/workflow-actions";
import type { WorkflowAction } from "@/server/inbox/workflow-state";
// The Inbox's read-only pieces only (audit M-1): never ../inbox/views, which carries the reply composer and its action.
import { authorOf, CoverageSummary, kindOf, OutboundRow, parentLabeller, previousTimes, renderNow, shortTime, threadEntries, ThreadMemberRecord } from "../inbox/read-views";

/**
 * COMMENTS-INT-03C-2 — the views backed by real data, each the server's own list (inbox.conversations.list narrowed to
 * one persisted workflow state BEFORE the page is cut, or not narrowed: All conversations). Their names, the list each
 * one is, and what an empty one says.
 */
const VIEW_NAMES: { readonly [V in CommentsView]: MessageKey } = { open: "comments.views.open", done: "comments.views.done", all: "comments.views.all" };
const LIST_NAMES: { readonly [V in CommentsView]: MessageKey } = { open: "comments.list.open", done: "comments.list.done", all: "comments.list.all" };
const EMPTY_IN_VIEW: { readonly [V in CommentsView]: MessageKey } = { open: "comments.empty.open", done: "comments.empty.done", all: "inbox.empty.no_conversations" };

function workflowLabels(): WorkflowControlLabels {
  return {
    markDone: t("comments.workflow.mark_done"),
    marking: t("comments.workflow.marking"),
    reopen: t("comments.workflow.reopen"),
    reopening: t("comments.workflow.reopening"),
    resolution: t("comments.workflow.resolution"),
    noResolution: t("comments.workflow.no_resolution"),
    undo: t("comments.workflow.undo"),
    undoing: t("comments.workflow.undoing"),
    outcomes: {
      savedDone: t("comments.workflow.saved_done"),
      savedReopened: t("comments.workflow.saved_reopened"),
      unchanged: t("comments.workflow.unchanged"),
      conflict: t("comments.workflow.conflict"),
      notPermitted: t("comments.workflow.not_permitted"),
      notFound: t("comments.workflow.not_found"),
      invalid: t("comments.workflow.invalid"),
      unavailable: t("comments.workflow.unavailable"),
      signedOut: t("comments.workflow.signed_out"),
    },
  };
}

/** One row: the same facts, wording and conditions as the Inbox row (app/…/inbox/views.tsx), in the Direction C shape. */
function Row({ workspaceId, view, item, cursor, now, current }: { readonly workspaceId: string; readonly view: CommentsView; readonly item: InboxConversationItem; readonly cursor: string | undefined; readonly now: Date; readonly current: boolean }) {
  const href = workspaceCommentsConversationPath(workspaceId, item.conversationId, cursor, COMMENTS_CONVERSATION_ANCHOR, view);
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

function ListColumn({ workspaceId, view, page, cursor, selectedId }: { readonly workspaceId: string; readonly view: CommentsView; readonly page: InboxPage; readonly cursor: string | undefined; readonly selectedId: string | undefined }) {
  // The next page of THIS view, at the position the server issued for it (never another view's).
  const older = page.nextCursor === null ? undefined : workspaceCommentsViewPath(workspaceId, view, page.nextCursor);
  if (page.items.length === 0) {
    // An empty page says only what THIS answer knows: a later page that the list ran out on means no OLDER conversations
    // (earlier pages may well have had some); only the view's first page, empty, says that none were found. WF-2B: the
    // queue chooses a page in one bounded read, so a page is never partial.
    if (cursor !== undefined) return <CommentsListMessage title={t(LIST_NAMES[view])}>{t("inbox.pagination.end")}</CommentsListMessage>;
    return <CommentsListMessage title={t(LIST_NAMES[view])}>{page.emptyReason === "nothing_read_yet" ? t("inbox.empty.nothing_read") : t(EMPTY_IN_VIEW[view])}</CommentsListMessage>;
  }
  const now = renderNow();
  return (
    <>
      <CommentsList label={t(LIST_NAMES[view])}>
        {page.items.map((item) => (
          <Row key={item.conversationId} workspaceId={workspaceId} view={view} item={item} cursor={cursor} now={now} current={item.conversationId === selectedId} />
        ))}
      </CommentsList>
      <CommentsListEnd>
        {older === undefined ? t("inbox.pagination.end") : <TextLink href={older}>{t("inbox.pagination.older")}</TextLink>}
      </CommentsListEnd>
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
/**
 * COMMENTS-INT-03C-1 — the header's navigation: this conversation's place among the rows LOADED in the list, and
 * Previous / Next among them. Undefined when the conversation is not on the loaded page (its place is not known, and
 * nothing outside the page is read to find it). "n of N on this page" whenever the list has other pages (as the Inbox
 * says it). Which control keeps the focus after a move is the navigation's own rule (ui/inbox/comments.tsx).
 */
function navigationFor(workspaceId: string, view: CommentsView, page: InboxPage, cursor: string | undefined, conversationId: string): React.ReactNode {
  const index = page.items.findIndex((item) => item.conversationId === conversationId);
  if (index < 0 || page.items.length < 2) return undefined;
  // COMMENTS-INT-03C-2: the loaded page is THIS view's page; a move stays in the view (and at its position).
  const hrefAt = (at: number, anchor: typeof COMMENTS_PREVIOUS_ANCHOR | typeof COMMENTS_NEXT_ANCHOR): string | undefined => {
    const item = page.items[at];
    return item === undefined ? undefined : workspaceCommentsConversationPath(workspaceId, item.conversationId, cursor, anchor, view);
  };
  const previous = hrefAt(index - 1, COMMENTS_PREVIOUS_ANCHOR);
  const next = hrefAt(index + 1, COMMENTS_NEXT_ANCHOR);
  const paged = cursor !== undefined || page.nextCursor !== null;
  return (
    <CommentsConversationNav
      label={t("inbox.nav.label")}
      position={t(paged ? "inbox.nav.position_page" : "inbox.nav.position", { index: String(index + 1), count: String(page.items.length) })}
      previous={{ label: t("inbox.nav.previous"), href: previous }}
      next={{ label: t("inbox.nav.next"), href: next }}
      anchors={{ previous: COMMENTS_PREVIOUS_ANCHOR, next: COMMENTS_NEXT_ANCHOR }}
    />
  );
}

function Conversation({ workspaceId, view, detail, nav, workflowAction }: { readonly workspaceId: string; readonly view: CommentsView; readonly detail: ConversationDetail; readonly nav: React.ReactNode; readonly workflowAction: WorkflowAction }) {
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
      origin={<OriginMark platform={detail.platform} name={platformText} paid={detail.source === "paid"} paidLabel={t("inbox.source.paid")} />}
      state={
        <>
          <StatePill>{t(CONVERSATION_STATE_MESSAGES[detail.workflowState])}</StatePill>
          {detail.workflow?.resolution === undefined || detail.workflow.resolution === null ? null : <DataTag>{t(RESOLUTION_MESSAGES[detail.workflow.resolution])}</DataTag>}
        </>
      }
      context={
        <>
          <DataTag>{platformText}</DataTag>
          <DataTag>{kindOf(detail.contentKind)}</DataTag>
          <DataTag>{t(SOURCE_MESSAGES[detail.source])}</DataTag>
        </>
      }
      contextNote={t("inbox.context.post_unavailable")}
      manage={
        <>
          {/* WORKFLOW-WF-2B: Mark done / Reopen for a member with workflow.internal; nothing at all for anyone else. */}
          {detail.workflow === undefined || detail.workflow === null || !detail.workflow.canChange ? null : (
            <WorkflowControl
              action={workflowAction}
              fields={{ workspaceId, conversationId: detail.conversationId }}
              current={{ state: detail.workflow.state, version: detail.workflow.version }}
              resolutions={OFFERED_RESOLUTIONS.map((value) => ({ value, label: t(RESOLUTION_MESSAGES[value]) }))}
              labels={workflowLabels()}
            />
          )}
          {inInbox === undefined ? null : <TextLink href={inInbox}>{t("comments.pane.open_in_inbox")}</TextLink>}
        </>
      }
      nav={nav}
    >
      {/* COMMENTS-INT-03C-2: a conversation opened by its address in a view it does not belong to (its persisted state is
          another, or not known) is still shown — it is the caller's — and the pane says so plainly, with its real state;
          the list beside it is the view's own, so no row is marked and there is no Previous / Next. */}
      {view !== "all" && detail.workflowState !== view ? <QuietNote>{t("comments.pane.not_in_view", { view: t(VIEW_NAMES[view]), state: t(CONVERSATION_STATE_MESSAGES[detail.workflowState]) })}</QuietNote> : null}
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
 *
 * `workflowAction` (WORKFLOW-WF-2D): the Server Action behind Mark done / Reopen. The real pages never pass it — it is
 * the real changeWorkflowStateAction. Only the development-only harness (/dev/ui-reference/comments-workflow, a 404
 * outside `next dev`) passes its local simulation, exactly as the reply harness does for ConversationView's replyAction.
 */
export function CommentsListView({ workspaceId, view, page, cursor, selection, workflowAction = changeWorkflowStateAction }: { readonly workspaceId: string; readonly view: CommentsView; readonly page: InboxPage; readonly cursor: string | undefined; readonly selection: CommentsSelectionView; readonly workflowAction?: WorkflowAction }) {
  const selectedId = selection.kind === "conversation" ? selection.detail.conversationId : undefined;
  // The list as it is drawn: this view, at this position (COMMENTS-INT-03C-2: the view is part of which list it is).
  const listHref = workspaceCommentsViewPath(workspaceId, view, cursor);
  const inbox = workspaceInboxPath(workspaceId);
  const backLabel = t(LIST_NAMES[view]);
  const back =
    selection.kind === "none" || listHref === undefined
      ? undefined
      : selectedId === undefined
        ? { href: listHref, label: backLabel }
        : // Back to the list at the conversation's own row. It stands for the conversation's anchor (COMMENTS-INT-03B-FIX):
          // where the row is not drawn (one panel), this link takes the focus once the conversation opens.
          { href: `${listHref}#${conversationRowId(selectedId)}`, label: backLabel, focusKey: COMMENTS_CONVERSATION_ANCHOR };
  // COMMENTS-INT-03C-2 (M-1): the views themselves are the shell's (the workspace sidebar, or its picker when narrow).
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
        list={<ListColumn workspaceId={workspaceId} view={view} page={page} cursor={cursor} selectedId={selectedId} />}
        pane={
          <CommentsPane label={t("comments.pane.label")} back={back} content={selection.kind === "conversation" ? "conversation" : "message"}>
            {selection.kind === "none" ? <p>{t("comments.pane.empty")}</p> : selection.kind === "closed" ? selection.message : <Conversation workspaceId={workspaceId} view={view} detail={selection.detail} nav={navigationFor(workspaceId, view, page, cursor, selection.detail.conversationId)} workflowAction={workflowAction} />}
          </CommentsPane>
        }
      />
    </CommentsWorkspace>
  );
}
