import { redirect } from "next/navigation";
import { currentConversation, currentInboxPage } from "@/server/inbox/runtime";
import { t } from "@/server/i18n";
import { workspaceInboxPagePath, workspaceInboxPath } from "@/server/routes";
import { InboxPanes } from "@/ui/inbox/inbox";
import { TextLink } from "@/ui/primitives/text-link";
import { ClosedState, ConversationView, ListPaneFor } from "../views";

/** Conversation content is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace › Inbox › Conversation (Step 7A read side; UI-4 presentation; IA §12 detail order: content context first,
 * then the thread). Rendering only reads: one inbox.conversation.view query and, for the list beside it, one
 * inbox.conversations.list query at the position the link carried — both through the action pipeline
 * (`workspace.read_operational`). Every comment and reply is shown AS TEXT exactly as retained, with its platform state
 * (hidden / no longer on the platform), its times, every earlier retained version of its text (Model §13: versions are
 * kept, never overwritten) and the persisted observed facts about its current text, labelled as facts — never as
 * labels, priority or an interpretation (S19). Your account's replies are marked as yours. No action exists on this
 * page. Below 1280px only the conversation is on screen, with a way back that keeps the list position.
 */
export default async function WorkspaceConversationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly conversationId: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId, conversationId } = await params;
  const raw = searchParams === undefined ? undefined : (await searchParams)["cursor"];
  const cursor = typeof raw === "string" && raw !== "" ? raw : undefined;
  const [state, list] = await Promise.all([currentConversation(workspaceId, conversationId), currentInboxPage(workspaceId, cursor)]);
  if (state.kind === "signed_out") redirect("/sign-in");
  const back = cursor === undefined ? workspaceInboxPath(workspaceId) : workspaceInboxPagePath(workspaceId, cursor);

  return (
    <main>
      <InboxPanes
        selected
        skipToDetail={{ href: "#conversation", label: t("inbox.skip_to_conversation") }}
        list={<ListPaneFor state={list} cursor={cursor} selectedId={conversationId} />}
        detail={
          state.kind === "ready" ? (
            <ConversationView workspaceId={state.workspaceId} detail={state.detail} cursor={cursor} />
          ) : (
            <div id="conversation">
              {back === undefined ? null : <TextLink href={back}>{t("inbox.back")}</TextLink>}
              <ClosedState kind={state.kind} />
            </div>
          )
        }
      />
    </main>
  );
}
