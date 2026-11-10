/**
 * PostgreSQL stores of the executor's own tables, bound to the caller's scoped transaction: the web's user scope
 * (member insert of a PENDING intent and its reply; member reads) or the worker's workspace job scope (transitions,
 * history, confirmation). RLS decides visibility — a row of another workspace is simply absent — and the grants decide
 * what each role may change (0027). Every write names the workspace explicitly (R5).
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import { isIntentOutcomeCode, isIntentStatus, MUTATION_KINDS, MUTATION_REQUEST_TYPES, type MutationIntent } from "../domain/intent";
import type { IntentStore, OutboundReply, OutboundReplyStore } from "../ports";
import { mutationIntentHistory, mutationIntents, outboundReplies } from "./tables";

const corrupt = (what: string): never => {
  throw new Error(`mutation persistence: incoherent ${what}`);
};

function toIntent(row: typeof mutationIntents.$inferSelect): MutationIntent {
  const kind = (MUTATION_KINDS as readonly string[]).includes(row.kind) ? (row.kind as MutationIntent["kind"]) : corrupt("kind");
  const requestType = (MUTATION_REQUEST_TYPES as readonly string[]).includes(row.requestType) ? (row.requestType as MutationIntent["requestType"]) : corrupt("request_type");
  const status = isIntentStatus(row.status) ? row.status : corrupt("status");
  const outcomeCode = row.outcomeCode === null ? null : isIntentOutcomeCode(row.outcomeCode) ? row.outcomeCode : corrupt("outcome_code");
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    kind,
    requestType,
    targetInteractionId: row.targetInteractionId,
    connectedAccountId: row.connectedAccountId,
    initiatorUserId: row.initiatorUserId,
    idempotencyKey: row.idempotencyKey,
    status,
    attempt: row.attempt,
    runReference: row.runReference,
    outcomeCode,
    capabilityCatalogId: row.capabilityCatalogId,
    capabilityCatalogRevision: row.capabilityCatalogRevision,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPostgresIntentStore(tx: DatabaseTransaction): IntentStore {
  const one = async (workspaceId: string, intentId: string, lock: boolean): Promise<MutationIntent | undefined> => {
    const query = tx.select().from(mutationIntents).where(and(eq(mutationIntents.workspaceId, workspaceId), eq(mutationIntents.id, intentId))).limit(1);
    const rows = lock ? await query.for("update") : await query;
    const row = rows[0];
    return row === undefined ? undefined : toIntent(row);
  };
  return {
    async insert(intent) {
      await tx.insert(mutationIntents).values({
        id: intent.id,
        organizationId: intent.organizationId,
        workspaceId: intent.workspaceId,
        kind: intent.kind,
        requestType: intent.requestType,
        targetInteractionId: intent.targetInteractionId,
        connectedAccountId: intent.connectedAccountId,
        initiatorUserId: intent.initiatorUserId,
        idempotencyKey: intent.idempotencyKey,
        status: intent.status,
        attempt: intent.attempt,
        runReference: intent.runReference,
        outcomeCode: intent.outcomeCode,
        capabilityCatalogId: intent.capabilityCatalogId,
        capabilityCatalogRevision: intent.capabilityCatalogRevision,
        correlationId: intent.correlationId,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
      });
    },
    async findByIdempotencyKey(workspaceId, idempotencyKey) {
      const row = (await tx.select().from(mutationIntents).where(and(eq(mutationIntents.workspaceId, workspaceId), eq(mutationIntents.idempotencyKey, idempotencyKey))).limit(1))[0];
      return row === undefined ? undefined : toIntent(row);
    },
    get: (workspaceId, intentId) => one(workspaceId, intentId, false),
    lock: (workspaceId, intentId) => one(workspaceId, intentId, true),
    async transition(workspaceId, intentId, next) {
      const updated = await tx
        .update(mutationIntents)
        .set({ status: next.status, attempt: next.attempt, runReference: next.runReference, outcomeCode: next.outcomeCode, updatedAt: next.at })
        .where(and(eq(mutationIntents.workspaceId, workspaceId), eq(mutationIntents.id, intentId)))
        .returning({ id: mutationIntents.id });
      if (updated.length !== 1) corrupt("transition");
    },
    async competitorsFor(workspaceId, intent) {
      // Same workspace (explicit, and the bound worker's RLS), same account, same target; the text is NOT compared.
      const rows = await tx
        .select({ id: mutationIntents.id, status: mutationIntents.status, providerReplyId: outboundReplies.providerReplyId })
        .from(mutationIntents)
        .leftJoin(outboundReplies, and(eq(outboundReplies.workspaceId, mutationIntents.workspaceId), eq(outboundReplies.intentId, mutationIntents.id)))
        .where(and(eq(mutationIntents.workspaceId, workspaceId), ne(mutationIntents.id, intent.id), eq(mutationIntents.connectedAccountId, intent.connectedAccountId), eq(mutationIntents.targetInteractionId, intent.targetInteractionId)))
        .orderBy(asc(mutationIntents.createdAt), asc(mutationIntents.id));
      return rows.map((row) => ({ id: row.id, status: isIntentStatus(row.status) ? row.status : corrupt("status"), hasProviderIdentity: row.providerReplyId !== null }));
    },
    async appendHistory(workspaceId, intentId, transition) {
      await tx.insert(mutationIntentHistory).values({
        id: transition.id,
        organizationId: sql`(select organization_id from mutations.mutation_intents where workspace_id = ${workspaceId} and id = ${intentId})`,
        workspaceId,
        intentId,
        fromStatus: transition.from,
        toStatus: transition.to,
        attempt: transition.attempt,
        actor: transition.actor,
        outcomeCode: transition.code,
        runReference: transition.runReference,
        correlationId: transition.correlationId,
        occurredAt: transition.at,
      });
    },
  };
}

function toReply(row: typeof outboundReplies.$inferSelect): OutboundReply {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    intentId: row.intentId,
    parentInteractionId: row.parentInteractionId,
    connectedAccountId: row.connectedAccountId,
    platform: row.platform,
    text: row.text,
    providerReplyId: row.providerReplyId,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
  };
}

export function createPostgresOutboundReplyStore(tx: DatabaseTransaction): OutboundReplyStore {
  return {
    async insert(reply) {
      await tx.insert(outboundReplies).values({
        id: reply.id,
        organizationId: reply.organizationId,
        workspaceId: reply.workspaceId,
        intentId: reply.intentId,
        parentInteractionId: reply.parentInteractionId,
        connectedAccountId: reply.connectedAccountId,
        platform: reply.platform,
        text: reply.text,
        providerReplyId: reply.providerReplyId,
        confirmedAt: reply.confirmedAt,
        createdAt: reply.createdAt,
      });
    },
    async getByIntent(workspaceId, intentId) {
      const row = (await tx.select().from(outboundReplies).where(and(eq(outboundReplies.workspaceId, workspaceId), eq(outboundReplies.intentId, intentId))).limit(1))[0];
      return row === undefined ? undefined : toReply(row);
    },
    async listForParents(workspaceId, parentInteractionIds) {
      const ids = [...new Set(parentInteractionIds)].slice(0, 500);
      if (ids.length === 0) return [];
      const rows = await tx
        .select({
          intentId: outboundReplies.intentId,
          parentInteractionId: outboundReplies.parentInteractionId,
          connectedAccountId: outboundReplies.connectedAccountId,
          platform: outboundReplies.platform,
          text: outboundReplies.text,
          providerReplyId: outboundReplies.providerReplyId,
          createdAt: outboundReplies.createdAt,
          confirmedAt: outboundReplies.confirmedAt,
          status: mutationIntents.status,
          outcomeCode: mutationIntents.outcomeCode,
          initiatorUserId: mutationIntents.initiatorUserId,
        })
        .from(outboundReplies)
        .innerJoin(mutationIntents, and(eq(mutationIntents.workspaceId, outboundReplies.workspaceId), eq(mutationIntents.id, outboundReplies.intentId)))
        .where(and(eq(outboundReplies.workspaceId, workspaceId), inArray(outboundReplies.parentInteractionId, ids)))
        .orderBy(asc(outboundReplies.createdAt), asc(outboundReplies.id));
      return rows.map((row) => ({
        intentId: row.intentId,
        parentInteractionId: row.parentInteractionId,
        connectedAccountId: row.connectedAccountId,
        platform: row.platform,
        text: row.text,
        status: isIntentStatus(row.status) ? row.status : corrupt("status"),
        outcomeCode: row.outcomeCode === null ? null : isIntentOutcomeCode(row.outcomeCode) ? row.outcomeCode : corrupt("outcome_code"),
        providerReplyId: row.providerReplyId,
        initiatorUserId: row.initiatorUserId,
        createdAt: row.createdAt,
        confirmedAt: row.confirmedAt,
      }));
    },
    async linkedIntent(workspaceId, platform, providerReplyId) {
      const row = (await tx.select({ intentId: outboundReplies.intentId }).from(outboundReplies)
        .where(and(eq(outboundReplies.workspaceId, workspaceId), eq(outboundReplies.platform, platform), eq(outboundReplies.providerReplyId, providerReplyId))).limit(1))[0];
      return row?.intentId;
    },
    async confirm(workspaceId, intentId, providerReplyId, confirmedAt) {
      const updated = await tx
        .update(outboundReplies)
        .set({ providerReplyId, confirmedAt })
        .where(and(eq(outboundReplies.workspaceId, workspaceId), eq(outboundReplies.intentId, intentId)))
        .returning({ id: outboundReplies.id });
      if (updated.length !== 1) corrupt("confirm");
    },
  };
}

/** The bound workspace of this transaction, from its sealed context (never from a caller); undefined when unbound. */
export async function currentWorkspace(tx: DatabaseTransaction): Promise<string | undefined> {
  const result = await tx.execute<{ workspace: string | null }>(sql`select app.current_workspace() as workspace`);
  return result.rows[0]?.workspace ?? undefined;
}

/**
 * 0027: the BOUND workspace's mode read under a SHARE lock (worker only): a concurrent mode change either committed
 * first (and is seen) or waits for this transaction — the executor's EXECUTING transition and the mode are consistent.
 */
export async function workspaceModeForExecution(tx: DatabaseTransaction): Promise<string | undefined> {
  const result = await tx.execute<{ mode: string | null }>(sql`select mutations.workspace_mode_for_execution() as mode`);
  return result.rows[0]?.mode ?? undefined;
}

/** 0027: the user's CURRENT role in the BOUND workspace (worker only), or undefined when not a member. */
export async function initiatorWorkspaceRole(tx: DatabaseTransaction, userId: string): Promise<string | undefined> {
  const result = await tx.execute<{ role: string | null }>(sql`select mutations.initiator_workspace_role(${userId}::uuid) as role`);
  return result.rows[0]?.role ?? undefined;
}
