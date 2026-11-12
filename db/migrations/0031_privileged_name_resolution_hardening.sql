-- 0031 · Platform-wide privileged name resolution hardening (Step 7B-14P1; TA §11 R4a). Forward-only and expand-only:
-- no earlier migration is edited; no table, column, row, grant, role, ownership, policy or RLS setting changes. The ONLY
-- change is the search_path each application function pins.
--
-- Cause. Under `search_path = ''` PostgreSQL still searches the session's temporary schema (pg_temp) FIRST for relation
-- and type names (it never searches it for functions or operators). Every role holding TEMP on the database — PUBLIC
-- holds it by default, so every runtime role does — can create, e.g., a domain pg_temp.uuid whose CHECK calls a pg_temp
-- function. A SECURITY DEFINER function pinned to '' that casts to or declares `uuid`, `text`, `record`… then resolves
-- the caller's domain and runs the caller's code as app_owner — which owns every application table and can disable its
-- RLS. Invoker functions are exposed the same way whenever they run under that identity: the triggers fired, and the
-- CHECK constraints evaluated, by a definer's writes. 0030 fixed the validation operator path (15 functions); the
-- independent review (Step 7B-14I3HR) reproduced the rest of the class locally. This migration pins the remaining 52 —
-- 35 SECURITY DEFINER and 17 SECURITY INVOKER (triggers, CHECK predicates and helpers) — to
-- `search_path = pg_catalog, pg_temp`: pg_catalog first for every builtin type and relation, pg_temp LAST (and never for
-- functions or operators). This is PostgreSQL's documented pattern ("Writing SECURITY DEFINER Functions Safely",
-- https://www.postgresql.org/docs/current/sql-createfunction.html).
--
-- No body changes: every reference these functions make outside pg_catalog is already schema-qualified (an empty
-- search_path resolved nothing else); their unqualified names are builtin types (text, uuid, timestamptz, integer,
-- bigint, boolean, jsonb, record), CTEs, PL/pgSQL variables and `rows from`. None uses dynamic SQL. Their signatures,
-- bodies, owners, EXECUTE grants, volatility and security mode are unchanged (verified below).
--
-- Fails safe: it refuses (and the runner rolls the whole transaction back) when any application function pins anything
-- other than '' or the safe path, when any is left un-pinned afterwards, or when anything else in the catalog moved.

do $$
declare
  v_bad pg_catalog.text;
begin
  -- Precondition: every application function (owned by app_owner, or in a schema app_owner owns) pins exactly ONE
  -- setting — search_path, either '' (re-pinned below) or already pg_catalog, pg_temp (0030).
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ' order by p.oid::pg_catalog.regprocedure::pg_catalog.text) into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where (p.proowner = 'app_owner'::pg_catalog.regrole or n.nspowner = 'app_owner'::pg_catalog.regrole)
     and (p.proconfig is null
          or (p.proconfig <> array['search_path=""']::pg_catalog.text[] and p.proconfig <> array['search_path=pg_catalog, pg_temp']::pg_catalog.text[]));
  if v_bad is not null then
    raise exception 'application functions with an unexpected configuration (refusing): %', v_bad;
  end if;
  -- Everything this migration must NOT change, fingerprinted (verified unchanged at the end).
  perform pg_catalog.set_config('app_migrations.r4a_fingerprint', (
    select pg_catalog.md5(pg_catalog.string_agg(line, E'\n' order by line)) from (
      select 'f ' || p.oid::pg_catalog.regprocedure::pg_catalog.text || ' ' || pg_catalog.pg_get_userbyid(p.proowner) || ' ' || p.prosecdef::pg_catalog.text || ' '
             || p.provolatile::pg_catalog.text || p.proleakproof::pg_catalog.text || p.proisstrict::pg_catalog.text || p.proparallel::pg_catalog.text || p.prokind::pg_catalog.text || ' '
             || p.prorettype::pg_catalog.regtype::pg_catalog.text || ' ' || coalesce(p.proacl::pg_catalog.text, '-') || ' ' || pg_catalog.md5(p.prosrc) as line
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where p.proowner = 'app_owner'::pg_catalog.regrole or n.nspowner = 'app_owner'::pg_catalog.regrole
      union all
      select 'r ' || c.oid::pg_catalog.regclass::pg_catalog.text || ' ' || pg_catalog.pg_get_userbyid(c.relowner) || ' ' || c.relrowsecurity::pg_catalog.text || ' '
             || c.relforcerowsecurity::pg_catalog.text || ' ' || coalesce(c.relacl::pg_catalog.text, '-')
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspowner = 'app_owner'::pg_catalog.regrole
      union all
      select 'n ' || n.nspname || ' ' || pg_catalog.pg_get_userbyid(n.nspowner) || ' ' || coalesce(n.nspacl::pg_catalog.text, '-')
        from pg_catalog.pg_namespace n where n.nspname !~ '^pg_(toast_)?temp_'
      union all
      select 'p ' || pol.polrelid::pg_catalog.regclass::pg_catalog.text || ' ' || pol.polname || ' ' || pol.polcmd::pg_catalog.text || pol.polpermissive::pg_catalog.text || ' '
             || pol.polroles::pg_catalog.text || ' ' || coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '-') || ' ' || coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
        from pg_catalog.pg_policy pol
      union all
      select 't ' || t.tgrelid::pg_catalog.regclass::pg_catalog.text || ' ' || t.tgname || ' ' || t.tgfoid::pg_catalog.regprocedure::pg_catalog.text || ' ' || t.tgenabled::pg_catalog.text
        from pg_catalog.pg_trigger t where not t.tgisinternal
      union all
      select 'a ' || r.rolname || ' ' || r.rolsuper::pg_catalog.text || r.rolinherit::pg_catalog.text || r.rolcreaterole::pg_catalog.text || r.rolcreatedb::pg_catalog.text
             || r.rolcanlogin::pg_catalog.text || r.rolreplication::pg_catalog.text || r.rolbypassrls::pg_catalog.text
        from pg_catalog.pg_roles r
      union all
      select 'm ' || m.roleid::pg_catalog.text || ' ' || m.member::pg_catalog.text || ' ' || m.admin_option::pg_catalog.text from pg_catalog.pg_auth_members m
      union all
      select 'd ' || coalesce(d.datacl::pg_catalog.text, '-') from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()
    ) facts), true);
end $$;

set role app_owner;

-- ── SECURITY DEFINER (35) ────────────────────────────────────────────────────────────────────────────────────────────
-- Tenancy, invitations and membership roles (0001 / 0002): web (authenticated) and the RLS policies that call them.
alter function app.can_bootstrap_organization_owner(uuid) set search_path = pg_catalog, pg_temp;
alter function app.can_bootstrap_workspace_owner(uuid, uuid) set search_path = pg_catalog, pg_temp;
alter function app.current_invitation() set search_path = pg_catalog, pg_temp;
alter function app.invitation_admits_organization_membership(uuid, text) set search_path = pg_catalog, pg_temp;
alter function app.invitation_admits_workspace_membership(uuid, uuid, text, text[]) set search_path = pg_catalog, pg_temp;
alter function app.invitation_workspace() set search_path = pg_catalog, pg_temp;
alter function app.my_organization_role(uuid) set search_path = pg_catalog, pg_temp;
alter function app.my_workspace_role(uuid) set search_path = pg_catalog, pg_temp;
alter function app.present_invitation(text) set search_path = pg_catalog, pg_temp;
alter function app_private.claimed_user() set search_path = pg_catalog, pg_temp;
alter function tenancy.organization_keeps_an_owner() set search_path = pg_catalog, pg_temp;
alter function tenancy.workspace_keeps_an_owner() set search_path = pg_catalog, pg_temp;
-- Audit provenance (0020).
alter function audit.bound_workspace_organization() set search_path = pg_catalog, pg_temp;
-- Connections and asset moves (0010 / 0012).
alter function connections.invalidate_open_fresh_meta_attempts(timestamp with time zone) set search_path = pg_catalog, pg_temp;
alter function connections.locate_active_link(uuid) set search_path = pg_catalog, pg_temp;
alter function connections.move_initiator_can_manage(uuid) set search_path = pg_catalog, pg_temp;
alter function connections.record_move_audit(uuid, text, text) set search_path = pg_catalog, pg_temp;
alter function connections.route_move_step(uuid, text, text, timestamp with time zone) set search_path = pg_catalog, pg_temp;
-- Credential envelopes (0007).
alter function credentials.delete_envelope(uuid) set search_path = pg_catalog, pg_temp;
alter function credentials.load_envelope(uuid) set search_path = pg_catalog, pg_temp;
alter function credentials.store_envelope(uuid, uuid, integer, bytea, timestamp with time zone) set search_path = pg_catalog, pg_temp;
-- Ingestion: reconciliation requests and signal confirmation (0019 / 0022 / 0023).
alter function ingestion.begin_signal_confirmation_read(uuid, uuid) set search_path = pg_catalog, pg_temp;
alter function ingestion.claim_signal_confirmation(uuid, uuid) set search_path = pg_catalog, pg_temp;
alter function ingestion.complete_signal_confirmation_read(uuid, uuid, timestamp with time zone) set search_path = pg_catalog, pg_temp;
alter function ingestion.provider_event_hint(uuid, uuid) set search_path = pg_catalog, pg_temp;
alter function ingestion.request_reconciliation(uuid, text, timestamp with time zone, jsonb) set search_path = pg_catalog, pg_temp;
-- Mutations executor (0027).
alter function mutations.initiator_workspace_role(uuid) set search_path = pg_catalog, pg_temp;
alter function mutations.intent_mode_guard() set search_path = pg_catalog, pg_temp;
alter function mutations.workspace_mode_for_execution() set search_path = pg_catalog, pg_temp;
-- System: switches, provider webhooks and signal routing (0005 / 0022 / 0023).
alter function system.dispatch_due_signal_marks(integer) set search_path = pg_catalog, pg_temp;
alter function system.expire_signal_marks(integer) set search_path = pg_catalog, pg_temp;
alter function system.purge_provider_events(integer) set search_path = pg_catalog, pg_temp;
alter function system.record_provider_webhook(text, text, text, bytea, integer, boolean, integer, integer, integer, integer, integer, jsonb) set search_path = pg_catalog, pg_temp;
alter function system.record_switch_change() set search_path = pg_catalog, pg_temp;
alter function system.route_provider_hint(uuid) set search_path = pg_catalog, pg_temp;

-- ── SECURITY INVOKER that run under a privileged identity (17) ───────────────────────────────────────────────────────
-- CHECK predicates, evaluated by whoever writes the row — a definer's writes included.
alter function audit.is_organization_membership_state(jsonb) set search_path = pg_catalog, pg_temp;
alter function audit.is_valid_change(jsonb) set search_path = pg_catalog, pg_temp;
alter function audit.is_workspace_membership_state(jsonb) set search_path = pg_catalog, pg_temp;
alter function classification.assessment_values_valid(text, text, text[], text[], numeric[], text[]) set search_path = pg_catalog, pg_temp;
alter function classification.source_spans_valid(integer[], integer[], integer) set search_path = pg_catalog, pg_temp;
alter function classification.watch_phrases_valid(text[], integer) set search_path = pg_catalog, pg_temp;
alter function system.is_identifier_map(jsonb) set search_path = pg_catalog, pg_temp;
-- Triggers, fired by whoever writes the row — a definer's writes included.
alter function classification.ai_budget_reservation_guard() set search_path = pg_catalog, pg_temp;
alter function classification.understanding_request_guard() set search_path = pg_catalog, pg_temp;
alter function ingestion.reconciliation_run_guard() set search_path = pg_catalog, pg_temp;
alter function ingestion.reconciliation_slice_guard() set search_path = pg_catalog, pg_temp;
alter function ingestion.reconciliation_slice_park_cursor() set search_path = pg_catalog, pg_temp;
alter function ingestion.reconciliation_watermark_guard() set search_path = pg_catalog, pg_temp;
alter function ingestion.signal_mark_confirmation_guard() set search_path = pg_catalog, pg_temp;
alter function interactions.interactions_scope_guard() set search_path = pg_catalog, pg_temp;
alter function system.outbox_execution_plane_guard() set search_path = pg_catalog, pg_temp;
-- A worker helper (0025).
alter function classification.reserve_ai_budget(text, date, integer, bigint, integer, bigint) set search_path = pg_catalog, pg_temp;

reset role;

do $$
declare
  v_bad pg_catalog.text;
begin
  -- Postcondition: EVERY application function now pins exactly pg_catalog first and pg_temp last.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ' order by p.oid::pg_catalog.regprocedure::pg_catalog.text) into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where (p.proowner = 'app_owner'::pg_catalog.regrole or n.nspowner = 'app_owner'::pg_catalog.regrole)
     and p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::pg_catalog.text[];
  if v_bad is not null then
    raise exception 'application functions left without the safe search_path (refusing): %', v_bad;
  end if;
  -- And nothing else moved.
  if (
    select pg_catalog.md5(pg_catalog.string_agg(line, E'\n' order by line)) from (
      select 'f ' || p.oid::pg_catalog.regprocedure::pg_catalog.text || ' ' || pg_catalog.pg_get_userbyid(p.proowner) || ' ' || p.prosecdef::pg_catalog.text || ' '
             || p.provolatile::pg_catalog.text || p.proleakproof::pg_catalog.text || p.proisstrict::pg_catalog.text || p.proparallel::pg_catalog.text || p.prokind::pg_catalog.text || ' '
             || p.prorettype::pg_catalog.regtype::pg_catalog.text || ' ' || coalesce(p.proacl::pg_catalog.text, '-') || ' ' || pg_catalog.md5(p.prosrc) as line
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where p.proowner = 'app_owner'::pg_catalog.regrole or n.nspowner = 'app_owner'::pg_catalog.regrole
      union all
      select 'r ' || c.oid::pg_catalog.regclass::pg_catalog.text || ' ' || pg_catalog.pg_get_userbyid(c.relowner) || ' ' || c.relrowsecurity::pg_catalog.text || ' '
             || c.relforcerowsecurity::pg_catalog.text || ' ' || coalesce(c.relacl::pg_catalog.text, '-')
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspowner = 'app_owner'::pg_catalog.regrole
      union all
      select 'n ' || n.nspname || ' ' || pg_catalog.pg_get_userbyid(n.nspowner) || ' ' || coalesce(n.nspacl::pg_catalog.text, '-')
        from pg_catalog.pg_namespace n where n.nspname !~ '^pg_(toast_)?temp_'
      union all
      select 'p ' || pol.polrelid::pg_catalog.regclass::pg_catalog.text || ' ' || pol.polname || ' ' || pol.polcmd::pg_catalog.text || pol.polpermissive::pg_catalog.text || ' '
             || pol.polroles::pg_catalog.text || ' ' || coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '-') || ' ' || coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
        from pg_catalog.pg_policy pol
      union all
      select 't ' || t.tgrelid::pg_catalog.regclass::pg_catalog.text || ' ' || t.tgname || ' ' || t.tgfoid::pg_catalog.regprocedure::pg_catalog.text || ' ' || t.tgenabled::pg_catalog.text
        from pg_catalog.pg_trigger t where not t.tgisinternal
      union all
      select 'a ' || r.rolname || ' ' || r.rolsuper::pg_catalog.text || r.rolinherit::pg_catalog.text || r.rolcreaterole::pg_catalog.text || r.rolcreatedb::pg_catalog.text
             || r.rolcanlogin::pg_catalog.text || r.rolreplication::pg_catalog.text || r.rolbypassrls::pg_catalog.text
        from pg_catalog.pg_roles r
      union all
      select 'm ' || m.roleid::pg_catalog.text || ' ' || m.member::pg_catalog.text || ' ' || m.admin_option::pg_catalog.text from pg_catalog.pg_auth_members m
      union all
      select 'd ' || coalesce(d.datacl::pg_catalog.text, '-') from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()
    ) facts) is distinct from pg_catalog.current_setting('app_migrations.r4a_fingerprint') then
    raise exception 'the catalog changed beyond function search_path pins (refusing)';
  end if;
end $$;
