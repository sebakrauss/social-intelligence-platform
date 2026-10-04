// DISPOSABLE SPIKE TASKS — Trigger.dev DEVELOPMENT environment. NOT PRODUCTION CODE.
// Every task receives IDs ONLY and reloads authoritative state from PostgreSQL (the local throwaway cluster).
// This file is the Trigger.dev ADAPTER layer of the spike: the domain logic it calls lives in plain SQL/functions
// below and does not import Trigger.dev types beyond the task wrapper.
import { task, schedules, AbortTaskRunError } from "@trigger.dev/sdk";
import pg from "pg";

type Ids = { outboxId: string; workspaceId: string; entityId: string };
const pool = new pg.Pool({ connectionString: process.env.SPIKE_DATABASE_URL, max: 4 });
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const log = (taskId: string, entityId: string, runId: string, attempt: number, outcome: string) =>
  q("insert into trigger_log (task, entity_id, run_id, attempt, outcome) values ($1,$2,$3,$4,$5)", [taskId, entityId, runId, attempt, outcome]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fault(name: string) { return (await q("select value from faults where name=$1", [name])).rows[0]?.value as string | undefined; }

// ---- domain operations (vendor-neutral) ----
async function classifyInteraction(p: Ids) {
  const it = (await q("select * from interactions where id=$1 and workspace_id=$2", [p.entityId, p.workspaceId])).rows[0];
  if (!it) return "missing";
  const r = await q("insert into assessments values ($1,'v1',$2) on conflict do nothing", [it.id, it.body.length > 10 ? "long" : "short"]);
  return r.rowCount ? "assessed" : "skip_duplicate";
}
async function executeMutation(p: Ids): Promise<string> {
  const intent = (await q("select * from mutation_intents where id=$1 and workspace_id=$2", [p.entityId, p.workspaceId])).rows[0];
  if (["confirmed", "failed"].includes(intent.status)) return `skip_${intent.status}`;
  if (intent.action === "reply" && ["executing", "outcome_unknown"].includes(intent.status)) {
    await q("update mutation_intents set status='outcome_unknown', updated_at=clock_timestamp() where id=$1", [intent.id]);
    return "reply_not_repeated_needs_reconciliation";
  }
  await q("update mutation_intents set status='executing', updated_at=clock_timestamp() where id=$1", [intent.id]);
  await q("insert into sim.calls (action, target) values ($1,$2)", [intent.action, intent.target]);
  if (intent.action === "reply") await q("insert into sim.replies (parent, body) values ($1,$2)", [intent.target, intent.text_body]);
  else await q("insert into sim.hidden values ($1,true) on conflict (target) do update set hidden = true", [intent.target]);
  if (await fault(`${intent.action}_timeout_after_success`)) {                  // the platform did it, we never heard back
    if (intent.action === "reply") {
      await q("update mutation_intents set status='outcome_unknown', updated_at=clock_timestamp() where id=$1", [intent.id]);
      return "reply_outcome_unknown";                                            // never retried by the runtime
    }
    throw new Error("provider timeout (state-setting action: safe to retry)");
  }
  await q("update mutation_intents set status='confirmed', provider_ref='ok', updated_at=clock_timestamp() where id=$1", [intent.id]);
  return "confirmed";
}
async function reconcileIntent(p: Ids) {
  const intent = (await q("select * from mutation_intents where id=$1", [p.entityId])).rows[0];
  if (intent.status !== "outcome_unknown") return "nothing_to_reconcile";
  const found = (await q("select id from sim.replies where parent=$1 and body=$2", [intent.target, intent.text_body])).rows[0];
  await q("update mutation_intents set status=$2, provider_ref=$3, updated_at=clock_timestamp() where id=$1", [intent.id, found ? "confirmed" : "failed", found ? `reconciled:${found.id}` : null]);
  return found ? "confirmed_by_reconciliation" : "not_found_safe_to_resend_by_human";
}

// ---- Trigger.dev task wrappers (adapter) ----
export const spikeClassify = task({ id: "spike-classify", run: async (p: Ids, { ctx }) => {
  const outcome = await classifyInteraction(p); await log("spike-classify", p.entityId, ctx.run.id, ctx.attempt.number, outcome); return { outcome };
} });
export const spikeFlaky = task({ id: "spike-flaky", retry: { maxAttempts: 4, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 8000, randomize: false },
  run: async (p: Ids, { ctx }) => { await log("spike-flaky", p.entityId, ctx.run.id, ctx.attempt.number, `attempt_at_${Date.now()}`);
    if (ctx.attempt.number < 3) throw new Error("simulated transient failure"); return { ok: true }; } });
export const spikeAbort = task({ id: "spike-abort", retry: { maxAttempts: 5 },
  run: async (p: Ids, { ctx }) => { await log("spike-abort", p.entityId, ctx.run.id, ctx.attempt.number, "attempt"); throw new AbortTaskRunError("permanent failure: do not retry"); } });
export const spikeCrash = task({ id: "spike-crash", retry: { maxAttempts: 3, minTimeoutInMs: 500, maxTimeoutInMs: 1000, factor: 1 },
  run: async (p: Ids, { ctx }) => { await log("spike-crash", p.entityId, ctx.run.id, ctx.attempt.number, "attempt");
    if (ctx.attempt.number === 1) process.exit(137); return { ok: true }; } });
export const spikeProviderCall = task({ id: "spike-provider-call", concurrency: { perKey: 1 },
  run: async (p: Ids, { ctx }) => { const start = Date.now(); await sleep(1500);
    await log("spike-provider-call", p.entityId, ctx.run.id, ctx.attempt.number, `${start}|${Date.now()}`); } });
export const spikeLong = task({ id: "spike-long", maxDuration: 120,
  run: async (p: Ids, { ctx }) => { await log("spike-long", p.entityId, ctx.run.id, ctx.attempt.number, "started");
    for (let i = 0; i < 45; i++) await sleep(1000); await log("spike-long", p.entityId, ctx.run.id, ctx.attempt.number, "completed"); } });
export const spikeMutate = task({ id: "spike-mutate", retry: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 2000, factor: 1 },
  run: async (p: Ids, { ctx }) => { const outcome = await executeMutation(p).catch(async (e) => { await log("spike-mutate", p.entityId, ctx.run.id, ctx.attempt.number, `retryable_error`); throw e; });
    await log("spike-mutate", p.entityId, ctx.run.id, ctx.attempt.number, outcome); return { outcome }; } });
export const spikeReconcile = task({ id: "spike-reconcile", run: async (p: Ids, { ctx }) => {
  const outcome = await reconcileIntent(p); await log("spike-reconcile", p.entityId, ctx.run.id, ctx.attempt.number, outcome); return { outcome };
} });
export const spikeScheduled = schedules.task({ id: "spike-scheduled", run: async () => ({ ok: true }) });
// Crashes the worker process on the FIRST execution for an entity (persisted marker), then behaves normally.
export const spikeCrashOnce = task({ id: "spike-crash-once", retry: { maxAttempts: 3, minTimeoutInMs: 500, maxTimeoutInMs: 1000, factor: 1 },
  run: async (p: Ids, { ctx }) => {
    const seen = (await q("select count(*)::int c from trigger_log where task='spike-crash-once' and entity_id=$1", [p.entityId])).rows[0].c;
    await log("spike-crash-once", p.entityId, ctx.run.id, ctx.attempt.number, seen === 0 ? "crashing" : "running");
    if (seen === 0) process.exit(137);
    const outcome = await classifyInteraction(p); await log("spike-crash-once", p.entityId, ctx.run.id, ctx.attempt.number, outcome); return { outcome };
  } });
