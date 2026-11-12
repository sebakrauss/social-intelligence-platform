/**
 * INTEGRATION-plane operator reconciliation of ONE authorized Instagram public-reply intent (Step 7B-14I2; DEV only). The
 * controlled vehicle that runs the EXISTING reconciler (mutations/executor/reconcile.ts) for an intent left EXECUTING
 * without an outcome or recorded OUTCOME_UNKNOWN — LOOK, never resend:
 *
 *   guards (release, plane, tier, runtime, provider mode, keyring, acknowledgement) → read-only candidate check (worker
 *   scope, the payload's ONE workspace) → composeInstagramReplyReconciliation (the read diagnostics' opener, worker
 *   identity, ONE KMS attempt, the Meta read-only own-reply lookup) → reconcileIntent
 *
 * It is NOT a product task: absent from the task registry (the outbox can never route to it), no schedule, no hook, no
 * UI, no endpoint; it runs only when an operator triggers it by id, and every guard runs before anything AWS- or
 * provider-capable is built. It never holds the write transport, a mutation port or the executor's send path: the only
 * provider calls are Graph GETs. The only writes are the reconciler's own, each with its history row and audit event in
 * the same transaction: EXECUTING → OUTCOME_UNKNOWN (RUN_INTERRUPTED), and OUTCOME_UNKNOWN → CONFIRMED on exactly ONE
 * unambiguous match from a COMPLETE listing. Nothing else is ever concluded (a negative or incomplete lookup keeps the
 * outcome unknown; it never becomes FAILED, and nothing is re-sent).
 *
 *   input      exactly { acknowledge, workspace_id, mutation_intent_id } — internal UUIDs only
 *   candidate  an AUTHORIZED intent (0028) of a Meta Instagram account, EXECUTING for at least 15 minutes by the database
 *              clock (a run may still be in flight before that) or OUTCOME_UNKNOWN; anything else is refused or a no-op
 *
 * Retry: ONE task attempt and ONE KMS attempt. A repeated run is safe: CONFIRMED is terminal (no-op), and an intent that
 * stays OUTCOME_UNKNOWN is only looked at again.
 */
import { randomUUID } from "node:crypto";
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { isPlatformKey } from "@/domain/platforms";
import { parseProviderObjectId, providerObjectRef, type ProviderAccess } from "@/integrations/providers/contract";
import type { InstagramReplyLookup } from "@/integrations/providers/meta/instagram-reply-lookup";
import type { ProviderCredentialAccess } from "@/modules/connections";
import { CredentialUnreadable } from "@/mutations/executor/execute";
import { reconcileIntent, type ReconcileResult } from "@/mutations/executor/reconcile";
import type { CredentialUse, MutationClock, ReplyLookup } from "@/mutations/ports";
import { withWorkspaceJobScope, type DatabaseTransaction } from "@/platform/db";
import { NonRetryableJobError, type JobRelease } from "@/platform/jobs";
import { selectCredentialCrypto } from "@/server/connections/environment";
import { PROVIDER_MODE_VARIABLES } from "@/server/connections/provider-mode";
import { credentialAuthority, executorStores, reconciliationCandidate, type ReconciliationCandidate } from "@/server/persistence/mutation-execution";
import { composeInstagramReplyReconciliation } from "./connections";
import { planeEnvironmentProblems } from "./plane-environment";
import { workerDatabase } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;

export const MUTATION_RECONCILE_TASK_ID = "integration.mutation_reconcile";
export const MUTATION_RECONCILE_ACKNOWLEDGEMENT = "INTEGRATION_MUTATION_RECONCILE_V1";
/** The only deployment tier and Trigger.dev environment type accepted (the read diagnostics' DEV tier). */
export const MUTATION_RECONCILE_TIER = "staging";
export const MUTATION_RECONCILE_TRIGGER_ENVIRONMENT = "PRODUCTION";
/** An EXECUTING intent younger than this may still have its run in flight: never looked at. */
export const MUTATION_RECONCILE_MIN_EXECUTING_AGE_SECONDS = 15 * 60;
export const MUTATION_RECONCILE_AWS_ATTEMPTS = Object.freeze({ maxAttempts: 1 } as const);

const PAYLOAD_FIELDS = ["acknowledge", "workspace_id", "mutation_intent_id"] as const;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const MUTATION_RECONCILE_FAILURES = [
  "mutation_reconcile_input_refused",
  "mutation_reconcile_release_refused",
  "mutation_reconcile_plane_refused",
  "mutation_reconcile_tier_refused",
  "mutation_reconcile_runtime_refused",
  "mutation_reconcile_provider_mode_refused",
  "mutation_reconcile_keyring_refused",
  "mutation_reconcile_intent_not_found",
  "mutation_reconcile_intent_not_authorized",
  "mutation_reconcile_intent_not_instagram",
  "mutation_reconcile_intent_in_flight",
  "mutation_reconcile_failed",
] as const;
export type MutationReconcileFailure = (typeof MUTATION_RECONCILE_FAILURES)[number];

export class MutationReconcileError extends NonRetryableJobError {
  readonly failure: MutationReconcileFailure;
  constructor(failure: MutationReconcileFailure) {
    super(failure);
    this.failure = failure;
  }
}

const refuse = (failure: MutationReconcileFailure): never => {
  throw new MutationReconcileError(failure);
};

export interface MutationReconcileRun {
  readonly environmentType: string | undefined;
  readonly release: JobRelease;
  readonly runId: string;
}

export interface MutationReconcileInput {
  readonly workspaceId: WorkspaceId;
  readonly intentId: string;
}

/** The ONLY output: the reconciler's closed answer — never a provider id, text or token. */
export type MutationReconcileOutcome =
  | { readonly result: "confirmed" }
  | { readonly result: "still_unknown"; readonly reason: Extract<ReconcileResult, { kind: "still_unknown" }>["reason"] }
  | { readonly result: "noop"; readonly status: string };

export interface MutationReconcileDependencies {
  readonly nodeVersion: string;
  readonly candidate: (input: MutationReconcileInput) => Promise<ReconciliationCandidate | undefined>;
  readonly compose: (environment: Environment) => { readonly access: ProviderCredentialAccess; readonly lookup: InstagramReplyLookup };
  /** Runs ONE worker transaction bound to the input's workspace. */
  readonly inScope: <T>(workspaceId: WorkspaceId, work: (tx: DatabaseTransaction) => Promise<T>) => Promise<T>;
  readonly clock: MutationClock;
}

export function parseMutationReconcileInput(payload: unknown): MutationReconcileInput {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return refuse("mutation_reconcile_input_refused");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PAYLOAD_FIELDS.length || !PAYLOAD_FIELDS.every((field) => keys.includes(field))) return refuse("mutation_reconcile_input_refused");
  if (record["acknowledge"] !== MUTATION_RECONCILE_ACKNOWLEDGEMENT) return refuse("mutation_reconcile_input_refused");
  const workspaceId = parseWorkspaceId(record["workspace_id"]);
  const intentId = record["mutation_intent_id"];
  if (workspaceId === undefined || !isUuid(intentId)) return refuse("mutation_reconcile_input_refused");
  return Object.freeze({ workspaceId, intentId });
}

/** Every precondition, in order, before anything AWS- or provider-capable exists (the preflight diagnostic's guards). */
export function assertMutationReconcilePreconditions(payload: unknown, run: MutationReconcileRun, environment: Environment, nodeVersion: string): MutationReconcileInput {
  const input = parseMutationReconcileInput(payload);
  if (run.environmentType !== MUTATION_RECONCILE_TRIGGER_ENVIRONMENT || run.release.kind !== "pinned" || !RUN_ID.test(run.runId)) refuse("mutation_reconcile_release_refused");
  if (planeEnvironmentProblems("integration", run.release, environment).length > 0) refuse("mutation_reconcile_plane_refused");
  if (environment[PROVIDER_MODE_VARIABLES.tier] !== MUTATION_RECONCILE_TIER) refuse("mutation_reconcile_tier_refused");
  if (!nodeVersion.startsWith("v22.")) refuse("mutation_reconcile_runtime_refused");
  if ((environment[PROVIDER_MODE_VARIABLES.mode] ?? "") !== "") refuse("mutation_reconcile_provider_mode_refused");
  let kms: boolean;
  try {
    kms = selectCredentialCrypto(environment).kind === "kms";
  } catch {
    return refuse("mutation_reconcile_keyring_refused");
  }
  if (!kms) refuse("mutation_reconcile_keyring_refused");
  return input;
}

/** The candidate's verdict (pure): proceed, a closed no-op, or a refusal. */
export function classifyReconciliationCandidate(candidate: ReconciliationCandidate | undefined): { readonly kind: "proceed" } | { readonly kind: "noop"; readonly status: string } | { readonly kind: "refuse"; readonly failure: MutationReconcileFailure } {
  if (candidate === undefined) return { kind: "refuse", failure: "mutation_reconcile_intent_not_found" };
  if (!candidate.authorized) return { kind: "refuse", failure: "mutation_reconcile_intent_not_authorized" };
  if (candidate.provider !== "meta" || candidate.platform !== "instagram") return { kind: "refuse", failure: "mutation_reconcile_intent_not_instagram" };
  if (candidate.status === "OUTCOME_UNKNOWN") return { kind: "proceed" };
  if (candidate.status === "EXECUTING") {
    return candidate.ageSeconds >= MUTATION_RECONCILE_MIN_EXECUTING_AGE_SECONDS ? { kind: "proceed" } : { kind: "refuse", failure: "mutation_reconcile_intent_in_flight" };
  }
  return { kind: "noop", status: candidate.status };
}

/** The reconciler's lookup over the Meta own-reply reader: Instagram account and comment refs only, nothing else. */
export function instagramReplyLookupPort(lookup: InstagramReplyLookup): ReplyLookup {
  return {
    async findOwnReply(access, target, text, since) {
      const instagramAccountId = parseProviderObjectId(access.account.id);
      const commentId = parseProviderObjectId(target.parent.id);
      if (access.account.platform !== "instagram" || target.parent.platform !== "instagram" || instagramAccountId === undefined || commentId === undefined) return { kind: "incomplete" };
      const found = await lookup.find(access.credential, { instagramAccountId, commentId }, text, since);
      return found.kind === "unique_match" ? { kind: "found", providerReplyId: found.replyId } : found;
    },
  };
}

/** The credential use for reads: the authority re-read in a worker transaction, opened outside it, once per look. */
function readCredentialUse(deps: MutationReconcileDependencies, workspaceId: WorkspaceId, access: ProviderCredentialAccess): CredentialUse {
  return {
    async withAccess(input, use) {
      const authority = await deps.inScope(workspaceId, (tx) => credentialAuthority(tx, input));
      if (authority === undefined || !isPlatformKey(authority.platform)) throw new CredentialUnreadable();
      const account = providerObjectRef(authority.platform, "asset", authority.providerAssetId);
      return access.withCredential({ workspaceId: authority.workspaceId, credentialId: authority.credentialId, envelope: authority.envelope }, (credential) => {
        const providerAccess: ProviderAccess = { credential, account };
        return use(providerAccess, { credentialId: authority.credentialId });
      });
    },
  };
}

const PRODUCTION: MutationReconcileDependencies = Object.freeze({
  nodeVersion: process.version,
  candidate: (input: MutationReconcileInput) => withWorkspaceJobScope(workerDatabase(), input.workspaceId, (tx) => reconciliationCandidate(tx, input.workspaceId, input.intentId)),
  compose: (environment: Environment) => composeInstagramReplyReconciliation(environment, MUTATION_RECONCILE_AWS_ATTEMPTS),
  inScope: <T>(workspaceId: WorkspaceId, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(workerDatabase(), workspaceId, work),
  clock: { newId: randomUUID, now: () => new Date() },
});

/** The task: guards, the candidate check, then the EXISTING reconciler with a read-only lookup. Never a send. */
export async function runMutationReconcile(payload: unknown, run: MutationReconcileRun, environment: Environment, overrides: Partial<MutationReconcileDependencies> = {}): Promise<MutationReconcileOutcome> {
  const deps: MutationReconcileDependencies = { ...PRODUCTION, ...overrides };
  const input = assertMutationReconcilePreconditions(payload, run, environment, deps.nodeVersion);
  let candidate: ReconciliationCandidate | undefined;
  try {
    candidate = await deps.candidate(input);
  } catch {
    return refuse("mutation_reconcile_failed");
  }
  const verdict = classifyReconciliationCandidate(candidate);
  if (verdict.kind === "refuse") return refuse(verdict.failure);
  if (verdict.kind === "noop") return Object.freeze({ result: "noop", status: verdict.status });

  let result: ReconcileResult;
  try {
    const { access, lookup } = deps.compose(environment);
    result = await reconcileIntent(
      {
        inScope: (work) => deps.inScope(input.workspaceId, (tx) => work(executorStores({ tx }, deps.clock.newId))),
        credentials: readCredentialUse(deps, input.workspaceId, access),
        lookup: instagramReplyLookupPort(lookup),
        clock: deps.clock,
      },
      { workspaceId: input.workspaceId, intentId: input.intentId, runReference: run.runId },
    );
  } catch {
    return refuse("mutation_reconcile_failed");
  }
  if (result.kind === "confirmed") return Object.freeze({ result: "confirmed" });
  if (result.kind === "still_unknown") return Object.freeze({ result: "still_unknown", reason: result.reason });
  return Object.freeze({ result: "noop", status: result.status });
}
