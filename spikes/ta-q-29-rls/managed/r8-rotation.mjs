// DISPOSABLE MANAGED SPIKE — R8: role rotation under Supavisor transaction pooling (Supabase DEVELOPMENT project).
// Characterizes what happens when a runtime login role is dropped and recreated with the SAME name while Supavisor
// may still hold pooled server connections for `<role>.<ref>`, and verifies the recovery procedure.
// TEST BOOTSTRAP credential only. Random in-memory passwords sent as SCRAM verifiers. Output redacted; write-once evidence.
import pg from 'pg';
import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
await import('./env.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = process.env.SUPABASE_PROJECT_REF, HOST = new URL(process.env.SUPABASE_DB_BOOTSTRAP_URL).hostname;
const rand = () => randomBytes(24).toString('base64url');
const scram = (pw, it = 4096) => { const salt = randomBytes(16), s = pbkdf2Sync(pw, salt, it, 32, 'sha256');
  const ck = createHmac('sha256', s).update('Client Key').digest(), sk = createHmac('sha256', s).update('Server Key').digest();
  return `SCRAM-SHA-256$${it}:${salt.toString('base64')}$${createHash('sha256').update(ck).digest('base64')}:${sk.toString('base64')}`; };
const ROLE = 'spike_rot_login';                      // FIXED name on purpose (this is what R8 is about)
const secrets = [process.env.SUPABASE_DB_BOOTSTRAP_URL, HOST, REF];
const redact = (s) => { let t = String(s); for (const v of secrets.filter(Boolean)) t = t.split(v).join('<redacted>'); return t; };
const lines = []; const rec = (k, v) => { const l = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`; lines.push(redact(l)); console.log(redact(l)); };

const boot = new pg.Client({ connectionString: process.env.SUPABASE_DB_BOOTSTRAP_URL, ssl: { rejectUnauthorized: false } });
await boot.connect();
const bq = (s, p) => boot.query(s, p);
const backends = async () => (await bq(`select count(*) filter (where usename = $1)::int as role_backends,
  count(*) filter (where usesysid is not null and not exists (select 1 from pg_roles r where r.oid = a.usesysid))::int as orphaned
  from pg_stat_activity a where backend_type = 'client backend'`, [ROLE])).rows[0];
const terminateRole = async () => (await bq(`select count(pg_terminate_backend(pid))::int n from pg_stat_activity where usename = $1`, [ROLE])).rows[0].n;
const terminateOrphans = async () => (await bq(`select count(pg_terminate_backend(a.pid))::int n from pg_stat_activity a where a.backend_type='client backend'
  and a.usesysid is not null and not exists (select 1 from pg_roles r where r.oid = a.usesysid)`)).rows[0].n;
async function tryRuntime(pw, label) {
  const pool = new pg.Pool({ host: HOST, port: 6543, user: `${ROLE}.${REF}`, password: pw, database: 'postgres', max: 2, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  try { for (let i = 0; i < 4; i++) await pool.query('select pg_backend_pid(), current_user'); rec(label, 'OK (4 queries through Supavisor transaction mode)'); return true; }
  catch (e) { rec(label, `ERROR ${e.code ?? ''} ${String(e.message).split('\n')[0]}`); return false; }
  finally { await pool.end().catch(() => {}); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exit = 1;
try {
  await bq(`do $$ begin if exists (select 1 from pg_roles where rolname = '${ROLE}') then execute 'drop role ${ROLE}'; end if; end $$`);
  const pw1 = rand(), pw2 = rand(); secrets.push(pw1, pw2);
  await bq(`create role ${ROLE} login noinherit nobypassrls password '${scram(pw1)}'`);
  rec('step1 role created (generation 1)', 'ok');
  await tryRuntime(pw1, 'step1 runtime connect as generation 1');
  await sleep(2000); rec('step1 pooled server backends held for role', await backends());

  rec('step2 terminate role backends', await terminateRole());
  await bq(`drop role ${ROLE}`); rec('step2 role dropped', 'ok');
  await sleep(3000); rec('step2 backends after drop (orphaned = role no longer exists)', await backends());

  await bq(`create role ${ROLE} login noinherit nobypassrls password '${scram(pw2)}'`);
  rec('step3 role recreated with SAME name (generation 2, new OID, new password)', 'ok');
  const naive = await tryRuntime(pw2, 'step3 runtime connect WITHOUT rotation procedure');

  rec('step4 rotation procedure: terminate role + orphaned backends', { role: await terminateRole(), orphaned: await terminateOrphans() });
  await sleep(3000);
  const procedure = await tryRuntime(pw2, 'step4 runtime connect AFTER rotation procedure');
  rec('R8 summary', { naive_reuse_ok: naive, after_procedure_ok: procedure });
  exit = procedure ? 0 : 1;
} finally {
  await terminateRole().catch(() => {});
  await bq(`do $$ begin if exists (select 1 from pg_roles where rolname = '${ROLE}') then execute 'drop role ${ROLE}'; end if; end $$`).catch((e) => rec('cleanup drop error', e.code));
  await sleep(2000);
  rec('cleanup orphaned backends terminated', await terminateOrphans().catch(() => 'n/a'));
  rec('cleanup final', (await bq(`select (select count(*) from pg_roles where rolname like 'spike\\_%')::int as spike_roles`)).rows[0]);
  await boot.end();
  await mkdir(path.join(here, '..', 'evidence'), { recursive: true });
  const f = path.join(here, '..', 'evidence', `ta-q-29-managed-r8-rotation-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  await writeFile(f, `R8 role-rotation characterization (Supabase DEVELOPMENT, Supavisor transaction mode) — ${new Date().toISOString()}\n\n${lines.join('\n')}\n`, { flag: 'wx' });
  console.log(`EVIDENCE WRITTEN: ${path.basename(f)}`);
}
process.exit(exit);
