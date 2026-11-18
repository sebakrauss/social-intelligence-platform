import { notFound, redirect } from "next/navigation";
import { currentCommentsSelection } from "@/server/inbox/comments";
import { ClosedState } from "../../inbox/read-views";
import { CommentsListView, type CommentsSelectionView } from "../views";

export const dynamic = "force-dynamic";

/**
 * COMMENTS-INT-03A — Comments with one conversation selected by its address (the selection the next step's
 * conversation panel will read). Access is decided by the LIST answer: authorized by the Inbox read, then offered by
 * the server's allowlist — otherwise the Inbox's own closed state, or 404. The conversation itself is read with the
 * Inbox's query only to tell "a conversation of this workspace" from "not found"; this step draws no part of it.
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

  const selection: CommentsSelectionView =
    conversation === undefined
      ? { kind: "closed", message: <ClosedState kind="unavailable" /> }
      : conversation.kind === "ready"
        ? { kind: "conversation", conversationId: conversation.detail.conversationId }
        : { kind: "closed", message: <ClosedState kind={conversation.kind} /> };

  return (
    <main>
      <CommentsListView workspaceId={list.workspaceId} page={list.page} cursor={cursor} selection={selection} />
    </main>
  );
}
