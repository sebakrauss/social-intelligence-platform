/**
 * The EXECUTION side of the Platform Mutation Executor over ONE bound worker transaction (Step 7B-1; TA §26.3 right
 * column, §26.4). Composed only by the job runtime (jobs/mutations.ts): the web never imports this file (pinned by
 * tests/architecture/mutation-boundary-guards.test.ts). It adds, over the shared request-side helpers:
 *   - the worker's transition stores (0027 grants: status/attempt/run/outcome on intents, append on history,
 *     confirmation on replies);
 *   - the executor's live re-checks: the initiator's CURRENT role through 0027's definer, the workspace mode under a
 *     SHARE lock on the bound workspace row through 0027's definer (the same transaction as the EXECUTING transition:
 *     a concurrent mode change is either seen or waits), the switches, the account/connection and the capability
 *     resolver scoped to the target's content;
 *   - the audit record of each outcome, actor `system`, identifiers and closed codes only — in the SAME transaction
 *     as the transition it records (TA §13, §41);
 *   - the credential authority read (connection → active credential → envelope) the job's credential use opens
 *     OUTSIDE any transaction (TA §39);
 *   - Step 7B-14G1: the validation reads (0028, read-only): the shared ones, plus whether another authorization already
 *     validated the target and whether the credential would be authorized (PRE-LIVE-2) — both read in the admit
 *     transaction before anything is spent. Nothing here writes an authorization.
 */
import { createAuditEvent, type AuditLog } from "@/modules/audit";
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { ConnectionWorkerStore } from "@/modules/connections";
import { createPostgresConnectionWorkerStore } from "@/modules/connections/persistence";
import type { WorkspaceId } from "@/domain/ids";
import type { ExecutorStores, IntentOutcomeEvent } from "@/mutations/executor/execute";
import { anotherValidationConsumedForTarget, createPostgresIntentStore, createPostgresOutboundReplyStore, currentWorkspace, databaseNow, initiatorWorkspaceRole, workspaceModeForExecution } from "@/mutations/persistence";
import type { ActiveCredentialIdentity, ExecutionGuards, ValidationExecutionReads } from "@/mutations/ports";
import type { DatabaseTransaction } from "@/platform/db";
import type { TenantJobScope } from "@/platform/jobs";
import { replyTargets, sharedGuards, validationReads, type AuthorityReads } from "./mutations";

const refuseWrite = (): never => {
  throw new Error("mutation executor authority reads are read-only");
};

/** The connections module's worker store with every write path refused: the executor changes no connection. */
export function connectionsAuthority(tx: DatabaseTransaction): ConnectionWorkerStore {
  return createPostgresConnectionWorkerStore(tx, {
    audit: { append: refuseWrite },
    outbox: { append: refuseWrite, routed: refuseWrite },
    claimEffect: refuseWrite,
    capabilityRequests: { requestOnce: refuseWrite },
  });
}

const OUTCOME_ACTION = {
  PENDING: "mutation_intent.created",
  EXECUTING: "mutation_intent.executing",
  CONFIRMED: "mutation_intent.confirmed",
  FAILED: "mutation_intent.failed",
  BLOCKED: "mutation_intent.blocked",
  OUTCOME_UNKNOWN: "mutation_intent.outcome_unknown",
} as const;

/** The executor's audit record of one transition: identifiers and closed codes only, actor `system`. */
export function recordOutcome(audit: AuditLog, newId: () => string): (event: IntentOutcomeEvent) => Promise<void> {
  return (event) =>
    audit.append(
      createAuditEvent({
        id: newId(),
        occurredAt: event.at,
        action: event.actor === "reconciliation" && (event.status === "CONFIRMED" || event.status === "FAILED") ? "mutation_intent.reconciled" : OUTCOME_ACTION[event.status],
        actorType: "system",
        organizationId: event.intent.organizationId,
        workspaceId: event.intent.workspaceId,
        targetType: "mutation_intent",
        targetId: event.intent.id,
        correlationId: event.intent.correlationId,
        outcome: event.status === "CONFIRMED" || event.status === "EXECUTING" ? "succeeded" : "failed",
      }),
    );
}

/** The job runtime's stores on one bound worker transaction. */
export function executorStores(scope: Pick<TenantJobScope, "tx">, newId: () => string): ExecutorStores {
  const { tx } = scope;
  const connections = connectionsAuthority(tx);
  const capability = createPostgresCapabilityStore(tx);
  const reads: AuthorityReads = { account: (id) => connections.connectedAccounts.get(id), connection: (id) => connections.connections.get(id), capability: { header: capability.header, entries: capability.entries } };
  const shared = sharedGuards(tx, reads);
  const validation: ValidationExecutionReads = {
    ...validationReads(tx, reads),
    async consumedElsewhere(workspaceId, targetInteractionId, authorizationId) {
      // Fail closed: a caller naming another workspace than the bound one is answered "consumed" (refuses).
      if (workspaceId !== (await currentWorkspace(tx))) return true;
      return anotherValidationConsumedForTarget(tx, workspaceId, targetInteractionId, authorizationId);
    },
    // PRE-LIVE-2: the same authority the credential use re-reads before opening — here only read, never opened.
    credentialReady: async (workspaceId, connectedAccountId) => (await authorizedCredential(tx, { workspaceId, connectedAccountId })) !== undefined,
    // Step 7B-14H1 (PRE-LIVE-1): identifiers only, for the final gate after the credential was opened.
    activeCredential: (workspaceId, connectedAccountId) => authorizedCredential(tx, { workspaceId, connectedAccountId }),
  };
  const guards: ExecutionGuards = {
    ...shared,
    initiatorRole: (_workspaceId, userId) => initiatorWorkspaceRole(tx, userId),
    async workspaceMode(workspaceId) {
      // The definer answers for the BOUND workspace only; a caller naming another workspace learns nothing.
      if ((await currentWorkspace(tx)) !== workspaceId) return undefined;
      const mode = await workspaceModeForExecution(tx);
      return mode === "STANDARD" ? "STANDARD" : mode === "MONITOR_ONLY" ? "MONITOR_ONLY" : undefined;
    },
  };
  return {
    intents: createPostgresIntentStore(tx),
    replies: createPostgresOutboundReplyStore(tx),
    targets: replyTargets(tx),
    guards,
    record: recordOutcome(createPostgresAuditLog(tx), newId),
    validation,
  };
}

export interface CredentialAuthority {
  readonly workspaceId: WorkspaceId;
  readonly credentialId: string;
  readonly envelope: Uint8Array;
  readonly platform: string;
  readonly providerAssetId: string;
}

/**
 * Step 7B-14H1 — the validation path's view of the account's credential: exactly the authority the credential use opens
 * (account and connection ACTIVE in this workspace, the connection's active credential row) — identifiers only, never
 * the envelope. A stored credential expiry is deliberately NOT read (Step 7G-H5.5-P12-C0-R5F: it has no runtime reader;
 * the provider stays the authority on a token's validity).
 */
async function authorizedCredential(tx: DatabaseTransaction, input: { readonly workspaceId: string; readonly connectedAccountId: string }): Promise<ActiveCredentialIdentity | undefined> {
  const authority = await credentialAuthority(tx, input);
  if (authority === undefined) return undefined;
  return { credentialId: authority.credentialId, platform: authority.platform, providerAssetId: authority.providerAssetId };
}

/**
 * The active credential of the account's connection, re-read in THIS transaction (never from a payload): the stored
 * envelope bytes only — opened later, outside the transaction, by the plane's credential access.
 */
export async function credentialAuthority(tx: DatabaseTransaction, input: { readonly workspaceId: string; readonly connectedAccountId: string }): Promise<CredentialAuthority | undefined> {
  const connections = connectionsAuthority(tx);
  const account = await connections.connectedAccounts.get(input.connectedAccountId);
  if (account === undefined || account.workspaceId !== input.workspaceId || account.status !== "ACTIVE") return undefined;
  const connection = await connections.connections.get(account.connectionId);
  // Step 7B-13C (F3): the connection is re-checked ACTIVE in the transaction that authorizes opening the credential —
  // a connection that left ACTIVE after the executor's guard read (DEGRADED/FAILED/CONNECTING may keep a credential id)
  // never has its envelope opened.
  if (connection === undefined || connection.status !== "ACTIVE" || connection.activeCredentialId === null) return undefined;
  const credential = await connections.credentials.load(connection.activeCredentialId);
  if (credential === undefined || credential.connectionId !== connection.id) return undefined;
  return { workspaceId: account.workspaceId, credentialId: connection.activeCredentialId, envelope: credential.envelope, platform: account.platform, providerAssetId: account.providerAssetId };
}

/** Step 7B-14I2 — what the operator reconciliation task may act on: closed facts of ONE intent of the bound workspace. */
export interface ReconciliationCandidate {
  readonly status: string;
  /** The intent names a one-time validation authorization (0028). */
  readonly authorized: boolean;
  /** Seconds since the intent's last transition, by the DATABASE clock. */
  readonly ageSeconds: number;
  readonly provider: string;
  readonly platform: string;
}

/**
 * Step 7B-14I2 — reads (worker scope, RLS: the bound workspace only) the intent the operator names, with its account's
 * provider and platform. undefined when absent, of another workspace, or its account/connection is unreadable.
 */
export async function reconciliationCandidate(tx: DatabaseTransaction, workspaceId: string, intentId: string): Promise<ReconciliationCandidate | undefined> {
  const intent = await createPostgresIntentStore(tx).get(workspaceId, intentId);
  if (intent === undefined) return undefined;
  const connections = connectionsAuthority(tx);
  const account = await connections.connectedAccounts.get(intent.connectedAccountId);
  const connection = account === undefined ? undefined : await connections.connections.get(account.connectionId);
  if (account === undefined || connection === undefined || account.workspaceId !== workspaceId) return undefined;
  const now = await databaseNow(tx);
  return { status: intent.status, authorized: intent.validationAuthorizationId !== null, ageSeconds: Math.floor((now.getTime() - intent.updatedAt.getTime()) / 1000), provider: connection.provider, platform: account.platform };
}
