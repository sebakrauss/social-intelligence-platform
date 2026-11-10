/**
 * Inbox read models (Step 7A; TA §6.2 `queries/`, IA §12, UX §9). Two READ-ONLY workspace commands behind the action
 * pipeline (`workspace.read_operational`: every non-guest role; a client guest is PERMISSION_DENIED before any read,
 * and RLS denies it again) over the owner modules' read ports:
 *
 *   inbox.conversations.list   conversations of the bound workspace, newest activity first, keyset-paginated
 *   inbox.conversation.view    one conversation: its content context, its whole thread (bounded), every retained text
 *                              version and the persisted deterministic signals of each current text
 *
 * What the view models carry and don't (honesty rules):
 *   - A conversation is the work item (IA-01); the UI never says "interaction".
 *   - Organic / paid / mixed / unknown is the content's reported source, inherited (PD D-38); it is a label, never a
 *     section.
 *   - Coverage is reported as the most recent coverage record per managed account and kind, with its as-of time; the
 *     observed count of a conversation is "what was read", never a count at the platform (S11: no data ≠ zero).
 *   - Signals are narrow facts (S19) and are labelled as such; no assessment, priority or label exists yet (step 8), so
 *     every item is explicitly "not yet understood" (TA §73 step 7 exit: the Inbox works with unclassified data).
 *   - Text is returned exactly as retained (Model §13) for the page to render AS TEXT; links stay inert (TA §38.7).
 *   - Nothing here mutates, locks, emits or audits: `audit` returns undefined and no outbox row is written.
 *
 * Cross-workspace reads are NOT_FOUND (the pipeline resolves membership live; RLS hides foreign rows); a conversation
 * that isn't the bound workspace's is indistinguishable from one that doesn't exist.
 */
import { AppError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { parseInstant } from "@/domain/instant";
import { isPlatformKey, type PlatformKey } from "@/domain/platforms";
import { object, optional, parsed } from "@/domain/validation";
import type { ContentItemRecord } from "@/modules/content";
import type { ConversationRow } from "@/modules/conversations";
import type { CoverageScopedRow } from "@/modules/coverage";
import type { ConversationActivityRow, InteractionSummaryRow, TextVersionRow } from "@/modules/interactions";
import type { PersistedSignalRow } from "@/modules/classification";
import type { PermissionKey } from "@/domain/access";
import type { WorkspaceMode } from "@/modules/tenancy";
import { REPLY_TEXT_MAX_CHARS, type OutboundReplyView, type RequestGuards } from "@/mutations/request";
import type { InboxAccountRow, Transaction, WorkspaceCommand, WorkspaceContext } from "@/server/pipeline";

export const INBOX_PAGE_SIZE = 25;
/** Members shown of one conversation; one more is read only to tell that the thread goes on (stays under the store's bound). */
export const INBOX_THREAD_LIMIT = 200;
export const INBOX_EXCERPT_LENGTH = 160;
/**
 * Managed accounts whose coverage is summarized: the first this many of the workspace's accounts, in the connections
 * module's stable order. Coverage is read for THOSE accounts only, as the newest record per (account, kind, scope
 * level) — at most four rows per account — so neither another account's volume nor an account beyond the bound
 * consumes the read. Beyond this many accounts the page says that accounts are not shown; it never shows one as
 * "unknown" because its records weren't read.
 */
export const INBOX_COVERAGE_ACCOUNTS = 250;
/**
 * Earlier retained text versions shown per comment. Two more are read per comment — the current one and one that only
 * proves older versions exist — so a long edit history is reported as incomplete, never presented as complete.
 */
export const INBOX_VERSION_LIMIT = 10;

export type PlatformLabel = PlatformKey | "unknown";
export type SourceLabel = "organic" | "paid" | "mixed" | "unknown";
export type AuthorKind = "audience" | "own_account" | "unknown";
/** The comment's presence at the platform, as last observed. */
export type PresenceState = "present" | "hidden" | "removed_at_source" | "unknown";
export type CoverageStateLabel = "complete" | "partial" | "importing" | "unavailable" | "failed" | "unknown" | "not_requested";
export type ConversationStateLabel = "open" | "done" | "unknown";

export interface InboxCursor {
  readonly latestActivityAt: Date;
  readonly conversationId: string;
}

export interface InboxConversationItem {
  readonly conversationId: string;
  readonly workflowState: ConversationStateLabel;
  readonly platform: PlatformLabel;
  readonly source: SourceLabel;
  readonly contentKind: string | null;
  /** The anchoring top-level comment, if it was read with its content. */
  readonly anchor: { readonly observed: true; readonly author: AuthorKind; readonly authorLabel: string | null; readonly excerpt: string | null; readonly presence: PresenceState } | { readonly observed: false };
  readonly latestActivityAt: Date;
  /** Comments and replies READ in this conversation (never the platform's count). */
  readonly observedCount: number;
  readonly notYetReadCount: number;
  readonly anyHidden: boolean;
  readonly anyRemovedAtSource: boolean;
}

export interface CoverageKindView {
  readonly state: CoverageStateLabel;
  readonly reason: string | null;
  readonly limitationCode: string | null;
  /** Whether the record speaks for the whole account or for one content item only. */
  readonly scope: "account" | "content";
  readonly coveredUntil: Date | null;
}

export interface AccountCoverageView {
  readonly connectedAccountId: string;
  readonly platform: PlatformLabel;
  readonly active: boolean;
  readonly comments: CoverageKindView;
  readonly replies: CoverageKindView;
  readonly asOf: Date | null;
}

export interface InboxPage {
  readonly items: readonly InboxConversationItem[];
  /** Position of the next (older) page, or null at the end. */
  readonly nextCursor: string | null;
  /** The most recent as-of time among the coverage records read, or null when nothing has ever been read. */
  readonly asOf: Date | null;
  readonly coverage: readonly AccountCoverageView[];
  /** True when the workspace has more managed accounts than INBOX_COVERAGE_ACCOUNTS: the ones beyond are absent from `coverage` (never shown as unknown). */
  readonly coverageOmitted: boolean;
  /** Why the list is empty, when it is: nothing read yet vs nothing found in what was read. */
  readonly emptyReason: "nothing_read_yet" | "no_conversations_in_coverage" | null;
}

export interface ThreadTextVersion {
  readonly text: string;
  readonly observedAt: Date;
  readonly providerEditedAt: Date | null;
}

export interface ThreadItem {
  readonly interactionId: string;
  readonly parentInteractionId: string | null;
  readonly kind: "comment" | "reply" | "unknown";
  readonly observed: boolean;
  readonly author: AuthorKind;
  readonly authorLabel: string | null;
  /** The CURRENT text, exactly as retained; null when not read or when the platform returned none. */
  readonly text: string | null;
  readonly presence: PresenceState;
  readonly providerCreatedAt: Date | null;
  readonly providerEditedAt: Date | null;
  readonly textObservedAt: Date | null;
  /** The most recent retained earlier versions (at most INBOX_VERSION_LIMIT), oldest first; the current one is excluded. */
  readonly earlierVersions: readonly ThreadTextVersion[];
  /** True when older retained versions exist beyond `earlierVersions`: the history shown is then incomplete, and says so. */
  readonly olderVersionsOmitted: boolean;
  /** Persisted deterministic signals about the CURRENT text (facts, not meaning). */
  readonly facts: readonly string[];
}

/**
 * Step 7B-3: whether THIS member may reply publicly in THIS conversation, resolved on the server with the request-side
 * guards the command itself uses (IA §18 precedence): no permission → hidden (no affordance at all); Monitor-only →
 * unavailable with the mode reason; then the account, the provider-action switch, the capability for the content's own
 * kind and source (which already folds connection health in). One reason only, in outcome language.
 */
export type ReplyUnavailableReason = "monitor_only" | "account_inactive" | "paused" | "connection" | "platform_unavailable";
export type ReplyModel =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: ReplyUnavailableReason; readonly platform: PlatformLabel }
  | { readonly kind: "available"; readonly connectedAccountId: string; readonly platform: PlatformLabel; readonly maxChars: number; readonly limitation: string | null };

/** The closed display states of an outbound reply (TA §44.1): never optimistic, never a provider detail. */
export type OutboundReplyState = "sending" | "sent" | "failed" | "checking" | "blocked";
export interface OutboundReplyItem {
  readonly intentId: string;
  readonly parentInteractionId: string;
  readonly text: string;
  readonly state: OutboundReplyState;
  readonly outcomeCode: string | null;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
}

export interface ConversationDetail {
  readonly conversationId: string;
  readonly workflowState: ConversationStateLabel;
  readonly platform: PlatformLabel;
  readonly source: SourceLabel;
  readonly contentKind: string | null;
  readonly anchorInteractionId: string;
  readonly thread: readonly ThreadItem[];
  /** True when the conversation has more members than INBOX_THREAD_LIMIT; the first ones are shown. */
  readonly truncated: boolean;
  /** Step 7B-3: the reply affordance for this member and conversation. */
  readonly reply: ReplyModel;
  /** Step 7B-3: outbound replies requested here, with their real states; a reply already read back as a canonical thread member is not repeated. */
  readonly outbound: readonly OutboundReplyItem[];
}

// ── Cursor ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([0-9a-f-]{36})$/;

export function encodeCursor(cursor: InboxCursor): string {
  return `${cursor.latestActivityAt.toISOString()}~${cursor.conversationId}`;
}

/** Strict: an exact instant and a canonical UUID, or nothing. Never an arbitrary string from the browser. */
export function parseCursor(value: unknown): InboxCursor | undefined {
  if (typeof value !== "string") return undefined;
  const match = CURSOR.exec(value);
  if (match === null) return undefined;
  const instant = parseInstant(match[1]);
  const conversationId = match[2];
  if (instant === undefined || conversationId === undefined || !isUuid(conversationId)) return undefined;
  return { latestActivityAt: new Date(instant), conversationId };
}

// ── Pure assembly ────────────────────────────────────────────────────────────────────────────────────────────────────

const platformLabel = (value: string | null | undefined): PlatformLabel => (isPlatformKey(value) ? value : "unknown");

const SOURCES: readonly SourceLabel[] = ["organic", "paid", "mixed", "unknown"];
const sourceLabel = (value: string | null | undefined): SourceLabel => (SOURCES as readonly string[]).includes(value ?? "") ? (value as SourceLabel) : "unknown";

const authorKind = (role: string | null): AuthorKind => (role === "account_identity" ? "own_account" : role === "user" ? "audience" : "unknown");

export function presenceOf(visibility: string | null, availability: string | null): PresenceState {
  if (availability === "removed_at_source") return "removed_at_source";
  if (visibility === "hidden") return "hidden";
  if (visibility === "visible") return "present";
  return "unknown";
}

const workflowLabel = (state: string): ConversationStateLabel => (state === "OPEN" ? "open" : state === "DONE" ? "done" : "unknown");

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** The first INBOX_EXCERPT_LENGTH grapheme clusters of one line of the text (whitespace collapsed), or null for no text. */
export function excerptOf(text: string | null): string | null {
  if (text === null) return null;
  const line = text.replace(/\s+/gu, " ").trim();
  if (line.length === 0) return null;
  let out = "";
  let n = 0;
  for (const { segment } of graphemes.segment(line)) {
    if (n === INBOX_EXCERPT_LENGTH) return `${out}…`;
    out += segment;
    n += 1;
  }
  return out;
}

const COVERAGE_LABELS: Readonly<Record<string, CoverageStateLabel>> = Object.freeze({
  COMPLETE: "complete",
  PARTIAL: "partial",
  IMPORTING: "importing",
  UNAVAILABLE: "unavailable",
  FAILED: "failed",
  UNKNOWN: "unknown",
  NOT_REQUESTED: "not_requested",
});

const NO_RECORD: CoverageKindView = Object.freeze({ state: "unknown", reason: null, limitationCode: null, scope: "account", coveredUntil: null });

/** The most recent record per kind, preferring account-level records over content-level ones (newest as-of wins). */
function coverageKind(rows: readonly CoverageScopedRow[], kind: "comment" | "reply"): CoverageKindView {
  const ofKind = rows.filter((row) => row.interactionKind === kind);
  const pick = (scoped: readonly CoverageScopedRow[]): CoverageScopedRow | undefined =>
    scoped.reduce<CoverageScopedRow | undefined>((best, row) => (best === undefined || row.asOf > best.asOf ? row : best), undefined);
  const accountLevel = pick(ofKind.filter((row) => row.contentItemId === null));
  const chosen = accountLevel ?? pick(ofKind);
  if (chosen === undefined) return NO_RECORD;
  return {
    state: COVERAGE_LABELS[chosen.state] ?? "unknown",
    reason: chosen.reason,
    limitationCode: chosen.limitationCode,
    scope: chosen.contentItemId === null ? "account" : "content",
    coveredUntil: chosen.state === "COMPLETE" || chosen.state === "PARTIAL" ? chosen.intervalEnd : null,
  };
}

export function buildCoverage(coverage: readonly CoverageScopedRow[], accounts: readonly InboxAccountRow[]): readonly AccountCoverageView[] {
  const byAccount = new Map<string, CoverageScopedRow[]>();
  for (const row of coverage) (byAccount.get(row.connectedAccountId) ?? byAccount.set(row.connectedAccountId, []).get(row.connectedAccountId))?.push(row);
  const known = new Map(accounts.map((account) => [account.id, account] as const));
  const ids = [...new Set([...accounts.map((account) => account.id), ...byAccount.keys()])].sort();
  return ids.map((id) => {
    const rows = byAccount.get(id) ?? [];
    const account = known.get(id);
    const asOf = rows.reduce<Date | null>((latest, row) => (latest === null || row.asOf > latest ? row.asOf : latest), null);
    return {
      connectedAccountId: id,
      platform: platformLabel(account?.platform),
      active: account?.status === "ACTIVE",
      comments: coverageKind(rows, "comment"),
      replies: coverageKind(rows, "reply"),
      asOf,
    };
  });
}

export interface InboxPageInput {
  readonly activity: readonly ConversationActivityRow[];
  readonly conversations: readonly ConversationRow[];
  readonly anchors: readonly InteractionSummaryRow[];
  readonly contents: readonly ContentItemRecord[];
  /** Coverage rows of the included accounts (the first coverageAccountLimit of `accounts`): at most four per account. */
  readonly coverage: readonly CoverageScopedRow[];
  /** Every managed account of the workspace, in the connections module's stable order. */
  readonly accounts: readonly InboxAccountRow[];
  readonly pageSize: number;
  readonly coverageAccountLimit: number;
}

/** The accounts whose coverage is summarized: a deterministic prefix of the workspace's accounts, never a sample of rows. */
export function coverageAccounts(accounts: readonly InboxAccountRow[], limit: number): readonly InboxAccountRow[] {
  return accounts.slice(0, limit);
}

/** Assembles one Inbox page. `activity` holds up to pageSize + 1 rows: the extra one only proves an older page exists. */
export function buildInboxPage(input: InboxPageInput): InboxPage {
  const rows = input.activity.slice(0, input.pageSize);
  const hasMore = input.activity.length > input.pageSize;
  const included = coverageAccounts(input.accounts, input.coverageAccountLimit);
  const includedIds = new Set(included.map((account) => account.id));
  // Only the included accounts' rows are summarized; an omitted account is absent, never shown as "unknown".
  const coverageRows = input.coverage.filter((row) => includedIds.has(row.connectedAccountId));
  const conversations = new Map(input.conversations.map((row) => [row.id, row] as const));
  const anchors = new Map(input.anchors.map((row) => [row.id, row] as const));
  const contents = new Map(input.contents.map((row) => [row.id, row] as const));
  const items: InboxConversationItem[] = [];
  for (const row of rows) {
    const conversation = conversations.get(row.conversationId);
    // An activity row whose conversation is not readable proves nothing: it is left out, never shown half-built.
    if (conversation === undefined) continue;
    const anchor = anchors.get(conversation.anchorInteractionId);
    const content = anchor === undefined ? undefined : contents.get(anchor.contentItemId);
    items.push({
      conversationId: conversation.id,
      workflowState: workflowLabel(conversation.workflowState),
      platform: platformLabel(anchor?.platform ?? content?.platform),
      source: sourceLabel(content?.reportedSource),
      contentKind: content?.contentKind ?? null,
      anchor:
        anchor === undefined || !anchor.observed
          ? { observed: false }
          : { observed: true, author: authorKind(anchor.authorRole), authorLabel: anchor.authorLabel, excerpt: excerptOf(anchor.currentText), presence: presenceOf(anchor.currentVisibility, anchor.currentAvailability) },
      latestActivityAt: row.latestActivityAt,
      observedCount: row.observedCount,
      notYetReadCount: row.placeholderCount,
      anyHidden: row.anyHidden,
      anyRemovedAtSource: row.anyRemovedAtSource,
    });
  }
  const last = rows.at(-1);
  const coverage = buildCoverage(coverageRows, included);
  const asOf = coverageRows.reduce<Date | null>((latest, row) => (latest === null || row.asOf > latest ? row.asOf : latest), null);
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor({ latestActivityAt: last.latestActivityAt, conversationId: last.conversationId }) : null,
    asOf,
    coverage,
    coverageOmitted: input.accounts.length > input.coverageAccountLimit,
    emptyReason: items.length > 0 ? null : coverageRows.length === 0 ? "nothing_read_yet" : "no_conversations_in_coverage",
  };
}

export interface ConversationDetailInput {
  readonly conversation: ConversationRow;
  /** Up to INBOX_THREAD_LIMIT + 1 members, oldest first; the extra one only proves truncation. */
  readonly thread: readonly InteractionSummaryRow[];
  /** Per member, its newest versionLimit + 2 retained versions at most: the current one, the shown ones, and one that only proves older ones exist. */
  readonly versions: readonly TextVersionRow[];
  readonly signals: readonly PersistedSignalRow[];
  readonly content: ContentItemRecord | undefined;
  readonly threadLimit: number;
  readonly versionLimit: number;
  /** Step 7B-3 (optional for callers that only draw the thread): the reply affordance and the outbound replies. */
  readonly reply?: ReplyModel;
  readonly outbound?: readonly OutboundReplyItem[];
}

export const OUTBOUND_STATE_OF: { readonly [S in OutboundReplyView["status"]]: OutboundReplyState } = {
  PENDING: "sending",
  EXECUTING: "sending",
  CONFIRMED: "sent",
  FAILED: "failed",
  BLOCKED: "blocked",
  OUTCOME_UNKNOWN: "checking",
};

/** Outbound replies as the thread shows them; one already read back as a canonical member (same provider id) is dropped. */
export function buildOutbound(views: readonly OutboundReplyView[], thread: readonly Pick<InteractionSummaryRow, "providerInteractionId">[]): readonly OutboundReplyItem[] {
  const readBack = new Set(thread.map((member) => member.providerInteractionId));
  return views
    .filter((view) => view.providerReplyId === null || !readBack.has(view.providerReplyId))
    .map((view) => ({ intentId: view.intentId, parentInteractionId: view.parentInteractionId, text: view.text, state: OUTBOUND_STATE_OF[view.status], outcomeCode: view.outcomeCode, createdAt: view.createdAt, confirmedAt: view.confirmedAt }));
}

export interface ReplyModelInput {
  readonly permissions: ReadonlySet<PermissionKey>;
  readonly mode: WorkspaceMode;
  readonly content: ContentItemRecord | undefined;
  readonly guards: RequestGuards;
}

/** The reply affordance, from the SAME guards the request command re-checks (one resolver chain, IA §18 order). */
export async function buildReplyModel(input: ReplyModelInput): Promise<ReplyModel> {
  if (!input.permissions.has("reply.public")) return { kind: "hidden" };
  const platform = platformLabel(input.content?.platform);
  if (input.mode !== "STANDARD") return { kind: "unavailable", reason: "monitor_only", platform };
  if (input.content === undefined) return { kind: "unavailable", reason: "account_inactive", platform };
  const account = await input.guards.account(input.content.connectedAccountId);
  if (account === undefined || account.status !== "ACTIVE") return { kind: "unavailable", reason: "account_inactive", platform };
  // What the platform and the connection allow comes first (IA §18); the operational authorization last (Step 7B-12A):
  // nothing granted reads as "not enabled yet", an emergency block or invalid configuration as "paused".
  const capability = await input.guards.replyCapability(input.content.connectedAccountId, { contentKind: input.content.contentKind, reportedSource: input.content.reportedSource });
  if (capability.state === "TEMPORARILY_UNAVAILABLE") return { kind: "unavailable", reason: "connection", platform };
  if (capability.state === "UNAVAILABLE") return { kind: "unavailable", reason: "platform_unavailable", platform };
  if (account.connectionStatus !== "ACTIVE") return { kind: "unavailable", reason: "connection", platform };
  const authorization = await input.guards.providerActionAllowed(account.platform, "public_reply");
  if (authorization === "not_enabled") return { kind: "unavailable", reason: "platform_unavailable", platform };
  if (authorization !== "allowed") return { kind: "unavailable", reason: "paused", platform };
  return { kind: "available", connectedAccountId: input.content.connectedAccountId, platform, maxChars: REPLY_TEXT_MAX_CHARS, limitation: capability.state === "AVAILABLE_WITH_LIMITATION" ? "limited" : null };
}

export function buildConversationDetail(input: ConversationDetailInput): ConversationDetail {
  const members = input.thread.slice(0, input.threadLimit);
  const versionsByInteraction = new Map<string, TextVersionRow[]>();
  for (const version of input.versions) (versionsByInteraction.get(version.interactionId) ?? versionsByInteraction.set(version.interactionId, []).get(version.interactionId))?.push(version);
  const factsByVersion = new Map<string, Set<string>>();
  for (const signal of input.signals) (factsByVersion.get(signal.sourceTextVersionId) ?? factsByVersion.set(signal.sourceTextVersionId, new Set()).get(signal.sourceTextVersionId))?.add(signal.kind);
  const anchor = members.find((member) => member.id === input.conversation.anchorInteractionId);
  const thread = members.map((member): ThreadItem => {
    // Newest first to keep the most recent earlier versions, then oldest first for the reader. Anything beyond the
    // limit (the store read one more than shown) is reported as omitted, never dropped silently.
    const others = (versionsByInteraction.get(member.id) ?? [])
      .filter((version) => version.id !== member.currentSourceTextVersionId)
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const earlier = others
      .slice(0, input.versionLimit)
      .reverse()
      .map((version): ThreadTextVersion => ({ text: version.sourceText, observedAt: version.observedAt, providerEditedAt: version.providerEditedAt }));
    const facts = member.currentSourceTextVersionId === null ? [] : [...(factsByVersion.get(member.currentSourceTextVersionId) ?? [])].sort();
    return {
      interactionId: member.id,
      parentInteractionId: member.parentInteractionId,
      kind: member.kind === "comment" || member.kind === "reply" ? member.kind : "unknown",
      observed: member.observed,
      author: authorKind(member.authorRole),
      authorLabel: member.authorLabel,
      text: member.observed ? member.currentText : null,
      presence: member.observed ? presenceOf(member.currentVisibility, member.currentAvailability) : "unknown",
      providerCreatedAt: member.providerCreatedAt,
      providerEditedAt: member.providerEditedAt,
      textObservedAt: member.textObservedAt,
      earlierVersions: earlier,
      olderVersionsOmitted: others.length > input.versionLimit,
      facts,
    };
  });
  return {
    conversationId: input.conversation.id,
    workflowState: workflowLabel(input.conversation.workflowState),
    platform: platformLabel(anchor?.platform ?? input.content?.platform),
    source: sourceLabel(input.content?.reportedSource),
    contentKind: input.content?.contentKind ?? null,
    anchorInteractionId: input.conversation.anchorInteractionId,
    thread,
    truncated: input.thread.length > input.threadLimit,
    reply: input.reply ?? { kind: "hidden" },
    outbound: input.outbound ?? [],
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function readInboxPage(tx: Transaction, cursor: InboxCursor | undefined): Promise<InboxPage> {
  const activity = await tx.inbox.interactions.listConversationActivity({ limit: INBOX_PAGE_SIZE + 1, before: cursor ?? null });
  const page = activity.slice(0, INBOX_PAGE_SIZE);
  const conversations = await tx.inbox.conversations.findMany(page.map((row) => row.conversationId));
  const anchors = await tx.inbox.interactions.summaries(conversations.map((row) => row.anchorInteractionId));
  const contents = await tx.inbox.content.findManyById(anchors.map((row) => row.contentItemId));
  const accounts = await tx.inbox.accounts();
  const coverage = await tx.inbox.coverage.latestPerAccountAndKind(coverageAccounts(accounts, INBOX_COVERAGE_ACCOUNTS).map((account) => account.id));
  return buildInboxPage({ activity, conversations, anchors, contents, coverage, accounts, pageSize: INBOX_PAGE_SIZE, coverageAccountLimit: INBOX_COVERAGE_ACCOUNTS });
}

export const inboxListCommand: WorkspaceCommand<{ readonly cursor: InboxCursor | undefined }, InboxPage, InboxPage> = {
  scope: "workspace",
  name: "inbox.conversations.list",
  permission: "workspace.read_operational",
  requiresStandardMode: false,
  validate: object({ cursor: optional(parsed(parseCursor)) }),
  execute: (_context, input, tx) => readInboxPage(tx, input.cursor),
  audit: () => undefined,
  respond: (output) => output,
};

const uuid = parsed((value) => (isUuid(value) ? value : undefined));

async function readConversation(tx: Transaction, context: WorkspaceContext, conversationId: string): Promise<ConversationDetail> {
  const conversation = await tx.inbox.conversations.get(conversationId);
  // Unknown here, or another workspace's (RLS hides it): the same NOT_FOUND, never "forbidden".
  if (conversation === undefined) throw new AppError("NOT_FOUND", {});
  const thread = await tx.inbox.interactions.thread(conversation.id, INBOX_THREAD_LIMIT + 1);
  const shown = thread.slice(0, INBOX_THREAD_LIMIT);
  const ids = shown.map((member) => member.id);
  const versions = await tx.inbox.interactions.textVersions(ids, INBOX_VERSION_LIMIT + 2);
  const signals = await tx.inbox.signals.forInteractions(ids);
  const anchor = thread.find((member) => member.id === conversation.anchorInteractionId) ?? (await tx.inbox.interactions.summaries([conversation.anchorInteractionId]))[0];
  const content = anchor === undefined ? undefined : (await tx.inbox.content.findManyById([anchor.contentItemId]))[0];
  // Step 7B-3: the reply affordance (same guards as the request command) and the outbound replies under these members.
  const reply = await buildReplyModel({ permissions: context.permissions, mode: context.mode, content, guards: tx.mutations.guards });
  const outbound = buildOutbound(await tx.mutations.replies.listForParents(context.workspaceId, ids), shown);
  return buildConversationDetail({ conversation, thread, versions, signals, content, threadLimit: INBOX_THREAD_LIMIT, versionLimit: INBOX_VERSION_LIMIT, reply, outbound });
}

export const inboxConversationCommand: WorkspaceCommand<{ readonly conversationId: string }, ConversationDetail, ConversationDetail> = {
  scope: "workspace",
  name: "inbox.conversation.view",
  permission: "workspace.read_operational",
  requiresStandardMode: false,
  validate: object({ conversationId: uuid }),
  execute: (context, input, tx) => readConversation(tx, context, input.conversationId),
  audit: () => undefined,
  respond: (output) => output,
};
