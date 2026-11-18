/**
 * COMMENTS-INT-03A — the redesigned Comments route's reads: the SAME Inbox queries (inbox.conversations.list,
 * inbox.conversation.view) through the same pipeline, permission, scope and RLS, then the pilot allowlist. No new
 * command, permission, table or write.
 *
 * Order matters. The Inbox read answers first; only a caller it authorized ("ready") is then told whether the route is
 * offered for that workspace (`not_offered` → the page answers 404). Every other answer — signed out, verification
 * required, workspace not found, not allowed, unavailable — is passed through unchanged, identical for listed and
 * unlisted workspaces.
 */
import { commentsOfferedFor } from "./comments-access";
import type { ConversationViewState, InboxListState } from "./inbox";
import { currentConversation, currentInboxPage } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;

export type CommentsListState = InboxListState | { readonly kind: "not_offered" };

/** The allowlist applied to an Inbox list answer: only "ready" can become "not_offered". */
export function offeredList(state: InboxListState, environment: Environment = process.env): CommentsListState {
  if (state.kind !== "ready") return state;
  return commentsOfferedFor(state.workspaceId, environment) ? state : { kind: "not_offered" };
}

/** The current request's Comments list page (the Inbox page read, then the allowlist). */
export async function currentCommentsPage(workspaceId: unknown, cursor: unknown): Promise<CommentsListState> {
  return offeredList(await currentInboxPage(workspaceId, cursor));
}

export interface CommentsSelection {
  readonly list: CommentsListState;
  /** The selected conversation's own answer; read only when the list was authorized and the route is offered. */
  readonly conversation: ConversationViewState | undefined;
}

/**
 * The list with one conversation selected by its address. The LIST answer is the authority for access: the
 * conversation is read only once the caller is authorized for the workspace and the route is offered, so an
 * unauthorized or unlisted request never reaches the conversation query through this route.
 */
export async function currentCommentsSelection(workspaceId: unknown, conversationId: unknown, cursor: unknown): Promise<CommentsSelection> {
  const list = await currentCommentsPage(workspaceId, cursor);
  if (list.kind !== "ready") return { list, conversation: undefined };
  return { list, conversation: await currentConversation(workspaceId, conversationId) };
}
