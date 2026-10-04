-- =====================================================================================
-- DISPOSABLE SPIKE FIXTURE — TA-Q-29. NOT THE PRODUCT SCHEMA. NOT PRODUCTION RLS POLICIES.
-- Purpose: prove (or disprove) that transaction-local tenant context is safe under pooled
-- connections, using a local emulation of the Supabase role model on real PostgreSQL.
-- Synthetic data only. Executed by scripts/run.mjs as the local bootstrap superuser.
-- =====================================================================================

-- ---------- Roles (emulating Supabase's documented role model + our architecture roles) ----------
create role spike_owner nologin;                 -- owns objects (stands in for the migration role)
create role anon nologin;                        -- Supabase: unauthenticated API role
create role authenticated nologin;               -- Supabase: signed-in user role (RLS applies)
create role service_role nologin bypassrls;      -- Supabase: bypasses RLS. Runtime must never hold it.
create role app_worker nologin;                  -- TA §11.3 restricted worker role (RLS applies)
create role app_system nologin;                  -- TA §11.3 system role (system tables only)
-- Login roles web_login / worker_login / system_login are created by run.mjs with random passwords.

revoke all on schema public from public;
grant usage, create on schema public to spike_owner;
grant usage on schema public to authenticated, app_worker;   -- public is owned by pg_database_owner, so grant here (as bootstrap superuser)
create schema auth       authorization spike_owner;
create schema app        authorization spike_owner;
create schema app_private authorization spike_owner;
create schema system     authorization spike_owner;

set role spike_owner;

-- ---------- Supabase-compatible identity helper (emulates auth.uid()) ----------
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(coalesce(
           nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
           (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
         ), '')::uuid
$$;

-- ---------- Tenant context: transaction-local + sealed (bound to the current transaction) ----------
create table app_private.ctx_secret (secret bytea not null);
insert into app_private.ctx_secret
  values (pg_catalog.convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'));

create function app.current_workspace() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ws     text := nullif(pg_catalog.current_setting('app.workspace_id', true), '');
  v_seal   text := nullif(pg_catalog.current_setting('app.ctx_seal', true), '');
  v_secret bytea;
begin
  if v_ws is null or v_seal is null then
    return null;                                   -- missing context => no tenant
  end if;
  select s.secret into v_secret from app_private.ctx_secret s;
  if v_seal <> pg_catalog.encode(pg_catalog.sha256(v_secret || pg_catalog.convert_to(
        v_ws || '|' || pg_catalog.pg_current_xact_id()::text || '|' || session_user, 'UTF8')), 'hex') then
    return null;                                   -- stale, forged or foreign context => no tenant
  end if;
  return v_ws::uuid;
end $$;

create function app.bind_context(p_workspace uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_secret bytea;
begin
  if p_workspace is null then
    raise exception 'tenant context: workspace required' using errcode = '42501';
  end if;
  if app.current_workspace() is not null then
    raise exception 'tenant context: already bound in this transaction' using errcode = '42501';
  end if;
  select s.secret into v_secret from app_private.ctx_secret s;
  perform pg_catalog.set_config('app.workspace_id', p_workspace::text, true);   -- is_local = true
  perform pg_catalog.set_config('app.ctx_seal', pg_catalog.encode(pg_catalog.sha256(v_secret || pg_catalog.convert_to(
        p_workspace::text || '|' || pg_catalog.pg_current_xact_id()::text || '|' || session_user, 'UTF8')), 'hex'), true);
end $$;

-- ---------- Synthetic tenant tables ----------
create table public.organizations (id uuid primary key, name text not null);
create table public.workspaces (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  name text not null
);
create table public.memberships (
  user_id uuid not null,
  workspace_id uuid not null references public.workspaces(id),
  role text not null check (role in ('owner','admin','manager','responder','analyst','client_guest')),
  primary key (user_id, workspace_id)
);

create function app.member_role(p_workspace uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
  where m.user_id = auth.uid() and m.workspace_id = p_workspace
$$;

create table public.conversations (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id),
  title text not null,
  unique (workspace_id, id)
);
create table public.interactions (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id),
  conversation_id uuid not null,
  body text not null,
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id)
);
create table public.guest_insights (            -- stands in for a guest projection (TA §49)
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id),
  statement text not null
);
create table public.attention_signals (         -- stands in for the attention read model (TA §50)
  workspace_id uuid primary key references public.workspaces(id),
  needs_attention boolean not null
);

-- ---------- System tables (identifiers only, no tenant content) ----------
create table system.outbox_meta (id uuid primary key, workspace_id uuid not null, status text not null);
create table system.asset_routing (provider_asset_id text primary key, workspace_id uuid not null);

-- ---------- RLS: enabled AND forced on every tenant table ----------
alter table public.organizations     enable row level security; alter table public.organizations     force row level security;
alter table public.workspaces        enable row level security; alter table public.workspaces        force row level security;
alter table public.memberships       enable row level security; alter table public.memberships       force row level security;
alter table public.conversations     enable row level security; alter table public.conversations     force row level security;
alter table public.interactions      enable row level security; alter table public.interactions      force row level security;
alter table public.guest_insights    enable row level security; alter table public.guest_insights    force row level security;
alter table public.attention_signals enable row level security; alter table public.attention_signals force row level security;
alter table system.outbox_meta       enable row level security; alter table system.outbox_meta       force row level security;
alter table system.asset_routing     enable row level security; alter table system.asset_routing     force row level security;

-- Users (role authenticated): operational rows need (a) the request's bound workspace AND (b) a non-guest membership in it.
create policy user_ops on public.conversations to authenticated
  using      (workspace_id = (select app.current_workspace())
              and (select app.member_role((select app.current_workspace()))) in ('owner','admin','manager','responder','analyst'))
  with check (workspace_id = (select app.current_workspace())
              and (select app.member_role((select app.current_workspace()))) in ('owner','admin','manager','responder','analyst'));
create policy user_ops on public.interactions to authenticated
  using      (workspace_id = (select app.current_workspace())
              and (select app.member_role((select app.current_workspace()))) in ('owner','admin','manager','responder','analyst'))
  with check (workspace_id = (select app.current_workspace())
              and (select app.member_role((select app.current_workspace()))) in ('owner','admin','manager','responder','analyst'));
-- Guest projections: any member (including client_guest) of the bound workspace.
create policy user_guest_read on public.guest_insights for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and (select app.member_role((select app.current_workspace()))) is not null);
-- Attention signals: organization-level page, no workspace context; non-guest memberships only.
create policy user_attention on public.attention_signals for select to authenticated
  using (app.member_role(workspace_id) in ('owner','admin','manager','responder','analyst'));
-- FORCE RLS also applies to the owner, so SECURITY DEFINER helpers (owned by spike_owner) need an explicit read policy:
create policy definer_read on public.memberships for select to spike_owner using (true);
create policy own_memberships on public.memberships for select to authenticated
  using (user_id = (select auth.uid()));
create policy member_workspaces on public.workspaces for select to authenticated
  using (app.member_role(id) is not null);
create policy member_orgs on public.organizations for select to authenticated
  using (exists (select 1 from public.workspaces w where w.organization_id = organizations.id));

-- Workers (role app_worker): exactly the bound workspace.
create policy worker_scope on public.conversations     to app_worker using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));
create policy worker_scope on public.interactions      to app_worker using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));
create policy worker_scope on public.guest_insights    to app_worker using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));
create policy worker_scope on public.attention_signals to app_worker using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- System role: system tables only.
create policy system_all on system.outbox_meta   to app_system using (true) with check (true);
create policy system_all on system.asset_routing to app_system using (true) with check (true);

-- ---------- Grants (least privilege). No grants to login roles themselves. ----------
grant usage on schema app, auth to authenticated, app_worker;
grant usage on schema system to app_system;
revoke all on all functions in schema app, auth from public;
grant execute on function app.current_workspace(), app.bind_context(uuid), app.member_role(uuid), auth.uid() to authenticated, app_worker;
grant select, insert, update, delete on public.conversations, public.interactions to authenticated, app_worker;
grant select on public.guest_insights, public.attention_signals, public.memberships, public.workspaces, public.organizations to authenticated;
grant select, insert, update, delete on public.guest_insights, public.attention_signals to app_worker;
grant select, insert, update on system.outbox_meta, system.asset_routing to app_system;

reset role;
