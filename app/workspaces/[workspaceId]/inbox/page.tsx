import { redirect } from "next/navigation";
import {
  AUTHOR_MESSAGES,
  CONTENT_KIND_FALLBACK,
  CONTENT_KIND_MESSAGES,
  CONVERSATION_STATE_MESSAGES,
  COVERAGE_REASON_FALLBACK,
  COVERAGE_REASON_MESSAGES,
  COVERAGE_STATE_MESSAGES,
  PRESENCE_MESSAGES,
  SOURCE_MESSAGES,
  platformName,
  when,
  type AccountCoverageView,
  type CoverageKindView,
  type InboxConversationItem,
} from "@/server/inbox/inbox";
import { currentInboxPage } from "@/server/inbox/runtime";
import { t } from "@/server/i18n";
import { workspaceConversationPath, workspaceInboxPagePath } from "@/server/routes";

/** Inbox content is per request and per member: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace › Inbox (Step 7A; IA §12; UX §9). Rendering only reads: one inbox.conversations.list query through the action
 * pipeline (`workspace.read_operational`: every non-guest role; a client guest sees the access message only). The list
 * unit is the conversation (IA-01). Each row shows the platform, the organic/paid label, the author, an excerpt of the
 * first comment, what has been read of it and its latest activity — rendered AS TEXT, links inert. No action exists on
 * this page: no reply, hide, delete, block, assignment or resolution, and no "Needs review" (step 8). Priority ordering
 * and labels are not available yet, which the page says. Older pages follow a server-issued position only.
 *
 * "What has been read" is the most recent coverage record per managed account and kind, with its as-of time (TA §17.4,
 * S11): an empty list says whether nothing was read or nothing was found. Minimal and utilitarian: no product design.
 */
export default async function WorkspaceInboxPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId } = await params;
  const cursor = (await searchParams)["cursor"];
  const state = await currentInboxPage(workspaceId, cursor);
  if (state.kind === "signed_out") redirect("/sign-in");

  return (
    <main>
      <h1>{t("inbox.heading")}</h1>

      {state.kind === "verification_required" ? <p role="status">{t("auth.status.verification_required")}</p> : null}
      {state.kind === "workspace_not_found" ? <p role="status">{t("inbox.workspace_not_found")}</p> : null}
      {state.kind === "not_allowed" ? <p role="status">{t("inbox.not_allowed")}</p> : null}
      {state.kind === "unavailable" ? <p role="status">{t("inbox.unavailable")}</p> : null}

      {state.kind === "ready" ? (
        <>
          <section aria-labelledby="inbox-coverage">
            <h2 id="inbox-coverage">{t("inbox.coverage.heading")}</h2>
            <p>{state.page.asOf === null ? t("inbox.coverage.never") : t("inbox.coverage.as_of", { time: when(state.page.asOf) })}</p>
            {state.page.coverageOmitted ? <p role="status">{t("inbox.coverage.omitted")}</p> : null}
            {state.page.coverage.length === 0 ? null : (
              <ul>
                {state.page.coverage.map((account) => (
                  <Coverage key={account.connectedAccountId} account={account} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="inbox-list">
            <h2 id="inbox-list">{t("inbox.list.heading")}</h2>
            <p>{t("inbox.ordering")}</p>
            {state.page.items.length === 0 ? (
              <p role="status">{state.page.emptyReason === "nothing_read_yet" ? t("inbox.empty.nothing_read") : t("inbox.empty.no_conversations")}</p>
            ) : (
              <>
                <p>{t("inbox.understanding_pending")}</p>
                <ol>
                  {state.page.items.map((item) => (
                    <ConversationRow key={item.conversationId} workspaceId={state.workspaceId} item={item} />
                  ))}
                </ol>
              </>
            )}
            <Older workspaceId={state.workspaceId} cursor={state.page.nextCursor} any={state.page.items.length > 0} />
          </section>
        </>
      ) : null}
    </main>
  );
}

function ConversationRow({ workspaceId, item }: { readonly workspaceId: string; readonly item: InboxConversationItem }) {
  const href = workspaceConversationPath(workspaceId, item.conversationId);
  const platform = platformName(item.platform);
  const kind = t(item.contentKind === null ? CONTENT_KIND_FALLBACK : (CONTENT_KIND_MESSAGES[item.contentKind] ?? CONTENT_KIND_FALLBACK));
  return (
    <li>
      <p>
        {platform ?? t("inbox.platform.unknown")} · {kind} · {t(SOURCE_MESSAGES[item.source])} · {t(CONVERSATION_STATE_MESSAGES[item.workflowState])}
      </p>
      {item.anchor.observed ? (
        <>
          <p>
            {t(AUTHOR_MESSAGES[item.anchor.author])}
            {item.anchor.author === "own_account" ? null : <> · {item.anchor.authorLabel ?? t("inbox.author.unnamed")}</>}
            {item.anchor.presence === "present" ? null : <> · {t(PRESENCE_MESSAGES[item.anchor.presence], { platform: platform ?? t("inbox.platform.unknown") })}</>}
          </p>
          <p>{item.anchor.excerpt ?? t("inbox.item.excerpt_none")}</p>
        </>
      ) : (
        <p>{t("inbox.item.anchor_not_read")}</p>
      )}
      <p>
        {t("inbox.item.read_count", { count: String(item.observedCount) })}
        {item.notYetReadCount > 0 ? <> · {t("inbox.item.not_yet_read_count", { count: String(item.notYetReadCount) })}</> : null}
        {item.anyHidden ? <> · {t("inbox.presence.hidden")}</> : null}
        {item.anyRemovedAtSource ? <> · {t("inbox.presence.removed", { platform: platform ?? t("inbox.platform.unknown") })}</> : null}
        {" · "}
        {t("inbox.item.latest", { time: when(item.latestActivityAt) })}
      </p>
      {href === undefined ? null : <a href={href}>{t("inbox.item.open")}</a>}
    </li>
  );
}

function Coverage({ account }: { readonly account: AccountCoverageView }) {
  const platform = platformName(account.platform);
  return (
    <li>
      <p>
        {platform === undefined ? t("inbox.coverage.account.unknown_platform") : t("inbox.coverage.account", { platform })}
        {account.active ? null : <> · {t("inbox.coverage.inactive")}</>}
        {account.asOf === null ? null : <> · {t("inbox.coverage.as_of", { time: when(account.asOf) })}</>}
      </p>
      <p>{t("inbox.coverage.comments", { state: coverageText(account.comments) })}</p>
      <p>{t("inbox.coverage.replies", { state: coverageText(account.replies) })}</p>
    </li>
  );
}

/** One reason only, in outcome language (UX §28): the state, its reason when it isn't complete, its extent when it is. */
function coverageText(view: CoverageKindView): string {
  const parts = [t(COVERAGE_STATE_MESSAGES[view.state])];
  if (view.state !== "complete" && view.state !== "unknown" && view.reason !== null) parts.push(t(COVERAGE_REASON_MESSAGES[view.reason] ?? COVERAGE_REASON_FALLBACK));
  if (view.coveredUntil !== null) parts.push(t("inbox.coverage.until", { time: when(view.coveredUntil) }));
  if (view.scope === "content") parts.push(t("inbox.coverage.content_scope"));
  return parts.join(" — ");
}

function Older({ workspaceId, cursor, any }: { readonly workspaceId: string; readonly cursor: string | null; readonly any: boolean }) {
  if (cursor === null) return any ? <p>{t("inbox.pagination.end")}</p> : null;
  const href = workspaceInboxPagePath(workspaceId, cursor);
  return href === undefined ? null : <a href={href}>{t("inbox.pagination.older")}</a>;
}
