// DISPOSABLE SPIKE — NOT PRODUCTION CODE.
// Integration shape under test:
//   domain tx (state + outbox row) -> commit -> dispatcher -> JobRuntime.enqueue(ids only, idempotency key)
//   -> mark dispatched -> worker receives IDs -> reloads authoritative state -> idempotent work.
// Domain code depends only on the JobRuntime PORT below, never on a vendor SDK.
import { makeWorkerUtils } from 'graphile-worker';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ALLOWED_PAYLOAD_KEYS = ['outboxId', 'workspaceId', 'entityId'];

// ---------- JobRuntime port + Graphile Worker adapter (a Trigger.dev adapter would implement the same port) ----------
export async function graphileRuntime(connectionString) {
  const utils = await makeWorkerUtils({ connectionString });
  const enqueued = [];
  return {
    enqueued,
    async enqueue(task, payload, { idempotencyKey, queueKey, runAt } = {}) {
      enqueued.push({ task, payload });
      return utils.addJob(task, payload, { jobKey: idempotencyKey, queueName: queueKey, runAt });
    },
    utils,
    release: () => utils.release(),
  };
}

// ---------- Domain commands (write state + outbox row in ONE transaction) ----------
export async function receiveInteraction(pool, { workspaceId, body, failBeforeCommit = false }) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const id = crypto.randomUUID();
    await c.query('insert into interactions values ($1,$2,$3)', [id, workspaceId, body]);
    await c.query(`insert into outbox (workspace_id, task, entity_id, dispatch_key) values ($1,'classify',$2,$3)`, [workspaceId, id, `classify:${id}:v1`]);
    if (failBeforeCommit) throw new Error('simulated domain failure before commit');
    await c.query('commit');
    return id;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

export async function startImport(pool, { workspaceId, totalPages }) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const id = crypto.randomUUID();
    await c.query('insert into import_checkpoints (import_id, workspace_id, total_pages) values ($1,$2,$3)', [id, workspaceId, totalPages]);
    await c.query(`insert into outbox (workspace_id, task, entity_id, dispatch_key) values ($1,'import',$2,$3)`, [workspaceId, id, `import:${id}`]);
    await c.query('commit');
    return id;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

export async function requestMutation(pool, { workspaceId, action, target, text, requestKey }) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const id = crypto.randomUUID();
    const r = await c.query(`insert into mutation_intents (id, workspace_id, request_key, action, target, text_body) values ($1,$2,$3,$4,$5,$6)
                             on conflict (request_key) do nothing returning id`, [id, workspaceId, requestKey, action, target, text ?? null]);
    if (r.rowCount === 0) { await c.query('rollback'); return (await pool.query('select id from mutation_intents where request_key=$1', [requestKey])).rows[0].id; }
    await c.query(`insert into outbox (workspace_id, task, entity_id, dispatch_key) values ($1,'mutate',$2,$3)`, [workspaceId, id, `mutate:${id}`]);
    await c.query('commit');
    return id;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

// ---------- Dispatcher / sweeper ----------
// crash: 'before_enqueue' | 'after_enqueue' simulates a dispatcher process dying in each window.
export async function dispatch(pool, runtime, { minAgeMs = 0, crash } = {}) {
  const pending = (await pool.query(
    `select * from outbox where status = 'pending' and created_at <= clock_timestamp() - make_interval(secs => $1::float / 1000) order by created_at limit 100`, [minAgeMs])).rows;
  for (const r of pending) {
    if (crash === 'before_enqueue') throw new Error('dispatcher crashed before enqueue');
    await runtime.enqueue(r.task, { outboxId: r.id, workspaceId: r.workspace_id, entityId: r.entity_id }, { idempotencyKey: r.dispatch_key });
    if (crash === 'after_enqueue') throw new Error('dispatcher crashed after enqueue, before marking');
    await pool.query(`update outbox set status = 'dispatched', dispatched_at = clock_timestamp() where id = $1 and status = 'pending'`, [r.id]);
  }
  return pending.length;
}

// ---------- Simulated provider (external side effects) ----------
async function fault(pool, name) { return (await pool.query('select value from faults where name=$1', [name])).rows[0]?.value; }
export const sim = {
  async reply(pool, parent, body) {
    await pool.query(`insert into sim.calls (action, target) values ('reply',$1)`, [parent]);
    await pool.query('insert into sim.replies (parent, body) values ($1,$2)', [parent, body]);       // side effect happens…
    if (await fault(pool, 'reply_timeout_after_success')) { const e = new Error('provider timeout'); e.outcomeUnknown = true; throw e; } // …but we never hear back
    return 'reply-ref';
  },
  async hide(pool, target) {
    await pool.query(`insert into sim.calls (action, target) values ('hide',$1)`, [target]);
    await pool.query('insert into sim.hidden values ($1,true) on conflict (target) do update set hidden = true', [target]);
    if (await fault(pool, 'hide_timeout_after_success')) { const e = new Error('provider timeout'); e.outcomeUnknown = true; throw e; }
    return 'hide-ok';
  },
};

// ---------- Task handlers (receive IDs only; reload authoritative state; idempotent) ----------
export function makeTasks(pool) {
  const log = (task, entityId, helpers, outcome) => pool.query('insert into handler_log (task, entity_id, attempt, outcome) values ($1,$2,$3,$4)', [task, entityId, helpers.job.attempts, outcome]);
  return {
    async classify(payload, helpers) {
      const it = (await pool.query('select * from interactions where id=$1 and workspace_id=$2', [payload.entityId, payload.workspaceId])).rows[0];
      if (!it) { await log('classify', payload.entityId, helpers, 'missing'); return; }
      const r = await pool.query(`insert into assessments values ($1,'v1',$2) on conflict do nothing`, [it.id, it.body.length > 10 ? 'long' : 'short']);
      await log('classify', it.id, helpers, r.rowCount ? 'assessed' : 'skip_duplicate');
    },
    async import(payload, helpers) {
      const delay = Number((await fault(pool, 'import_page_delay_ms')) ?? 0);
      for (;;) {
        const cp = (await pool.query('select * from import_checkpoints where import_id=$1', [payload.entityId])).rows[0];
        if (cp.completed) break;
        const page = cp.next_page;
        if (page > cp.total_pages) { await pool.query('update import_checkpoints set completed=true where import_id=$1', [cp.import_id]); break; }
        if (delay) await sleep(delay);
        const c = await pool.connect();
        try {   // page result + checkpoint advance commit atomically
          await c.query('begin');
          await c.query('insert into imported_items values ($1,$2) on conflict do nothing', [cp.import_id, page]);
          await c.query('update import_checkpoints set next_page = $2 where import_id = $1 and next_page = $3', [cp.import_id, page + 1, page]);
          await c.query('commit');
        } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
        await log('import', cp.import_id, helpers, `page_${page}`);
        const crashAfter = await fault(pool, 'import_throw_after_page');
        if (crashAfter && Number(crashAfter) === page && helpers.job.attempts === 1) throw new Error(`simulated worker failure after page ${page}`);
      }
    },
    async mutate(payload, helpers) {
      const intent = (await pool.query('select * from mutation_intents where id=$1 and workspace_id=$2', [payload.entityId, payload.workspaceId])).rows[0];
      if (['confirmed', 'failed'].includes(intent.status)) { await log('mutate', intent.id, helpers, `skip_${intent.status}`); return; }
      // A reply that may already have happened is NEVER repeated blindly (TA §18.3).
      if (intent.action === 'reply' && ['executing', 'outcome_unknown'].includes(intent.status)) {
        await pool.query(`update mutation_intents set status='outcome_unknown', updated_at=clock_timestamp() where id=$1`, [intent.id]);
        await log('mutate', intent.id, helpers, 'reply_not_repeated_needs_reconciliation');
        return;
      }
      await pool.query(`update mutation_intents set status='executing', updated_at=clock_timestamp() where id=$1`, [intent.id]);
      try {
        const ref = intent.action === 'reply' ? await sim.reply(pool, intent.target, intent.text_body) : await sim.hide(pool, intent.target);
        await pool.query(`update mutation_intents set status='confirmed', provider_ref=$2, updated_at=clock_timestamp() where id=$1`, [intent.id, ref]);
        await log('mutate', intent.id, helpers, 'confirmed');
      } catch (e) {
        if (e.outcomeUnknown && intent.action === 'reply') {
          await pool.query(`update mutation_intents set status='outcome_unknown', updated_at=clock_timestamp() where id=$1`, [intent.id]);
          await log('mutate', intent.id, helpers, 'reply_outcome_unknown');
          return;                                            // do not let the job runtime retry a non-idempotent call
        }
        await log('mutate', intent.id, helpers, `retryable_error:${e.message}`);
        throw e;                                             // hide/unhide are state-setting: safe to retry
      }
    },
    async reconcile(payload, helpers) {
      const intent = (await pool.query('select * from mutation_intents where id=$1', [payload.entityId])).rows[0];
      if (intent.status !== 'outcome_unknown') return;
      const found = (await pool.query('select id from sim.replies where parent=$1 and body=$2', [intent.target, intent.text_body])).rows[0];
      await pool.query(`update mutation_intents set status=$2, provider_ref=$3, updated_at=clock_timestamp() where id=$1`,
        [intent.id, found ? 'confirmed' : 'failed', found ? `reconciled:${found.id}` : null]);
      await log('reconcile', intent.id, helpers, found ? 'confirmed_by_reconciliation' : 'not_found_safe_to_resend_by_human');
    },
    async slow(payload, helpers) {
      const start = Date.now(); await sleep(250);
      await pool.query('insert into handler_log (task, entity_id, attempt, outcome) values ($1,$2,$3,$4)', ['slow', payload.entityId, helpers.job.attempts, `${payload.queue}|${start}|${Date.now()}`]);
    },
  };
}
