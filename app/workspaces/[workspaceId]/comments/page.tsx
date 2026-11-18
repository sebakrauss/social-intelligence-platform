import { notFound, redirect } from "next/navigation";
import { currentCommentsPage } from "@/server/inbox/comments";
import { ClosedState } from "../inbox/read-views";
import { CommentsListView } from "./views";

export const dynamic = "force-dynamic";

/**
 * COMMENTS-INT-03A — Workspace › Comments: the redesigned list, piloted beside the Inbox. The Inbox read authorizes
 * the caller first; a workspace that is not on the server's allowlist then answers 404 (as if the route did not
 * exist). Every other closed state is the Inbox's own, identical whether or not the workspace is listed.
 */
export default async function WorkspaceCommentsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId } = await params;
  const raw = (await searchParams)["cursor"];
  const cursor = typeof raw === "string" && raw !== "" ? raw : undefined;
  const state = await currentCommentsPage(workspaceId, cursor);
  if (state.kind === "signed_out") redirect("/sign-in");
  if (state.kind === "not_offered") notFound();

  return <main>{state.kind === "ready" ? <CommentsListView workspaceId={state.workspaceId} page={state.page} cursor={cursor} selection={{ kind: "none" }} /> : <ClosedState kind={state.kind} />}</main>;
}
