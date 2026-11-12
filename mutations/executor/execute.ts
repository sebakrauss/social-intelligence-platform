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
 *
 * Step 7B-14G1 — an intent that names a one-time validation authorization (0028) runs through the SAME chain; only two
 * barriers may be stood in for, decided by decideValidationAdmission on live reads (a missing provider-action grant —
 * never a pause or the emergency block — and a catalog that has not validated reply_public — never any other state).
 * Three additions apply to such an intent only (an ordinary intent's path is unchanged):
 *   - before EXECUTING: the authorization is re-read and must be bound to THIS never-attempted intent, unrevoked,
 *     unexpired (database clock), unconsumed, its target never validated before; and the credential must be
 *     authorizable (PRE-LIVE-2) — so a refusal is BLOCKED from PENDING and the authorization is NOT spent;
 *   - if the EXECUTING commit itself is refused (a revocation or an expiry that landed after the check — the 0028
 *     consume trigger raises — or a second consumption for the target — the unique index raises): a NEW transaction
 *     re-reads, and records BLOCKED only when the database now shows the authorization no longer admits the intent;
 *     anything else is re-thrown untouched (never a fictitious revocation), and the intent stays PENDING (F, X2);
 *   - after EXECUTING, twice — before the credential is opened, and (Step 7B-14H1) again after the key service handed it
 *     over and before the request leaves — one short transaction re-checks the whole chain on live reads (sendGate): the
 *     row is still exactly this run's EXECUTING (X1), the authorization this intent's consumed one, the initiator, the
 *     mode, the account and connection, no pause or emergency block, the target, the capability and (after opening)
 *     the opened credential still the account's authorized one (PRE-LIVE-1). Otherwise nothing is sent. A check that
 *     cannot be completed fails closed: no call and no recorded refusal (the row stays for reconciliation).
 *     Residual (cannot be closed without holding a transaction across the HTTP call): a change committed after the
 *     second gate's reads, while the request is leaving, does not recall it.
 *   - Step 7B-14I3H (H1) — before EXECUTING and in both gates: the account's authorized credential (and, after opening,
 *     the opened one) must be EXACTLY the credential the authorization's PREFLIGHT examined, as the database persisted and
 *     linked that evidence (never a value from a payload or a browser). A replaced credential, another connection, or
 *     missing / foreign / inconsistent evidence sends nothing (before EXECUTING: BLOCKED from PENDING, nothing spent).
 * Consumption is the 0028 trigger's, in the EXECUTING transaction; once consumed it is never re-armed: an uncertain
 * outcome stays OUTCOME_UNKNOWN (reconciliation looks, never resends), and nothing returns an intent to PENDING.
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
import { assertTransition, publicReplyDepthAllowed, type IntentOutcomeCode, type IntentStatus, type MutationIntent, OUTCOME_STATUS } from "../domain/intent";
import { decideFinalSend, decideValidationAdmission, examinedCredentialRefusal, isThisRunsExecution, validationNoLongerAdmits, type FinalSendDecision, type ValidationAuthorizationReading } from "../domain/validation-authorization";
import type { CredentialUse, ExecutionGuards, IntentStore, MutationClock, MutationProviders, OpenedCredential, OutboundReply, OutboundReplyStore, ProviderActionDecision, ReplyTarget, ReplyTargets, ValidationExecutionReads } from "../ports";

export interface ExecutorStores {
  readonly intents: IntentStore;
  readonly replies: OutboundReplyStore;
  readonly targets: ReplyTargets;
  readonly guards: ExecutionGuards;
  /** Records what happened in the SAME transaction as the transition (TA §13, §41): the composition writes the audit event. */
  readonly record: (event: IntentOutcomeEvent) => Promise<void>;
  /** Step 7B-14G1: the validation reads; absent → an intent naming an authorization is BLOCKED (fail closed). */
  readonly validation?: ValidationExecutionReads;
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
  await stores.intents.transition(intent.workspaceId, intent.id, { from: intent.status, status, attempt, runReference, outcomeCode: code, at });
  await stores.intents.appendHistory(intent.workspaceId, intent.id, { id: clock.newId(), from: intent.status, to: status, attempt, actor, code, runReference, correlationId: intent.correlationId, at });
  await stores.record({ intent: { ...intent, status, attempt, runReference, outcomeCode: code, updatedAt: at }, actor, status, code, attempt, runReference, at });
}

type Admitted =
  | { readonly kind: "execute"; readonly intent: MutationIntent; readonly reply: OutboundReply; readonly target: { readonly providerInteractionId: string; readonly platform: string }; readonly provider: string; readonly accountPlatform: string }
  | { readonly kind: "done"; readonly result: ExecutionResult };

/**
 * Step 7B-14G1 — the validation verdict for an authorized intent, on live reads in the admit transaction: undefined
 * admits; otherwise the closed BLOCKED code. The authorization is read, never locked (the runtimes hold SELECT only):
 * the 0028 consume trigger locks it, after this intent's row — the order every path keeps.
 */
async function validationVerdict(
  validation: ValidationExecutionReads,
  intent: MutationIntent & { readonly validationAuthorizationId: string },
  reading: ValidationAuthorizationReading | undefined,
  account: { readonly provider: string; readonly platform: string },
  target: ReplyTarget,
  providerAction: ProviderActionDecision,
  usable: boolean,
): Promise<IntentOutcomeCode | undefined> {
  const scope = { contentKind: target.contentKind, reportedSource: target.reportedSource };
  const decision = decideValidationAdmission({
    phase: "execution",
    subject: { intentId: intent.id, organizationId: intent.organizationId, workspaceId: intent.workspaceId, connectedAccountId: intent.connectedAccountId, targetInteractionId: intent.targetInteractionId, initiatorUserId: intent.initiatorUserId, kind: intent.kind, attempt: intent.attempt },
    reading,
    account,
    targetPlatform: target.platform,
    providerAction,
    capability: { usable, catalogValidationPending: usable ? false : await validation.catalogValidationPending(intent.connectedAccountId, scope) },
    consumedElsewhere: await validation.consumedElsewhere(intent.workspaceId, intent.targetInteractionId, intent.validationAuthorizationId),
  });
  if (decision.kind === "admit") return undefined;
  return decision.reason === "provider_action" ? "PROVIDER_ACTIONS_DISABLED" : decision.reason === "capability" ? "CAPABILITY_UNAVAILABLE" : "VALIDATION_AUTHORIZATION_UNAVAILABLE";
}

/** Step 1: lock, re-check, mark EXECUTING. Returns what to do next. `seen` tells the caller whether the locked intent is authorized. */
async function admit(stores: ExecutorStores, workspaceId: string, intentId: string, runReference: string, clock: MutationClock, seen: { authorized: boolean }): Promise<Admitted> {
  const intent = await stores.intents.lock(workspaceId, intentId);
  if (intent === undefined) return { kind: "done", result: { kind: "noop", status: "missing" } };
  if (intent.status === "EXECUTING") {
    // A run died, lost its response or was redelivered after EXECUTING committed: never a second send (R6).
    await settle(stores, intent, "OUTCOME_UNKNOWN", "RUN_INTERRUPTED", intent.attempt, runReference, clock);
    return { kind: "done", result: { kind: "outcome_unknown", code: "RUN_INTERRUPTED" } };
  }
  if (intent.status !== "PENDING") return { kind: "done", result: { kind: "noop", status: intent.status } };
  const authorizationId = intent.validationAuthorizationId;
  seen.authorized = authorizationId !== null;

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
  // Re-checked here, in the transaction that would commit EXECUTING, before any credential is opened (Step 7B-12A).
  // An authorized intent defers the decision to the validation verdict below (which still refuses a pause).
  const providerAction = await stores.guards.providerActionAllowed(account.platform, "public_reply");
  if (authorizationId === null && providerAction !== "allowed") return block("PROVIDER_ACTIONS_DISABLED");
  if (account.connectionStatus !== "ACTIVE" || account.credentialId === null) return block("CONNECTION_UNAVAILABLE");
  const target = await stores.targets.load(intent.targetInteractionId);
  if (target === undefined || !target.observed || target.presence !== "present" || target.ownAccount) return block("TARGET_NOT_PRESENT");
  // Step 7B-13C (F1): re-checked on the persisted target at execution (a queued or redelivered intent never skips it).
  if (!publicReplyDepthAllowed(target)) return block("TARGET_NOT_REPLYABLE");
  const reply = await stores.replies.getByIntent(intent.workspaceId, intent.id);
  if (reply === undefined) return block("TARGET_NOT_PRESENT");
  // Authority coherence: the intent's account OWNS the target, and the outbound reply names exactly that target and
  // account (0027 enforces the same with composite keys; the executor refuses before any credential is opened).
  if (target.connectedAccountId !== intent.connectedAccountId || target.workspaceId !== intent.workspaceId) return block("TARGET_ACCOUNT_MISMATCH");
  if (reply.parentInteractionId !== intent.targetInteractionId || reply.connectedAccountId !== intent.connectedAccountId || reply.workspaceId !== intent.workspaceId) return block("TARGET_ACCOUNT_MISMATCH");
  // Capability for THIS target's content kind and reported source, never a generic scope.
  const capability = await stores.guards.replyCapability(intent.connectedAccountId, { contentKind: target.contentKind, reportedSource: target.reportedSource });
  const usable = capability.state === "AVAILABLE" || capability.state === "AVAILABLE_WITH_LIMITATION";
  if (authorizationId === null) {
    if (!usable) return block("CAPABILITY_UNAVAILABLE");
  } else {
    // Step 7B-14G1: the bounded exception, re-decided on live reads; then PRE-LIVE-2 before anything is spent.
    if (stores.validation === undefined) return block("VALIDATION_AUTHORIZATION_UNAVAILABLE");
    const reading = await stores.validation.authorization(intent.workspaceId, authorizationId);
    const verdict = await validationVerdict(stores.validation, { ...intent, validationAuthorizationId: authorizationId }, reading, account, target, providerAction, usable);
    if (verdict !== undefined) return block(verdict);
    if (!(await stores.validation.credentialReady(intent.workspaceId, intent.connectedAccountId))) return block("CREDENTIAL_UNREADABLE");
    // Step 7B-14I3H (H1): the credential that would be opened is exactly the one the authorization's PREFLIGHT examined
    // (persisted evidence, linked by the database) — refused here, from PENDING, before anything is spent.
    if (reading === undefined) return block("VALIDATION_AUTHORIZATION_UNAVAILABLE");
    const examined = examinedCredentialRefusal({
      authorization: reading.authorization,
      preflight: await stores.validation.examinedCredential(intent.workspaceId, authorizationId),
      active: await stores.validation.activeCredential(intent.workspaceId, intent.connectedAccountId),
      accountCredentialId: account.credentialId,
    });
    if (examined !== undefined) return block(examined);
  }

  // For an authorized intent, 0028's consume trigger spends the authorization in THIS update, before the call (R6).
  await settle(stores, intent, "EXECUTING", null, attempt, runReference, clock);
  return { kind: "execute", intent: { ...intent, status: "EXECUTING", attempt, runReference }, reply, target: { providerInteractionId: target.providerInteractionId, platform: target.platform }, provider: account.provider, accountPlatform: account.platform };
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

/**
 * Step 7B-14G1 (F, X2): the EXECUTING commit of an AUTHORIZED intent was refused. In a NEW transaction, re-lock the
 * intent and re-read the authorization: when the database now shows that it no longer admits this intent (revoked,
 * expired, consumed, rebound, or its target validated by another), record BLOCKED from PENDING — nothing was sent and
 * nothing was spent. Otherwise answer undefined: the caller re-throws the original error (an infrastructure failure is
 * never recorded as a revocation), and the intent stays PENDING as it was.
 */
async function blockRefusedValidation(stores: ExecutorStores, input: { readonly workspaceId: string; readonly intentId: string; readonly runReference: string }, clock: MutationClock): Promise<ExecutionResult | undefined> {
  const intent = await stores.intents.lock(input.workspaceId, input.intentId);
  if (intent === undefined || intent.status !== "PENDING" || intent.validationAuthorizationId === null || stores.validation === undefined) return undefined;
  const reading = await stores.validation.authorization(intent.workspaceId, intent.validationAuthorizationId);
  const consumedElsewhere = await stores.validation.consumedElsewhere(intent.workspaceId, intent.targetInteractionId, intent.validationAuthorizationId);
  if (!validationNoLongerAdmits(reading, intent.id, consumedElsewhere)) return undefined;
  await settle(stores, intent, "BLOCKED", "VALIDATION_AUTHORIZATION_UNAVAILABLE", intent.attempt + 1, input.runReference, clock);
  return { kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" };
}

/** The opened credential as the final gate compares it (identifiers only). */
interface OpenedForCall {
  readonly credentialId: string | undefined;
  readonly platform: string;
  readonly providerAssetId: string;
}

/**
 * Step 7B-14G1 / 7B-14H1 (PRE-LIVE-1, X1): one short transaction immediately before the ONE provider call of an
 * AUTHORIZED intent, run twice — before the credential is opened, and again after the key service handed it over and
 * before the request leaves (`opened` given). It re-reads, live: the row (still exactly this run's EXECUTING, same
 * attempt, run reference and authorization — otherwise nothing is sent and the row is left to reconciliation), the
 * authorization (this intent's, consumed, unrevoked, unexpired), the initiator's role, the workspace mode (SHARE-locked
 * by the definer), the account and its connection, the exact provider-action decision (a pause or the emergency block
 * vetoes; only a missing grant is stood in for), the persisted target, the capability, and — after opening — that the
 * opened credential is still the account's authorized credential. A refusal ends BLOCKED (EXECUTING →
 * BLOCKED, admitted by 0027 and 0028) with no call; the authorization stays consumed (never re-armed).
 * undefined: proceed. A failed READ throws (never a refusal): the caller fails closed without recording anything.
 * The transaction commits BEFORE the request: nothing is held open across the provider call.
 */
async function sendGate(stores: ExecutorStores, intent: MutationIntent, accountPlatform: string, runReference: string, clock: MutationClock, opened?: OpenedForCall): Promise<ExecutionResult | undefined> {
  const current = await stores.intents.lock(intent.workspaceId, intent.id);
  if (current === undefined) return { kind: "noop", status: "missing" };
  const authorizationId = intent.validationAuthorizationId;
  if (authorizationId === null) return { kind: "noop", status: current.status };
  const expected = {
    intentId: intent.id,
    organizationId: intent.organizationId,
    workspaceId: intent.workspaceId,
    connectedAccountId: intent.connectedAccountId,
    targetInteractionId: intent.targetInteractionId,
    initiatorUserId: intent.initiatorUserId,
    validationAuthorizationId: authorizationId,
    attempt: intent.attempt,
    runReference,
    accountPlatform,
  };
  // X1 first: a row that is no longer this run's is never touched further (no other read, nothing recorded).
  if (!isThisRunsExecution(expected, current)) return { kind: "noop", status: current.status };
  const validation = stores.validation;
  let decision: FinalSendDecision;
  if (validation === undefined) {
    decision = { kind: "refuse", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" };
  } else {
    const target = await stores.targets.load(intent.targetInteractionId);
    const scope = target === undefined ? undefined : { contentKind: target.contentKind, reportedSource: target.reportedSource };
    const capability = scope === undefined ? undefined : await stores.guards.replyCapability(intent.connectedAccountId, scope);
    const usable = capability !== undefined && (capability.state === "AVAILABLE" || capability.state === "AVAILABLE_WITH_LIMITATION");
    const active = await validation.activeCredential(intent.workspaceId, intent.connectedAccountId);
    decision = decideFinalSend({
      expected,
      current,
      reading: await validation.authorization(intent.workspaceId, authorizationId),
      consumedElsewhere: await validation.consumedElsewhere(intent.workspaceId, intent.targetInteractionId, authorizationId),
      initiatorRole: await stores.guards.initiatorRole(intent.workspaceId, intent.initiatorUserId),
      replyingRoles: ROLES_WITH_PUBLIC_REPLY,
      mode: await stores.guards.workspaceMode(intent.workspaceId),
      account: await stores.guards.account(intent.connectedAccountId),
      providerAction: await stores.guards.providerActionAllowed(accountPlatform, "public_reply"),
      target:
        target === undefined
          ? undefined
          : {
              present: target.observed && target.presence === "present" && !target.ownAccount,
              replyable: publicReplyDepthAllowed(target),
              connectedAccountId: target.connectedAccountId,
              workspaceId: target.workspaceId,
              platform: target.platform,
            },
      capability: { usable, catalogValidationPending: usable || scope === undefined ? false : await validation.catalogValidationPending(intent.connectedAccountId, scope) },
      // Step 7B-14I3H (H1): the evidence linked to the authorization and the account's authorized credential, live.
      examined: { preflight: await validation.examinedCredential(intent.workspaceId, authorizationId), active },
      ...(opened === undefined ? {} : { credential: { opened, active } }),
    });
  }
  if (decision.kind === "send") return undefined;
  if (decision.kind === "not_this_run") return { kind: "noop", status: current.status };
  await settle(stores, current, "BLOCKED", decision.code, current.attempt, runReference, clock);
  return { kind: "blocked", code: decision.code };
}

/** What the credential callback answers: the call was made (receipt), or it was not (a recorded result, or a failed check). */
type CallOutcome =
  | { readonly sent: true; readonly receipt: PublicReplyReceipt }
  | { readonly sent: false; readonly result: ExecutionResult }
  | { readonly sent: false; readonly checkFailed: unknown };

/** Executes one intent for one run. Never throws for a provider failure; every path ends recorded. */
export async function executeIntent(deps: ExecutorDependencies, input: { readonly workspaceId: string; readonly intentId: string; readonly runReference: string }): Promise<ExecutionResult> {
  const seen = { authorized: false };
  let admitted: Admitted;
  try {
    admitted = await deps.inScope((stores) => admit(stores, input.workspaceId, input.intentId, input.runReference, deps.clock, seen));
  } catch (error) {
    // An ordinary intent's failure propagates exactly as before.
    if (!seen.authorized) throw error;
    const recovered = await deps.inScope((stores) => blockRefusedValidation(stores, input, deps.clock)).catch(() => undefined);
    if (recovered === undefined) throw error;
    return recovered;
  }
  if (admitted.kind === "done") return admitted.result;
  const { intent, reply, target, provider, accountPlatform } = admitted;

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

  // The port for the account's provider AND platform — the pair the authorization was asked for (Step 7B-13A).
  const port = deps.providers.mutation(provider, accountPlatform);
  if (port === undefined || !isPlatformKey(target.platform)) return finish("BLOCKED", "PROVIDER_MUTATION_UNSUPPORTED");
  const platform = target.platform;

  const authorized = intent.validationAuthorizationId !== null;
  if (authorized) {
    // Before the credential is opened: nothing is decrypted for an intent that may no longer be sent.
    const gate = await deps.inScope((stores) => sendGate(stores, intent, accountPlatform, input.runReference, deps.clock));
    if (gate !== undefined) return gate;
  }

  let call: CallOutcome;
  try {
    call = await deps.credentials.withAccess({ workspaceId: intent.workspaceId, connectedAccountId: intent.connectedAccountId }, async (access, opened): Promise<CallOutcome> => {
      if (authorized) {
        // Step 7B-14H1 (PRE-LIVE-1): the key service has handed the credential over; the request has NOT left. One more
        // short transaction (committed before the call) re-reads everything that may have changed meanwhile.
        // An opener that (against its contract) names no credential is refused by the gate, never trusted.
        const openedId = (opened as OpenedCredential | undefined)?.credentialId;
        let gate: ExecutionResult | undefined;
        try {
          gate = await deps.inScope((stores) =>
            sendGate(stores, intent, accountPlatform, input.runReference, deps.clock, { credentialId: openedId, platform: access.account.platform, providerAssetId: access.account.id }),
          );
        } catch (error) {
          // The check could not be completed: fail closed — no call, no refusal recorded (never a fictitious
          // revocation), no new attempt. The intent stays this run's EXECUTING for reconciliation (a redelivery records
          // OUTCOME_UNKNOWN / RUN_INTERRUPTED and sends nothing).
          return { sent: false, checkFailed: error };
        }
        if (gate !== undefined) return { sent: false, result: gate };
      }
      const result = await port.replyPublicly(access, providerObjectRef(platform, "interaction", target.providerInteractionId), reply.text, { key: `${intent.workspaceId}:${intent.id}` });
      return { sent: true, receipt: result.data };
    });
  } catch (error) {
    if (error instanceof CredentialUnreadable) return finish("BLOCKED", "CREDENTIAL_UNREADABLE");
    const outcome = classifyProviderError(error);
    return finish(outcome.status, outcome.code);
  }
  if (call.sent) return finish("CONFIRMED", null, call.receipt);
  if ("checkFailed" in call) throw call.checkFailed;
  return call.result;
}

/** The composition raises this when the credential cannot be opened BEFORE any provider call. */
export class CredentialUnreadable extends Error {
  override readonly name = "CredentialUnreadable";
  constructor() {
    super("mutation executor: credential unreadable");
  }
}
