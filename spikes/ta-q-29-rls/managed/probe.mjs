// DISPOSABLE SPIKE — read-only inspection of the Supabase DEVELOPMENT project (TEST BOOTSTRAP credential).
// Prints only non-secret facts. Never prints connection strings, keys, passwords, hosts or tokens.
import pg from 'pg';
import './env.mjs';

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_BOOTSTRAP_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const out = {};
out.server_version = (await q('show server_version'))[0].server_version;
out.bootstrap_role = (await q(`select rolname, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname = current_user`))[0];
out.supabase_roles = await q(`select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper from pg_roles
  where rolname in ('postgres','anon','authenticated','authenticator','service_role','supabase_admin','supabase_auth_admin') order by 1`);
out.members_of_authenticated = await q(`select m.rolname as member, a.admin_option, a.set_option, a.inherit_option
  from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member where r.rolname = 'authenticated' order by 1`);
out.postgres_can_admin_authenticated = (await q(`select pg_has_role(current_user, 'authenticated', 'USAGE WITH ADMIN OPTION') as v`))[0].v;
out.auth_uid_definition = (await q(`select pg_get_functiondef('auth.uid()'::regprocedure) as d`))[0].d.replace(/\s+/g, ' ').trim();
out.auth_schema_usage_grantable = (await q(`select has_schema_privilege(current_user, 'auth', 'USAGE WITH GRANT OPTION') as v`))[0].v;
out.default_acls = await q(`select pg_get_userbyid(d.defaclrole) as for_objects_created_by, n.nspname as schema, d.defaclobjtype as objtype, d.defaclacl::text as acl
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace where n.nspname in ('public') or d.defaclnamespace = 0 order by 1,2,3`);
out.public_schema_acl = (await q(`select nspacl::text as acl from pg_namespace where nspname = 'public'`))[0].acl;
out.existing_public_tables = (await q(`select count(*)::int c from pg_tables where schemaname = 'public'`))[0].c;
out.leftover_spike_objects = (await q(`select (select count(*) from pg_namespace where nspname like 'spike29%')::int as schemas, (select count(*) from pg_roles where rolname like 'spike_%')::int as roles`))[0];
await c.end();

const jwks = await (await fetch(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)).json();
out.jwks_keys = (jwks.keys ?? []).map((k) => ({ kty: k.kty, alg: k.alg, use: k.use, has_kid: Boolean(k.kid) }));
console.log(JSON.stringify(out, null, 2));
