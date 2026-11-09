import { redirect } from "next/navigation";
import {
  AUTHOR_MESSAGES,
  CONTENT_KIND_FALLBACK,
  CONTENT_KIND_MESSAGES,
  CONVERSATION_STATE_MESSAGES,
  FACT_FALLBACK,
  FACT_MESSAGES,
  PRESENCE_MESSAGES,
  SOURCE_MESSAGES,
  platformName,
  when,
  type ConversationDetail,
  type ThreadItem,
} from "@/server/inbox/inbox";
import { currentConversation } from "@/server/inbox/runtime";
import { t } from "@/server/i18n";
import { workspaceInboxPath } from "@/server/routes";

/** Conversation content is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace › Inbox › Conversation (Step 7A; IA §12 detail order: content context first, then the thread). Rendering
 * only reads: one inbox.conversation.view query through the action pipeline (`workspace.read_operational`). Every
 * comment and reply is shown AS TEXT exactly as retained, with its platform state (hidden / no longer on the platform),
 * its times, every earlier retained version of its text (Model §13: versions are kept, never overwritten) and the
 * persisted observed facts about its current text, labelled as facts — never as labels, priority or an interpretation
 * (S19). Your account's replies are marked as yours. No action exists on this page.
 */
export default async function WorkspaceConversationPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly conversationId: string }>;
}) {
  const { workspaceId, conversationId } = await params;
  const state = await currentConversation(workspaceId, conversationId);
  if (state.kind === "signed_out") redirect("/sign-in");
  const back = workspaceInboxPath(workspaceId);

  return (
    <main>
      {back === undefined ? null : <a href={back}>{t("inbox.back")}</a>}
      <h1>{t("inbox.conversation.heading")}</h1>

      {state.kind === "verification_required" ? <p role="status">{t("auth.status.verification_required")}</p> : null}
      {state.kind === "workspace_not_found" ? <p role="status">{t("inbox.workspace_not_found")}</p> : null}
      {state.kind === "conversation_not_found" ? <p role="status">{t("inbox.conversation.not_found")}</p> : null}
      {state.kind === "not_allowed" ? <p role="status">{t("inbox.not_allowed")}</p> : null}
      {state.kind === "unavailable" ? <p role="status">{t("inbox.unavailable")}</p> : null}

      {state.kind === "ready" ? <Detail detail={state.detail} /> : null}
    </main>
  );
}

function Detail({ detail }: { readonly detail: ConversationDetail }) {
  const platform = platformName(detail.platform);
  const kind = t(detail.contentKind === null ? CONTENT_KIND_FALLBACK : (CONTENT_KIND_MESSAGES[detail.contentKind] ?? CONTENT_KIND_FALLBACK));
  const source = t(SOURCE_MESSAGES[detail.source]);
  return (
    <>
      <p>{platform === undefined ? t("inbox.conversation.context.unknown_platform", { kind, label: source }) : t("inbox.conversation.context", { platform, kind, label: source })}</p>
      <p>{t(CONVERSATION_STATE_MESSAGES[detail.workflowState])}</p>
      <p>{t("inbox.understanding_pending")}</p>
      <section aria-labelledby="thread">
        <h2 id="thread">{t("inbox.thread.heading")}</h2>
        {detail.truncated ? <p role="status">{t("inbox.thread.truncated", { count: String(detail.thread.length) })}</p> : null}
        <ol>
          {detail.thread.map((item) => (
            <Member key={item.interactionId} item={item} platform={platform} />
          ))}
        </ol>
      </section>
    </>
  );
}

function Member({ item, platform }: { readonly item: ThreadItem; readonly platform: string | undefined }) {
  const platformText = platform ?? t("inbox.platform.unknown");
  return (
    <li>
      <p>
        {t(item.kind === "reply" ? "inbox.thread.reply" : "inbox.thread.comment")} · {t(AUTHOR_MESSAGES[item.author])}
        {item.author === "own_account" ? null : <> · {item.authorLabel ?? t("inbox.author.unnamed")}</>}
        {item.observed && item.presence !== "present" ? <> · {t(PRESENCE_MESSAGES[item.presence], { platform: platformText })}</> : null}
      </p>
      {item.observed ? <p>{item.text ?? t("inbox.thread.no_text")}</p> : <p>{t("inbox.thread.not_read")}</p>}
      <p>
        {item.providerCreatedAt === null ? null : t("inbox.thread.posted", { time: when(item.providerCreatedAt) })}
        {item.providerEditedAt === null ? null : <> · {t("inbox.thread.edited", { time: when(item.providerEditedAt) })}</>}
        {item.textObservedAt === null ? null : <> · {t("inbox.thread.text_read", { time: when(item.textObservedAt) })}</>}
      </p>
      {item.earlierVersions.length === 0 ? null : (
        <details>
          <summary>{t(item.olderVersionsOmitted ? "inbox.thread.versions_recent" : "inbox.thread.versions", { count: String(item.earlierVersions.length) })}</summary>
          {item.olderVersionsOmitted ? <p role="status">{t("inbox.thread.versions_omitted")}</p> : null}
          <ol>
            {item.earlierVersions.map((version, index) => (
              <li key={`${version.observedAt.toISOString()}-${String(index)}`}>
                <p>{t("inbox.thread.version_read", { time: when(version.observedAt) })}</p>
                <p>{version.text}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      {item.facts.length === 0 ? null : (
        <>
          <p>{t("inbox.facts.heading")}</p>
          <ul>
            {item.facts.map((fact) => (
              <li key={fact}>{t(FACT_MESSAGES[fact] ?? FACT_FALLBACK)}</li>
            ))}
          </ul>
        </>
      )}
    </li>
  );
}
