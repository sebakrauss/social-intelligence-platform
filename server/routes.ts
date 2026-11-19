/**
 * Fixed internal paths built from validated identifiers only (Step 7G-F4). Nothing here takes a browser-chosen
 * destination: a value that isn't a canonical UUID yields no path at all.
 */
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";

/** Workspace Settings › Connections (IA §18: Owner/Admin). */
export function workspaceConnectionsPath(workspaceId: WorkspaceId): string;
export function workspaceConnectionsPath(workspaceId: unknown): string | undefined;
export function workspaceConnectionsPath(workspaceId: unknown): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  return id === undefined ? undefined : `/workspaces/${id}/settings/connections`;
}

/** Workspace › Inbox (Step 7A; IA §18: every non-guest role, read). */
export function workspaceInboxPath(workspaceId: WorkspaceId): string;
export function workspaceInboxPath(workspaceId: unknown): string | undefined;
export function workspaceInboxPath(workspaceId: unknown): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  return id === undefined ? undefined : `/workspaces/${id}/inbox`;
}

/** The DOM id of a conversation's row in the list (UI-4): the conversation page's fragment target. */
export function conversationRowId(conversationId: string): string {
  return `row-${conversationId}`;
}

/**
 * Workspace › Inbox › one conversation (Step 7A). Both ids must be canonical UUIDs or there is no path. With a list
 * position (UI-4), the page re-renders the list at that position and the fragment brings the row into view; the
 * cursor is the opaque, server-issued string.
 */
export function workspaceConversationPath(workspaceId: unknown, conversationId: unknown, cursor?: string): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  if (id === undefined || !isUuid(conversationId)) return undefined;
  const position = cursor === undefined || cursor === "" ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return `/workspaces/${id}/inbox/${conversationId}${position}#${conversationRowId(conversationId)}`;
}

/** The Inbox page with an older-conversations position (Step 7A); the cursor is an opaque, server-issued string. */
export function workspaceInboxPagePath(workspaceId: unknown, cursor: string): string | undefined {
  const base = workspaceInboxPath(workspaceId);
  return base === undefined ? undefined : `${base}?cursor=${encodeURIComponent(cursor)}`;
}

/** The DOM id of one comment or reply in the open conversation (Step 7B-15B): the fragment target of "reply here". */
export function threadMemberId(memberId: string): string {
  return `member-${memberId}`;
}

/**
 * The open conversation with the ONE reply composer under a chosen comment (Step 7B-15B). Navigation only: it selects
 * where the composer is drawn, never what may be replied to — the page re-checks eligibility and the server re-checks
 * everything at request time. All three ids must be canonical UUIDs or there is no path.
 */
export function workspaceConversationReplyPath(workspaceId: unknown, conversationId: unknown, memberId: unknown, cursor?: string): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  if (id === undefined || !isUuid(conversationId) || !isUuid(memberId)) return undefined;
  const position = cursor === undefined || cursor === "" ? "" : `cursor=${encodeURIComponent(cursor)}&`;
  return `/workspaces/${id}/inbox/${conversationId}?${position}reply=${memberId}#${threadMemberId(memberId)}`;
}

/**
 * Workspace › Comments (COMMENTS-INT-03A): the redesigned list piloted beside the Inbox for allowlisted workspaces
 * only. The path grants nothing — the server authorizes the workspace and then checks the allowlist on every request.
 */
export function workspaceCommentsPath(workspaceId: unknown): string | undefined {
  const id = parseWorkspaceId(workspaceId);
  return id === undefined ? undefined : `/workspaces/${id}/comments`;
}

/** The Comments list at an older-conversations position; the cursor is the opaque, server-issued string. */
export function workspaceCommentsPagePath(workspaceId: unknown, cursor: string): string | undefined {
  const base = workspaceCommentsPath(workspaceId);
  return base === undefined ? undefined : `${base}?cursor=${encodeURIComponent(cursor)}`;
}

/**
 * COMMENTS-INT-03B-FIX (M-1): the Comments conversation area's anchor — what a link to a conversation goes to. Opening
 * one lands at its start (its header and the first comments; on one panel, its way back too), whatever was scrolled
 * before. Never the row: beside a conversation the row sits in the list's own (sticky) scroll, or is not drawn at all
 * on one panel, so bringing it into view scrolled the page to an arbitrary place (or not at all).
 */
export const COMMENTS_CONVERSATION_ANCHOR = "conversation";
/**
 * COMMENTS-INT-03C-1: where Previous / Next lead — the same place as the conversation's anchor (its start), under
 * their own names, so the control used keeps the keyboard focus after the move (the in-app link hands the focus to
 * the link standing for the anchor it went to).
 */
export const COMMENTS_PREVIOUS_ANCHOR = "conversation-previous";
export const COMMENTS_NEXT_ANCHOR = "conversation-next";
export type CommentsConversationAnchor = typeof COMMENTS_CONVERSATION_ANCHOR | typeof COMMENTS_PREVIOUS_ANCHOR | typeof COMMENTS_NEXT_ANCHOR;

/** Comments with one conversation selected by its address (same ids and cursor as the Inbox; it opens at its start). */
export function workspaceCommentsConversationPath(workspaceId: unknown, conversationId: unknown, cursor?: string, anchor: CommentsConversationAnchor = COMMENTS_CONVERSATION_ANCHOR): string | undefined {
  const base = workspaceCommentsPath(workspaceId);
  if (base === undefined || !isUuid(conversationId)) return undefined;
  const position = cursor === undefined || cursor === "" ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return `${base}/${conversationId}${position}#${anchor}`;
}
