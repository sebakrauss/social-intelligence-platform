/**
 * Requesting a mutation (TA §26.3, left column): the web side of the executor. A WORKSPACE command (server/commands)
 * runs this inside the action pipeline, which has already authenticated the session, resolved the tenant, authorized
 * `reply.public` and refused a non-Standard workspace. This service adds the request-time guard chain the pipeline
 * cannot know — the target, the account, the capability, the provider-action switch — and then records, in the SAME
 * transaction: the intent (PENDING), the outbound reply (text, sending), the first history row and the outbox row
 * that will execute it. Nothing is sent from here; the web deployment has no execution path.
 *
 * Idempotency: the key is unique per workspace; the same key with the SAME payload (initiator, target, text,
 * validation authorization) returns the existing intent unchanged (R6: domain idempotency is authoritative); the same
 * key with a different payload is refused as a key reuse — it never silently answers another request's intent.
 *
 * Step 7B-14G1 — an OPTIONAL one-time validation authorization (0028). Without one, nothing here changed: the same
 * guards, in the same order, with the same refusals (no grant → PROVIDER_ACTIONS_DISABLED; catalog not validated →
 * CAPABILITY_UNAVAILABLE). With one, the request is admitted only when decideValidationAdmission says so (exact scope,
 * live, unbound — read through RLS, which shows a member ONLY the authorization naming them as initiator), and then it
 * may stand in for exactly a missing grant and an unvalidated catalog — never a pause, the emergency block or any other
 * capability state. Any refusal about the authorization itself is ONE closed reason (no oracle). The intent is inserted
 * naming it, and 0028's trigger binds it in the same statement's transaction (a concurrent binding or a revocation that
 * committed first makes the insert fail: nothing is written).
 */
import type { CapabilityAvailability } from "@/modules/capability";
import { REPLY_TEXT_MAX_CHARS, publicReplyDepthAllowed, type MutationIntent } from "../domain/intent";
import { decideValidationAdmission } from "../domain/validation-authorization";
import type { IntentStore, MutationClock, OutboundReply, OutboundReplyStore, ReplyTargets, RequestGuards, ValidationAuthorityReads } from "../ports";

export { MUTATION_KINDS, INTENT_STATUSES, INTENT_OUTCOME_CODES, REPLY_TEXT_MAX_CHARS, type IntentOutcomeCode, type IntentStatus, type MutationIntent, type MutationKind } from "../domain/intent";
export type { IntentStore, OutboundReply, OutboundReplyStore, OutboundReplyView, ProviderActionDecision, ReplyTarget, ReplyTargets, RequestGuards, ValidationAuthorityReads } from "../ports";

/** The outbox topic the request appends; the job runtime registers the task of the same name (lane 1). */
export const EXECUTE_INTENT_TASK = "mutations.execute_intent";

export interface MutationRequestSources {
  readonly intents: IntentStore;
  readonly replies: OutboundReplyStore;
  readonly targets: ReplyTargets;
  readonly guards: RequestGuards;
  /** Step 7B-14G1: the validation reads; absent → a request naming an authorization is refused (fail closed). */
  readonly validation?: ValidationAuthorityReads;
}

export interface PublicReplyRequest {
  /** Canonical interaction id (validated UUID by the command's input schema). */
  readonly targetInteractionId: string;
  readonly text: string;
  /** Server-issued per form render; unique per workspace. */
  readonly idempotencyKey: string;
  /** Step 7B-14G1: an operator-issued one-time validation authorization (validated UUID), or absent for every ordinary request. */
  readonly validationAuthorizationId?: string;
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
  | "IDEMPOTENCY_KEY_REUSED"
  /** Step 7B-14G1: the named validation authorization does not admit this request (one reason for every case). */
  | "VALIDATION_AUTHORIZATION_UNAVAILABLE";

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
  const authorizationId = request.validationAuthorizationId ?? null;
  const existing = await sources.intents.findByIdempotencyKey(context.workspaceId, request.idempotencyKey);
  if (existing !== undefined) {
    const existingReply = await sources.replies.getByIntent(context.workspaceId, existing.id);
    const samePayload = existing.initiatorUserId === context.userId && existing.targetInteractionId === request.targetInteractionId && existingReply?.text === request.text
      && existing.validationAuthorizationId === authorizationId;
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

  const providerAction = await sources.guards.providerActionAllowed(target.platform, "public_reply");
  // Ordinary request: exactly as before — no grant (or a pause) refuses here.
  if (authorizationId === null && providerAction !== "allowed") return { kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" };
  const account = await sources.guards.account(target.connectedAccountId);
  if (account === undefined || account.status !== "ACTIVE") return { kind: "refused", reason: "ACCOUNT_INACTIVE" };
  if (account.connectionStatus !== "ACTIVE") return { kind: "refused", reason: "CONNECTION_UNAVAILABLE" };
  const scope = { contentKind: target.contentKind, reportedSource: target.reportedSource };
  const capability = await sources.guards.replyCapability(target.connectedAccountId, scope);
  const usable = CAPABILITY_OK.has(capability.state);
  if (authorizationId === null) {
    if (!usable) return { kind: "refused", reason: "CAPABILITY_UNAVAILABLE" };
  } else {
    // Step 7B-14G1: the bounded exception, decided in ONE pure place on what the database answered.
    const validation = sources.validation;
    if (validation === undefined) return { kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" };
    const decision = decideValidationAdmission({
      phase: "request",
      subject: { intentId: null, organizationId: context.organizationId, workspaceId: context.workspaceId, connectedAccountId: target.connectedAccountId, targetInteractionId: target.interactionId, initiatorUserId: context.userId, kind: "reply_public", attempt: 0 },
      reading: await validation.authorization(context.workspaceId, authorizationId),
      account: { provider: account.provider, platform: account.platform },
      targetPlatform: target.platform,
      providerAction,
      capability: { usable, catalogValidationPending: usable ? false : await validation.catalogValidationPending(target.connectedAccountId, scope) },
      consumedElsewhere: false,
    });
    if (decision.kind === "refuse") {
      if (decision.reason === "provider_action") return { kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" };
      if (decision.reason === "capability") return { kind: "refused", reason: "CAPABILITY_UNAVAILABLE" };
      return { kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" };
    }
  }

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
    validationAuthorizationId: authorizationId,
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
