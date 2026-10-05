/**
 * Domain idempotency (R6, TA §18.3). Vendor idempotency keys only reduce duplicate runs; this is what makes
 * a durable effect happen at most once per (workspace, effect key), across retries, duplicate deliveries
 * and crash-recovery runs.
 *
 * The claim is written in the SAME transaction as the effect it protects: if the effect's transaction rolls
 * back, so does the claim and a later run may try again; if it commits, every later run sees
 * "already_applied" and must skip the effect. Concurrent claims serialize on the primary key.
 */
import { sql } from "drizzle-orm";
import { pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DatabaseTransaction } from "./scopes";

const idempotency = pgSchema("idempotency");

export const effectKeys = idempotency.table(
  "effect_keys",
  {
    workspaceId: uuid("workspace_id").notNull(),
    effectKey: text("effect_key").notNull(),
    task: text("task").notNull(),
    outboxId: uuid("outbox_id"),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.effectKey] })],
);

const EFFECT_KEY = /^[a-z][a-z0-9_.]{0,63}(:[A-Za-z0-9_-]{1,64}){1,6}$/;

export type EffectClaim = "claimed" | "already_applied";

export class InvalidEffectKeyError extends Error {
  override readonly name = "InvalidEffectKeyError";
}

export interface EffectClaimRequest {
  readonly workspaceId: string;
  /** Stable domain identity of the effect, e.g. "assessment:<interactionId>:<taskVersion>". IDs only. */
  readonly effectKey: string;
  readonly task: string;
  readonly outboxId?: string | undefined;
  readonly runId?: string | undefined;
}

/** Claims the effect inside the caller's (worker, workspace-bound) transaction. */
export async function claimEffect(tx: DatabaseTransaction, request: EffectClaimRequest): Promise<EffectClaim> {
  if (!EFFECT_KEY.test(request.effectKey)) throw new InvalidEffectKeyError("effect key must be identifier-shaped");
  const result = await tx.execute<{ effect_key: string }>(sql`
    insert into idempotency.effect_keys (workspace_id, effect_key, task, outbox_id, run_id)
    values (${request.workspaceId}::uuid, ${request.effectKey}, ${request.task}, ${request.outboxId ?? null}::uuid, ${request.runId ?? null})
    on conflict (workspace_id, effect_key) do nothing
    returning effect_key`);
  return result.rows.length === 1 ? "claimed" : "already_applied";
}
