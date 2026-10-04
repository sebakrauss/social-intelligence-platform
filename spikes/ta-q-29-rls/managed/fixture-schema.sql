-- =====================================================================================
-- DISPOSABLE MANAGED-SPIKE FIXTURE (Supabase DEVELOPMENT project) — TA-Q-29 Phase 0E.2b.
-- NOT THE PRODUCT SCHEMA. Everything is prefixed spike29 / spike_ and dropped by teardown.
-- Uses the REAL Supabase `authenticated` role and REAL auth.uid(). Synthetic data only.
-- Part 1 (this file): roles, schemas, tables, helper functions. Seeding happens next (JS),
-- then fixture-security.sql enables/forces RLS, policies and grants.
-- =====================================================================================
create role spike_owner nologin;
create role spike_app_worker nologin;
create role spike_app_system nologin;
grant spike_owner to current_user;                     -- bootstrap may SET ROLE to create owned objects

create schema spike29         authorization spike_owner;   -- tenant tables (NOT exposed by the Data API)
create schema spike29_app     authorization spike_owner;   -- context helpers
create schema spike29_private authorization spike_owner;   -- seal secret
create schema spike29_system  authorization spike_owner;   -- system metadata

set role spike_owner;

create table spike29_private.ctx_secret (secret bytea not null);
insert into spike29_private.ctx_secret values (convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'));

create function spike29_app.current_workspace() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws     text := nullif(pg_catalog.current_setting('app.workspace_id', true), '');
  v_seal   text := nullif(pg_catalog.current_setting('app.ctx_seal', true), '');
  v_secret bytea;
begin
  if v_ws is null or v_seal is null then return null; end if;
  select s.secret into v_secret from spike29_private.ctx_secret s;
  if v_seal <> pg_catalog.encode(pg_catalog.sha256(v_secret || pg_catalog.convert_to(
        v_ws || '|' || pg_catalog.pg_current_xact_id()::text || '|' || session_user, 'UTF8')), 'hex') then
    return null;
  end if;
  return v_ws::uuid;
end $$;

create function spike29_app.bind_context(p_workspace uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_secret bytea;
begin
  if p_workspace is null then raise exception 'tenant context: workspace required' using errcode = '42501'; end if;
  if spike29_app.current_workspace() is not null then
    raise exception 'tenant context: already bound in this transaction' using errcode = '42501';
  end if;
  select s.secret into v_secret from spike29_private.ctx_secret s;
  perform pg_catalog.set_config('app.workspace_id', p_workspace::text, true);
  perform pg_catalog.set_config('app.ctx_seal', pg_catalog.encode(pg_catalog.sha256(v_secret || pg_catalog.convert_to(
        p_workspace::text || '|' || pg_catalog.pg_current_xact_id()::text || '|' || session_user, 'UTF8')), 'hex'), true);
end $$;

create table spike29.organizations (id uuid primary key, name text not null);
create table spike29.workspaces (id uuid primary key, organization_id uuid not null references spike29.organizations(id), name text not null);
create table spike29.memberships (
  user_id uuid not null, workspace_id uuid not null references spike29.workspaces(id),
  role text not null check (role in ('owner','admin','manager','responder','analyst','client_guest')),
  primary key (user_id, workspace_id));

-- Membership lookup (definer). The user id is passed in by the POLICY from the real auth.uid().
create function spike29_app.member_role(p_workspace uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from spike29.memberships m where m.user_id = p_user and m.workspace_id = p_workspace
$$;

create table spike29.conversations (id uuid primary key, workspace_id uuid not null references spike29.workspaces(id),
  title text not null, unique (workspace_id, id));
create table spike29.interactions (id uuid primary key, workspace_id uuid not null references spike29.workspaces(id),
  conversation_id uuid not null, body text not null,
  foreign key (workspace_id, conversation_id) references spike29.conversations(workspace_id, id));
create table spike29.guest_insights (id uuid primary key, workspace_id uuid not null references spike29.workspaces(id), statement text not null);
create table spike29.attention_signals (workspace_id uuid primary key references spike29.workspaces(id), needs_attention boolean not null);
create table spike29_system.outbox_meta (id uuid primary key, workspace_id uuid not null, status text not null);

reset role;
