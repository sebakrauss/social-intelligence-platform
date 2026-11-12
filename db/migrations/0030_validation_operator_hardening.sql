-- 0030 · Targeted PRE-LIVE hardening of the validation operator path (Step 7B-14I3H). Forward-only and expand-only:
-- 0028 and 0029 are not edited. No table, column or row changes; no privilege of any operator role is widened.
--
--   H2  name resolution in privileged code. Under `search_path = ''` PostgreSQL still searches the session's temporary
--       schema FIRST for relation and type names (it is never searched for functions or operators). A session that may
--       create temporary objects — any role holding TEMP, which PUBLIC holds by default — could therefore define, e.g., a
--       domain pg_temp.text whose CHECK calls a pg_temp function, and that function then ran as app_owner inside the
--       operator definers (reproduced locally in Step 7B-14I3H: validation_authorization_status, issue and revoke, the
--       0028 guard, app.current_workspace, app.bind_workspace, app.current_workspace_organization and
--       app_private.context_seal all resolved pg_temp types). Every function an operator session compiles or runs, and
--       the authorization's own triggers and evidence definer, now pin `search_path = pg_catalog, pg_temp`: pg_catalog
--       is searched first for every builtin type and relation, pg_temp LAST (and never for functions or operators).
--       Every name these functions use is schema-qualified or a builtin, so nothing they reference changes.
--       This is PostgreSQL's documented pattern for SECURITY DEFINER functions ("Writing SECURITY DEFINER Functions
--       Safely"). TA §11 wording ("empty search_path") is not edited here: the discrepancy is reported for decision.
--
--   H4  the operator login's identity check (mutations.validation_operator_login) refuses, in addition to 0029's checks,
--       a login whose membership in app_validation_operator INHERITs or cannot SET; any role other than the migration role
--       that is a member OF the login; per-role settings; ANY direct privilege, ownership or policy reference of the login (pg_shdepend, every
--       database) other than CONNECT on this database and its own session's temporary objects; CREATE on this database
--       or on any schema; and an app_validation_operator that is not exactly NOLOGIN NOINHERIT with no attribute, no
--       membership, no ownership, and no privilege beyond USAGE on `mutations` and EXECUTE on its three functions.
--
--   H1  the executor binds the credential it opens to the PREFLIGHT evidence the authorization was issued from: the
--       bound worker may now READ the USED evidence of its bound workspace (identifiers, verdict and time; never text).
--       Unused evidence stays invisible to every runtime; nothing here lets a runtime write it.
--
-- Window: 0029 and 0030 are applied together, BEFORE any validation operator login exists. This migration refuses to
-- run when any role other than the migration role itself holds app_validation_operator (a login provisioned in the
-- intermediate state).

do $$
begin
  -- The migration role itself holds it (PostgreSQL 16+ grants the creator of a role ADMIN on it): that is not a login.
  if exists (
    select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles g on g.oid = m.roleid join pg_catalog.pg_roles r on r.oid = m.member
     where g.rolname = 'app_validation_operator' and r.rolname <> session_user) then
    raise exception 'a role already holds app_validation_operator; validation operator logins are provisioned only after 0030 (refusing)';
  end if;
end $$;

set role app_owner;

-- ── H2: pin pg_catalog first and pg_temp last for every function of the operator path ───────────────────────────────
-- The operator definers and their helpers (0029).
alter function mutations.issue_validation_authorization(uuid, uuid, uuid, text, integer, boolean) set search_path = pg_catalog, pg_temp;
alter function mutations.revoke_validation_authorization(uuid, uuid, text) set search_path = pg_catalog, pg_temp;
alter function mutations.validation_authorization_status(uuid, uuid) set search_path = pg_catalog, pg_temp;
alter function mutations.validation_operator_bind(uuid) set search_path = pg_catalog, pg_temp;
alter function mutations.record_validation_preflight(uuid, uuid, uuid, uuid, text, text, integer, boolean, boolean, integer, integer, boolean) set search_path = pg_catalog, pg_temp;
alter function mutations.validation_preflight_guard() set search_path = pg_catalog, pg_temp;
alter function mutations.validation_operator_event_guard() set search_path = pg_catalog, pg_temp;
-- The authorization's guard and its intent triggers (0028).
alter function mutations.validation_authorization_guard() set search_path = pg_catalog, pg_temp;
alter function mutations.bind_validation_authorization() set search_path = pg_catalog, pg_temp;
alter function mutations.consume_validation_authorization() set search_path = pg_catalog, pg_temp;
-- The tenancy helpers the operator definers and the owner policies they pass through call (0003 / 0004 era).
alter function app.current_workspace() set search_path = pg_catalog, pg_temp;
alter function app.bind_workspace(uuid) set search_path = pg_catalog, pg_temp;
alter function app.current_workspace_organization() set search_path = pg_catalog, pg_temp;
alter function app_private.context_seal(text, text) set search_path = pg_catalog, pg_temp;

-- ── H4: the operator identity, re-derived from the session login and the catalog (replaces 0029's) ────────────────
-- SECURITY INVOKER, executed by nobody but the owner's definers (no EXECUTE grant). It reads only pg_catalog.
create or replace function mutations.validation_operator_login() returns text
language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
declare
  v_role     record;
  v_operator pg_catalog.oid;
  v_database pg_catalog.oid := (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database());
  -- The session's own temporary schemas (pg_temp_N and its pg_toast_temp_N): what it creates there is its own business —
  -- the functions above never resolve it (H2) — and vanishes with the session.
  v_toast    pg_catalog.oid := (select n.oid from pg_catalog.pg_namespace n
                                 where n.nspname = 'pg_toast_' || pg_catalog.substr(pg_catalog.pg_my_temp_schema()::pg_catalog.regnamespace::pg_catalog.text, 4));
begin
  select r.oid, r.rolname::pg_catalog.text as name, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit
    into v_role
    from pg_catalog.pg_roles r where r.rolname = session_user;
  if not found
     or v_role.name !~ '^validation_operator_[a-z0-9_]{2,40}$'
     or not v_role.rolcanlogin or v_role.rolsuper or v_role.rolbypassrls or v_role.rolcreaterole
     or v_role.rolcreatedb or v_role.rolreplication or v_role.rolinherit then
    raise exception 'validation operator: the session login is not a validation operator login' using errcode = '42501';
  end if;
  select g.oid into v_operator from pg_catalog.pg_roles g
   where g.rolname = 'app_validation_operator' and not g.rolcanlogin and not g.rolinherit and not g.rolsuper and not g.rolbypassrls
     and not g.rolcreaterole and not g.rolcreatedb and not g.rolreplication;
  if v_operator is null or v_database is null then
    raise exception 'validation operator: the session login is not a validation operator login' using errcode = '42501';
  end if;
  -- Exactly ONE membership: app_validation_operator — SET (to act as it), never ADMIN, never INHERIT.
  if (select pg_catalog.count(*) from pg_catalog.pg_auth_members m where m.member = v_role.oid) <> 1
     or not exists (
       select 1 from pg_catalog.pg_auth_members m
        where m.member = v_role.oid and m.roleid = v_operator and not m.admin_option and not m.inherit_option and m.set_option)
     -- Nobody acts through the login — the migration role aside (PostgreSQL 16+ grants the role that CREATEs a role ADMIN
     -- on it; it is the root of trust, and its own sessions are refused above by session_user) — and the operator role is
     -- a member of nothing (no SET ROLE beyond it).
     or exists (select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.member where m.roleid = v_role.oid and r.rolname <> 'postgres')
     or exists (select 1 from pg_catalog.pg_auth_members m where m.member = v_operator)
     -- No per-role settings (in any database).
     or exists (select 1 from pg_catalog.pg_db_role_setting s where s.setrole = v_role.oid) then
    raise exception 'validation operator: the session login is not a validation operator login' using errcode = '42501';
  end if;
  -- The login: no direct privilege, ownership or policy reference anywhere (pg_shdepend covers every database), other
  -- than CONNECT on this database and the objects of its own session's temporary schema.
  if exists (
    select 1 from pg_catalog.pg_shdepend d
     where d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and d.refobjid = v_role.oid
       and not (d.deptype = 'a' and d.classid = 'pg_catalog.pg_database'::pg_catalog.regclass and d.objid = v_database)
       and not (d.deptype = 'o' and d.dbid = v_database and pg_catalog.pg_my_temp_schema() <> 0 and (
             exists (select 1 from pg_catalog.pg_class c where d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass and c.oid = d.objid and c.relnamespace in (pg_catalog.pg_my_temp_schema(), v_toast))
          or exists (select 1 from pg_catalog.pg_type t where d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass and t.oid = d.objid and t.typnamespace = pg_catalog.pg_my_temp_schema())
          or exists (select 1 from pg_catalog.pg_proc p where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and p.oid = d.objid and p.pronamespace = pg_catalog.pg_my_temp_schema())
          or exists (select 1 from pg_catalog.pg_operator o where d.classid = 'pg_catalog.pg_operator'::pg_catalog.regclass and o.oid = d.objid and o.oprnamespace = pg_catalog.pg_my_temp_schema()))))
     -- On this database: CONNECT only (no CREATE, no grant option).
     or exists (
       select 1 from pg_catalog.pg_database db, pg_catalog.aclexplode(db.datacl) a
        where db.oid = v_database and a.grantee = v_role.oid and (a.privilege_type <> 'CONNECT' or a.is_grantable))
     or pg_catalog.has_database_privilege(v_role.oid, v_database, 'CREATE')
     -- CREATE on no schema (directly or through PUBLIC), its own temporary schema aside.
     or exists (
       select 1 from pg_catalog.pg_namespace n
        where n.nspname !~ '^pg_(toast_)?temp_' and pg_catalog.has_schema_privilege(v_role.oid, n.oid, 'CREATE')) then
    raise exception 'validation operator: the session login is not a validation operator login' using errcode = '42501';
  end if;
  -- The operator role: owns nothing, is named in no policy, and holds exactly USAGE on `mutations` and EXECUTE on its
  -- three functions — nothing else, anywhere.
  if exists (
    select 1 from pg_catalog.pg_shdepend d
     where d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and d.refobjid = v_operator
       and not (d.deptype = 'a' and d.dbid = v_database and (
             (d.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass and d.objid = 'mutations'::pg_catalog.regnamespace::pg_catalog.oid)
          or (d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid in (
                'mutations.issue_validation_authorization(uuid,uuid,uuid,text,integer,boolean)'::pg_catalog.regprocedure::pg_catalog.oid,
                'mutations.revoke_validation_authorization(uuid,uuid,text)'::pg_catalog.regprocedure::pg_catalog.oid,
                'mutations.validation_authorization_status(uuid,uuid)'::pg_catalog.regprocedure::pg_catalog.oid)))))
     or exists (
       select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
        where n.oid = 'mutations'::pg_catalog.regnamespace and a.grantee = v_operator and (a.privilege_type <> 'USAGE' or a.is_grantable))
     or exists (
       select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
        where a.grantee = v_operator and (a.privilege_type <> 'EXECUTE' or a.is_grantable)) then
    raise exception 'validation operator: the operator role holds more than its three functions' using errcode = '42501';
  end if;
  return v_role.name;
end
$$;
revoke all on function mutations.validation_operator_login() from public;

-- ── H1: the bound worker reads the USED evidence of its bound workspace ─────────────────────────────────────────────
grant select on mutations.validation_preflights to app_worker;

reset role;

create policy worker_read on mutations.validation_preflights for select to app_worker
  using (workspace_id = (select app.current_workspace()) and authorization_id is not null);
