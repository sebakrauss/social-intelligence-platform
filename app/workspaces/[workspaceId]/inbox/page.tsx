import { redirect } from "next/navigation";
import { currentInboxPage } from "@/server/inbox/runtime";
import { t } from "@/server/i18n";
import { InboxPanes } from "@/ui/inbox/inbox";
import { ClosedState, DetailEmpty, InboxListView } from "./views";

/** Inbox content is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace › Inbox (Step 7A read side; UI-4 presentation; IA §12; UX §9). Rendering only reads: one
 * inbox.conversations.list query through the action pipeline (`workspace.read_operational`: every non-guest role; a
 * client guest sees the access message only). The list unit is the conversation (IA-01). Each row is one link showing
 * where it comes from, who wrote the first comment, an excerpt of it AS TEXT (links inert), when it last moved and what
 * is known about what was read. No action exists on this page: no reply, hide, delete, block, assignment, resolution
 * or "Needs review" (steps 7B and 8). Priority and labels are not available yet, which the page says. From 1280px the
 * list sits beside an empty detail pane; older pages follow a server-issued position only.
 *
 * "What has been read" is the most recent coverage record per managed account and kind, with its as-of time (TA
 * §17.4, S11): an empty list says whether nothing was read or nothing was found.
 */
export default async function WorkspaceInboxPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId } = await params;
  const raw = (await searchParams)["cursor"];
  const cursor = typeof raw === "string" && raw !== "" ? raw : undefined;
  const state = await currentInboxPage(workspaceId, cursor);
  if (state.kind === "signed_out") redirect("/sign-in");

  return (
    <main>
      <InboxPanes
        selected={false}
        list={state.kind === "ready" ? <InboxListView workspaceId={state.workspaceId} page={state.page} cursor={cursor} /> : <ClosedState kind={state.kind} />}
        detail={state.kind === "ready" && state.page.items.length > 0 ? <DetailEmpty /> : null}
      />
      <span className="wk-sr-only">{t("inbox.heading")}</span>
    </main>
  );
}
