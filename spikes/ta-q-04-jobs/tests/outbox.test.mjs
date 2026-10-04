// DISPOSABLE SPIKE TESTS — TA-Q-04 outbox integration shape, executed against a REAL durable queue
// (Graphile Worker on real PostgreSQL). Trigger.dev is NOT executed here (requires an account/cloud or Docker).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { runOnce, run } from 'graphile-worker';
import { graphileRuntime, receiveInteraction, startImport, requestMutation, dispatch, makeTasks, sleep, ALLOWED_PAYLOAD_KEYS } from '../lib/outbox.mjs';

const url = process.env.SPIKE_DATABASE_URL;
const WS = '0a000000-0000-0000-0000-0000000000a1';
let pool, rt, tasks;
const q = async (s, p) => (await pool.query(s, p)).rows;
const drain = (opts = {}) => runOnce({ connectionString: url, taskList: tasks, noHandleSignals: true, ...opts });
async function drainUntil(cond, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) { await drain(); if (await cond()) return; if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition'); await sleep(300); }
}
const jobsFor = (entityId) => q(`select j.id, t.identifier as task_identifier, j.key, j.attempts, j.locked_by, j.payload from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id where j.payload->>'entityId' = $1`, [entityId]);
const setFault = (name, value) => pool.query('insert into faults values ($1,$2) on conflict (name) do update set value = $2', [name, value]);
const clearFaults = () => pool.query('delete from faults');

before(async () => { pool = new pg.Pool({ connectionString: url, max: 8 }); rt = await graphileRuntime(url); tasks = makeTasks(pool); });
after(async () => { await rt.release(); await pool.end(); });

describe('A — transaction rolls back => no outbox row, no job', () => {
  it('nothing is ever dispatched', async () => {
    await assert.rejects(receiveInteraction(pool, { workspaceId: WS, body: 'synthetic rollback comment', failBeforeCommit: true }));
    assert.equal((await q(`select count(*)::int c from outbox where status='pending'`))[0].c, 0);
    assert.equal(await dispatch(pool, rt), 0);
    assert.equal((await q(`select count(*)::int c from graphile_worker.jobs`))[0].c, 0);
  });
});

describe('B — commit, then dispatcher crashes BEFORE enqueue => sweeper dispatches later', () => {
  it('outbox row survives; sweeper enqueues; worker completes', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment B' });
    await assert.rejects(dispatch(pool, rt, { crash: 'before_enqueue' }));
    assert.equal((await jobsFor(id)).length, 0);
    assert.equal((await q('select status from outbox where entity_id=$1', [id]))[0].status, 'pending');
    await sleep(50);
    assert.equal(await dispatch(pool, rt, { minAgeMs: 10 }), 1);           // sweeper pass
    await drainUntil(async () => (await q('select 1 from assessments where interaction_id=$1', [id])).length === 1);
    assert.equal((await q('select status from outbox where entity_id=$1', [id]))[0].status, 'dispatched');
  });
});

describe('C — job enqueued, dispatcher crashes BEFORE marking dispatched => redispatch is harmless', () => {
  it('C1: job still queued => same idempotency key collapses to ONE job', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment C1' });
    await assert.rejects(dispatch(pool, rt, { crash: 'after_enqueue' }));
    assert.equal((await jobsFor(id)).length, 1);
    await dispatch(pool, rt);                                               // redispatch
    const jobs = await jobsFor(id);
    assert.equal(jobs.length, 1, 'job key deduplicated the redispatch');
    await drainUntil(async () => (await jobsFor(id)).length === 0);
    assert.equal((await q(`select count(*)::int c from handler_log where entity_id=$1 and task='classify'`, [id]))[0].c, 1);
  });
  it('C2: job already ran => redispatch creates a second run, domain idempotency keeps ONE effect (see D)', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment C2' });
    await assert.rejects(dispatch(pool, rt, { crash: 'after_enqueue' }));
    await drainUntil(async () => (await jobsFor(id)).length === 0);        // first run completes; Graphile deletes the job row
    await dispatch(pool, rt);                                               // still 'pending' => redispatched
    await drainUntil(async () => (await jobsFor(id)).length === 0);
    const outcomes = (await q(`select outcome from handler_log where entity_id=$1 and task='classify' order by id`, [id])).map((r) => r.outcome);
    assert.deepEqual(outcomes, ['assessed', 'skip_duplicate']);
    assert.equal((await q('select count(*)::int c from assessments where interaction_id=$1', [id]))[0].c, 1);
  });
});

describe('D — the same job delivered twice => one domain effect', () => {
  it('two deliveries without a job key; assessment written once', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment D' });
    const payload = { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: id };
    await rt.utils.addJob('classify', payload); await rt.utils.addJob('classify', payload);
    await drainUntil(async () => (await jobsFor(id)).length === 0);
    assert.equal((await q('select count(*)::int c from assessments where interaction_id=$1', [id]))[0].c, 1);
    assert.deepEqual((await q(`select outcome from handler_log where entity_id=$1 order by id`, [id])).map((r) => r.outcome).sort(), ['assessed', 'skip_duplicate']);
  });
});

describe('E — worker fails after partial work => retry resumes from checkpoint', () => {
  it('E1: thrown error after page 3 => runtime retries with backoff; every page processed exactly once', async () => {
    await clearFaults(); await setFault('import_throw_after_page', '3');
    const imp = await startImport(pool, { workspaceId: WS, totalPages: 6 });
    await dispatch(pool, rt);
    await drain();
    const mid = (await q('select next_page from import_checkpoints where import_id=$1', [imp]))[0].next_page;
    assert.equal(mid, 4, 'checkpoint persisted before the failure');
    const job = (await jobsFor(imp))[0];
    assert.equal(job.attempts, 1, 'job kept for retry');
    await drainUntil(async () => (await q('select completed from import_checkpoints where import_id=$1', [imp]))[0].completed, 20000);
    assert.equal((await q('select count(*)::int c from imported_items where import_id=$1', [imp]))[0].c, 6);
    const pages = (await q(`select outcome, attempt from handler_log where entity_id=$1 and task='import' order by id`, [imp]));
    assert.deepEqual(pages.map((p) => p.outcome), ['page_1', 'page_2', 'page_3', 'page_4', 'page_5', 'page_6']);
    assert.deepEqual([...new Set(pages.map((p) => p.attempt))], [1, 2]);
    await clearFaults();
  });
  it('E2: worker process HARD-KILLED mid-import => job stays locked (Graphile default) until unlocked; then resumes from checkpoint', async () => {
    await clearFaults(); await setFault('import_page_delay_ms', '400');
    const imp = await startImport(pool, { workspaceId: WS, totalPages: 8 });
    await dispatch(pool, rt);
    const child = spawn(process.execPath, ['scripts/crash-worker.mjs'], { env: { ...process.env, SPIKE_WORKER_ID: 'spike-crash-worker' }, stdio: 'ignore' });
    const t0 = Date.now();
    while ((await q('select next_page from import_checkpoints where import_id=$1', [imp]))[0].next_page < 3) {
      if (Date.now() - t0 > 15000) throw new Error('crash worker did not progress'); await sleep(100);
    }
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const stuck = (await jobsFor(imp))[0];
    assert.ok(stuck.locked_by, 'job remains locked by the dead worker process');
    console.log(`E2 observed: job ${stuck.id} still locked_by=${stuck.locked_by} after SIGKILL`);
    const before = (await q('select next_page from import_checkpoints where import_id=$1', [imp]))[0].next_page;
    await drain(); await sleep(1500); await drain();                          // a healthy worker cannot take it
    assert.equal((await q('select next_page from import_checkpoints where import_id=$1', [imp]))[0].next_page, before);
    await rt.utils.forceUnlockWorkers([stuck.locked_by]);                   // explicit recovery (needs crash detection)
    await setFault('import_page_delay_ms', '0');
    await drainUntil(async () => (await q('select completed from import_checkpoints where import_id=$1', [imp]))[0].completed, 20000);
    assert.equal((await q('select count(*)::int c from imported_items where import_id=$1', [imp]))[0].c, 8);
    await clearFaults();
  });
});

describe('F — provider mutation times out with UNKNOWN outcome => never blindly repeated', () => {
  it('F1: reply times out after the platform accepted it => no retry, outcome_unknown, reconciliation confirms; exactly ONE platform reply', async () => {
    await clearFaults(); await setFault('reply_timeout_after_success', 'on');
    const intent = await requestMutation(pool, { workspaceId: WS, action: 'reply', target: 'comment-F1', text: 'synthetic reply F1', requestKey: 'req-F1' });
    await dispatch(pool, rt);
    await drainUntil(async () => (await jobsFor(intent)).length === 0);
    assert.equal((await q('select status from mutation_intents where id=$1', [intent]))[0].status, 'outcome_unknown');
    // the same job is delivered again (e.g., redispatch): still no second platform call
    await rt.utils.addJob('mutate', { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: intent });
    await drainUntil(async () => (await jobsFor(intent)).length === 0);
    await rt.utils.addJob('reconcile', { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: intent });
    await drainUntil(async () => (await jobsFor(intent)).length === 0);
    assert.equal((await q(`select count(*)::int c from sim.calls where action='reply' and target='comment-F1'`))[0].c, 1, 'exactly one provider call');
    assert.equal((await q(`select count(*)::int c from sim.replies where parent='comment-F1'`))[0].c, 1, 'exactly one public reply');
    assert.equal((await q('select status from mutation_intents where id=$1', [intent]))[0].status, 'confirmed');
    await clearFaults();
  });
  it('F2: duplicate user submission (same request key) => one intent, one platform reply', async () => {
    const a = await requestMutation(pool, { workspaceId: WS, action: 'reply', target: 'comment-F2', text: 'synthetic reply F2', requestKey: 'req-F2' });
    const b = await requestMutation(pool, { workspaceId: WS, action: 'reply', target: 'comment-F2', text: 'synthetic reply F2', requestKey: 'req-F2' });
    assert.equal(a, b);
    await dispatch(pool, rt);
    await drainUntil(async () => (await jobsFor(a)).length === 0);
    assert.equal((await q(`select count(*)::int c from sim.replies where parent='comment-F2'`))[0].c, 1);
  });
  it('F3: hide times out after success => retried (state-setting is idempotent); final state hidden, intent confirmed', async () => {
    await clearFaults(); await setFault('hide_timeout_after_success', 'on');
    const intent = await requestMutation(pool, { workspaceId: WS, action: 'hide', target: 'comment-F3', requestKey: 'req-F3' });
    await dispatch(pool, rt);
    await drain();
    assert.equal((await jobsFor(intent))[0]?.attempts, 1, 'failed attempt scheduled for retry with backoff');
    await clearFaults();
    await drainUntil(async () => (await q('select status from mutation_intents where id=$1', [intent]))[0].status === 'confirmed', 20000);
    assert.equal((await q(`select hidden from sim.hidden where target='comment-F3'`))[0].hidden, true);
    assert.ok((await q(`select count(*)::int c from sim.calls where action='hide' and target='comment-F3'`))[0].c >= 2);
  });
});

describe('Job runtime properties exercised on the fallback runtime', () => {
  it('keyed concurrency: jobs in the same queue never overlap; different queues run in parallel', async () => {
    const runner = await run({ connectionString: url, concurrency: 4, noHandleSignals: true, pollInterval: 100, taskList: tasks });
    try {
      for (const queue of ['provider:acct-1', 'provider:acct-2']) for (let i = 0; i < 3; i++) {
        await rt.utils.addJob('slow', { entityId: crypto.randomUUID(), queue }, { queueName: queue });
      }
      const t0 = Date.now();
      while ((await q(`select count(*)::int c from handler_log where task='slow'`))[0].c < 6) { if (Date.now() - t0 > 15000) throw new Error('timeout'); await sleep(100); }
    } finally { await runner.stop(); }
    const iv = (await q(`select outcome from handler_log where task='slow'`)).map((r) => { const [queue, s, e] = r.outcome.split('|'); return { queue, s: +s, e: +e }; });
    const overlaps = (a, b) => a.s < b.e && b.s < a.e;
    for (const a of iv) for (const b of iv) if (a !== b && a.queue === b.queue) assert.equal(overlaps(a, b), false, 'same-queue overlap');
    assert.ok(iv.some((a) => iv.some((b) => a.queue !== b.queue && overlaps(a, b))), 'different queues overlapped in time');
  });
  it('delayed execution: a job with runAt in the future does not run early', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment delayed' });
    await rt.enqueue('classify', { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: id }, { runAt: new Date(Date.now() + 1500) });
    await drain();
    assert.equal((await q('select count(*)::int c from assessments where interaction_id=$1', [id]))[0].c, 0);
    await sleep(1700);
    await drainUntil(async () => (await q('select count(*)::int c from assessments where interaction_id=$1', [id]))[0].c === 1);
  });
  it('payload privacy: every dispatched payload carries identifiers only (no comment text, no credentials)', async () => {
    const dispatched = rt.enqueued.filter((e) => e.payload.outboxId);
    assert.ok(dispatched.length > 0);
    for (const { payload } of dispatched) assert.deepEqual(Object.keys(payload).sort(), [...ALLOWED_PAYLOAD_KEYS].sort());
    const bodies = (await q('select body from interactions')).map((r) => r.body);
    const stored = JSON.stringify(await q('select payload from graphile_worker._private_jobs'));
    for (const b of bodies) assert.equal(stored.includes(b), false);
  });
});
