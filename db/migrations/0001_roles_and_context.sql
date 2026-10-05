-- 0001 · Foundation roles and the sealed, transaction-bound context (TA §9.3, §10.4, §11.6 R1–R4).
--
-- Runs as the migration role (on Supabase: `postgres`, which can create roles and holds USAGE on `auth`).
-- Object-owning statements run as the NOLOGIN owner role `app_owner`; the migration role is a member of it.
--
-- R8: roles are long-lived. This migration creates a foundation role only if it is absent and otherwise
-- validates its attributes. It never drops or recreates a role. Login roles (web_login, worker_login,
-- system_login) are created by the provisioning tool, never here, and never with a password in SQL.

-- ── Foundation roles (NOLOGIN) ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_role text;
begin
  foreach v_role in array array['app_owner', 'app_worker', 'app_system'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute pg_catalog.format('create role %I nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls', v_role);
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.pg_roles
    where rolname in ('app_owner', 'app_worker', 'app_system')
      and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)
  ) then
    raise exception 'foundation role exists with unexpected attributes; refusing to continue (R1)';
  end if;

  -- Supabase provides `authenticated` (local test databases emulate it). It must exist and obey RLS.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated' and not rolcanlogin and not rolbypassrls and not rolsuper) then
    raise exception 'role "authenticated" missing or unsafe (expected NOLOGIN NOBYPASSRLS)';
  end if;
end $$;

-- The migration role acts as a member of the owner role (R4: policies that call auth.uid() are created by
-- a role with USAGE on `auth`, acting as a member of the owner).
grant app_owner to current_user with inherit true, set true;

-- ── Schemas (explicit; never `public`, never Supabase default privileges) ────────────────────────────
create schema app authorization app_owner;          -- context and membership helper functions
create schema app_private authorization app_owner;  -- the context seal secret; no grants to anyone
revoke all on schema app, app_private from public;

set role app_owner;

-- Functions are executable only where explicitly granted.
alter default privileges for role app_owner revoke execute on functions from public;

-- ── R2: seal secret (generated inside the database, never leaves it, readable only by the owner) ─────
create table app_private.context_secret (
  singleton boolean primary key default true check (singleton),
  secret bytea not null check (pg_catalog.octet_length(secret) = 32)
);
insert into app_private.context_secret (secret)
values (pg_catalog.sha256(pg_catalog.convert_to(
  pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text,
  'UTF8')));
alter table app_private.context_secret enable row level security;
alter table app_private.context_secret force row level security;
create policy owner_read on app_private.context_secret for select to app_owner using (true);

-- Seal = sha256(secret ‖ kind ‖ value ‖ current transaction id ‖ session user). A value copied from another
-- transaction, written with raw set_config, or left behind at session level never matches.
create function app_private.context_seal(p_kind text, p_value text) returns text
language sql stable security definer set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(s.secret || pg_catalog.convert_to(
           p_kind || '|' || p_value || '|' || pg_catalog.pg_current_xact_id()::text || '|' || session_user, 'UTF8')), 'hex')
  from app_private.context_secret s
$$;

-- The verified user id carried by the transaction-local claims (the same source as Supabase auth.uid()).
-- Read directly because the owner role has no USAGE on schema `auth` (F-S2).
create function app_private.claimed_user() returns uuid
language sql stable security definer set search_path = '' as $$
  select nullif(coalesce(
           nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
           (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
         ), '')::uuid
$$;

-- ── Workspace context ─────────────────────────────────────────────────────────────────────────────────
-- Returns the bound workspace only when its seal is valid for THIS transaction; otherwise NULL (no tenant).
create function app.current_workspace() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_workspace text := nullif(pg_catalog.current_setting('app.workspace_id', true), '');
  v_seal      text := nullif(pg_catalog.current_setting('app.workspace_seal', true), '');
begin
  if v_workspace is null or v_seal is null then
    return null;
  end if;
  if v_seal is distinct from app_private.context_seal('workspace', v_workspace) then
    return null;
  end if;
  return v_workspace::uuid;
end $$;

-- Binds the workspace once per transaction (transaction-local settings only). Rebinding is refused.
create function app.bind_workspace(p_workspace uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_workspace is null then
    raise exception 'tenant context: workspace required' using errcode = '42501';
  end if;
  if app.current_workspace() is not null then
    raise exception 'tenant context: already bound in this transaction' using errcode = '42501';
  end if;
  perform pg_catalog.set_config('app.workspace_id', p_workspace::text, true);
  perform pg_catalog.set_config('app.workspace_seal', app_private.context_seal('workspace', p_workspace::text), true);
end $$;

reset role;
