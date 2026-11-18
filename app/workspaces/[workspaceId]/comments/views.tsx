/**
 * COMMENTS-INT-03A — the redesigned Comments list drawn from the Inbox's own view model (InboxPage: the result of
 * inbox.conversations.list). No read, no action, no new field: every row shows exactly what the Inbox row shows —
 * platform, author, excerpt, latest activity, content kind, workflow state, what was read and what the platform hid or
 * removed — in the same order and with the same positions. What the read model does not carry (an account's name, a
 * post's caption, a total count) is not drawn.
 */
import { cache } from "react";
import { t } from "@/server/i18n";
import { AUTHOR_MESSAGES, CONTENT_KIND_FALLBACK, CONTENT_KIND_MESSAGES, CONVERSATION_STATE_MESSAGES, displayTime, platformName, when, type InboxConversationItem, type InboxPage } from "@/server/inbox/inbox";
import { conversationRowId, workspaceCommentsConversationPath, workspaceCommentsPagePath, workspaceCommentsPath, workspaceConversationPath, workspaceInboxPath } from "@/server/routes";
import { CommentsAbove, CommentsHeader, CommentsList, CommentsListEnd, CommentsListMessage, CommentsPane, CommentsRow, CommentsSplit, CommentsWorkspace } from "@/ui/inbox/comments";
import { DataTag } from "@/ui/primitives/data-tag";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { StatePill } from "@/ui/primitives/state-pill";
import { TextLink } from "@/ui/primitives/text-link";
// The Inbox's read-only pieces only (audit M-1): never ../inbox/views, which carries the reply composer and its action.
import { CoverageSummary, shortTime } from "../inbox/read-views";

const renderNow = cache((): Date => new Date());

const kindOf = (contentKind: string): string => t(CONTENT_KIND_MESSAGES[contentKind] ?? CONTENT_KIND_FALLBACK);

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
  /** A conversation of this workspace is selected by the address; this step does not draw it. */
  | { readonly kind: "conversation"; readonly conversationId: string }
  /** The address names no conversation of this workspace (or one that can't be read): the Inbox's own closed state. */
  | { readonly kind: "closed"; readonly message: React.ReactNode };

/**
 * The Comments page for a ready (authorized and offered) list. `selection` is what the address selects; the
 * conversation area is a placeholder in this step — it says so and points to the Inbox, where the conversation is read.
 */
export function CommentsListView({ workspaceId, page, cursor, selection }: { readonly workspaceId: string; readonly page: InboxPage; readonly cursor: string | undefined; readonly selection: CommentsSelectionView }) {
  const selectedId = selection.kind === "conversation" ? selection.conversationId : undefined;
  const listHref = cursor === undefined ? workspaceCommentsPath(workspaceId) : workspaceCommentsPagePath(workspaceId, cursor);
  const inbox = workspaceInboxPath(workspaceId);
  const back =
    selection.kind === "none" || listHref === undefined
      ? undefined
      : selectedId === undefined
        ? { href: listHref, label: t("inbox.back") }
        : { href: `${listHref}#${conversationRowId(selectedId)}`, label: t("inbox.back"), focusKey: conversationRowId(selectedId) };
  const inInbox = selectedId === undefined ? undefined : workspaceConversationPath(workspaceId, selectedId);
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
        list={<ListColumn workspaceId={workspaceId} page={page} cursor={cursor} selectedId={selectedId} />}
        pane={
          <CommentsPane label={t("comments.pane.label")} back={back}>
            {selection.kind === "none" ? (
              <p>{t("comments.pane.empty")}</p>
            ) : selection.kind === "closed" ? (
              selection.message
            ) : (
              <>
                <p>{t("comments.pane.pending")}</p>
                {inInbox === undefined ? null : (
                  <p>
                    <TextLink href={inInbox}>{t("comments.pane.open_in_inbox")}</TextLink>
                  </p>
                )}
              </>
            )}
          </CommentsPane>
        }
      />
    </CommentsWorkspace>
  );
}
