import { notFound, redirect } from "next/navigation";
import { commentsPosition, currentCommentsPage } from "@/server/inbox/comments";
import { COMMENTS_VIEW_PARAM, parseCommentsView } from "@/server/routes";
import { ClosedState } from "../inbox/read-views";
import { CommentsListView } from "./views";

export const dynamic = "force-dynamic";

/**
 * COMMENTS-INT-03A — Workspace › Comments: the redesigned list, piloted beside the Inbox. The Inbox read authorizes
 * the caller first; a workspace that is not on the server's allowlist then answers 404 (as if the route did not
 * exist). Every other closed state is the Inbox's own, identical whether or not the workspace is listed.
 * COMMENTS-INT-03C-2: the address names the view (Open by default; `?view=done`, `?view=all`); anything else is Open.
 */
export default async function WorkspaceCommentsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const view = parseCommentsView(query[COMMENTS_VIEW_PARAM]);
  // Only a position issued for this view (COMMENTS-INT-03C-2); otherwise the view's first page, and no link carries it.
  const cursor = commentsPosition(view, query["cursor"]);
  const state = await currentCommentsPage(workspaceId, cursor, view);
  if (state.kind === "signed_out") redirect("/sign-in");
  if (state.kind === "not_offered") notFound();

  return <main>{state.kind === "ready" ? <CommentsListView workspaceId={state.workspaceId} view={view} page={state.page} cursor={cursor} selection={{ kind: "none" }} /> : <ClosedState kind={state.kind} />}</main>;
}
