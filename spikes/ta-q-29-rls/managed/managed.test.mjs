// DISPOSABLE MANAGED SPIKE TESTS — TA-Q-29 against the Supabase DEVELOPMENT project.
// Runs with RUNTIME credentials only (custom login roles via Supavisor TRANSACTION mode + REAL user tokens).
// Launched by run-managed.mjs; all output is redacted by the parent before display or storage.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq } from 'drizzle-orm';
import { pgSchema, uuid, text, boolean } from 'drizzle-orm/pg-core';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, generateKeyPair, SignJWT, decodeJwt } from 'jose';
import { createClient } from '@supabase/supabase-js';

const E = process.env;
const ORIGIN = E.SPK_ORIGIN, U = JSON.parse(E.SPK_USERS);
const A1 = 'a1000000-0000-0000-0000-000000000000', A2 = 'a2000000-0000-0000-0000-000000000000', B1 = 'b1000000-0000-0000-0000-000000000000';
const CONV_A1 = 'ca100000-0000-0000-0000-000000000001', CONV_B1 = 'cb100000-0000-0000-0000-000000000001';

const s = pgSchema('spike29');
const conversations = s.table('conversations', { id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), title: text('title').notNull() });
const interactions = s.table('interactions', { id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), conversationId: uuid('conversation_id').notNull(), body: text('body').notNull() });
const guestInsights = s.table('guest_insights', { id: uuid('id').primaryKey(), workspaceId: uuid('workspace_id').notNull(), statement: text('statement').notNull() });
const attentionSignals = s.table('attention_signals', { workspaceId: uuid('workspace_id').primaryKey(), needsAttention: boolean('needs_attention').notNull() });

// ---------- runtime connection: Supavisor TRANSACTION mode (port 6543), custom login role `<role>.<ref>` ----------
const pool = (login, pw, max) => new pg.Pool({ host: E.SPK_POOLER_HOST, port: 6543, user: `${login}.${E.SPK_REF}`, password: pw, database: 'postgres', max, ssl: { rejectUnauthorized: false }, idleTimeoutMillis: 2000 });
function makePools(max = 1) {
  const web = pool(`spike_web_login${E.SPK_SFX}`, E.SPK_WEB_PW, max), worker = pool(`spike_worker_login${E.SPK_SFX}`, E.SPK_WORKER_PW, max), system = pool(`spike_system_login${E.SPK_SFX}`, E.SPK_SYSTEM_PW, max);
  return { web, worker, system, webDb: drizzle(web), workerDb: drizzle(worker), systemDb: drizzle(system), end: () => Promise.all([web.end(), worker.end(), system.end()]) };
}

// ---------- server-side verification of REAL Supabase Auth tokens (asymmetric keys via JWKS) ----------
const JWKS = createRemoteJWKSet(new URL(`${ORIGIN}/auth/v1/.well-known/jwks.json`));
const ALLOWED_DB_ROLES = new Set(['authenticated']);
async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, JWKS, { issuer: `${ORIGIN}/auth/v1`, audience: 'authenticated', algorithms: ['ES256', 'RS256'] });
  if (!ALLOWED_DB_ROLES.has(payload.role)) throw new Error(`role not allowed: ${payload.role}`);
  if (!/^[0-9a-f-]{36}$/i.test(String(payload.sub))) throw new Error('bad sub');
  return payload;
}
async function withUserScope(P, token, ws, fn) {
  const claims = await verifyAccessToken(token);
  return P.webDb.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);                         // R3: fixed literal
    await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true), set_config('request.jwt.claim.sub', ${claims.sub}, true)`);
    await tx.execute(sql`select spike29_app.bind_context(${ws}::uuid)`);
    return fn(tx);
  });
}
const withWorker = (P, ws, fn) => P.workerDb.transaction(async (tx) => { await tx.execute(sql`set local role spike_app_worker`); await tx.execute(sql`select spike29_app.bind_context(${ws}::uuid)`); return fn(tx); });
const withSystem = (P, fn) => P.systemDb.transaction(async (tx) => { await tx.execute(sql`set local role spike_app_system`); return fn(tx); });

const rows = (r) => r.rows ?? r;
const codeOf = (e) => e?.code ?? e?.cause?.code;
const observed = new Set();
async function expectPgError(p, codes) { let err; try { await p; } catch (e) { err = e; } assert.ok(err, `expected error ${codes}`); const c = codeOf(err); assert.ok([codes].flat().includes(c), `got ${c}: ${err?.cause?.message ?? err?.message}`); observed.add(`${c} ${(err?.cause?.message ?? err?.message).split('\n')[0]}`); }
const DENIED = ['42501', '42P01', '3F000'];
const wsOf = (rs) => [...new Set(rs.map((r) => r.workspaceId ?? r.workspace_id))];
const LEFTOVER = sql`select pg_backend_pid() as pid, current_user as cu, coalesce(current_setting('request.jwt.claims', true),'') as claims, coalesce(current_setting('app.workspace_id', true),'') as ws, coalesce(current_setting('app.ctx_seal', true),'') as seal`;
const note = (k, v) => console.log(`OBSERVED ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

let P;
before(async () => { P = makePools(1); });
after(async () => { await P.end(); note('rejections', [...observed]); });

describe('M01/M02 — REAL Supabase Auth identity verified server-side and mapped to transaction-local context', () => {
  it('real tokens verify against the project JWKS; getClaims() agrees; header uses an asymmetric key', async () => {
    const hdr = decodeProtectedHeader(U.u_a1.token);
    note('token header', { alg: hdr.alg, has_kid: Boolean(hdr.kid) });
    assert.ok(['ES256', 'RS256'].includes(hdr.alg));
    const viaJwks = await verifyAccessToken(U.u_a1.token);
    const sb = createClient(ORIGIN, E.SPK_PUBLISHABLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await sb.auth.getClaims(U.u_a1.token);
    assert.equal(error, null);
    assert.equal(viaJwks.sub, U.u_a1.id); assert.equal(data.claims.sub, U.u_a1.id);
    note('claims shape', Object.keys(viaJwks).sort());
  });
  it('tampered, re-signed and foreign-key tokens are rejected before any query', async () => {
    const [h, p, sg] = U.u_a1.token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(U.u_a1.token), sub: U.u_b1.id })).toString('base64url');
    const { privateKey } = await generateKeyPair('ES256');
    const reSigned = await new SignJWT({ ...decodeJwt(U.u_a1.token) }).setProtectedHeader(decodeProtectedHeader(U.u_a1.token)).sign(privateKey);
    for (const bad of [`${h}.${forgedPayload}.${sg}`, reSigned, `${h}.${p}.${sg.slice(0, -4)}AAAA`]) {
      let ran = false;
      await assert.rejects(withUserScope(P, bad, A1, async () => { ran = true; }));
      assert.equal(ran, false);
    }
  });
  it('inside the transaction: REAL auth.uid() = token sub, role = authenticated, session user = custom login, workspace bound', async () => {
    const r = await withUserScope(P, U.u_a1.token, A1, async (tx) => rows(await tx.execute(sql`select auth.uid()::text as uid, current_user as cu, session_user as su, spike29_app.current_workspace()::text as ws`))[0]);
    assert.deepEqual(r, { uid: U.u_a1.id, cu: 'authenticated', su: `spike_web_login${E.SPK_SFX}`, ws: A1 });
  });
});

describe('M03 — direct PostgreSQL does not get PostgREST JWT injection', () => {
  it('authenticated role without app-set claims: auth.uid() is NULL and tenant reads return nothing', async () => {
    const r = await P.webDb.transaction(async (tx) => { await tx.execute(sql`set local role authenticated`);
      return { u: rows(await tx.execute(sql`select auth.uid() as u, coalesce(current_setting('request.jwt.claims', true),'') as c`))[0], rs: await tx.select().from(conversations) }; });
    assert.equal(r.u.u, null); assert.equal(r.u.c, ''); assert.equal(r.rs.length, 0);
  });
});

describe('M04/M05 — custom runtime login roles are safe', () => {
  it('catalog (read by the runtime itself): LOGIN only on *_login roles, NOINHERIT, NOBYPASSRLS, not superuser', async () => {
    const r = rows(await P.webDb.execute(sql`select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper from pg_roles where rolname like 'spike\_%' order by 1`));
    for (const x of r) { assert.equal(x.rolbypassrls, false); assert.equal(x.rolsuper, false); assert.equal(x.rolcanlogin, x.rolname.includes('_login')); if (x.rolname.includes('_login')) assert.equal(x.rolinherit, false); }
    note('runtime role attributes', r);
  });
  it('no runtime login can SET ROLE to service_role, postgres, supabase_admin, authenticator, anon, the owner, or another runtime role', async () => {
    const targets = ['service_role', 'postgres', 'supabase_admin', 'authenticator', 'anon', 'spike_owner'];
    for (const [db, own] of [[P.webDb, 'authenticated'], [P.workerDb, 'spike_app_worker'], [P.systemDb, 'spike_app_system']]) {
      for (const t of [...targets, ...['authenticated', 'spike_app_worker', 'spike_app_system'].filter((x) => x !== own)]) {
        await expectPgError(db.transaction(async (tx) => { await tx.execute(sql.raw(`set local role ${t}`)); }), '42501');
      }
    }
  });
});

describe('M06/M07 — Supavisor transaction mode and prepared statements', () => {
  it('transactions multiplex onto server backends; unnamed statements (Drizzle/node-postgres default) work', async () => {
    const pids = [];
    for (let i = 0; i < 20; i++) pids.push(rows(await P.webDb.execute(sql`select pg_backend_pid() as pid`))[0].pid);
    note('backend pids seen by ONE client connection over 20 statements', { distinct: new Set(pids).size });
    assert.equal(pids.length, 20);
  });
  it('named prepared statement reuse behavior through the pooler is recorded', async () => {
    const c = await P.web.connect();
    let outcome;
    try { await c.query({ name: 'spike_named_stmt', text: 'select 1 as x' }); await c.query({ name: 'spike_named_stmt', text: 'select 1 as x' }); outcome = 'reused without error'; }
    catch (e) { outcome = `error ${e.code}: ${e.message}`; } finally { c.release(true); }
    note('named prepared statement through transaction pooler', outcome);
  });
});

describe('M08/M09 — transaction-local context disappears; reused backends serve A → B → none without leakage', () => {
  it('sequential cycle A1 → B1 → none (users and workers): every transaction starts clean and sees only its own rows', async () => {
    const seq = new Map(); let checked = 0;
    for (let i = 0; i < 45; i++) {
      const step = i % 3;
      const worker = i % 2 === 1;
      const run = async (tx) => ({ left: rows(await tx.execute(LEFTOVER))[0], rs: await tx.select().from(conversations) });
      let r;
      if (step === 2) {
        r = await (worker ? P.workerDb : P.webDb).transaction(async (tx) => { const left = rows(await tx.execute(LEFTOVER))[0]; await tx.execute(sql.raw(`set local role ${worker ? 'spike_app_worker' : 'authenticated'}`)); return { left, rs: await tx.select().from(conversations) }; });
        assert.equal(r.rs.length, 0);
      } else {
        const ws = step === 0 ? A1 : B1, tok = step === 0 ? U.u_a1.token : U.u_b1.token;
        const pre = await (worker ? P.workerDb : P.webDb).transaction(async (tx) => rows(await tx.execute(LEFTOVER))[0]);
        assert.equal(pre.ws, ''); assert.equal(pre.seal, ''); assert.equal(pre.claims, '');
        r = worker ? await withWorker(P, ws, run) : await withUserScope(P, tok, ws, run);
        assert.deepEqual(wsOf(r.rs), [ws]); assert.equal(r.rs.length, 3);
      }
      if (step === 2) { assert.equal(r.left.ws, ''); assert.equal(r.left.seal, ''); assert.equal(r.left.claims, ''); }  // A1/B1: clean start asserted by `pre`; r.left is read after bind
      checked++;
      const k = r.left.pid; if (!seq.has(k)) seq.set(k, []); seq.get(k).push(step === 2 ? 'none' : step === 0 ? 'A1' : 'B1');
    }
    const multi = [...seq.entries()].filter(([, v]) => new Set(v).size >= 2);
    note('backend reuse across tenants (sequential)', { transactions: checked, backends: seq.size, backends_serving_2plus_contexts: multi.length, example: multi[0]?.[1]?.slice(0, 9) });
    assert.ok(multi.length >= 1, 'at least one server backend served different tenants/none');
  });
});

describe('M10/M11 — missing and foreign context fail closed (reads, writes, references)', () => {
  it('missing workspace context: zero rows, inserts denied (user and worker)', async () => {
    const r = await P.webDb.transaction(async (tx) => { await tx.execute(sql`set local role authenticated`); await tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: U.u_a1.id, role: 'authenticated' })}, true)`); return tx.select().from(conversations); });
    assert.equal(r.length, 0);
    await expectPgError(P.workerDb.transaction(async (tx) => { await tx.execute(sql`set local role spike_app_worker`); await tx.insert(conversations).values({ id: crypto.randomUUID(), workspaceId: A1, title: 'x' }); }), '42501');
  });
  it('foreign reads return nothing; fabricated / cross-org context returns nothing', async () => {
    const r = await withUserScope(P, U.u_a1.token, A1, async (tx) => [await tx.select().from(conversations).where(eq(conversations.workspaceId, B1)), await tx.select().from(conversations).where(eq(conversations.id, CONV_B1))]);
    for (const x of r) assert.equal(x.length, 0);
    for (const [tok, ws] of [[U.u_a1.token, A2], [U.u_a1.token, B1], [U.u_a1.token, crypto.randomUUID()], [U.u_none.token, A1]]) assert.equal((await withUserScope(P, tok, ws, (tx) => tx.select().from(conversations))).length, 0);
    assert.deepEqual(wsOf(await withUserScope(P, U.u_a12.token, A1, (tx) => tx.select().from(conversations))), [A1]);
  });
  it('foreign writes: 0 rows updated/deleted; inserts/moves into B rejected', async () => {
    const r = await withUserScope(P, U.u_a1.token, A1, async (tx) => ({ u: await tx.update(conversations).set({ title: 'pwned' }).where(eq(conversations.id, CONV_B1)).returning(), d: await tx.delete(conversations).where(eq(conversations.workspaceId, B1)).returning() }));
    assert.equal(r.u.length, 0); assert.equal(r.d.length, 0);
    await expectPgError(withUserScope(P, U.u_a1.token, A1, (tx) => tx.insert(conversations).values({ id: crypto.randomUUID(), workspaceId: B1, title: 'x' })), '42501');
    await expectPgError(withUserScope(P, U.u_a1.token, A1, (tx) => tx.update(conversations).set({ workspaceId: B1 }).where(eq(conversations.id, CONV_A1))), '42501');
    const still = await withUserScope(P, U.u_b1.token, B1, (tx) => tx.select().from(conversations));
    assert.equal(still.length, 3); assert.ok(still.every((x) => x.title !== 'pwned'));
  });
  it('cross-workspace reference fails exactly like a non-existent one (R5)', async () => {
    await expectPgError(withWorker(P, A1, (tx) => tx.insert(interactions).values({ id: crypto.randomUUID(), workspaceId: A1, conversationId: CONV_B1, body: 'x' })), '23503');
    await expectPgError(withWorker(P, A1, (tx) => tx.insert(interactions).values({ id: crypto.randomUUID(), workspaceId: A1, conversationId: crypto.randomUUID(), body: 'x' })), '23503');
  });
  it('client guest: guest projection only; attention signals follow non-guest memberships (REAL auth.uid())', async () => {
    const g = await withUserScope(P, U.u_guest.token, A1, async (tx) => ({ c: await tx.select().from(conversations), gi: await tx.select().from(guestInsights), at: await tx.select().from(attentionSignals) }));
    assert.equal(g.c.length, 0); assert.equal(g.at.length, 0); assert.deepEqual(wsOf(g.gi), [A1]);
    assert.deepEqual(wsOf(await withUserScope(P, U.u_a12.token, A1, (tx) => tx.select().from(attentionSignals))).sort(), [A1, A2]);
  });
});

describe('M12 — worker cannot escape its workspace', () => {
  it('query B from A, rebind, raw set_config, replayed seal: all fail closed', async () => {
    assert.equal((await withWorker(P, A1, (tx) => tx.select().from(conversations).where(eq(conversations.workspaceId, B1)))).length, 0);
    await expectPgError(withWorker(P, A1, (tx) => tx.execute(sql`select spike29_app.bind_context(${B1}::uuid)`)), '42501');
    assert.equal((await withWorker(P, A1, async (tx) => { await tx.execute(sql`select set_config('app.workspace_id', ${B1}, true)`); return tx.select().from(conversations); })).length, 0);
    const seal = await withWorker(P, B1, async (tx) => rows(await tx.execute(sql`select current_setting('app.ctx_seal') as s`))[0].s);
    const replay = await P.workerDb.transaction(async (tx) => { await tx.execute(sql`set local role spike_app_worker`); await tx.execute(sql`select set_config('app.workspace_id', ${B1}, true), set_config('app.ctx_seal', ${seal}, true)`); return tx.select().from(conversations); });
    assert.equal(replay.length, 0);
  });
});

describe('M13 — system role reaches only explicit system metadata', () => {
  it('reads system table; tenant tables, helpers and Supabase auth tables denied', async () => {
    assert.equal(rows(await withSystem(P, (tx) => tx.execute(sql`select * from spike29_system.outbox_meta`))).length, 1);
    await expectPgError(withSystem(P, (tx) => tx.select().from(conversations)), DENIED);
    await expectPgError(withSystem(P, (tx) => tx.execute(sql`select spike29_app.current_workspace()`)), DENIED);
    await expectPgError(withSystem(P, (tx) => tx.execute(sql`select count(*) from auth.users`)), DENIED);
  });
});

describe('M14/M15 — Supabase default grants / auth roles create no unexpected path', () => {
  it('authenticated (as used by the web runtime) cannot read Supabase auth or storage internals', async () => {
    await expectPgError(withUserScope(P, U.u_a1.token, A1, (tx) => tx.execute(sql`select count(*) from auth.users`)), DENIED);
    const pub = rows(await withUserScope(P, U.u_a1.token, A1, (tx) => tx.execute(sql`select count(*)::int as n from information_schema.role_table_grants where grantee in ('authenticated','anon','PUBLIC') and table_schema not in ('pg_catalog','information_schema')`)));
    note('table grants visible to authenticated/anon/PUBLIC in this project (from runtime view)', pub[0]);
  });
  it('runtime login roles have no privileges of their own (without SET ROLE everything is denied)', async () => {
    await expectPgError(P.webDb.select().from(conversations), DENIED);
    await expectPgError(P.workerDb.select().from(interactions), DENIED);
    await expectPgError(P.systemDb.execute(sql`select * from spike29_system.outbox_meta`), DENIED);
  });
});

describe('M16 — runtime holds no service-role / bootstrap credential', () => {
  it('runtime environment contains no secret key, service-role key or bootstrap DB URL', () => {
    for (const k of Object.keys(E)) assert.ok(!/SECRET_KEY|SERVICE_ROLE|BOOTSTRAP/.test(k), `unexpected runtime env var ${k}`);
    assert.equal(Object.values(E).some((v) => typeof v === 'string' && v.startsWith('sb_secret_')), false);
  });
});

describe('M17 — direct Drizzle without the tenant wrapper fails closed', () => {
  it('unscoped queries are rejected; a leftover session-level SET ROLE yields zero rows', async () => {
    await expectPgError(P.webDb.update(conversations).set({ title: 'x' }), DENIED);
    const c = await P.web.connect();
    try { await c.query('set role authenticated'); const r = await c.query('select count(*)::int n from spike29.conversations'); assert.equal(r.rows[0].n, 0); await c.query('reset role'); }
    finally { c.release(true); }
  });
});

describe('R2 under Supavisor — session-level state left by buggy code', () => {
  it('a session-level workspace/seal written outside a transaction may surface on other clients, but the seal makes it unusable', async () => {
    const seal = await withWorker(P, B1, async (tx) => rows(await tx.execute(sql`select current_setting('app.ctx_seal') as s`))[0].s);
    const poison = pool(`spike_worker_login${E.SPK_SFX}`, E.SPK_WORKER_PW, 1);
    await poison.query(`select set_config('app.workspace_id', $1, false), set_config('app.ctx_seal', $2, false)`, [B1, seal]);
    await poison.end();
    const Q = makePools(4); let surfaced = 0, leaked = 0;
    try {
      await Promise.all(Array.from({ length: 60 }, async () => {
        const r = await Q.workerDb.transaction(async (tx) => { const left = rows(await tx.execute(LEFTOVER))[0]; await tx.execute(sql`set local role spike_app_worker`); return { left, rs: await tx.select().from(conversations) }; });
        if (r.left.ws) surfaced++; if (r.rs.length) leaked++;
      }));
    } finally { await Q.end(); }
    note('session-level value surfaced in other clients\' transactions', { transactions: 60, surfaced, rows_leaked: leaked });
    assert.equal(leaked, 0);
  });
});

describe('M18 — pooling stress across synthetic tenants', () => {
  it('300 concurrent user/worker transactions over Supavisor never see foreign rows and always start clean', async () => {
    const Q = makePools(6);
    const plan = [[U.u_a1.token, A1], [U.u_a12.token, A1], [U.u_a12.token, A2], [U.u_b1.token, B1]];
    const per = new Map(); let ok = 0, dirtyStarts = 0;
    try {
      await Promise.all(Array.from({ length: 300 }, async (_, i) => {
        const [tok, ws] = plan[i % plan.length]; const worker = i % 3 === 0;
        const run = async (tx) => ({ left: rows(await tx.execute(sql`select pg_backend_pid() as pid`))[0], rs: await tx.select().from(conversations) });
        const r = worker ? await withWorker(Q, ws, run) : await withUserScope(Q, tok, ws, run);
        assert.deepEqual(wsOf(r.rs), [ws]); assert.equal(r.rs.length, 3); ok++;
        if (!per.has(r.left.pid)) per.set(r.left.pid, new Set()); per.get(r.left.pid).add(ws);
      }));
    } finally { await Q.end(); }
    note('stress', { transactions: ok, backends: per.size, backends_serving_multiple_tenants: [...per.values()].filter((v) => v.size > 1).length, dirtyStarts });
    assert.equal(ok, 300);
  });
});
