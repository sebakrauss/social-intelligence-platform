// DISPOSABLE MANAGED SPIKE RUNNER — Supabase DEVELOPMENT project (social-intelligence-dev). NOT PRODUCTION CODE.
//
// TEST BOOTSTRAP privilege (this file only, never runtime):
//   · SUPABASE_DB_BOOTSTRAP_URL (postgres role via session pooler) creates/drops the disposable spike29 objects
//   · SUPABASE_SECRET_KEY (Admin API) creates/deletes synthetic Auth users
// RUNTIME privilege (the tests): custom login roles through Supavisor TRANSACTION mode (port 6543) with random,
//   in-memory-only passwords, plus REAL user access tokens obtained with the publishable key.
// Nothing secret is printed or written: child output is redacted before it reaches the console or evidence file.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
// SCRAM-SHA-256 verifier computed client-side: the server (and any DDL statement log) never sees a plaintext password.
const scram = (password, iterations = 4096) => {
  const salt = randomBytes(16), salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest(), serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${createHash('sha256').update(clientKey).digest('base64')}:${serverKey.toString('base64')}`;
};
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await import('./env.mjs');
const ORIGIN = new URL(process.env.SUPABASE_URL).origin;               // tolerate a pasted /rest/v1/ suffix
const REF = process.env.SUPABASE_PROJECT_REF;
const boot = new URL(process.env.SUPABASE_DB_BOOTSTRAP_URL);
const POOLER_HOST = boot.hostname;
const rand = (n = 24) => randomBytes(n).toString('base64url');
const SSL = { rejectUnauthorized: false };                              // spike only — see validation doc §0E.2b limitations

const secrets = new Set([process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_PUBLISHABLE_KEY, process.env.SUPABASE_DB_BOOTSTRAP_URL,
  decodeURIComponent(boot.password), POOLER_HOST, REF, ORIGIN]);
const redact = (s) => { let t = s; for (const v of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(v).join('<redacted>'); return t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>').replace(/[\w.+-]+@example\.com/g, '<synthetic-email>'); };
const log = (...a) => console.log(redact(a.join(' ')));

const runId = rand(4).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const admin = createClient(ORIGIN, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anonClient = () => createClient(ORIGIN, process.env.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_BOOTSTRAP_URL, ssl: SSL });
const createdUsers = [];
// Per-run login role names: Supavisor keeps pooled server connections per <role>.<ref>; recreating a dropped role with the
// SAME name gives it a new OID and stale pooled backends then fail with `invalid role OID` (observed, see evidence).
const SFX = '_' + rand(3).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const logins = { [`spike_web_login${SFX}`]: rand(), [`spike_worker_login${SFX}`]: rand(), [`spike_system_login${SFX}`]: rand() };
for (const v of Object.values(logins)) secrets.add(v);
const teardownReport = {};

async function teardown() {
  const q = (s) => db.query(s).catch((e) => ({ error: e.code + ' ' + e.message }));
  const kill = async () => (await q(`select count(pg_terminate_backend(a.pid))::int c from pg_stat_activity a where a.backend_type = 'client backend'
     and (a.usename like 'spike\\_%' or (a.usesysid is not null and not exists (select 1 from pg_roles r where r.oid = a.usesysid)))`)).rows?.[0]?.c ?? 'n/a';
  teardownReport.terminated_spike_backends = await kill();
  await q(`drop table if exists public.spike29_canary`);
  await q(`drop schema if exists spike29, spike29_app, spike29_private, spike29_system cascade`);
  const spikeRoles = ((await q(`select rolname from pg_roles where rolname like 'spike\\_%' order by rolcanlogin desc, rolname`)).rows ?? []).map((x) => x.rolname);
  for (const r of spikeRoles.filter((x) => x !== 'spike_owner').concat(spikeRoles.includes('spike_owner') ? ['spike_owner'] : [])) {
    // DROP OWNED needs membership in the role; try a plain DROP ROLE first, take temporary membership only if needed.
    await q(`do $$ begin if exists (select 1 from pg_roles where rolname = '${r}') then
      begin execute 'drop role ${r}';
      exception when others then execute 'grant ${r} to current_user'; execute 'drop owned by ${r}'; execute 'drop role ${r}'; end;
    end if; end $$`);
  }
  teardownReport.terminated_orphaned_after_drop = await kill();
  teardownReport.remaining_spike_roles = (await q(`select count(*)::int c from pg_roles where rolname like 'spike\\_%'`)).rows?.[0]?.c;
  teardownReport.remaining_spike_schemas = (await q(`select count(*)::int c from pg_namespace where nspname like 'spike29%'`)).rows?.[0]?.c;
  let deleted = 0;
  for (const u of createdUsers) { const { error } = await admin.auth.admin.deleteUser(u.id); if (!error) deleted++; }
  teardownReport.synthetic_auth_users_created = createdUsers.length;
  teardownReport.synthetic_auth_users_deleted = deleted;
}

let exitCode = 1;
await db.connect();
try {
  await teardown();                                                       // clean any leftovers of an aborted run
  const facts = {};
  facts.server_version = (await db.query('show server_version')).rows[0].server_version;
  facts.postmaster_uptime_at_start = (await db.query('select (now() - pg_postmaster_start_time())::text as u')).rows[0].u;
  facts.bootstrap_role = (await db.query(`select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user`)).rows[0];

  // ---- synthetic Auth users (TEST BOOTSTRAP: Admin API) ----
  const labels = ['u_a1', 'u_a12', 'u_b1', 'u_guest', 'u_none'];
  const users = {};
  for (const label of labels) {
    const email = `spike-${runId}-${label.replace('_', '')}@example.com`, password = rand();
    secrets.add(password);
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { spike: true } });
    if (error) throw new Error(`createUser failed: ${error.message}`);
    createdUsers.push(data.user); users[label] = { id: data.user.id, email, password };
  }
  // ---- REAL access tokens (publishable key, password grant) ----
  for (const label of labels) {
    const { data, error } = await anonClient().auth.signInWithPassword({ email: users[label].email, password: users[label].password });
    if (error) throw new Error(`signIn failed: ${error.message}`);
    users[label].token = data.session.access_token; secrets.add(data.session.access_token); secrets.add(data.session.refresh_token);
  }

  // ---- disposable schema, roles, seed, security ----
  await db.query(await readFile(path.join(here, 'fixture-schema.sql'), 'utf8'));
  const A1 = 'a1000000-0000-0000-0000-000000000000', A2 = 'a2000000-0000-0000-0000-000000000000', B1 = 'b1000000-0000-0000-0000-000000000000';
  await db.query('begin'); await db.query('set local role spike_owner');
  await db.query(`insert into spike29.organizations values ('0a000000-0000-0000-0000-000000000000','Org A'),('0b000000-0000-0000-0000-000000000000','Org B')`);
  await db.query(`insert into spike29.workspaces values ($1,'0a000000-0000-0000-0000-000000000000','A1'),($2,'0a000000-0000-0000-0000-000000000000','A2'),($3,'0b000000-0000-0000-0000-000000000000','B1')`, [A1, A2, B1]);
  await db.query(`insert into spike29.memberships values ($1,$4,'manager'),($2,$4,'responder'),($2,$5,'manager'),($3,$6,'manager'),($7,$4,'client_guest')`,
    [users.u_a1.id, users.u_a12.id, users.u_b1.id, A1, A2, B1, users.u_guest.id]);
  for (const [tag, ws] of [['a1', A1], ['a2', A2], ['b1', B1]]) for (let n = 1; n <= 3; n++) {
    const conv = `c${tag}00000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    await db.query(`insert into spike29.conversations values ($1,$2,$3)`, [conv, ws, `synthetic conversation ${n}`]);
    await db.query(`insert into spike29.interactions values ($1,$2,$3,$4)`, [`d${tag}00000-0000-0000-0000-${String(n).padStart(12, '0')}`, ws, conv, `synthetic comment ${n}`]);
  }
  await db.query(`insert into spike29.guest_insights values ('e1000000-0000-0000-0000-0000000000a1',$1,'guest-safe A1'),('e1000000-0000-0000-0000-0000000000b1',$2,'guest-safe B1')`, [A1, B1]);
  await db.query(`insert into spike29.attention_signals values ($1,true),($2,false),($3,true)`, [A1, A2, B1]);
  await db.query(`insert into spike29_system.outbox_meta values ('f0000000-0000-0000-0000-000000000001',$1,'pending')`, [A1]);
  await db.query('commit');
  await db.query(await readFile(path.join(here, 'fixture-security.sql'), 'utf8'));

  // ---- runtime login roles: LOGIN NOINHERIT NOBYPASSRLS, each may SET ROLE to exactly one runtime role ----
  facts.role_grants = {};
  for (const [login, target] of [[`spike_web_login${SFX}`, 'authenticated'], [`spike_worker_login${SFX}`, 'spike_app_worker'], [`spike_system_login${SFX}`, 'spike_app_system']]) {
    await db.query(`create role ${login} login noinherit nobypassrls password '${scram(logins[login])}'`);
    try { await db.query(`grant ${target} to ${login}`); facts.role_grants[login] = `granted ${target}`; }
    catch (e) { facts.role_grants[login] = `FAILED to grant ${target}: ${e.code} ${e.message}`; throw e; }
  }

  // ---- default-grant inspection + public canary (item 14) ----
  facts.default_acls = (await db.query(`select pg_get_userbyid(d.defaclrole) as creator, coalesce(n.nspname,'<all schemas>') as schema, d.defaclobjtype as type, d.defaclacl::text as acl
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1,2,3`)).rows;
  await db.query(`create table public.spike29_canary (id int primary key, note text)`);
  await db.query(`insert into public.spike29_canary values (1, 'synthetic canary row')`);
  facts.canary_privileges_after_create = (await db.query(`select r as role, has_table_privilege(r, 'public.spike29_canary', 'SELECT') as can_select
    from unnest(array['anon','authenticated',$1,$2]) r`, [`spike_web_login${SFX}`, `spike_worker_login${SFX}`])).rows;
  const restCanary = async () => { const res = await fetch(`${ORIGIN}/rest/v1/spike29_canary?select=id,note`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } }); return { status: res.status, rows: res.ok ? (await res.json()).length : null }; };
  facts.canary_rest_publishable_key_no_rls = await restCanary();
  await db.query(`alter table public.spike29_canary enable row level security`);
  facts.canary_rest_publishable_key_with_rls = await restCanary();
  await db.query(`drop table public.spike29_canary`);
  const resSpike = await fetch(`${ORIGIN}/rest/v1/conversations?select=id`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${users.u_a1.token}`, 'Accept-Profile': 'spike29' } });
  facts.rest_spike29_schema_exposed = { status: resSpike.status, ok: resSpike.ok };
  facts.runtime_role_attributes = (await db.query(`select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper,
      pg_has_role(rolname,'service_role','MEMBER') as member_service_role, pg_has_role(rolname,'postgres','MEMBER') as member_postgres,
      pg_has_role(rolname,'spike_owner','MEMBER') as member_owner, pg_has_role(rolname,'anon','MEMBER') as member_anon
    from pg_roles where rolname like 'spike\\_%' or rolname in ('authenticated') order by 1`)).rows;
  facts.forced_rls_tables = (await db.query(`select count(*) filter (where relrowsecurity and relforcerowsecurity)::int forced, count(*)::int total
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('spike29','spike29_system') and relkind='r'`)).rows[0];
  facts.auth_uid_definition = (await db.query(`select regexp_replace(pg_get_functiondef('auth.uid()'::regprocedure), '\\s+', ' ', 'g') as d`)).rows[0].d;
  await mkdir(path.join(here, '..', 'evidence'), { recursive: true });

  // ---- run the managed test suite with RUNTIME credentials only ----
  const env = { PATH: process.env.PATH, HOME: process.env.HOME,
    SPK_ORIGIN: ORIGIN, SPK_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    SPK_POOLER_HOST: POOLER_HOST, SPK_REF: REF,
    SPK_SFX: SFX, SPK_WEB_PW: logins[`spike_web_login${SFX}`], SPK_WORKER_PW: logins[`spike_worker_login${SFX}`], SPK_SYSTEM_PW: logins[`spike_system_login${SFX}`],
    SPK_USERS: JSON.stringify(Object.fromEntries(Object.entries(users).map(([k, v]) => [k, { id: v.id, token: v.token }]))) };
  // NOTE: the child receives NO bootstrap URL and NO secret key — runtime must work without them.
  const out = [];
  exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', path.join(here, 'managed.test.mjs')], { env });
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { const t = redact(d.toString()); process.stdout.write(t); out.push(t); });
    child.on('close', resolve);
  });
  await teardown();
  const header = `TA-Q-29 MANAGED run (Supabase DEVELOPMENT project) — ${new Date().toISOString()}\nexit code: ${exitCode}\n\nPROJECT FACTS (bootstrap inspection, redacted):\n${redact(JSON.stringify(facts, null, 2))}\n\nTEARDOWN:\n${JSON.stringify(teardownReport, null, 2)}\n\n`;
  const evidencePath = path.join(here, '..', 'evidence', `ta-q-29-managed-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  await writeFile(evidencePath, header + out.join('').replace(/\x1b\[[0-9;]*m/g, ''), { flag: 'wx' });   // write-once: never overwrites
  log(`EVIDENCE WRITTEN: ${path.basename(evidencePath)}`);
  log(header);
} catch (e) {
  log('MANAGED RUN ERROR:', e.code ?? '', e.message);
  await teardown().catch(() => {});
  log('TEARDOWN:', JSON.stringify(teardownReport));
} finally {
  await db.end();
}
process.exit(exitCode);
