import { redirect } from "next/navigation";
import { isUuid } from "@/domain/ids";
import { currentConversation, currentInboxPage, currentReplyDraftScope } from "@/server/inbox/runtime";
import { t } from "@/server/i18n";
import { workspaceInboxPagePath, workspaceInboxPath } from "@/server/routes";
import { InboxWorkspace, StandaloneConversation } from "@/ui/inbox/inbox";
import { TextLink } from "@/ui/primitives/text-link";
import { ClosedState, ConversationView, ListPaneFor, listShows } from "../views";

/** Conversation content is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace › Inbox › Conversation (Step 7A read side; UI-4 presentation; Step 7B-15B layout; IA §8 order: content
 * context first, then the thread). Rendering only reads: one inbox.conversation.view query and one
 * inbox.conversations.list query at the position the link carried — both through the action pipeline
 * (`workspace.read_operational`). The conversation is drawn IN PLACE, inside its own row of the list (no second pane);
 * when its row is not among the ones on screen (another position, or the list could not be read) it is drawn on its
 * own, above the list. Every comment and reply is shown AS TEXT exactly as retained, with its platform state, its
 * times, every earlier retained version of its text (Model §13) and the persisted observed facts about its current text,
 * labelled as facts (S19). The one action is the existing public reply, under the comment it answers: ONE composer per
 * render, placed by `?reply=` (a canonical id of an eligible comment, or ignored). Below 768px only the conversation
 * is on screen, with a way back that keeps the list position.
 */
export default async function WorkspaceConversationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly conversationId: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId, conversationId } = await params;
  const query = searchParams === undefined ? {} : await searchParams;
  const raw = query["cursor"];
  const cursor = typeof raw === "string" && raw !== "" ? raw : undefined;
  const reply = query["reply"];
  const replyTo = isUuid(reply) ? reply : undefined;
  // Step 7B-15F: the reply-draft scope (an opaque digest of the verified person) is read beside the two queries; without
  // it the composer simply keeps no draft.
  const [state, list, draftScope] = await Promise.all([currentConversation(workspaceId, conversationId), currentInboxPage(workspaceId, cursor), currentReplyDraftScope()]);
  if (state.kind === "signed_out") redirect("/sign-in");
  const back = cursor === undefined ? workspaceInboxPath(workspaceId) : workspaceInboxPagePath(workspaceId, cursor);
  const conversation =
    state.kind === "ready" ? (
      <ConversationView workspaceId={state.workspaceId} detail={state.detail} cursor={cursor} {...(replyTo === undefined ? {} : { replyTo })} {...(draftScope === undefined ? {} : { draftScope })} />
    ) : (
      <div id="conversation">
        {back === undefined ? null : <TextLink href={back}>{t("inbox.back")}</TextLink>}
        <ClosedState kind={state.kind} />
      </div>
    );
  // In place when its row is on screen; on its own otherwise (never hidden because the list moved on).
  const inList = listShows(list, conversationId);

  return (
    <main>
      <InboxWorkspace selected skipToConversation={{ href: "#conversation", label: t("inbox.skip_to_conversation") }}>
        {inList ? (
          <ListPaneFor state={list} cursor={cursor} selectedId={conversationId} expanded={conversation} />
        ) : (
          <>
            <StandaloneConversation>{conversation}</StandaloneConversation>
            <ListPaneFor state={list} cursor={cursor} selectedId={conversationId} />
          </>
        )}
      </InboxWorkspace>
    </main>
  );
}
