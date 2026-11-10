/**
 * Workspace › Inbox surface states (Step 7A). Read only: two pipeline queries (server/queries/inbox.ts), closed outcome
 * states, presentation copy keys. Nothing from an error, the database or a provider reaches the page or a URL.
 *
 *   - A workspace that doesn't exist, isn't the caller's, or isn't a UUID is the same `workspace_not_found`.
 *   - A client guest (or any role without `workspace.read_operational`) is `not_allowed`: IA §18 says the Inbox is
 *     hidden for guests, and T-02 says the server denies it by URL too — the page shows the access message only.
 *   - A conversation that doesn't exist, isn't this workspace's or isn't a UUID is the same `conversation_not_found`.
 *   - A browser-supplied cursor that isn't one the server issued is ignored (first page): it is a position, not data.
 */
import type { MessageKey } from "@/domain/i18n/message-keys";
import type { PublicReplyRefusal } from "@/mutations/request";
import type { OutboundReplyState, ReplyUnavailableReason } from "@/server/queries/inbox";
import type { ReplyBlockedCode } from "./reply-state";
import { PLATFORM_DISPLAY_NAMES } from "@/domain/platforms";
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import type { ActionPipeline } from "@/server/pipeline";
import {
  encodeCursor,
  inboxConversationCommand,
  inboxListCommand,
  parseCursor,
  type AuthorKind,
  type ConversationDetail,
  type ConversationStateLabel,
  type CoverageStateLabel,
  type InboxPage,
  type PlatformLabel,
  type PresenceState,
  type SourceLabel,
} from "@/server/queries/inbox";

export type { AccountCoverageView, ConversationDetail, CoverageKindView, InboxConversationItem, InboxPage, OutboundReplyItem, OutboundReplyState, ReplyModel, ReplyUnavailableReason, ThreadItem, ThreadTextVersion } from "@/server/queries/inbox";
export type { ReplyActionState } from "./reply-state";

export type InboxListState =
  | { readonly kind: "signed_out" }
  | { readonly kind: "verification_required" }
  | { readonly kind: "workspace_not_found" }
  | { readonly kind: "not_allowed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly workspaceId: WorkspaceId; readonly page: InboxPage };

export type ConversationViewState =
  | Exclude<InboxListState, { readonly kind: "ready" }>
  | { readonly kind: "conversation_not_found" }
  | { readonly kind: "ready"; readonly workspaceId: WorkspaceId; readonly detail: ConversationDetail };

/** The caller's Inbox page. Read only: one inbox.conversations.list query. */
export async function resolveInboxPage(pipeline: ActionPipeline, workspaceId: unknown, cursor: unknown): Promise<InboxListState> {
  const position = parseCursor(cursor);
  const result = await pipeline.run(inboxListCommand, { workspaceId, input: { cursor: position === undefined ? undefined : encodeCursor(position) } });
  if (result.status === "unauthenticated") return { kind: "signed_out" };
  if (result.status === "verification_required") return { kind: "verification_required" };
  if (result.status === "error") {
    if (result.error.code === "NOT_FOUND") return { kind: "workspace_not_found" };
    if (result.error.code === "PERMISSION_DENIED") return { kind: "not_allowed" };
    return { kind: "unavailable" };
  }
  const resolved = parseWorkspaceId(workspaceId);
  if (resolved === undefined) return { kind: "workspace_not_found" };
  return { kind: "ready", workspaceId: resolved, page: result.value };
}

/** One conversation of the caller's workspace. Read only: one inbox.conversation.view query. */
export async function resolveConversation(pipeline: ActionPipeline, workspaceId: unknown, conversationId: unknown): Promise<ConversationViewState> {
  if (!isUuid(conversationId)) return { kind: "conversation_not_found" };
  const result = await pipeline.run(inboxConversationCommand, { workspaceId, input: { conversationId } });
  if (result.status === "unauthenticated") return { kind: "signed_out" };
  if (result.status === "verification_required") return { kind: "verification_required" };
  if (result.status === "error") {
    if (result.error.code === "PERMISSION_DENIED") return { kind: "not_allowed" };
    // The workspace or the conversation: the pipeline resolves the workspace first, so a foreign workspace is NOT_FOUND
    // before the query runs. Both are told apart only by whether the routed workspace parses — never by existence.
    if (result.error.code === "NOT_FOUND" || result.error.code === "INVALID_INPUT") return parseWorkspaceId(workspaceId) === undefined ? { kind: "workspace_not_found" } : { kind: "conversation_not_found" };
    return { kind: "unavailable" };
  }
  const resolved = parseWorkspaceId(workspaceId);
  if (resolved === undefined) return { kind: "workspace_not_found" };
  return { kind: "ready", workspaceId: resolved, detail: result.value };
}

// ── Presentation copy (keys only; the catalog holds the text) ────────────────────────────────────────────────────────

/** Proper nouns for the platform, identical in every language; "unknown" has a catalog message. */
export function platformName(platform: PlatformLabel): string | undefined {
  return platform === "unknown" ? undefined : PLATFORM_DISPLAY_NAMES[platform];
}

export const SOURCE_MESSAGES: { readonly [S in SourceLabel]: MessageKey } = {
  organic: "inbox.source.organic",
  paid: "inbox.source.paid",
  mixed: "inbox.source.mixed",
  unknown: "inbox.source.unknown",
};

export const AUTHOR_MESSAGES: { readonly [A in AuthorKind]: MessageKey } = {
  audience: "inbox.author.audience",
  own_account: "inbox.author.own_account",
  unknown: "inbox.author.unknown",
};

export const PRESENCE_MESSAGES: { readonly [P in Exclude<PresenceState, "present">]: MessageKey } = {
  hidden: "inbox.presence.hidden",
  removed_at_source: "inbox.presence.removed",
  unknown: "inbox.presence.unknown",
};

/** Step 7B-3: one reason per unavailable reply (IA §18: outcome language, one reason only). */
export const REPLY_REASON_MESSAGES: { readonly [R in ReplyUnavailableReason]: MessageKey } = {
  monitor_only: "inbox.reply.reason.monitor_only",
  account_inactive: "inbox.reply.reason.account_inactive",
  paused: "inbox.reply.reason.paused",
  connection: "inbox.reply.reason.connection",
  platform_unavailable: "inbox.reply.reason.platform_unavailable",
};

/** Step 7B-3: the closed answers of the publish action, as copy (the composer receives them translated). */
export const REPLY_REFUSAL_MESSAGES: { readonly [R in PublicReplyRefusal]: MessageKey } = {
  TARGET_NOT_FOUND: "inbox.reply.refused.target_not_found",
  TARGET_NOT_READ: "inbox.reply.refused.target_not_read",
  TARGET_NOT_PRESENT: "inbox.reply.refused.target_not_present",
  TARGET_OWN_ACCOUNT: "inbox.reply.refused.target_own_account",
  TARGET_NOT_REPLYABLE: "inbox.reply.refused.target_not_replyable",
  TEXT_EMPTY: "inbox.reply.refused.text_empty",
  TEXT_TOO_LONG: "inbox.reply.refused.text_too_long",
  ACCOUNT_INACTIVE: "inbox.reply.refused.account_inactive",
  CONNECTION_UNAVAILABLE: "inbox.reply.refused.connection_unavailable",
  CAPABILITY_UNAVAILABLE: "inbox.reply.refused.capability_unavailable",
  PROVIDER_ACTIONS_DISABLED: "inbox.reply.refused.provider_actions_disabled",
  IDEMPOTENCY_KEY_REUSED: "inbox.reply.refused.idempotency_key_reused",
};
export const REPLY_BLOCKED_MESSAGES: { readonly [C in ReplyBlockedCode]: MessageKey } = {
  PERMISSION_DENIED: "inbox.reply.blocked.permission_denied",
  MODE_BLOCKED: "inbox.reply.blocked.mode_blocked",
  NOT_FOUND: "inbox.reply.blocked.not_found",
  INVALID_INPUT: "inbox.reply.blocked.invalid_input",
};

export const OUTBOUND_STATE_MESSAGES: { readonly [S in OutboundReplyState]: MessageKey } = {
  sending: "inbox.outbound.state.sending",
  sent: "inbox.outbound.state.sent",
  failed: "inbox.outbound.state.failed",
  checking: "inbox.outbound.state.checking",
  blocked: "inbox.outbound.state.blocked",
};

export const CONVERSATION_STATE_MESSAGES: { readonly [S in ConversationStateLabel]: MessageKey } = {
  open: "inbox.state.open",
  done: "inbox.state.done",
  unknown: "inbox.state.unknown",
};

export const COVERAGE_STATE_MESSAGES: { readonly [S in CoverageStateLabel]: MessageKey } = {
  complete: "inbox.coverage.state.complete",
  partial: "inbox.coverage.state.partial",
  importing: "inbox.coverage.state.importing",
  unavailable: "inbox.coverage.state.unavailable",
  failed: "inbox.coverage.state.failed",
  unknown: "inbox.coverage.state.unknown",
  not_requested: "inbox.coverage.state.not_requested",
};

/** Coverage reasons (modules/coverage COVERAGE_REASONS) in outcome language; an unlisted reason gets the generic one. */
export const COVERAGE_REASON_MESSAGES: Readonly<Record<string, MessageKey>> = Object.freeze({
  VALIDATED_SCOPE_READ: "inbox.coverage.reason.read",
  CAPABILITY_LIMITATION: "inbox.coverage.reason.limitation",
  CAPABILITY_NOT_VALIDATED: "inbox.coverage.reason.not_validated",
  CAPABILITY_UNSUPPORTED: "inbox.coverage.reason.unsupported",
  ACCOUNT_PERMISSION_MISSING: "inbox.coverage.reason.permission_missing",
  PROFILE_STALE: "inbox.coverage.reason.profile_stale",
  ACCOUNT_INACTIVE: "inbox.coverage.reason.account_inactive",
  CONNECTION_UNAVAILABLE: "inbox.coverage.reason.connection_unavailable",
  PROVIDER_FAILURE: "inbox.coverage.reason.provider_failure",
  HISTORY_DEPTH_NOT_VALIDATED: "inbox.coverage.reason.history",
  IN_PROGRESS: "inbox.coverage.reason.in_progress",
  TRAVERSAL_INCOMPLETE: "inbox.coverage.reason.traversal_incomplete",
});
export const COVERAGE_REASON_FALLBACK: MessageKey = "inbox.coverage.reason.other";

/** Content kinds (provider contract CONTENT_KINDS) as outcome words; anything else is "content". */
export const CONTENT_KIND_MESSAGES: Readonly<Record<string, MessageKey>> = Object.freeze({
  post: "inbox.content.post",
  reel: "inbox.content.reel",
  video: "inbox.content.video",
  carousel: "inbox.content.carousel",
  story: "inbox.content.story",
  ad_creative: "inbox.content.ad",
  other: "inbox.content.other",
});
export const CONTENT_KIND_FALLBACK: MessageKey = "inbox.content.other";

/** Deterministic signal kinds (modules/classification SIGNAL_KINDS) as observed facts; never as meaning. */
export const FACT_MESSAGES: Readonly<Record<string, MessageKey>> = Object.freeze({
  link_present: "inbox.facts.link_present",
  text_empty: "inbox.facts.text_empty",
  text_emoji_only: "inbox.facts.text_emoji_only",
  author_own_brand: "inbox.facts.author_own_brand",
  watch_term_match: "inbox.facts.watch_term_match",
});
export const FACT_FALLBACK: MessageKey = "inbox.facts.other";

/** UTC, second precision, no locale: a surface that isn't live shows as-of times (TA §47). */
export function when(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/**
 * The visible form of an as-of time (UI-4): absolute, UTC, minute precision, in the data typeface — "01 NOV 2026 ·
 * 10:10 UTC". Never relative (the page isn't live) and never in a local zone (no workspace time zone exists yet).
 * The machine-readable instant goes in <time dateTime> through when().
 */
export function displayTime(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? "???"} ${String(date.getUTCFullYear())} · ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}
