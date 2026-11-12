import {
  AUTHOR_MESSAGES,
  CONTENT_KIND_FALLBACK,
  CONTENT_KIND_MESSAGES,
  CONVERSATION_STATE_MESSAGES,
  COVERAGE_REASON_FALLBACK,
  COVERAGE_REASON_MESSAGES,
  COVERAGE_STATE_MESSAGES,
  FACT_FALLBACK,
  FACT_MESSAGES,
  PRESENCE_MESSAGES,
  SOURCE_MESSAGES,
  displayTime,
  platformName,
  when,
  type AccountCoverageView,
  type ConversationDetail as ConversationDetailModel,
  type ConversationViewState,
  type OutboundReplyItem,
  OUTBOUND_STATE_MESSAGES,
  REPLY_BLOCKED_MESSAGES,
  REPLY_REASON_MESSAGES,
  REPLY_REFUSAL_MESSAGES,
  type CoverageKindView,
  type InboxConversationItem,
  type InboxListState,
  type InboxPage,
  type ThreadItem,
} from "@/server/inbox/inbox";
import { randomUUID } from "node:crypto";
import { publishReplyAction } from "@/server/inbox/actions";
import type { ReplyAction } from "@/server/inbox/reply-state";
import { t } from "@/server/i18n";
import { ReplyComposer, type ReplyComposerLabels, type ReplyOutcomeMessages } from "@/ui/inbox/reply-composer";
import { conversationRowId, workspaceConversationPath, workspaceInboxPagePath, workspaceInboxPath } from "@/server/routes";
import type { IconName } from "@/ui/icons/icon";
import {
  ConversationDetail,
  ConversationList,
  ConversationRow,
  CoverageAccount,
  CoverageAccounts,
  CoverageBlock,
  CoverageSummaryLabel,
  DetailPlaceholder,
  Facts,
  InboxEmpty,
  InboxHeader,
  NoticeSlot,
  PaneMessage,
  Pagination,
  SectionLabel,
  OutboundReply,
  ReplyUnavailable,
  Thread,
  ThreadMember,
  Version,
  VersionList,
} from "@/ui/inbox/inbox";
import { DataTag } from "@/ui/primitives/data-tag";
import { Disclosure } from "@/ui/primitives/disclosure";
import { Notice } from "@/ui/primitives/notice";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { StatePill, type StateTone } from "@/ui/primitives/state-pill";
import { TextLink } from "@/ui/primitives/text-link";
import type { MessageKey } from "@/domain/i18n/message-keys";

/**
 * Inbox views (UI-4): how the Step 7A view models are drawn — the list, the coverage summary, the detail — shared by
 * the two pages and by the development-only reference. Reads nothing, decides nothing: every value comes shaped from
 * server/queries/inbox and every word from the catalog. No action exists here (Step 7B). Audience text is rendered as
 * text, links in it stay inert, and nothing is interpreted: no label, priority, sentiment or risk.
 */

const time = (date: Date): { readonly iso: string; readonly label: string } => ({ iso: when(date), label: displayTime(date) });
const kindOf = (contentKind: string | null): string => t(contentKind === null ? CONTENT_KIND_FALLBACK : (CONTENT_KIND_MESSAGES[contentKind] ?? CONTENT_KIND_FALLBACK));

/** Manual §7 tones for what has been read: success when complete, amber when partial, red when the last read failed. */
export const COVERAGE_TONES: { readonly [S in CoverageKindView["state"]]: { readonly tone: StateTone; readonly icon?: IconName } } = {
  complete: { tone: "success", icon: "decision-approve" },
  importing: { tone: "neutral", icon: "estado-sync" },
  partial: { tone: "warning" },
  failed: { tone: "danger", icon: "estado-alert" },
  unavailable: { tone: "neutral", icon: "estado-lock" },
  not_requested: { tone: "neutral", icon: "estado-lock" },
  unknown: { tone: "neutral" },
};

const CLOSED_MESSAGES: { readonly [K in Exclude<ConversationViewState["kind"], "ready" | "signed_out">]: MessageKey } = {
  verification_required: "auth.status.verification_required",
  workspace_not_found: "inbox.workspace_not_found",
  conversation_not_found: "inbox.conversation.not_found",
  not_allowed: "inbox.not_allowed",
  unavailable: "inbox.unavailable",
};

/** A closed state: a red notice when the Inbox could not be read, neutral text otherwise (not an error). */
export function ClosedState({ kind }: { readonly kind: keyof typeof CLOSED_MESSAGES }) {
  if (kind === "unavailable") {
    return (
      <NoticeSlot>
        <Notice tone="danger" live="assertive">
          {t(CLOSED_MESSAGES[kind])}
        </Notice>
      </NoticeSlot>
    );
  }
  if (kind === "verification_required") {
    return (
      <NoticeSlot>
        <Notice tone="info">{t(CLOSED_MESSAGES[kind])}</Notice>
      </NoticeSlot>
    );
  }
  return <PaneMessage>{t(CLOSED_MESSAGES[kind])}</PaneMessage>;
}

/** The list pane for a ready page. `selectedId` marks the open conversation; `cursor` is the position being shown. */
export function InboxListView({ workspaceId, page, cursor, selectedId }: { readonly workspaceId: string; readonly page: InboxPage; readonly cursor: string | undefined; readonly selectedId?: string }) {
  const empty = page.items.length === 0;
  return (
    <>
      <InboxHeader level={selectedId === undefined ? 1 : 2} title={t("inbox.heading")} subtitle={t("inbox.ordering")} />
      <CoverageSummary page={page} open={empty && page.coverage.length > 0} />
      {empty ? (
        <InboxEmpty title={t("inbox.list.heading")}>{page.emptyReason === "nothing_read_yet" ? t("inbox.empty.nothing_read") : t("inbox.empty.no_conversations")}</InboxEmpty>
      ) : (
        <>
          <ConversationList>
            {page.items.map((item) => (
              <Row key={item.conversationId} workspaceId={workspaceId} item={item} cursor={cursor} current={item.conversationId === selectedId} />
            ))}
          </ConversationList>
          <Pagination>
            {page.nextCursor === null ? (
              t("inbox.pagination.end")
            ) : (
              <OlderLink workspaceId={workspaceId} cursor={page.nextCursor} />
            )}
          </Pagination>
        </>
      )}
    </>
  );
}

function OlderLink({ workspaceId, cursor }: { readonly workspaceId: string; readonly cursor: string }) {
  const href = workspaceInboxPagePath(workspaceId, cursor);
  return href === undefined ? null : <TextLink href={href}>{t("inbox.pagination.older")}</TextLink>;
}

function Row({ workspaceId, item, cursor, current }: { readonly workspaceId: string; readonly item: InboxConversationItem; readonly cursor: string | undefined; readonly current: boolean }) {
  const href = workspaceConversationPath(workspaceId, item.conversationId, cursor);
  if (href === undefined) return null;
  const platform = platformName(item.platform);
  const platformText = platform ?? t("inbox.platform.unknown");
  const author = item.anchor.observed ? (item.anchor.author === "own_account" ? t(AUTHOR_MESSAGES.own_account) : item.anchor.author === "unknown" ? t(AUTHOR_MESSAGES.unknown) : (item.anchor.authorLabel ?? t("inbox.author.unnamed"))) : t("inbox.author.unknown");
  const meta: React.ReactNode[] = [];
  if (item.contentKind !== null) meta.push(<DataTag key="kind">{kindOf(item.contentKind)}</DataTag>);
  if (item.source === "mixed") meta.push(<DataTag key="source">{t("inbox.source.mixed_short")}</DataTag>);
  if (item.source === "unknown") meta.push(<DataTag key="source">{t("inbox.source.unknown_short")}</DataTag>);
  if (item.workflowState !== "open") meta.push(<StatePill key="state">{t(CONVERSATION_STATE_MESSAGES[item.workflowState])}</StatePill>);
  if (item.observedCount > 1) meta.push(<DataTag key="read" icon="conv-thread" mono srLabel={t("inbox.item.read_count", { count: String(item.observedCount) })}>{t("inbox.item.read_count_short", { count: String(item.observedCount) })}</DataTag>);
  if (item.notYetReadCount > 0) meta.push(<DataTag key="unread" mono>{t("inbox.item.not_yet_read_count", { count: String(item.notYetReadCount) })}</DataTag>);
  if (item.anchor.observed && item.anchor.presence === "hidden") meta.push(<DataTag key="hidden" icon="estado-lock">{t("inbox.presence.hidden")}</DataTag>);
  else if (item.anyHidden) meta.push(<DataTag key="hidden" icon="estado-lock">{t("inbox.presence.hidden")}</DataTag>);
  if (item.anyRemovedAtSource || (item.anchor.observed && item.anchor.presence === "removed_at_source")) meta.push(<DataTag key="removed">{t("inbox.presence.removed", { platform: platformText })}</DataTag>);
  if (item.anchor.observed && item.anchor.presence === "unknown") meta.push(<DataTag key="presence">{t("inbox.presence.unknown")}</DataTag>);
  return (
    <ConversationRow
      id={conversationRowId(item.conversationId)}
      href={href}
      current={current}
      origin={<OriginMark platform={item.platform} name={platformText} paid={item.source === "paid"} paidLabel={t("inbox.source.paid")} />}
      author={author}
      time={time(item.latestActivityAt)}
      excerpt={item.anchor.observed ? (item.anchor.excerpt ?? t("inbox.item.excerpt_none")) : t("inbox.item.anchor_not_read")}
      excerptMuted={!item.anchor.observed || item.anchor.excerpt === null}
      meta={meta.length === 0 ? undefined : meta}
    />
  );
}

/** What has been read, per account and kind, as a disclosure (open when the list is empty). */
export function CoverageSummary({ page, open }: { readonly page: InboxPage; readonly open: boolean }) {
  const incomplete = page.coverage.some((account) => account.comments.state === "failed" || account.comments.state === "partial" || account.comments.state === "unknown");
  return (
    <CoverageBlock>
      <Disclosure
        open={open}
        summary={<CoverageSummaryLabel title={t("inbox.coverage.heading")} meta={page.asOf === null ? t("inbox.coverage.never") : t("inbox.coverage.as_of", { time: displayTime(page.asOf) })} {...(incomplete ? { incomplete: t("inbox.coverage.incomplete") } : {})} />}
      >
        {page.coverageOmitted ? (
          <NoticeSlot>
            <Notice tone="info">{t("inbox.coverage.omitted")}</Notice>
          </NoticeSlot>
        ) : null}
        {page.coverage.length === 0 ? <p>{t("inbox.coverage.never")}</p> : <CoverageAccounts>{page.coverage.map((account) => <Account key={account.connectedAccountId} account={account} />)}</CoverageAccounts>}
      </Disclosure>
    </CoverageBlock>
  );
}

function Account({ account }: { readonly account: AccountCoverageView }) {
  const platform = platformName(account.platform);
  const name = platform === undefined ? t("inbox.coverage.account.unknown_platform") : t("inbox.coverage.account", { platform });
  return (
    <CoverageAccount
      head={
        <>
          <OriginMark platform={account.platform} name={name} showName />
          {account.active ? null : <DataTag>{t("inbox.coverage.inactive")}</DataTag>}
          {account.asOf === null ? null : <span className="wk-sr-only">{t("inbox.coverage.as_of", { time: displayTime(account.asOf) })}</span>}
        </>
      }
      kinds={[kindView("comments", "inbox.coverage.comments", account.comments), kindView("replies", "inbox.coverage.replies", account.replies)]}
    />
  );
}

function kindView(key: string, messageKey: "inbox.coverage.comments" | "inbox.coverage.replies", view: CoverageKindView) {
  const { tone, icon } = COVERAGE_TONES[view.state];
  const captions: string[] = [];
  if (view.state !== "complete" && view.state !== "unknown" && view.reason !== null) captions.push(t(COVERAGE_REASON_MESSAGES[view.reason] ?? COVERAGE_REASON_FALLBACK));
  if (view.scope === "content") captions.push(t("inbox.coverage.content_scope"));
  return {
    key,
    pill: (
      <StatePill tone={tone} {...(icon === undefined ? {} : { icon })}>
        {t(messageKey, { state: t(COVERAGE_STATE_MESSAGES[view.state]) })}
      </StatePill>
    ),
    captions,
    ...(view.coveredUntil === null ? {} : { until: t("inbox.coverage.until", { time: displayTime(view.coveredUntil) }) }),
  };
}

export function DetailEmpty() {
  return <DetailPlaceholder>{t("inbox.detail.placeholder")}</DetailPlaceholder>;
}

/** The detail pane for a ready conversation. The back link (one-screen layouts) keeps the list position. */
export function ConversationView({ workspaceId, detail, cursor, replyAction = publishReplyAction, replyOutcomes }: { readonly workspaceId: string; readonly detail: ConversationDetailModel; readonly cursor: string | undefined; readonly replyAction?: ReplyAction; readonly replyOutcomes?: ReplyOutcomeMessages }) {
  const platform = platformName(detail.platform);
  const platformText = platform ?? t("inbox.platform.unknown");
  const back = cursor === undefined ? workspaceInboxPath(workspaceId) : workspaceInboxPagePath(workspaceId, cursor);
  const outboundByParent = new Map<string, OutboundReplyItem[]>();
  for (const item of detail.outbound) (outboundByParent.get(item.parentInteractionId) ?? outboundByParent.set(item.parentInteractionId, []).get(item.parentInteractionId))?.push(item);
  return (
    <ConversationDetail
      back={back === undefined ? undefined : <TextLink href={back}>{t("inbox.back")}</TextLink>}
      title={t("inbox.conversation.heading")}
      context={
        <>
          <OriginMark platform={detail.platform} name={platformText} showName paid={detail.source === "paid"} paidLabel={t("inbox.source.paid")} />
          <DataTag>{kindOf(detail.contentKind)}</DataTag>
          <DataTag>{t(SOURCE_MESSAGES[detail.source])}</DataTag>
          <StatePill>{t(CONVERSATION_STATE_MESSAGES[detail.workflowState])}</StatePill>
        </>
      }
    >
      <Notice tone="info" live="off">
        {t("inbox.understanding_pending")}
      </Notice>
      <SectionLabel id="thread">{t("inbox.thread.heading")}</SectionLabel>
      {detail.reply.kind === "unavailable" ? <ReplyUnavailable label={t("inbox.reply.unavailable_label")} reason={t(REPLY_REASON_MESSAGES[detail.reply.reason])} /> : null}
      <Thread labelledBy="thread">
        {detail.thread.map((item) => (
          <Member key={item.interactionId} item={item} platformText={platformText} detail={detail} workspaceId={workspaceId} replyAction={replyAction} outcomes={replyOutcomes ?? replyOutcomeMessages()} outbound={outboundByParent.get(item.interactionId) ?? []} />
        ))}
      </Thread>
      {detail.truncated ? (
        <Notice tone="info" live="off">
          {t("inbox.thread.truncated", { count: String(detail.thread.length) })}
        </Notice>
      ) : null}
    </ConversationDetail>
  );
}

/**
 * Step 7B-3: which members may receive a public reply. The brand's own messages, placeholders never read, and
 * comments hidden or gone from the platform offer nothing; on Instagram, only top-level comments do (replies attach to
 * the top-level comment, PD/Meta documented restriction). The server re-checks every one of these at request time.
 */
export function replyEligible(item: Pick<ThreadItem, "observed" | "presence" | "author" | "parentInteractionId">, platform: ConversationDetailModel["platform"]): boolean {
  if (!item.observed || item.presence !== "present" || item.author === "own_account") return false;
  if (platform === "instagram" && item.parentInteractionId !== null) return false;
  return true;
}

const OUTBOUND_TONES: { readonly [S in OutboundReplyItem["state"]]: StateTone } = { sending: "neutral", sent: "success", failed: "danger", checking: "warning", blocked: "warning" };

function composerLabels(platformText: string, author: string, maxChars: number, instagramTopLevel: boolean): ReplyComposerLabels {
  return {
    open: t("inbox.reply.action"),
    heading: t("inbox.reply.heading"),
    to: t("inbox.reply.to", { author }),
    as: t("inbox.reply.as", { platform: platformText }),
    ...(instagramTopLevel ? { note: t("inbox.reply.instagram_top_level") } : {}),
    fieldLabel: t("inbox.reply.field_label"),
    fieldHelp: t("inbox.reply.field_help", { max: String(maxChars) }),
    // Templates: the client fills `{count}` as the person types (functions never cross the server → client boundary).
    remaining: t("inbox.reply.remaining", { count: "{count}" }),
    overLimit: t("inbox.reply.over_limit", { count: "{count}" }),
    empty: t("inbox.reply.empty"),
    cancel: t("inbox.reply.cancel"),
    review: t("inbox.reply.review"),
    edit: t("inbox.reply.edit"),
    reviewHeading: t("inbox.reply.review_heading"),
    reviewTextLabel: t("inbox.reply.review_text_label"),
    reviewNote: t("inbox.reply.review_note"),
    publish: t("inbox.reply.publish"),
    publishing: t("inbox.reply.publishing"),
  };
}

/** Every closed outcome the action can answer, translated on the server (the client holds no catalog). */
export function replyOutcomeMessages(): ReplyOutcomeMessages {
  return {
    requested: t("inbox.reply.requested"),
    existing: t("inbox.reply.existing"),
    unavailable: t("inbox.reply.unavailable"),
    signed_out: t("inbox.reply.signed_out"),
    ...Object.fromEntries(Object.entries(REPLY_REFUSAL_MESSAGES).map(([reason, key]) => [`refused.${reason}`, t(key)])),
    ...Object.fromEntries(Object.entries(REPLY_BLOCKED_MESSAGES).map(([code, key]) => [`blocked.${code}`, t(key)])),
  };
}

/** The server-issued key of ONE composer render: unique per form, bound to its target by the command's reuse check. */
export function replyFormKey(): string {
  return `rk-${randomUUID()}`;
}

function OutboundRows({ items }: { readonly items: readonly OutboundReplyItem[] }) {
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => {
        const times = [t("inbox.outbound.requested_at", { time: displayTime(item.createdAt) })];
        if (item.confirmedAt !== null) times.push(t("inbox.outbound.confirmed_at", { time: displayTime(item.confirmedAt) }));
        const note = item.state === "checking" ? t("inbox.outbound.checking_note") : item.state === "failed" ? t("inbox.outbound.failed_note") : item.state === "blocked" ? t("inbox.outbound.blocked_note") : undefined;
        return (
          <OutboundReply
            key={item.intentId}
            author={t("inbox.outbound.author")}
            kind={t("inbox.outbound.kind")}
            state={<StatePill tone={OUTBOUND_TONES[item.state]}>{t(OUTBOUND_STATE_MESSAGES[item.state])}</StatePill>}
            text={item.text}
            times={times}
            {...(note === undefined ? {} : { note })}
          />
        );
      })}
    </>
  );
}

function Member({ item, platformText, detail, workspaceId, replyAction, outcomes, outbound }: { readonly item: ThreadItem; readonly platformText: string; readonly detail: ConversationDetailModel; readonly workspaceId: string; readonly replyAction: ReplyAction; readonly outcomes: ReplyOutcomeMessages; readonly outbound: readonly OutboundReplyItem[] }) {
  const author = item.author === "own_account" ? t(AUTHOR_MESSAGES.own_account) : item.author === "unknown" ? t(AUTHOR_MESSAGES.unknown) : (item.authorLabel ?? t("inbox.author.unnamed"));
  const times: string[] = [];
  if (item.providerEditedAt !== null) times.push(t("inbox.thread.edited", { time: displayTime(item.providerEditedAt) }));
  if (item.textObservedAt !== null) times.push(t("inbox.thread.text_read", { time: displayTime(item.textObservedAt) }));
  const removed = item.observed && item.presence === "removed_at_source";
  // "Written by your account" repeats what the author line already says on the brand's own messages: the fact stays in
  // the data (nothing is removed from the view model) and is simply not drawn twice.
  const facts = item.facts.filter((fact) => !(fact === "author_own_brand" && item.author === "own_account"));
  // Step 7B-14I2: the exceptional validation composer appears ONLY under the exact comment a live authorization naming this
  // member covers; it sends no identifier — the server resolves the authorization itself.
  const validationTarget = detail.reply.kind === "validation" ? detail.reply.targets.find((target) => target.targetInteractionId === item.interactionId) : undefined;
  const composer =
    detail.reply.kind === "available" && replyEligible(item, detail.platform) ? (
      <ReplyComposer
        action={replyAction}
        fields={{ workspaceId, conversationId: detail.conversationId, targetInteractionId: item.interactionId, idempotencyKey: replyFormKey() }}
        maxChars={detail.reply.maxChars}
        labels={composerLabels(platformText, author, detail.reply.maxChars, detail.platform === "instagram")}
        outcomes={outcomes}
      />
    ) : detail.reply.kind === "validation" && validationTarget !== undefined && replyEligible(item, detail.platform) ? (
      <ReplyComposer
        action={replyAction}
        fields={{ workspaceId, conversationId: detail.conversationId, targetInteractionId: item.interactionId, idempotencyKey: replyFormKey(), validation: true }}
        maxChars={detail.reply.maxChars}
        labels={{ ...composerLabels(platformText, author, detail.reply.maxChars, detail.platform === "instagram"), validationNotice: t("inbox.reply.validation_notice", { time: displayTime(validationTarget.expiresAt) }) }}
        outcomes={outcomes}
      />
    ) : undefined;
  return (
    <ThreadMember
      nested={item.parentInteractionId !== null}
      own={item.author === "own_account"}
      author={author}
      kind={t(item.kind === "reply" ? "inbox.thread.reply" : "inbox.thread.comment")}
      {...(item.providerCreatedAt === null ? {} : { time: time(item.providerCreatedAt) })}
      {...(item.observed && item.presence !== "present"
        ? { presence: <StatePill icon="estado-lock">{t(PRESENCE_MESSAGES[item.presence], { platform: platformText })}</StatePill> }
        : {})}
      text={item.observed ? (item.text ?? t("inbox.thread.no_text")) : t("inbox.thread.not_read")}
      textMuted={!item.observed || item.text === null || removed}
      times={times}
      {...(item.earlierVersions.length === 0
        ? {}
        : {
            versions: (
              <Disclosure summary={t(item.olderVersionsOmitted ? "inbox.thread.versions_recent" : "inbox.thread.versions", { count: String(item.earlierVersions.length) })} meta={String(item.earlierVersions.length)}>
                <VersionList
                  {...(item.olderVersionsOmitted
                    ? {
                        notice: (
                          <Notice tone="info" live="off">
                            {t("inbox.thread.versions_omitted")}
                          </Notice>
                        ),
                      }
                    : {})}
                >
                  {item.earlierVersions.map((version, index) => (
                    <Version key={`${version.observedAt.toISOString()}-${String(index)}`} time={{ iso: when(version.observedAt), label: t("inbox.thread.version_read", { time: displayTime(version.observedAt) }) }} text={version.text} />
                  ))}
                </VersionList>
              </Disclosure>
            ),
          })}
      {...(facts.length === 0
        ? {}
        : {
            facts: (
              <Facts label={t("inbox.facts.heading")}>
                {facts.map((fact) => (
                  <DataTag key={fact} {...(fact === "link_present" ? { icon: "conv-link" as const } : fact === "watch_term_match" ? { icon: "util-tag" as const } : {})}>
                    {t(FACT_MESSAGES[fact] ?? FACT_FALLBACK)}
                  </DataTag>
                ))}
              </Facts>
            ),
          })}
      {...(composer === undefined ? {} : { actions: composer })}
      {...(outbound.length === 0 ? {} : { outbound: <OutboundRows items={outbound} /> })}
    />
  );
}


/** The whole list-pane content for a list state (ready or closed). */
export function ListPaneFor({ state, cursor, selectedId }: { readonly state: InboxListState | undefined; readonly cursor: string | undefined; readonly selectedId?: string }) {
  if (state === undefined || state.kind === "signed_out") return null;
  if (state.kind === "ready") return <InboxListView workspaceId={state.workspaceId} page={state.page} cursor={cursor} {...(selectedId === undefined ? {} : { selectedId })} />;
  return <ClosedState kind={state.kind} />;
}
