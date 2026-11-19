import { notFound, redirect } from "next/navigation";
import { currentCommentsSelection } from "@/server/inbox/comments";
import { ClosedState } from "../../inbox/read-views";
import { CommentsListView, type CommentsSelectionView } from "../views";

export const dynamic = "force-dynamic";

/**
 * COMMENTS-INT-03A — Comments with one conversation selected by its address. Access is decided by the LIST answer:
 * authorized by the Inbox read, then offered by the server's allowlist — otherwise the Inbox's own closed state, or
 * 404. Only then is the conversation read, with the Inbox's own query (inbox.conversation.view: the same pipeline,
 * permission and RLS). COMMENTS-INT-03B: its answer is drawn read only in the pane; any other answer — another
 * workspace's or an unknown conversation, not allowed, unavailable — is the Inbox's own closed state.
 */
export default async function WorkspaceCommentsConversationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly conversationId: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId, conversationId } = await params;
  const raw = (searchParams === undefined ? {} : await searchParams)["cursor"];
  const cursor = typeof raw === "string" && raw !== "" ? raw : undefined;
  const { list, conversation } = await currentCommentsSelection(workspaceId, conversationId, cursor);
  if (list.kind === "signed_out") redirect("/sign-in");
  if (list.kind === "not_offered") notFound();
  if (list.kind !== "ready") return <main><ClosedState kind={list.kind} /></main>;
  if (conversation?.kind === "signed_out") redirect("/sign-in");

  // COMMENTS-INT-03B (defence in depth; RLS and the query already scope it): an answer is drawn only for the workspace
  // the list authorized and the conversation the address names — anything else is the Inbox's own "not found".
  const selection: CommentsSelectionView =
    conversation === undefined
      ? { kind: "closed", message: <ClosedState kind="unavailable" /> }
      : conversation.kind === "ready"
        ? conversation.workspaceId === list.workspaceId && conversation.detail.conversationId === conversationId
          ? { kind: "conversation", detail: conversation.detail }
          : { kind: "closed", message: <ClosedState kind="conversation_not_found" /> }
        : { kind: "closed", message: <ClosedState kind={conversation.kind} /> };

  return (
    <main>
      <CommentsListView workspaceId={list.workspaceId} page={list.page} cursor={cursor} selection={selection} />
    </main>
  );
}
