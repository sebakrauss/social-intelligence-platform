/**
 * Requesting a mutation (TA §26.3, left column): the web side of the executor. A WORKSPACE command (server/commands)
 * runs this inside the action pipeline, which has already authenticated the session, resolved the tenant, authorized
 * `reply.public` and refused a non-Standard workspace. This service adds the request-time guard chain the pipeline
 * cannot know — the target, the account, the capability, the provider-action switch — and then records, in the SAME
 * transaction: the intent (PENDING), the outbound reply (text, sending), the first history row and the outbox row
 * that will execute it. Nothing is sent from here; the web deployment has no execution path.
 *
 * Idempotency: the key is unique per workspace; the same key with the SAME payload (initiator, target, text) returns the
 * existing intent unchanged (R6: domain idempotency is authoritative); the same key with a different payload is refused
 * as a key reuse — it never silently answers another request's intent.
 */
import type { CapabilityAvailability } from "@/modules/capability";
import { REPLY_TEXT_MAX_CHARS, publicReplyDepthAllowed, type MutationIntent } from "../domain/intent";
import type { IntentStore, MutationClock, OutboundReply, OutboundReplyStore, ReplyTargets, RequestGuards } from "../ports";

export { MUTATION_KINDS, INTENT_STATUSES, INTENT_OUTCOME_CODES, REPLY_TEXT_MAX_CHARS, type IntentOutcomeCode, type IntentStatus, type MutationIntent, type MutationKind } from "../domain/intent";
export type { IntentStore, OutboundReply, OutboundReplyStore, OutboundReplyView, ProviderActionDecision, ReplyTarget, ReplyTargets, RequestGuards } from "../ports";

/** The outbox topic the request appends; the job runtime registers the task of the same name (lane 1). */
export const EXECUTE_INTENT_TASK = "mutations.execute_intent";

export interface MutationRequestSources {
  readonly intents: IntentStore;
  readonly replies: OutboundReplyStore;
  readonly targets: ReplyTargets;
  readonly guards: RequestGuards;
}

export interface PublicReplyRequest {
  /** Canonical interaction id (validated UUID by the command's input schema). */
  readonly targetInteractionId: string;
  readonly text: string;
  /** Server-issued per form render; unique per workspace. */
  readonly idempotencyKey: string;
}

export type PublicReplyRefusal =
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_READ"
  | "TARGET_NOT_PRESENT"
  | "TARGET_OWN_ACCOUNT"
  | "TARGET_NOT_REPLYABLE"
  | "TEXT_EMPTY"
  | "TEXT_TOO_LONG"
  | "ACCOUNT_INACTIVE"
  | "CONNECTION_UNAVAILABLE"
  | "CAPABILITY_UNAVAILABLE"
  | "PROVIDER_ACTIONS_DISABLED"
  | "IDEMPOTENCY_KEY_REUSED";

export type PublicReplyOutcome =
  | { readonly kind: "created"; readonly intent: MutationIntent; readonly reply: OutboundReply }
  | { readonly kind: "existing"; readonly intent: MutationIntent }
  | { readonly kind: "refused"; readonly reason: PublicReplyRefusal };

export interface RequestContext {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly correlationId: string;
}

const CAPABILITY_OK: ReadonlySet<CapabilityAvailability["state"]> = new Set(["AVAILABLE", "AVAILABLE_WITH_LIMITATION"]);

export async function requestPublicReply(sources: MutationRequestSources, clock: MutationClock, context: RequestContext, request: PublicReplyRequest): Promise<PublicReplyOutcome> {
  const existing = await sources.intents.findByIdempotencyKey(context.workspaceId, request.idempotencyKey);
  if (existing !== undefined) {
    const existingReply = await sources.replies.getByIntent(context.workspaceId, existing.id);
    const samePayload = existing.initiatorUserId === context.userId && existing.targetInteractionId === request.targetInteractionId && existingReply?.text === request.text;
    return samePayload ? { kind: "existing", intent: existing } : { kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" };
  }

  const text = request.text;
  if (text.trim().length === 0) return { kind: "refused", reason: "TEXT_EMPTY" };
  // UTF-16 length is never below the character count the database checks (0027: char_length ≤ 2200): strict and safe.
  if (text.length > REPLY_TEXT_MAX_CHARS) return { kind: "refused", reason: "TEXT_TOO_LONG" };

  const target = await sources.targets.load(request.targetInteractionId);
  if (target === undefined || target.workspaceId !== context.workspaceId) return { kind: "refused", reason: "TARGET_NOT_FOUND" };
  if (!target.observed) return { kind: "refused", reason: "TARGET_NOT_READ" };
  if (target.presence !== "present") return { kind: "refused", reason: "TARGET_NOT_PRESENT" };
  if (target.ownAccount) return { kind: "refused", reason: "TARGET_OWN_ACCOUNT" };
  // Step 7B-13C (F1): Instagram top-level comments only, on the persisted target (the UI's rule is never the authority).
  if (!publicReplyDepthAllowed(target)) return { kind: "refused", reason: "TARGET_NOT_REPLYABLE" };

  if ((await sources.guards.providerActionAllowed(target.platform, "public_reply")) !== "allowed") return { kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" };
  const account = await sources.guards.account(target.connectedAccountId);
  if (account === undefined || account.status !== "ACTIVE") return { kind: "refused", reason: "ACCOUNT_INACTIVE" };
  if (account.connectionStatus !== "ACTIVE") return { kind: "refused", reason: "CONNECTION_UNAVAILABLE" };
  const capability = await sources.guards.replyCapability(target.connectedAccountId, { contentKind: target.contentKind, reportedSource: target.reportedSource });
  if (!CAPABILITY_OK.has(capability.state)) return { kind: "refused", reason: "CAPABILITY_UNAVAILABLE" };

  const now = clock.now();
  const intent: MutationIntent = {
    id: clock.newId(),
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    kind: "reply_public",
    requestType: "human",
    targetInteractionId: target.interactionId,
    connectedAccountId: target.connectedAccountId,
    initiatorUserId: context.userId,
    idempotencyKey: request.idempotencyKey,
    status: "PENDING",
    attempt: 0,
    runReference: null,
    outcomeCode: null,
    capabilityCatalogId: capability.catalogId,
    capabilityCatalogRevision: capability.catalogRevision,
    correlationId: context.correlationId,
    createdAt: now,
    updatedAt: now,
  };
  const reply: OutboundReply = {
    id: clock.newId(),
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    intentId: intent.id,
    parentInteractionId: target.interactionId,
    connectedAccountId: target.connectedAccountId,
    platform: target.platform,
    text,
    providerReplyId: null,
    confirmedAt: null,
    createdAt: now,
  };
  await sources.intents.insert(intent);
  await sources.replies.insert(reply);
  await sources.intents.appendHistory(context.workspaceId, intent.id, { id: clock.newId(), from: null, to: "PENDING", attempt: 0, actor: "web", code: null, runReference: null, correlationId: context.correlationId, at: now });
  return { kind: "created", intent, reply };
}

/** The outbox message that asks the job runtime to execute ONE intent: identifiers only. */
export function executeIntentDispatch(input: { readonly id: string; readonly intent: MutationIntent; readonly now: Date }) {
  return {
    id: input.id,
    topic: EXECUTE_INTENT_TASK,
    organizationId: input.intent.organizationId,
    workspaceId: input.intent.workspaceId,
    subjectIds: { mutation_intent_id: input.intent.id, connected_account_id: input.intent.connectedAccountId },
    correlationId: input.intent.correlationId,
    initiator: { type: "user" as const, userId: input.intent.initiatorUserId },
    dispatchKey: `mutations.execute_intent:${input.intent.workspaceId}:${input.intent.id}`,
    createdAt: input.now,
  };
}
