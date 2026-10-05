-- 0002 · Tenancy: organizations, workspaces, memberships, invitations (TA §9, §10.2–§10.5, §11.2 R4–R5).
--
-- Isolation families:
--   organization rows   — readable by the organization's members; managed by its Owners/Admins.
--   workspace rows      — the primary boundary. Workspace access requires a WORKSPACE membership;
--                         organization membership alone never grants it.
--   memberships         — a user reads their own; workspace Owners/Admins read and manage their bound
--                         workspace's; organization Owners/Admins manage the organization's people.
-- RLS is a backstop under the application's authorization (TA §11.1.5): both layers are mandatory.

create schema tenancy authorization app_owner;
revoke all on schema tenancy from public;

set role app_owner;

-- ── Tables ────────────────────────────────────────────────────────────────────────────────────────────
create table tenancy.organizations (
  id         uuid primary key,
  name       text not null check (pg_catalog.char_length(name) between 1 and 120),
  created_at timestamptz not null
);

create table tenancy.workspaces (
  id              uuid primary key,
  organization_id uuid not null references tenancy.organizations (id) on delete cascade,
  name            text not null check (pg_catalog.char_length(name) between 1 and 120),
  mode            text not null check (mode in ('STANDARD', 'MONITOR_ONLY')),
  created_at      timestamptz not null,
  unique (organization_id, id)                                   -- R5 target for composite references
);

create table tenancy.organization_memberships (
  organization_id uuid not null references tenancy.organizations (id) on delete cascade,
  user_id         uuid not null,
  role            text not null check (role in ('OWNER', 'ADMIN', 'MEMBER')),
  created_at      timestamptz not null,
  primary key (organization_id, user_id)
);

create table tenancy.workspace_memberships (
  organization_id uuid not null,
  workspace_id    uuid not null,
  user_id         uuid not null,
  role            text not null check (role in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER', 'CLIENT_GUEST')),
  grants          text[] not null default '{}',
  created_at      timestamptz not null,
  primary key (workspace_id, user_id),
  constraint workspace_memberships_known_grants check (grants <@ array[
    'workspace.read_operational', 'intelligence.read', 'reports.read', 'reply.public', 'reply.private',
    'moderate.hide_unhide', 'moderate.delete', 'moderate.block', 'workflow.internal', 'automation.configure',
    'recommendations.decide', 'responding.manage', 'escalation.default_contact.set', 'connections.manage',
    'members.manage', 'workspace.mode.change', 'organization.manage', 'billing.manage', 'attention.read'
  ]::text[]),
  -- R5: the workspace belongs to the membership's organization …
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- … and workspace membership requires organization membership in that same organization. No cascade:
  -- removing an organization member must remove (and audit) their workspace memberships explicitly first.
  foreign key (organization_id, user_id) references tenancy.organization_memberships (organization_id, user_id)
);
create index workspace_memberships_by_organization_user on tenancy.workspace_memberships (organization_id, user_id);

create table tenancy.invitations (
  id              uuid primary key,
  organization_id uuid not null references tenancy.organizations (id) on delete cascade,
  target_kind     text not null check (target_kind in ('organization', 'workspace')),
  workspace_id    uuid,
  role            text not null,
  grants          text[] not null default '{}',
  recipient_email text not null check (pg_catalog.char_length(recipient_email) between 3 and 254 and pg_catalog.strpos(recipient_email, '@') > 1),
  token_digest    text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),   -- SHA-256 only; the raw token is never stored
  invited_by      uuid not null,
  created_at      timestamptz not null,
  expires_at      timestamptz not null,
  status          text not null check (status in ('PENDING', 'ACCEPTED', 'REVOKED')),
  accepted_by     uuid,
  closed_at       timestamptz,
  check (expires_at > created_at),
  check (
    (target_kind = 'organization' and workspace_id is null and grants = '{}' and role in ('OWNER', 'ADMIN', 'MEMBER'))
    or (target_kind = 'workspace' and workspace_id is not null
        and role in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER', 'CLIENT_GUEST'))
  ),
  check ((status = 'PENDING') = (closed_at is null)),
  check ((status = 'ACCEPTED') = (accepted_by is not null)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade
);

-- ── Membership helpers (SECURITY DEFINER, empty search_path, caller identity from the claims only) ──
-- They answer only about the CALLER, so they are no oracle about other users' memberships.
create function app.my_workspace_role(p_workspace uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from tenancy.workspace_memberships m
  where m.workspace_id = p_workspace and m.user_id = app_private.claimed_user()
$$;

create function app.my_organization_role(p_organization uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from tenancy.organization_memberships m
  where m.organization_id = p_organization and m.user_id = app_private.claimed_user()
$$;

-- Bootstrap: the creator of a new organization becomes its first Owner (only while it has no members).
create function app.can_bootstrap_organization_owner(p_organization uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from tenancy.organizations o where o.id = p_organization)
     and not exists (select 1 from tenancy.organization_memberships m where m.organization_id = p_organization)
$$;

-- Bootstrap: an organization Owner/Admin who creates a workspace becomes its first Workspace Owner.
create function app.can_bootstrap_workspace_owner(p_organization uuid, p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.my_organization_role(p_organization) in ('OWNER', 'ADMIN')
     and exists (select 1 from tenancy.workspaces w where w.id = p_workspace and w.organization_id = p_organization)
     and not exists (select 1 from tenancy.workspace_memberships m where m.workspace_id = p_workspace)
$$;

-- ── Invitation presentation context (sealed, transaction-bound, single per transaction) ─────────────
-- Accepting an invitation requires presenting its token digest (derivable only from the delivered raw
-- token). Recipient binding (verified email) stays in the application: the database never receives email.
create function app.current_invitation() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_invitation text := nullif(pg_catalog.current_setting('app.invitation_id', true), '');
  v_seal       text := nullif(pg_catalog.current_setting('app.invitation_seal', true), '');
begin
  if v_invitation is null or v_seal is null then
    return null;
  end if;
  if v_seal is distinct from app_private.context_seal('invitation', v_invitation) then
    return null;
  end if;
  return v_invitation::uuid;
end $$;

create function app.present_invitation(p_token_digest text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select i.id into v_id from tenancy.invitations i where i.token_digest = p_token_digest;
  if v_id is null then
    return null;
  end if;
  if app.current_invitation() is not null then
    raise exception 'invitation context: already presented in this transaction' using errcode = '42501';
  end if;
  perform pg_catalog.set_config('app.invitation_id', v_id::text, true);
  perform pg_catalog.set_config('app.invitation_seal', app_private.context_seal('invitation', v_id::text), true);
  return v_id;
end $$;

create function app.invitation_workspace() returns uuid
language sql stable security definer set search_path = '' as $$
  select i.workspace_id from tenancy.invitations i where i.id = app.current_invitation()
$$;

-- The presented invitation admits exactly the membership it describes, while pending and unexpired.
create function app.invitation_admits_organization_membership(p_organization uuid, p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from tenancy.invitations i
    where i.id = app.current_invitation()
      and i.status = 'PENDING' and i.expires_at > pg_catalog.now()
      and i.organization_id = p_organization
      and ((i.target_kind = 'organization' and i.role = p_role) or (i.target_kind = 'workspace' and p_role = 'MEMBER'))
  )
$$;

create function app.invitation_admits_workspace_membership(p_organization uuid, p_workspace uuid, p_role text, p_grants text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from tenancy.invitations i
    where i.id = app.current_invitation()
      and i.status = 'PENDING' and i.expires_at > pg_catalog.now()
      and i.target_kind = 'workspace'
      and i.organization_id = p_organization and i.workspace_id = p_workspace
      and i.role = p_role and p_grants <@ i.grants
  )
$$;

-- ── Last-Owner invariant, concurrency-safe (organization and workspace) ─────────────────────────────
-- Any demotion or removal of an Owner takes a transaction-scoped advisory lock keyed by the organization
-- or workspace, then re-counts the OTHER Owners. Concurrent transactions touching the same organization's
-- or workspace's Owners serialize on that key; the waiting one re-reads committed state (each statement in
-- this VOLATILE function takes a fresh READ COMMITTED snapshot) and is refused if it would remove the last
-- Owner. No table lock; unrelated organizations/workspaces never wait. Removing the parent itself
-- (privileged retention/cleanup) is exempt: the check applies only while the parent row still exists.
create function tenancy.workspace_keeps_an_owner() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
begin
  if old.role = 'OWNER' and (tg_op = 'DELETE' or new.role <> 'OWNER' or new.workspace_id <> old.workspace_id) then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tenancy.workspace_owners:' || old.workspace_id::text, 0));
    if exists (select 1 from tenancy.workspaces w where w.id = old.workspace_id)
       and not exists (
         select 1 from tenancy.workspace_memberships m
         where m.workspace_id = old.workspace_id and m.role = 'OWNER' and m.user_id <> old.user_id
       ) then
      raise exception 'workspace must keep an owner' using errcode = '23514', constraint = 'workspace_keeps_an_owner';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create function tenancy.organization_keeps_an_owner() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
begin
  if old.role = 'OWNER' and (tg_op = 'DELETE' or new.role <> 'OWNER' or new.organization_id <> old.organization_id) then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tenancy.organization_owners:' || old.organization_id::text, 0));
    if exists (select 1 from tenancy.organizations o where o.id = old.organization_id)
       and not exists (
         select 1 from tenancy.organization_memberships m
         where m.organization_id = old.organization_id and m.role = 'OWNER' and m.user_id <> old.user_id
       ) then
      raise exception 'organization must keep an owner' using errcode = '23514', constraint = 'organization_keeps_an_owner';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger workspace_keeps_an_owner before update or delete on tenancy.workspace_memberships
  for each row execute function tenancy.workspace_keeps_an_owner();
create trigger organization_keeps_an_owner before update or delete on tenancy.organization_memberships
  for each row execute function tenancy.organization_keeps_an_owner();

-- ── RLS: enabled AND forced; deny by default (R4) ────────────────────────────────────────────────────
alter table tenancy.organizations enable row level security;
alter table tenancy.organizations force row level security;
alter table tenancy.workspaces enable row level security;
alter table tenancy.workspaces force row level security;
alter table tenancy.organization_memberships enable row level security;
alter table tenancy.organization_memberships force row level security;
alter table tenancy.workspace_memberships enable row level security;
alter table tenancy.workspace_memberships force row level security;
alter table tenancy.invitations enable row level security;
alter table tenancy.invitations force row level security;

-- Forced RLS also binds the owner: the reviewed definer helpers above read through explicit owner policies.
create policy owner_read on tenancy.organizations for select to app_owner using (true);
create policy owner_read on tenancy.workspaces for select to app_owner using (true);
create policy owner_read on tenancy.organization_memberships for select to app_owner using (true);
create policy owner_read on tenancy.workspace_memberships for select to app_owner using (true);
create policy owner_read on tenancy.invitations for select to app_owner using (true);

reset role;

-- Policies that call auth.uid() are created by the migration role (USAGE on `auth`, F-S2), as owner member.

-- organizations
create policy member_read on tenancy.organizations for select to authenticated
  using (app.my_organization_role(id) is not null);
create policy create_organization on tenancy.organizations for insert to authenticated
  with check (true);

-- workspaces
create policy member_read on tenancy.workspaces for select to authenticated
  using (
    app.my_workspace_role(id) is not null
    or app.my_organization_role(organization_id) in ('OWNER', 'ADMIN')
    or id = (select app.invitation_workspace())
  );
create policy create_workspace on tenancy.workspaces for insert to authenticated
  with check (app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'));
create policy manage_bound_workspace on tenancy.workspaces for update to authenticated
  using (id = (select app.current_workspace()) and app.my_workspace_role(id) in ('OWNER', 'ADMIN'))
  with check (id = (select app.current_workspace()) and app.my_workspace_role(id) in ('OWNER', 'ADMIN'));
create policy worker_bound_workspace on tenancy.workspaces for select to app_worker
  using (id = (select app.current_workspace()));

-- organization memberships
create policy read_own_or_managed on tenancy.organization_memberships for select to authenticated
  using (user_id = (select auth.uid()) or app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'));
create policy join_self on tenancy.organization_memberships for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      (role = 'OWNER' and app.can_bootstrap_organization_owner(organization_id))
      or app.invitation_admits_organization_membership(organization_id, role)
    )
  );
create policy manage on tenancy.organization_memberships for update to authenticated
  using (app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'))
  with check (app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'));
create policy remove on tenancy.organization_memberships for delete to authenticated
  using (app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'));

-- workspace memberships
create policy read_own_or_managed on tenancy.workspace_memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
    or app.my_organization_role(organization_id) in ('OWNER', 'ADMIN')
  );
create policy join_self on tenancy.workspace_memberships for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      (role = 'OWNER' and grants = '{}' and app.can_bootstrap_workspace_owner(organization_id, workspace_id))
      or app.invitation_admits_workspace_membership(organization_id, workspace_id, role, grants)
    )
  );
create policy manage_bound_workspace on tenancy.workspace_memberships for update to authenticated
  using (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'));
create policy remove on tenancy.workspace_memberships for delete to authenticated
  using (
    (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
    or app.my_organization_role(organization_id) in ('OWNER', 'ADMIN')
  );

-- invitations
create policy managed_or_presented on tenancy.invitations for select to authenticated
  using (
    (target_kind = 'workspace' and workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
    or (target_kind = 'organization' and app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'))
    or id = (select app.current_invitation())
  );
create policy invite on tenancy.invitations for insert to authenticated
  with check (
    invited_by = (select auth.uid()) and status = 'PENDING'
    and (
      (target_kind = 'workspace' and workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
      or (target_kind = 'organization' and app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'))
    )
  );
create policy revoke_or_accept on tenancy.invitations for update to authenticated
  using (
    (target_kind = 'workspace' and workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
    or (target_kind = 'organization' and app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'))
    or id = (select app.current_invitation())
  )
  with check (
    (status = 'REVOKED' and accepted_by is null and (
      (target_kind = 'workspace' and workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
      or (target_kind = 'organization' and app.my_organization_role(organization_id) in ('OWNER', 'ADMIN'))
    ))
    or (status = 'ACCEPTED' and id = (select app.current_invitation()) and accepted_by = (select auth.uid()))
  );

-- ── Grants (explicit, least privilege; login roles hold none themselves) ─────────────────────────────
set role app_owner;

grant usage on schema app, tenancy to authenticated, app_worker;

grant select, insert on tenancy.organizations to authenticated;
grant select, insert on tenancy.workspaces to authenticated;
grant update (mode) on tenancy.workspaces to authenticated;
grant select, insert, delete on tenancy.organization_memberships to authenticated;
grant update (role) on tenancy.organization_memberships to authenticated;
grant select, insert, delete on tenancy.workspace_memberships to authenticated;
grant update (role, grants) on tenancy.workspace_memberships to authenticated;
grant select, insert on tenancy.invitations to authenticated;
grant update (status, accepted_by, closed_at) on tenancy.invitations to authenticated;

grant select on tenancy.workspaces to app_worker;

grant execute on function
  app.current_workspace(),
  app.bind_workspace(uuid),
  app.my_workspace_role(uuid),
  app.my_organization_role(uuid),
  app.can_bootstrap_organization_owner(uuid),
  app.can_bootstrap_workspace_owner(uuid, uuid),
  app.current_invitation(),
  app.present_invitation(text),
  app.invitation_workspace(),
  app.invitation_admits_organization_membership(uuid, text),
  app.invitation_admits_workspace_membership(uuid, uuid, text, text[])
to authenticated;

grant execute on function app.current_workspace(), app.bind_workspace(uuid) to app_worker;

reset role;
