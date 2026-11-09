/**
 * The Platform Mutation Executor (TA §26.3 right column, §26.4; R6). Runs in the job runtime only, in three steps:
 *
 *   1. one transaction — lock the intent; refuse anything but PENDING (an EXECUTING intent without an outcome is a
 *      crashed, lost or redelivered run: it becomes OUTCOME_UNKNOWN and goes to reconciliation — never a resend);
 *      re-run the guard chain with live reads; record EXECUTING (attempt, run reference) and COMMIT;
 *   2. outside any transaction — open the credential for ONE call and ask the provider's mutation port;
 *   3. one transaction — record the outcome: CONFIRMED (with the created reply's provider id) · FAILED (definite
 *      provider refusal, or a request that never left) · BLOCKED (a guard refused) · OUTCOME_UNKNOWN (timeout / lost
 *      response / an error the contract does not classify), each with its history row and its audit event in the
 *      same transaction. A receipt that arrives after another run already recorded OUTCOME_UNKNOWN confirms the intent
 *      through the authorized OUTCOME_UNKNOWN → CONFIRMED transition (a race never loses a verifiable confirmation,
 *      and never causes a second call).
 *
 * ONE provider call per intent, ever: the executor never retries a provider call, never throws for the runtime to
 * retry one, and never reaches a provider without the EXECUTING commit. It never decides product behavior the guards
 * don't express. It depends on ports only (../ports).
 */
import type { PublicReplyReceipt } from "@/integrations/providers/contract/mutation-port";
import {
  CredentialInvalidError,
  OutcomeUnknownError,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TargetNotEligibleError,
  TargetNotFoundError,
  TransientError,
} from "@/integrations/providers/contract/errors";
import { providerObjectRef } from "@/integrations/providers/contract/identity";
import { isPlatformKey } from "@/domain/platforms";
import { assertTransition, type IntentOutcomeCode, type IntentStatus, type MutationIntent, OUTCOME_STATUS } from "../domain/intent";
import type { CredentialUse, ExecutionGuards, IntentStore, MutationClock, MutationProviders, OutboundReply, OutboundReplyStore, ReplyTargets } from "../ports";

export interface ExecutorStores {
  readonly intents: IntentStore;
  readonly replies: OutboundReplyStore;
  readonly targets: ReplyTargets;
  readonly guards: ExecutionGuards;
  /** Records what happened in the SAME transaction as the transition (TA §13, §41): the composition writes the audit event. */
  readonly record: (event: IntentOutcomeEvent) => Promise<void>;
}

export interface IntentOutcomeEvent {
  readonly intent: MutationIntent;
  readonly actor: "executor" | "reconciliation";
  readonly status: IntentStatus;
  readonly code: IntentOutcomeCode | null;
  readonly attempt: number;
  readonly runReference: string;
  readonly at: Date;
}

export interface ExecutorDependencies {
  /** Opens ONE worker transaction bound to the intent's workspace; commits on return. */
  readonly inScope: <T>(work: (stores: ExecutorStores) => Promise<T>) => Promise<T>;
  readonly credentials: CredentialUse;
  readonly providers: MutationProviders;
  readonly clock: MutationClock;
}

export type ExecutionResult =
  | { readonly kind: "confirmed"; readonly providerReplyId: string | null }
  | { readonly kind: "failed"; readonly code: IntentOutcomeCode }
  | { readonly kind: "blocked"; readonly code: IntentOutcomeCode }
  | { readonly kind: "outcome_unknown"; readonly code: IntentOutcomeCode }
  /** Nothing to do: already terminal, or not this run's to execute. */
  | { readonly kind: "noop"; readonly status: IntentStatus | "missing" };

/** The roles whose catalog holds `reply.public` (platform/permissions): not grantable, so the role decides. */
export const ROLES_WITH_PUBLIC_REPLY: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "MANAGER", "RESPONDER"]);

/** One admitted transition with its history row and its audit record, all in the caller's transaction. */
export async function settle(
  stores: ExecutorStores,
  intent: MutationIntent,
  status: IntentStatus,
  code: IntentOutcomeCode | null,
  attempt: number,
  runReference: string,
  clock: MutationClock,
  actor: "executor" | "reconciliation" = "executor",
): Promise<void> {
  assertTransition(intent.status, status);
  if (code !== null && OUTCOME_STATUS[code] !== status) throw new TypeError(`outcome ${code} does not belong to ${status}`);
  const at = clock.now();
  await stores.intents.transition(intent.workspaceId, intent.id, { status, attempt, runReference, outcomeCode: code, at });
  await stores.intents.appendHistory(intent.workspaceId, intent.id, { id: clock.newId(), from: intent.status, to: status, attempt, actor, code, runReference, correlationId: intent.correlationId, at });
  await stores.record({ intent: { ...intent, status, attempt, runReference, outcomeCode: code, updatedAt: at }, actor, status, code, attempt, runReference, at });
}

type Admitted =
  | { readonly kind: "execute"; readonly intent: MutationIntent; readonly reply: OutboundReply; readonly target: { readonly providerInteractionId: string; readonly platform: string }; readonly provider: string }
  | { readonly kind: "done"; readonly result: ExecutionResult };

/** Step 1: lock, re-check, mark EXECUTING. Returns what to do next. */
async function admit(stores: ExecutorStores, workspaceId: string, intentId: string, runReference: string, clock: MutationClock): Promise<Admitted> {
  const intent = await stores.intents.lock(workspaceId, intentId);
  if (intent === undefined) return { kind: "done", result: { kind: "noop", status: "missing" } };
  if (intent.status === "EXECUTING") {
    // A run died, lost its response or was redelivered after EXECUTING committed: never a second send (R6).
    await settle(stores, intent, "OUTCOME_UNKNOWN", "RUN_INTERRUPTED", intent.attempt, runReference, clock);
    return { kind: "done", result: { kind: "outcome_unknown", code: "RUN_INTERRUPTED" } };
  }
  if (intent.status !== "PENDING") return { kind: "done", result: { kind: "noop", status: intent.status } };

  const attempt = intent.attempt + 1;
  const block = async (code: IntentOutcomeCode): Promise<Admitted> => {
    await settle(stores, intent, "BLOCKED", code, attempt, runReference, clock);
    return { kind: "done", result: { kind: "blocked", code } };
  };
  // The guard chain, live (TA §26.4): identity/permission → mode (consistent read) → account → switch → connection →
  // capability → target. Each refusal is recorded; nothing is sent.
  const role = await stores.guards.initiatorRole(intent.workspaceId, intent.initiatorUserId);
  if (role === undefined) return block("INITIATOR_NOT_MEMBER");
  if (!ROLES_WITH_PUBLIC_REPLY.has(role)) return block("PERMISSION_DENIED");
  if ((await stores.guards.workspaceMode(intent.workspaceId)) !== "STANDARD") return block("MODE_NOT_STANDARD");
  const account = await stores.guards.account(intent.connectedAccountId);
  if (account === undefined || account.status !== "ACTIVE") return block("ACCOUNT_INACTIVE");
  if (!(await stores.guards.providerActionsEnabled(account.platform))) return block("PROVIDER_ACTIONS_DISABLED");
  if (account.connectionStatus !== "ACTIVE" || account.credentialId === null) return block("CONNECTION_UNAVAILABLE");
  const target = await stores.targets.load(intent.targetInteractionId);
  if (target === undefined || !target.observed || target.presence !== "present" || target.ownAccount) return block("TARGET_NOT_PRESENT");
  const reply = await stores.replies.getByIntent(intent.workspaceId, intent.id);
  if (reply === undefined) return block("TARGET_NOT_PRESENT");
  // Authority coherence: the intent's account OWNS the target, and the outbound reply names exactly that target and
  // account (0027 enforces the same with composite keys; the executor refuses before any credential is opened).
  if (target.connectedAccountId !== intent.connectedAccountId || target.workspaceId !== intent.workspaceId) return block("TARGET_ACCOUNT_MISMATCH");
  if (reply.parentInteractionId !== intent.targetInteractionId || reply.connectedAccountId !== intent.connectedAccountId || reply.workspaceId !== intent.workspaceId) return block("TARGET_ACCOUNT_MISMATCH");
  // Capability for THIS target's content kind and reported source, never a generic scope.
  const capability = await stores.guards.replyCapability(intent.connectedAccountId, { contentKind: target.contentKind, reportedSource: target.reportedSource });
  if (capability.state !== "AVAILABLE" && capability.state !== "AVAILABLE_WITH_LIMITATION") return block("CAPABILITY_UNAVAILABLE");

  await settle(stores, intent, "EXECUTING", null, attempt, runReference, clock);
  return { kind: "execute", intent: { ...intent, status: "EXECUTING", attempt, runReference }, reply, target: { providerInteractionId: target.providerInteractionId, platform: target.platform }, provider: account.provider };
}

/**
 * Every provider failure ends recorded: there is no "retry" branch (one call per intent). Only the contract's DEFINITE
 * failures become FAILED; anything the contract does not classify may have followed a sent request, so it is
 * OUTCOME_UNKNOWN (conservative: a possible publication is never declared failed).
 */
export function classifyProviderError(error: unknown): { readonly status: "FAILED" | "OUTCOME_UNKNOWN"; readonly code: IntentOutcomeCode } {
  if (error instanceof OutcomeUnknownError) return { status: "OUTCOME_UNKNOWN", code: "RESPONSE_LOST" };
  if (error instanceof TargetNotFoundError) return { status: "FAILED", code: "TARGET_NOT_FOUND" };
  if (error instanceof TargetNotEligibleError) return { status: "FAILED", code: "TARGET_NOT_ELIGIBLE" };
  if (error instanceof PermanentRejectedError) return { status: "FAILED", code: "PROVIDER_REJECTED" };
  if (error instanceof PermissionMissingError) return { status: "FAILED", code: "PERMISSION_MISSING" };
  if (error instanceof CredentialInvalidError) return { status: "FAILED", code: "CREDENTIAL_INVALID" };
  if (error instanceof TransientError || error instanceof RateLimitedError) return { status: "FAILED", code: "PROVIDER_UNAVAILABLE" };
  return { status: "OUTCOME_UNKNOWN", code: "PROVIDER_ERROR_UNCLASSIFIED" };
}

/** Executes one intent for one run. Never throws for a provider failure; every path ends recorded. */
export async function executeIntent(deps: ExecutorDependencies, input: { readonly workspaceId: string; readonly intentId: string; readonly runReference: string }): Promise<ExecutionResult> {
  const admitted = await deps.inScope((stores) => admit(stores, input.workspaceId, input.intentId, input.runReference, deps.clock));
  if (admitted.kind === "done") return admitted.result;
  const { intent, reply, target, provider } = admitted;

  const finish = (status: IntentStatus, code: IntentOutcomeCode | null, receipt?: PublicReplyReceipt): Promise<ExecutionResult> =>
    deps.inScope(async (stores) => {
      const current = await stores.intents.lock(intent.workspaceId, intent.id);
      if (current === undefined) return { kind: "noop", status: "missing" };
      const providerReplyId = receipt?.createdInteraction?.id ?? null;
      // A verifiable receipt (the created reply's provider identity) confirms even after another run recorded
      // OUTCOME_UNKNOWN for this intent: the authorized OUTCOME_UNKNOWN → CONFIRMED transition, atomically, no new call.
      const lateReceipt = current.status === "OUTCOME_UNKNOWN" && status === "CONFIRMED" && providerReplyId !== null;
      if (current.status !== "EXECUTING" && !lateReceipt) return { kind: "noop", status: current.status };
      if (status === "CONFIRMED" && providerReplyId !== null) {
        const linked = await stores.replies.linkedIntent(intent.workspaceId, reply.platform, providerReplyId);
        if (linked !== undefined && linked !== intent.id) {
          // The platform's reply identity already belongs to another intent: never confirm the wrong row.
          if (current.status !== "EXECUTING") return { kind: "noop", status: current.status };
          await settle(stores, current, "OUTCOME_UNKNOWN", "REPLY_IDENTITY_CONFLICT", intent.attempt, input.runReference, deps.clock);
          return { kind: "outcome_unknown", code: "REPLY_IDENTITY_CONFLICT" };
        }
      }
      if (status === "CONFIRMED") await stores.replies.confirm(intent.workspaceId, intent.id, providerReplyId, deps.clock.now());
      await settle(stores, current, status, code, current.attempt, input.runReference, deps.clock);
      if (status === "CONFIRMED") return { kind: "confirmed", providerReplyId };
      if (status === "BLOCKED") return { kind: "blocked", code: code ?? "PROVIDER_MUTATION_UNSUPPORTED" };
      if (status === "OUTCOME_UNKNOWN") return { kind: "outcome_unknown", code: code ?? "RESPONSE_LOST" };
      return { kind: "failed", code: code ?? "PROVIDER_FAILURE" };
    });

  const port = deps.providers.mutation(provider);
  if (port === undefined || !isPlatformKey(target.platform)) return finish("BLOCKED", "PROVIDER_MUTATION_UNSUPPORTED");
  const platform = target.platform;

  let receipt: PublicReplyReceipt;
  try {
    receipt = await deps.credentials.withAccess({ workspaceId: intent.workspaceId, connectedAccountId: intent.connectedAccountId }, async (access) => {
      const result = await port.replyPublicly(access, providerObjectRef(platform, "interaction", target.providerInteractionId), reply.text, { key: `${intent.workspaceId}:${intent.id}` });
      return result.data;
    });
  } catch (error) {
    if (error instanceof CredentialUnreadable) return finish("BLOCKED", "CREDENTIAL_UNREADABLE");
    const outcome = classifyProviderError(error);
    return finish(outcome.status, outcome.code);
  }
  return finish("CONFIRMED", null, receipt);
}

/** The composition raises this when the credential cannot be opened BEFORE any provider call. */
export class CredentialUnreadable extends Error {
  override readonly name = "CredentialUnreadable";
  constructor() {
    super("mutation executor: credential unreadable");
  }
}
