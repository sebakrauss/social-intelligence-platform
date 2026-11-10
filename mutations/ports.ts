/**
 * The executor's ports (TA §26.2). Everything the request side and the execution side need from persistence, the
 * tenant modules and the provider boundary, as interfaces: the web composes the request subset on its tenant-scoped
 * transaction; the job runtime composes all of them. Nothing here touches a database client or a provider SDK.
 */
import type { ProviderAccess } from "@/integrations/providers/contract/dto";
import type { ProviderObjectRef } from "@/integrations/providers/contract/identity";
import type { ProviderMutationPort } from "@/integrations/providers/contract/mutation-port";
import type { MutationAction } from "@/platform/flags";
import type { CompetingIntent, IntentOutcomeCode, IntentStatus, IntentTransition, MutationIntent } from "./domain/intent";

/** The canonical interaction a reply targets, as persistence knows it (never a browser-supplied provider id). */
export interface ReplyTarget {
  readonly interactionId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly platform: string;
  readonly providerInteractionId: string;
  readonly providerAssetId: string;
  readonly providerContentId: string;
  readonly contentItemId: string;
  /** The content's kind and reported source, as the content module records them (capability is scoped by them). */
  readonly contentKind: string;
  readonly reportedSource: string;
  readonly parentProviderInteractionId: string | null;
  readonly kind: "comment" | "reply" | "unknown";
  /** Observed with its content (never a placeholder). */
  readonly observed: boolean;
  /** As last observed: a hidden or removed comment can't receive a reply (Meta) — refused before any call. */
  readonly presence: "present" | "hidden" | "removed_at_source" | "unknown";
  /** The brand's own message: replying to yourself is not a product action. */
  readonly ownAccount: boolean;
}

export interface ReplyTargets {
  /** The target by canonical id in the bound workspace, or undefined (unknown here, or another workspace's). */
  load(interactionId: string): Promise<ReplyTarget | undefined>;
}

export interface OutboundReply {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly intentId: string;
  readonly parentInteractionId: string;
  readonly connectedAccountId: string;
  readonly platform: string;
  readonly text: string;
  readonly providerReplyId: string | null;
  readonly confirmedAt: Date | null;
  readonly createdAt: Date;
}

export interface IntentStore {
  insert(intent: MutationIntent): Promise<void>;
  /** The intent with this idempotency key in the bound workspace, if any (the idempotent answer). */
  findByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<MutationIntent | undefined>;
  get(workspaceId: string, intentId: string): Promise<MutationIntent | undefined>;
  /** Row-locked read (FOR UPDATE): one executor at a time per intent. */
  lock(workspaceId: string, intentId: string): Promise<MutationIntent | undefined>;
  /** Applies one admitted transition: status, attempt, run reference, outcome code, updated time. */
  transition(workspaceId: string, intentId: string, next: { readonly status: IntentStatus; readonly attempt: number; readonly runReference: string | null; readonly outcomeCode: IntentOutcomeCode | null; readonly at: Date }): Promise<void>;
  appendHistory(workspaceId: string, intentId: string, transition: IntentTransition & { readonly id: string; readonly correlationId: string; readonly at: Date }): Promise<void>;
  /**
   * Step 7B-5: every OTHER intent of the same workspace, account and target — the candidates that may have produced a
   * reply found on the platform (the pure rule decides which are plausible). Text is deliberately NOT a criterion: the
   * platform may normalize it, so two requests with different texts can still be the same published reply.
   * Read in the SAME transaction as the confirmation it guards.
   */
  competitorsFor(workspaceId: string, intent: { readonly id: string; readonly connectedAccountId: string; readonly targetInteractionId: string }): Promise<readonly CompetingIntent[]>;
}

/** One outbound reply with its intent's state, as the Inbox shows it (Step 7B-3): text, closed state, identifiers. */
export interface OutboundReplyView {
  readonly intentId: string;
  readonly parentInteractionId: string;
  readonly connectedAccountId: string;
  readonly platform: string;
  readonly text: string;
  readonly status: IntentStatus;
  readonly outcomeCode: IntentOutcomeCode | null;
  readonly providerReplyId: string | null;
  readonly initiatorUserId: string;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
}

export interface OutboundReplyStore {
  insert(reply: OutboundReply): Promise<void>;
  getByIntent(workspaceId: string, intentId: string): Promise<OutboundReply | undefined>;
  /** The outbound replies under the given parents with their intents' states, oldest first (bounded by the caller). */
  listForParents(workspaceId: string, parentInteractionIds: readonly string[]): Promise<readonly OutboundReplyView[]>;
  /** The intent already linked to this provider reply in the workspace, if any (0027: one link per reply identity). */
  linkedIntent(workspaceId: string, platform: string, providerReplyId: string): Promise<string | undefined>;
  confirm(workspaceId: string, intentId: string, providerReplyId: string | null, confirmedAt: Date): Promise<void>;
}

/** What the executor re-checks at execution time (TA §26.4), read live from the tenant modules. */
export interface ExecutionGuards {
  /** The initiator's current workspace role, or undefined when no longer a member. */
  initiatorRole(workspaceId: string, userId: string): Promise<string | undefined>;
  /** The workspace mode, read in the same transaction as the EXECUTING transition (consistent read). */
  workspaceMode(workspaceId: string): Promise<"STANDARD" | "MONITOR_ONLY" | undefined>;
  /**
   * Operational authorization mutation.provider_action for EXACTLY `<platform>:<action>` (Step 7B-12A, fail-closed):
   * "allowed" only when that exact pair is granted and nothing restricts it; "not_enabled" when nothing grants it (the
   * default); "paused" when a restrictive row (the "*" emergency block included) or invalid configuration denies it.
   */
  providerActionAllowed(platform: string, action: MutationAction): Promise<ProviderActionDecision>;
  /** Current availability of reply_public for the account and the TARGET's content kind and source (never inferred; UNAVAILABLE on any doubt). */
  replyCapability(connectedAccountId: string, scope: { readonly contentKind: string; readonly reportedSource: string }): Promise<{ readonly state: "AVAILABLE" | "AVAILABLE_WITH_LIMITATION" | "UNAVAILABLE" | "TEMPORARILY_UNAVAILABLE"; readonly catalogId: string; readonly catalogRevision: number }>;
  /** The account and its connection: provider, statuses and the credential envelope reference the job may open. */
  account(connectedAccountId: string): Promise<{ readonly status: "ACTIVE" | "INACTIVE"; readonly platform: string; readonly provider: string; readonly providerAssetId: string; readonly connectionStatus: string; readonly credentialId: string | null } | undefined>;
}

/** What the request side checks before creating an intent: the same guards, minus the runtime-only ones. */
export type RequestGuards = Pick<ExecutionGuards, "providerActionAllowed" | "replyCapability" | "account">;

/** The operational authorization of one platform:action (Step 7B-12A). Only "allowed" lets a mutation proceed. */
export type ProviderActionDecision = "allowed" | "not_enabled" | "paused";

/**
 * The provider boundary as the executor sees it: a mutation port per provider AND platform of the account (the same
 * platform the operational authorization was asked for), or none (fails closed). Step 7B-13A: a provider may write on
 * one of its platforms only (Meta: Instagram), so the platform is part of the selection, never inferred by the port.
 */
export interface MutationProviders {
  mutation(provider: string, platform: string): ProviderMutationPort | undefined;
}

/** Opens the credential for ONE provider call, outside any transaction (TA §39; the single credential-access function). */
export interface CredentialUse {
  withAccess<T>(input: { readonly workspaceId: string; readonly connectedAccountId: string }, use: (access: ProviderAccess) => Promise<T>): Promise<T>;
}

/**
 * Reconciliation after an unknown outcome: did OUR reply land under the parent? Read-only; never a resend.
 *   found      exactly ONE reply by the account identity, under the parent, with the exact text, created at or after the
 *              attempt (small clock skew allowed), in a listing that was read to its END;
 *   none       the complete listing shows no such reply — which is NOT evidence that it was never published;
 *   ambiguous  more than one candidate, or any such reply whose creation time the provider did not state reliably
 *              (it cannot be placed before or after the attempt): no identity can be assigned safely.
 * An unreadable, incomplete or failed listing throws: the caller keeps the outcome unknown.
 */
export type ReplyLookupResult = { readonly kind: "found"; readonly providerReplyId: string } | { readonly kind: "none" } | { readonly kind: "ambiguous" };

export interface ReplyLookup {
  findOwnReply(
    access: ProviderAccess,
    target: { readonly parent: ProviderObjectRef<"interaction">; readonly content: ProviderObjectRef<"content"> },
    text: string,
    since: Date,
  ): Promise<ReplyLookupResult>;
}

export interface MutationClock {
  readonly now: () => Date;
  readonly newId: () => string;
}
