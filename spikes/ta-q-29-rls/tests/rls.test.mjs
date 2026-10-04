// DISPOSABLE SPIKE TESTS — TA-Q-29. Synthetic data only. Run via `npm test` (scripts/run.mjs).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { sql, eq } from 'drizzle-orm';
import { makePools, withUserScope, withWorkspaceJobScope, withSystemScope, rows, conversations, interactions, guestInsights, attentionSignals } from '../lib/db.mjs';
import { issueTestToken, foreignKey } from '../lib/auth.mjs';

const A1 = 'a1000000-0000-0000-0000-000000000000', A2 = 'a2000000-0000-0000-0000-000000000000', B1 = 'b1000000-0000-0000-0000-000000000000';
const U_A1 = '11111111-0000-0000-0000-0000000000a1', U_A12 = '11111111-0000-0000-0000-000000000a12', U_B1 = '11111111-0000-0000-0000-0000000000b1';
const U_GUEST = '11111111-0000-0000-0000-0000000000ee', U_NONE = '11111111-0000-0000-0000-0000000000ff';
const CONV_B1 = 'cb100000-0000-0000-0000-000000000001', CONV_A1 = 'ca100000-0000-0000-0000-000000000001';
const codeOf = (e) => e?.code ?? e?.cause?.code;
const observed = [];  // records the exact rejection observed, for the evidence file
const expectPgError = async (p, code) => { let err; try { await p; } catch (e) { err = e; } assert.ok(err, `expected error ${code}`);
  const codes = Array.isArray(code) ? code : [code]; assert.ok(codes.includes(codeOf(err)), `got ${codeOf(err)}: ${err?.cause?.message ?? err?.message}`);
  observed.push(`${codeOf(err)} ${err?.cause?.message ?? err?.message}`.split('\n')[0]); return err; };
const DENIED = ['42501', '42P01'];  // permission denied, or relation not visible because the role lacks schema USAGE — both are rejections
const wsOf = (rs) => [...new Set(rs.map((r) => r.workspaceId ?? r.workspace_id))];
const pid = async (tx) => rows(await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid;

let P;          // pools with max=1 per login role => every transaction reuses the same server connection
let oracle;     // TEST ORACLE ONLY (bootstrap superuser) — used to assert database state, never by runtime scopes
const tok = {};
before(async () => {
  P = makePools({ max: 1 });
  oracle = new pg.Client({ host: '127.0.0.1', port: Number(process.env.SPIKE_PGPORT), user: 'spike_super', password: process.env.SPIKE_SUPER_PW, database: 'spike' });
  await oracle.connect();
  for (const [k, u] of Object.entries({ U_A1, U_A12, U_B1, U_GUEST, U_NONE })) tok[k] = await issueTestToken(u);
});
after(async () => { await P.end(); await oracle.end(); console.log('OBSERVED REJECTIONS:\n' + [...new Set(observed)].map((o) => '  ' + o).join('\n')); });

describe('R01 — server-verified identity maps to database execution context', () => {
  it('valid token => auth.uid(), role and workspace context set inside the transaction', async () => {
    const r = await withUserScope(P, tok.U_A1, A1, async (tx) => rows(await tx.execute(sql`select auth.uid()::text as uid, current_user as cu, session_user as su, app.current_workspace()::text as ws`))[0]);
    assert.deepEqual(r, { uid: U_A1, cu: 'authenticated', su: 'web_login', ws: A1 });
  });
  it('tokens failing verification never reach the database (foreign signing key, expired, wrong audience, non-allowlisted role)', async () => {
    const bad = [
      await issueTestToken(U_A1, {}, await foreignKey()),
      await issueTestToken(U_A1, { expSeconds: Math.floor(Date.now() / 1000) - 60 }),
      await issueTestToken(U_A1, { aud: 'service' }),
      await issueTestToken(U_A1, { role: 'service_role' }),
      await issueTestToken('not-a-uuid'),
    ];
    for (const t of bad) {
      let ran = false;
      await assert.rejects(withUserScope(P, t, A1, async () => { ran = true; }));
      assert.equal(ran, false);
    }
  });
});

describe('R02/R03 — context is transaction-local and disappears after commit or rollback (same pooled connection)', () => {
  it('commit: context gone on the very same backend', async () => {
    const inTx = await withUserScope(P, tok.U_A1, A1, async (tx) => ({ pid: await pid(tx), ws: rows(await tx.execute(sql`select current_setting('app.workspace_id', true) as v`))[0].v }));
    assert.equal(inTx.ws, A1);
    const after = rows(await P.webDb.execute(sql`select pg_backend_pid() as pid, current_user as cu, current_setting('request.jwt.claims', true) as claims, current_setting('app.workspace_id', true) as ws, current_setting('app.ctx_seal', true) as seal`))[0];
    assert.equal(after.pid, inTx.pid, 'must be the same pooled server connection');
    assert.equal(after.cu, 'web_login');
    for (const v of [after.claims, after.ws, after.seal]) assert.ok(v === null || v === '', `leftover context: ${v}`);
  });
  it('rollback (error inside scope): context gone on the same backend', async () => {
    let p;
    await assert.rejects(withUserScope(P, tok.U_A1, A1, async (tx) => { p = await pid(tx); throw new Error('boom'); }));
    const after = rows(await P.webDb.execute(sql`select pg_backend_pid() as pid, current_user as cu, current_setting('app.workspace_id', true) as ws`))[0];
    assert.equal(after.pid, p);
    assert.equal(after.cu, 'web_login');
    assert.ok(after.ws === null || after.ws === '');
  });
});

describe('R04 — pooled connection reuse cannot inherit another tenant context', () => {
  it('user scope: A1 -> B1 -> no context on ONE backend', async () => {
    const t1 = await withUserScope(P, tok.U_A1, A1, async (tx) => ({ pid: await pid(tx), rs: await tx.select().from(conversations) }));
    const t2 = await withUserScope(P, tok.U_B1, B1, async (tx) => ({ pid: await pid(tx), rs: await tx.select().from(conversations) }));
    const t3 = await P.webDb.transaction(async (tx) => { await tx.execute(sql`set local role authenticated`); return { pid: await pid(tx), rs: await tx.select().from(conversations) }; });
    assert.equal(t1.pid, t2.pid); assert.equal(t2.pid, t3.pid);
    assert.deepEqual(wsOf(t1.rs), [A1]); assert.equal(t1.rs.length, 3);
    assert.deepEqual(wsOf(t2.rs), [B1]); assert.equal(t2.rs.length, 3);
    assert.equal(t3.rs.length, 0);
  });
  it('worker scope: A1 -> B1 -> no context on ONE backend', async () => {
    const t1 = await withWorkspaceJobScope(P, A1, async (tx) => ({ pid: await pid(tx), rs: await tx.select().from(interactions) }));
    const t2 = await withWorkspaceJobScope(P, B1, async (tx) => ({ pid: await pid(tx), rs: await tx.select().from(interactions) }));
    const t3 = await P.workerDb.transaction(async (tx) => { await tx.execute(sql`set local role app_worker`); return { pid: await pid(tx), rs: await tx.select().from(interactions) }; });
    assert.equal(t1.pid, t2.pid); assert.equal(t2.pid, t3.pid);
    assert.deepEqual(wsOf(t1.rs), [A1]); assert.deepEqual(wsOf(t2.rs), [B1]); assert.equal(t3.rs.length, 0);
  });
  it('stress: 400 interleaved user/worker transactions across tenants on 4-connection pools never see foreign rows', async () => {
    const S = makePools({ max: 4 });
    const plan = [[U_A1, A1, 'A1'], [U_A12, A1, 'A1'], [U_A12, A2, 'A2'], [U_B1, B1, 'B1']];
    const pidTenants = new Map(); let checks = 0;
    try {
      await Promise.all(Array.from({ length: 400 }, async (_, i) => {
        const [u, ws] = plan[i % plan.length];
        const worker = i % 3 === 0;
        const run = async (tx) => { const p = await pid(tx); const rs = await tx.select().from(conversations); return { p, rs }; };
        const { p, rs } = worker ? await withWorkspaceJobScope(S, ws, run) : await withUserScope(S, await issueTestToken(u), ws, run);
        assert.equal(rs.length, 3); assert.deepEqual(wsOf(rs), [ws]); checks++;
        if (!pidTenants.has(p)) pidTenants.set(p, new Set()); pidTenants.get(p).add(ws);
      }));
    } finally { await S.end(); }
    assert.equal(checks, 400);
    assert.ok(pidTenants.size <= 8, 'at most 4 web + 4 worker backends');
    assert.ok([...pidTenants.values()].some((s) => s.size >= 2), 'backends were reused across different tenants');
  });
});

describe('R05 — missing workspace context returns zero tenant rows (fail-closed)', () => {
  it('user role + valid claims but no bound workspace: zero rows on every tenant table; inserts rejected', async () => {
    const r = await P.webDb.transaction(async (tx) => {
      await tx.execute(sql`set local role authenticated`);
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: U_A1, role: 'authenticated' })}, true)`);
      return [await tx.select().from(conversations), await tx.select().from(interactions), await tx.select().from(guestInsights)];
    });
    for (const rs of r) assert.equal(rs.length, 0);
    await expectPgError(P.webDb.transaction(async (tx) => {
      await tx.execute(sql`set local role authenticated`);
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: U_A1, role: 'authenticated' })}, true)`);
      await tx.insert(conversations).values({ id: crypto.randomUUID(), workspaceId: A1, title: 'x' });
    }), '42501');
  });
  it('worker role without bound workspace: zero rows; inserts rejected; binding NULL rejected', async () => {
    const rs = await P.workerDb.transaction(async (tx) => { await tx.execute(sql`set local role app_worker`); return tx.select().from(conversations); });
    assert.equal(rs.length, 0);
    await expectPgError(P.workerDb.transaction(async (tx) => { await tx.execute(sql`set local role app_worker`); await tx.insert(conversations).values({ id: crypto.randomUUID(), workspaceId: A1, title: 'x' }); }), '42501');
    await expectPgError(P.workerDb.transaction(async (tx) => { await tx.execute(sql`set local role app_worker`); await tx.execute(sql`select app.bind_context(null)`); }), '42501');
  });
});

describe('R06 — Workspace A cannot read Workspace B (incl. fabricated and cross-organization context)', () => {
  it('explicit filters and ids for another workspace return nothing', async () => {
    const r = await withUserScope(P, tok.U_A1, A1, async (tx) => [
      await tx.select().from(conversations).where(eq(conversations.workspaceId, B1)),
      await tx.select().from(conversations).where(eq(conversations.id, CONV_B1)),
      await tx.select().from(interactions).where(eq(interactions.workspaceId, A2)),
    ]);
    for (const rs of r) assert.equal(rs.length, 0);
  });
  it('member of A1 and A2, bound to A1: sees only A1', async () => {
    const rs = await withUserScope(P, tok.U_A12, A1, (tx) => tx.select().from(conversations));
    assert.deepEqual(wsOf(rs), [A1]);
  });
  it('fabricated / foreign context: user binds a workspace they do not belong to (same org, other org, random id)', async () => {
    for (const [t, ws] of [[tok.U_A1, A2], [tok.U_A1, B1], [tok.U_A1, crypto.randomUUID()], [tok.U_NONE, A1]]) {
      const rs = await withUserScope(P, t, ws, (tx) => tx.select().from(conversations));
      assert.equal(rs.length, 0, `leak for ${ws}`);
    }
  });
  it('client guest sees guest projections only; never operational rows or attention signals', async () => {
    const r = await withUserScope(P, tok.U_GUEST, A1, async (tx) => ({
      conv: await tx.select().from(conversations), inter: await tx.select().from(interactions),
      guest: await tx.select().from(guestInsights), attention: await tx.select().from(attentionSignals) }));
    assert.equal(r.conv.length, 0); assert.equal(r.inter.length, 0); assert.equal(r.attention.length, 0);
    assert.deepEqual(wsOf(r.guest), [A1]);
  });
  it('attention signals (organization-level page) return only workspaces with a non-guest membership', async () => {
    const a = await withUserScope(P, tok.U_A1, A1, (tx) => tx.select().from(attentionSignals));
    const b = await withUserScope(P, tok.U_A12, A1, (tx) => tx.select().from(attentionSignals));
    assert.deepEqual(wsOf(a), [A1]);
    assert.deepEqual(wsOf(b).sort(), [A1, A2]);
  });
});

describe('R07 — Workspace A cannot modify Workspace B', () => {
  it('update/delete of B rows affect 0 rows; inserting or moving rows into B is rejected; oracle confirms B unchanged', async () => {
    const before = (await oracle.query(`select count(*)::int c, max(title) t from conversations where workspace_id = $1`, [B1])).rows[0];
    const r = await withUserScope(P, tok.U_A1, A1, async (tx) => ({
      upd: await tx.update(conversations).set({ title: 'pwned' }).where(eq(conversations.id, CONV_B1)).returning(),
      del: await tx.delete(conversations).where(eq(conversations.workspaceId, B1)).returning(),
    }));
    assert.equal(r.upd.length, 0); assert.equal(r.del.length, 0);
    await expectPgError(withUserScope(P, tok.U_A1, A1, (tx) => tx.insert(conversations).values({ id: crypto.randomUUID(), workspaceId: B1, title: 'x' })), '42501');
    await expectPgError(withUserScope(P, tok.U_A1, A1, (tx) => tx.update(conversations).set({ workspaceId: B1 }).where(eq(conversations.id, CONV_A1))), '42501');
    await expectPgError(withWorkspaceJobScope(P, A1, (tx) => tx.insert(conversations).values({ id: crypto.randomUUID(), workspaceId: B1, title: 'x' })), '42501');
    const afterRow = (await oracle.query(`select count(*)::int c, max(title) t from conversations where workspace_id = $1`, [B1])).rows[0];
    assert.deepEqual(afterRow, before);
  });
});

describe('R08 — cross-workspace references fail and do not reveal existence', () => {
  it('referencing a B1 conversation from A1 fails exactly like referencing a non-existent one', async () => {
    const e1 = await expectPgError(withUserScope(P, tok.U_A1, A1, (tx) => tx.insert(interactions).values({ id: crypto.randomUUID(), workspaceId: A1, conversationId: CONV_B1, body: 'x' })), '23503');
    const e2 = await expectPgError(withUserScope(P, tok.U_A1, A1, (tx) => tx.insert(interactions).values({ id: crypto.randomUUID(), workspaceId: A1, conversationId: crypto.randomUUID(), body: 'x' })), '23503');
    const shape = (e) => String(e.cause?.message ?? e.message).replace(/[0-9a-f-]{36}/g, '<id>');
    assert.equal(shape(e1), shape(e2));
    await expectPgError(withWorkspaceJobScope(P, A1, (tx) => tx.insert(interactions).values({ id: crypto.randomUUID(), workspaceId: A1, conversationId: CONV_B1, body: 'x' })), '23503');
  });
});

describe('R09/R10 — restricted worker role obeys RLS and cannot escape its workspace', () => {
  it('worker bound to A1 sees exactly A1 rows (oracle: table holds all workspaces)', async () => {
    const total = (await oracle.query('select count(*)::int c from conversations')).rows[0].c;
    const rs = await withWorkspaceJobScope(P, A1, (tx) => tx.select().from(conversations));
    assert.equal(total, 9); assert.equal(rs.length, 3); assert.deepEqual(wsOf(rs), [A1]);
  });
  it('worker scheduled for A1 querying B1 gets nothing', async () => {
    const rs = await withWorkspaceJobScope(P, A1, (tx) => tx.select().from(conversations).where(eq(conversations.workspaceId, B1)));
    assert.equal(rs.length, 0);
  });
  it('re-binding inside the transaction is refused', async () => {
    await expectPgError(withWorkspaceJobScope(P, A1, (tx) => tx.execute(sql`select app.bind_context(${B1}::uuid)`)), '42501');
  });
  it('raw set_config to switch workspace invalidates the context (fails closed, zero rows)', async () => {
    const r = await withWorkspaceJobScope(P, A1, async (tx) => {
      await tx.execute(sql`select set_config('app.workspace_id', ${B1}, true)`);
      return { ws: rows(await tx.execute(sql`select app.current_workspace() as ws`))[0].ws, rs: await tx.select().from(conversations) };
    });
    assert.equal(r.ws, null); assert.equal(r.rs.length, 0);
  });
  it('replaying a seal captured from an earlier transaction (stale context) is rejected', async () => {
    const seal = await withWorkspaceJobScope(P, B1, async (tx) => rows(await tx.execute(sql`select current_setting('app.ctx_seal') as s`))[0].s);
    const rs = await P.workerDb.transaction(async (tx) => {
      await tx.execute(sql`set local role app_worker`);
      await tx.execute(sql`select set_config('app.workspace_id', ${B1}, true), set_config('app.ctx_seal', ${seal}, true)`);
      return tx.select().from(conversations);
    });
    assert.equal(rs.length, 0);
  });
  it('session-level (non-local) context written by buggy code persists on the connection but is ignored', async () => {
    const seal = await withWorkspaceJobScope(P, B1, async (tx) => rows(await tx.execute(sql`select current_setting('app.ctx_seal') as s`))[0].s);
    await P.workerDb.execute(sql`select set_config('app.workspace_id', ${B1}, false), set_config('app.ctx_seal', ${seal}, false)`);
    try {
      const r = await P.workerDb.transaction(async (tx) => {
        await tx.execute(sql`set local role app_worker`);
        return { leaked: rows(await tx.execute(sql`select current_setting('app.workspace_id', true) as v`))[0].v, rs: await tx.select().from(conversations) };
      });
      assert.equal(r.leaked, B1, 'demonstrates the hazard: a plain GUC WOULD leak across pooled transactions');
      assert.equal(r.rs.length, 0, 'the transaction-bound seal makes the leaked value unusable');
    } finally {
      await P.workerDb.execute(sql`select set_config('app.workspace_id', '', false), set_config('app.ctx_seal', '', false)`);
    }
  });
  it('worker cannot assume the user role, the system role or service_role', async () => {
    for (const role of ['authenticated', 'app_system', 'service_role', 'spike_owner']) {
      await expectPgError(P.workerDb.transaction(async (tx) => { await tx.execute(sql.raw(`set local role ${role}`)); }), '42501');
    }
  });
});

describe('R11 — system role reaches only explicit system tables', () => {
  it('reads system metadata; tenant tables and tenant context functions are denied', async () => {
    const meta = await withSystemScope(P, async (tx) => rows(await tx.execute(sql`select * from system.outbox_meta`)));
    assert.equal(meta.length, 1);
    await expectPgError(withSystemScope(P, (tx) => tx.select().from(conversations)), DENIED);
    await expectPgError(withSystemScope(P, (tx) => tx.execute(sql`select * from public.conversations`)), '42501');
    await expectPgError(withSystemScope(P, (tx) => tx.select().from(attentionSignals)), DENIED);
    await expectPgError(withSystemScope(P, (tx) => tx.execute(sql`select app.current_workspace()`)), '42501');
    for (const role of ['app_worker', 'authenticated', 'service_role']) {
      await expectPgError(P.systemDb.transaction(async (tx) => { await tx.execute(sql.raw(`set local role ${role}`)); }), '42501');
    }
  });
});

describe('R12 — runtime needs no service-role or RLS-bypassing credential', () => {
  it('runtime login roles are not superuser, cannot bypass RLS, do not inherit, and are not members of service_role or the owner', async () => {
    const r = (await oracle.query(`
      select rolname, rolsuper, rolbypassrls, rolinherit,
             pg_has_role(rolname, 'service_role', 'MEMBER') as svc, pg_has_role(rolname, 'spike_owner', 'MEMBER') as own
      from pg_roles where rolname in ('web_login','worker_login','system_login','authenticated','app_worker','app_system') order by rolname`)).rows;
    assert.equal(r.length, 6);
    for (const x of r) { assert.equal(x.rolsuper, false); assert.equal(x.rolbypassrls, false); assert.equal(x.svc, false); assert.equal(x.own, false); }
    for (const x of r.filter((y) => y.rolname.endsWith('_login'))) assert.equal(x.rolinherit, false);
    const forced = (await oracle.query(`select count(*)::int c from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','system') and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)`)).rows[0].c;
    assert.equal(forced, 0, 'every table has RLS enabled and forced');
  });
  it('web runtime cannot escalate to service_role, the worker role, the system role or the owner', async () => {
    for (const role of ['service_role', 'app_worker', 'app_system', 'spike_owner']) {
      await expectPgError(P.webDb.transaction(async (tx) => { await tx.execute(sql.raw(`set local role ${role}`)); }), '42501');
    }
  });
});

describe('R13 — direct Drizzle access cannot silently bypass RLS (fail-closed)', () => {
  it('queries without any scope helper are rejected with permission denied for every runtime pool', async () => {
    await expectPgError(P.webDb.select().from(conversations), DENIED);
    await expectPgError(P.workerDb.select().from(interactions), DENIED);
    await expectPgError(P.systemDb.select().from(conversations), DENIED);
    await expectPgError(P.webDb.update(conversations).set({ title: 'x' }), DENIED);
    for (const db of [P.webDb, P.workerDb, P.systemDb]) await expectPgError(db.execute(sql`select * from public.conversations`), '42501');
  });
  it('even a session-level SET ROLE left behind by buggy code yields zero rows, not foreign data', async () => {
    await P.webDb.execute(sql`set role authenticated`);
    try {
      const rs = await P.webDb.select().from(conversations);
      assert.equal(rs.length, 0);
    } finally { await P.webDb.execute(sql`reset role`); }
  });
  it('read-only transactions can bind context too (no write needed)', async () => {
    const rs = await P.webDb.transaction(async (tx) => {
      await tx.execute(sql`set local role authenticated`);
      await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: U_A1, role: 'authenticated' })}, true)`);
      await tx.execute(sql`select app.bind_context(${A1}::uuid)`);
      return tx.select().from(conversations);
    }, { accessMode: 'read only' });
    assert.deepEqual(wsOf(rs), [A1]);
  });
});
