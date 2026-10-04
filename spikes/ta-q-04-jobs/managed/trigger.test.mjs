// DISPOSABLE MANAGED SPIKE TESTS — TA-Q-04 against the Trigger.dev DEVELOPMENT environment.
// The domain/outbox code (../lib/outbox.mjs) talks to a JobRuntime PORT; this file supplies a Trigger.dev ADAPTER for it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { tasks, runs, idempotencyKeys, schedules } from '@trigger.dev/sdk';
import { receiveInteraction, requestMutation, dispatch, ALLOWED_PAYLOAD_KEYS } from '../lib/outbox.mjs';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'CRASHED', 'SYSTEM_FAILURE', 'EXPIRED', 'TIMED_OUT']);
const WS = '0a000000-0000-0000-0000-0000000000a1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (k, v) => console.log(`OBSERVED ${k}: ${JSON.stringify(v)}`);
let pool; const q = async (s, p) => (await pool.query(s, p)).rows;
const triggered = [];

// ---- JobRuntime port implemented with Trigger.dev (adapter; domain code never imports the SDK) ----
const TASK_ID = { classify: 'spike-classify', import: 'spike-classify', mutate: 'spike-mutate', reconcile: 'spike-reconcile', crash_once: 'spike-crash-once' };
const triggerRuntime = {
  async enqueue(task, payload, { idempotencyKey } = {}) {
    const key = idempotencyKey ? await idempotencyKeys.create(idempotencyKey, { scope: 'global' }) : undefined;
    const h = await tasks.trigger(TASK_ID[task], payload, { idempotencyKey: key, tags: [`outbox_${payload.outboxId.slice(0, 8)}`] });
    triggered.push(h.id); return h;
  },
};
async function waitRun(id, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) { const r = await runs.retrieve(id); if (TERMINAL.has(r.status)) return r; if (Date.now() - t0 > timeoutMs) throw new Error(`run ${r.status} after ${timeoutMs}ms`); await sleep(1000); }
}
const trig = async (taskId, payload, opts = {}) => { const h = await tasks.trigger(taskId, payload, opts); triggered.push(h.id); return h; };
const ids = (entityId = crypto.randomUUID()) => ({ outboxId: crypto.randomUUID(), workspaceId: WS, entityId });
const logFor = (entityId, task) => q(`select run_id, attempt, outcome, at from trigger_log where entity_id=$1 and task=$2 order by id`, [entityId, task]);
const setFault = (n, v) => pool.query('insert into faults values ($1,$2) on conflict (name) do update set value=$2', [n, v]);

before(async () => { pool = new pg.Pool({ connectionString: process.env.SPIKE_DATABASE_URL, max: 4 });
  const warm = await trig('spike-classify', ids()); await waitRun(warm.id, 180000); });   // waits for the dev worker to be registered
after(async () => { await pool.end(); });

describe('T1/T2/T17 — outbox → Trigger.dev by IDs → worker reloads PostgreSQL → idempotent domain operation', () => {
  it('committed domain change is dispatched, executed and correlated (stable run id, tags, DB log)', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment T1' });
    await dispatch(pool, triggerRuntime);
    const runId = triggered.at(-1); const r = await waitRun(runId);
    assert.equal(r.status, 'COMPLETED'); assert.equal(r.id, runId);
    assert.equal((await q('select count(*)::int c from assessments where interaction_id=$1', [id]))[0].c, 1);
    const l = await logFor(id, 'spike-classify'); assert.equal(l.length, 1); assert.equal(l[0].run_id, runId);
    note('run correlation fields', { id_prefix: r.id.slice(0, 4), status: r.status, tags: r.tags, attemptCount: r.attemptCount, durationMs: r.durationMs, costInCents: r.costInCents, has_startedAt: Boolean(r.startedAt), has_finishedAt: Boolean(r.finishedAt) });
  });
  it('dispatcher crash after enqueue → redispatch returns the SAME run (vendor idempotency key) and executes once', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment T2' });
    await assert.rejects(dispatch(pool, triggerRuntime, { crash: 'after_enqueue' }));
    const first = triggered.at(-1);
    await dispatch(pool, triggerRuntime);
    const second = triggered.at(-1);
    assert.equal(second, first, 'same idempotency key → same run handle');
    await waitRun(first);
    const again = await triggerRuntime.enqueue('classify', { outboxId: (await q('select id from outbox where entity_id=$1', [id]))[0].id, workspaceId: WS, entityId: id }, { idempotencyKey: (await q('select dispatch_key from outbox where entity_id=$1', [id]))[0].dispatch_key });
    assert.equal(again.id, first, 'after success the key still maps to the original run');
    assert.equal((await logFor(id, 'spike-classify')).length, 1);
  });
});

describe('T18 — vendor idempotency is NOT domain idempotency', () => {
  it('two runs without a key both execute; the domain writes one assessment', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment T18' });
    const p = { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: id };
    const [a, b] = [await trig('spike-classify', p), await trig('spike-classify', p)];
    assert.notEqual(a.id, b.id); await waitRun(a.id); await waitRun(b.id);
    assert.deepEqual((await logFor(id, 'spike-classify')).map((x) => x.outcome).sort(), ['assessed', 'skip_duplicate']);
    assert.equal((await q('select count(*)::int c from assessments where interaction_id=$1', [id]))[0].c, 1);
  });
});

describe('T5/T6/T7/T14 — retries, backoff, explicit non-retry, crash recovery', () => {
  it('transient failures retry with configured exponential backoff and then succeed', async () => {
    const p = ids(); const h = await trig('spike-flaky', p); const r = await waitRun(h.id);
    const l = await logFor(p.entityId, 'spike-flaky'); const at = l.map((x) => Number(x.outcome.split('_').pop()));
    assert.equal(r.status, 'COMPLETED'); assert.equal(l.length, 3);
    note('flaky attempts', { status: r.status, attempts: l.length, gaps_ms: at.slice(1).map((t, i) => t - at[i]) });
    assert.ok(at[1] - at[0] >= 900 && at[2] - at[1] >= 1800, 'backoff grows (≈1s then ≈2s, factor 2)');
  });
  it('AbortTaskRunError fails the run without retries', async () => {
    const p = ids(); const r = await waitRun((await trig('spike-abort', p)).id);
    assert.equal(r.status, 'FAILED'); assert.equal((await logFor(p.entityId, 'spike-abort')).length, 1);
  });
  it('worker process crash (process.exit mid-attempt) → run CRASHED and is NOT retried by Trigger.dev (documented)', async () => {
    const p = ids(); const r = await waitRun((await trig('spike-crash', p)).id);
    const l = await logFor(p.entityId, 'spike-crash');
    note('crash behavior', { status: r.status, attempts_logged: l.length, attemptCount: r.attemptCount });
    assert.equal(r.status, 'CRASHED'); assert.equal(l.length, 1);
  });
  it('recovery belongs to the outbox: a run-outcome sweeper re-dispatches CRASHED runs and the domain effect happens once', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment crash-once' });
    await pool.query(`update outbox set task='crash_once', dispatch_key='crash_once:'||entity_id where entity_id=$1`, [id]);
    const key = (await q('select dispatch_key from outbox where entity_id=$1', [id]))[0].dispatch_key;
    await dispatch(pool, triggerRuntime); const run1 = triggered.at(-1); const r1 = await waitRun(run1);
    assert.equal(r1.status, 'CRASHED');
    // sweeper: dispatched row whose run ended CRASHED/SYSTEM_FAILURE → re-dispatch
    await pool.query(`update outbox set status='pending' where entity_id=$1`, [id]);
    await dispatch(pool, triggerRuntime); const sameKeyRun = triggered.at(-1);
    let path = 'same key created a new run';
    if (sameKeyRun === run1) {                                   // key still bound to the crashed run → explicit reset needed
      path = 'same key returned the CRASHED run; idempotencyKeys.reset() required';
      await idempotencyKeys.reset('spike-crash-once', await idempotencyKeys.create(key, { scope: 'global' }));
      await pool.query(`update outbox set status='pending' where entity_id=$1`, [id]);
      await dispatch(pool, triggerRuntime);
    }
    const r2 = await waitRun(triggered.at(-1));
    note('crash recovery via outbox sweeper', { first_run: r1.status, redispatch_path: path, final_run: r2.status, new_run_id: triggered.at(-1) !== run1 });
    assert.equal(r2.status, 'COMPLETED');
    assert.equal((await q('select count(*)::int c from assessments where interaction_id=$1', [id]))[0].c, 1);
  });
});

describe('T8/T9 — concurrencyKey per provider account', () => {
  it('perKey: 1 → runs with the same key never overlap; different keys run in parallel', async () => {
    const hs = [];
    for (const key of ['provider:acct-1', 'provider:acct-2']) for (let i = 0; i < 3; i++) { const p = ids(); hs.push({ key, p, h: await trig('spike-provider-call', p, { concurrencyKey: key }) }); }
    for (const x of hs) assert.equal((await waitRun(x.h.id)).status, 'COMPLETED');
    const iv = []; for (const x of hs) { const [l] = await logFor(x.p.entityId, 'spike-provider-call'); const [s, e] = l.outcome.split('|').map(Number); iv.push({ key: x.key, s, e }); }
    const ov = (a, b) => a.s < b.e && b.s < a.e;
    for (const a of iv) for (const b of iv) if (a !== b && a.key === b.key) assert.equal(ov(a, b), false, 'same-key overlap');
    const cross = iv.some((a) => iv.some((b) => a.key !== b.key && ov(a, b)));
    note('concurrencyKey', { same_key_overlaps: 0, cross_key_parallelism_observed: cross });
    assert.ok(cross, 'different keys ran in parallel');
  });
});

describe('T10/T11/T12/T13 — delay, schedules, cancellation, long runs', () => {
  it('delayed run waits before executing', async () => {
    const id = await receiveInteraction(pool, { workspaceId: WS, body: 'synthetic comment delay' });
    const t0 = Date.now(); const h = await trig('spike-classify', { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: id }, { delay: '8s' });
    const early = await runs.retrieve(h.id); const r = await waitRun(h.id); const [l] = await logFor(id, 'spike-classify');
    note('delay', { status_right_after_trigger: early.status, has_delayedUntil: Boolean(early.delayedUntil), executed_after_ms: new Date(l.at).getTime() - t0 });
    assert.equal(r.status, 'COMPLETED'); assert.ok(new Date(l.at).getTime() - t0 >= 7500);
  });
  it('imperative per-tenant schedule: create (deduplicated), inspect next run, delete', async () => {
    const opts = { task: 'spike-scheduled', cron: '0 3 * * *', timezone: 'America/Santiago', externalId: 'ws_a1', deduplicationKey: `spike-ws-a1-${Date.now()}` };
    const s1 = await schedules.create(opts); const s2 = await schedules.create(opts);
    note('schedule', { same_id_on_dedup: s1.id === s2.id, timezone: s1.timezone, has_nextRun: Boolean(s1.nextRun), active: s1.active });
    assert.equal(s1.id, s2.id);
    await schedules.del(s1.id);
    await assert.rejects(schedules.retrieve(s1.id));
  });
  it('cancelling an executing run stops it before completion', async () => {
    const p = ids(); const h = await trig('spike-long', p);
    const t0 = Date.now(); while ((await logFor(p.entityId, 'spike-long')).length === 0) { if (Date.now() - t0 > 90000) throw new Error('long run never started'); await sleep(1000); }
    await runs.cancel(h.id); const r = await waitRun(h.id); await sleep(5000);
    const outcomes = (await logFor(p.entityId, 'spike-long')).map((x) => x.outcome);
    note('cancel', { status: r.status, outcomes });
    assert.equal(r.status, 'CANCELED'); assert.deepEqual(outcomes, ['started']);
  });
});

describe('T19 — unknown provider outcome → OUTCOME_UNKNOWN → reconciliation, never a blind resend', () => {
  it('reply accepted by the platform but timed out: one platform call, no runtime retry, reconciled', async () => {
    await pool.query('delete from faults'); await setFault('reply_timeout_after_success', 'on');
    const intent = await requestMutation(pool, { workspaceId: WS, action: 'reply', target: 'comment-T19', text: 'synthetic reply T19', requestKey: `req-T19-${Date.now()}` });
    await dispatch(pool, triggerRuntime); const r1 = await waitRun(triggered.at(-1));
    assert.equal(r1.status, 'COMPLETED'); assert.equal((await q('select status from mutation_intents where id=$1', [intent]))[0].status, 'outcome_unknown');
    const r2 = await waitRun((await trig('spike-mutate', { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: intent })).id);   // duplicate delivery
    assert.equal(r2.status, 'COMPLETED');
    await waitRun((await trig('spike-reconcile', { outboxId: crypto.randomUUID(), workspaceId: WS, entityId: intent })).id);
    await pool.query('delete from faults');
    const calls = (await q(`select count(*)::int c from sim.calls where action='reply' and target='comment-T19'`))[0].c;
    note('unknown outcome', { provider_calls: calls, final_status: (await q('select status from mutation_intents where id=$1', [intent]))[0].status, outcomes: (await logFor(intent, 'spike-mutate')).map((x) => x.outcome) });
    assert.equal(calls, 1); assert.equal((await q(`select count(*)::int c from sim.replies where parent='comment-T19'`))[0].c, 1);
    assert.equal((await q('select status from mutation_intents where id=$1', [intent]))[0].status, 'confirmed');
  });
  it('hide timed out after success: retried by the runtime (state-setting), ends confirmed', async () => {
    await setFault('hide_timeout_after_success', 'on');
    const intent = await requestMutation(pool, { workspaceId: WS, action: 'hide', target: 'comment-T19h', requestKey: `req-T19h-${Date.now()}` });
    await dispatch(pool, triggerRuntime); const runId = triggered.at(-1);
    const t0 = Date.now(); while ((await logFor(intent, 'spike-mutate')).length === 0) { if (Date.now() - t0 > 60000) break; await sleep(500); }
    await pool.query('delete from faults');
    const r = await waitRun(runId);
    assert.equal(r.status, 'COMPLETED'); assert.equal((await q('select status from mutation_intents where id=$1', [intent]))[0].status, 'confirmed');
    assert.ok((await q(`select count(*)::int c from sim.calls where action='hide' and target='comment-T19h'`))[0].c >= 2);
  });
});

describe('T16 — payload privacy (IDs only) as stored by Trigger.dev', () => {
  it('every run payload retrieved back from Trigger.dev contains only identifiers', async () => {
    const bodies = (await q('select body from interactions')).map((r) => r.body);
    let checked = 0;
    for (const id of [...new Set(triggered)]) {
      const r = await runs.retrieve(id);
      if (r.payload === undefined) continue;
      assert.deepEqual(Object.keys(r.payload).sort(), [...ALLOWED_PAYLOAD_KEYS].sort());
      for (const b of bodies) assert.equal(JSON.stringify(r.payload).includes(b), false);
      checked++;
    }
    note('payload privacy', { runs_checked: checked });
    assert.ok(checked > 0);
  });
});
