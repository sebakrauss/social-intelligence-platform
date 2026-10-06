-- 0007 · Connections and credential foundation (Step 5B; TA §8, §11, §39; PD D-48, D-50; ADR-38, ADR-64).
-- Expand-only: two new schemas, their tables, policies, grants and definer functions, plus a widening of the
-- audit vocabulary. No existing table, column, policy or grant is narrowed or removed; no role is created.
--
--   connections.connections               one provider authorization per workspace (D-48); status only, no secrets
--   connections.connection_events         append-only status history (closed reason codes, never provider text)
--   connections.connect_attempts          OAuth round-trip foundation: state DIGEST only; the PKCE verifier only
--                                         as a sealed envelope (5A boundary, distinct purpose) — never plaintext
--   connections.discovered_assets         normalized assets a connection exposes (Step 4 contract vocabulary)
--   connections.connected_accounts        assets activated in a workspace; M-01 and the TEMPORARY TA-Q-02 rule
--                                         are two separately named partial unique indexes
--   connections.connected_account_events  append-only link/move history
--   connections.asset_moves               durable Move coordination: one tenant-local row per side
--   credentials.provider_credentials      Step 5A EnvelopeV1 bytes only; no runtime role has any table privilege;
--                                         reached only through the reviewed definer functions below
--
-- Tenant rows carry (organization_id, workspace_id) with a composite FK to tenancy.workspaces (R5); every
-- intra-tenant reference is composite and includes workspace_id, so a cross-workspace reference fails exactly
-- like a missing one. Primary keys are (workspace_id, id): an identifier used in another workspace never collides,
-- so no insert (including through the credential definer API, whose IDs come from the caller) can reveal that it
-- exists elsewhere. RLS is enabled and forced everywhere; Client Guests read none of these tables.

create schema connections authorization app_owner;
create schema credentials authorization app_owner;
revoke all on schema connections, credentials from public;

set role app_owner;

-- ── connections.connections ──────────────────────────────────────────────────────────────────────────
create table connections.connections (
  id                   uuid not null,
  organization_id      uuid not null,
  workspace_id         uuid not null,
  provider             text not null check (provider in ('meta', 'tiktok', 'simulator')),
  status               text not null check (status in ('CONNECTING', 'ACTIVE', 'DEGRADED', 'FAILED', 'DISCONNECTED', 'REMOVED')),
  active_credential_id uuid,
  authorized_by        uuid not null,
  authorized_at        timestamptz not null,
  last_success_at      timestamptz,
  last_problem_code    text check (last_problem_code in (
                         'AUTHORIZATION_DENIED', 'CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED', 'CREDENTIAL_INVALID',
                         'CREDENTIAL_UNREADABLE', 'PERMISSION_MISSING', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED',
                         'DISCOVERY_FAILED')),
  last_problem_at      timestamptz,
  version              integer not null default 1 check (version >= 1),
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  primary key (workspace_id, id),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint connections_problem_recorded check ((last_problem_code is null) = (last_problem_at is null)),
  -- A disconnected or removed connection holds no credential (definitive crypto-shred, D8).
  constraint connections_no_credential_when_gone check (status not in ('DISCONNECTED', 'REMOVED') or active_credential_id is null)
);

-- ── credentials.provider_credentials ──────────────────────────────────────────────────────────────────
-- The envelope is the Step 5A binary EnvelopeV1 ("SIPE", format 1, …). The plaintext never reaches the database;
-- the structural check refuses anything that isn't a v1 envelope. Rows are immutable: insert and delete only.
create table credentials.provider_credentials (
  id                 uuid not null,
  organization_id    uuid not null,
  workspace_id       uuid not null,
  connection_id      uuid not null,
  credential_version integer not null check (credential_version >= 1),
  envelope           bytea not null check (
                       pg_catalog.octet_length(envelope) between 46 and 70000
                       and pg_catalog.substring(envelope, 1, 5) = '\x5349504501'::bytea),
  expires_at         timestamptz,
  created_at         timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, connection_id, credential_version),
  unique (workspace_id, connection_id, id),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connection_id) references connections.connections (workspace_id, id) on delete cascade
);

-- The active pointer must name a credential of the SAME workspace AND the same connection.
alter table connections.connections
  add constraint connections_active_credential_same_connection
  foreign key (workspace_id, id, active_credential_id)
  references credentials.provider_credentials (workspace_id, connection_id, id);

-- ── connections.connection_events ─────────────────────────────────────────────────────────────────────
create table connections.connection_events (
  id              uuid not null,
  organization_id uuid not null,
  workspace_id    uuid not null,
  connection_id   uuid not null,
  previous_status text check (previous_status in ('CONNECTING', 'ACTIVE', 'DEGRADED', 'FAILED', 'DISCONNECTED', 'REMOVED')),
  new_status      text not null check (new_status in ('CONNECTING', 'ACTIVE', 'DEGRADED', 'FAILED', 'DISCONNECTED', 'REMOVED')),
  reason_code     text not null check (reason_code in (
                    'AUTHORIZED', 'REAUTHORIZED', 'VALIDATED', 'RECOVERED', 'CREDENTIAL_REFRESHED',
                    'AUTHORIZATION_DENIED', 'CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED', 'CREDENTIAL_INVALID',
                    'CREDENTIAL_UNREADABLE', 'PERMISSION_MISSING', 'PROVIDER_UNAVAILABLE', 'DISCOVERY_FAILED',
                    'REMOVED_BY_USER')),
  actor_type      text not null check (actor_type in ('user', 'system')),
  actor_user_id   uuid,
  occurred_at     timestamptz not null,
  primary key (workspace_id, id),
  check ((actor_type = 'user') = (actor_user_id is not null)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connection_id) references connections.connections (workspace_id, id) on delete cascade
);
create index connection_events_by_connection on connections.connection_events (workspace_id, connection_id, occurred_at);

-- ── connections.connect_attempts ──────────────────────────────────────────────────────────────────────
-- Only the SHA-256 digest of the OAuth `state` is stored. The PKCE verifier, when used (5D), is stored only as a
-- 5A envelope sealed under its own closed purpose, keyed by pkce_secret_id; it is cleared once the attempt closes.
create table connections.connect_attempts (
  id                      uuid not null,
  organization_id         uuid not null,
  workspace_id            uuid not null,
  provider                text not null check (provider in ('meta', 'tiktok', 'simulator')),
  created_by              uuid not null,
  state_digest            text not null unique check (state_digest ~ '^[0-9a-f]{64}$'),
  redirect_uri            text not null check (
                            pg_catalog.char_length(redirect_uri) <= 512
                            and redirect_uri ~ '^(https://[A-Za-z0-9.-]+(:[0-9]{1,5})?|http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?)/[A-Za-z0-9/._~-]*$'),
  reconnect_connection_id uuid,
  pkce_secret_id          uuid,
  pkce_envelope           bytea check (
                            pkce_envelope is null or (
                              pg_catalog.octet_length(pkce_envelope) between 46 and 4096
                              and pg_catalog.substring(pkce_envelope, 1, 5) = '\x5349504501'::bytea)),
  status                  text not null check (status in ('PENDING', 'COMPLETED', 'DENIED', 'EXPIRED', 'CANCELLED')),
  expires_at              timestamptz not null,
  created_at              timestamptz not null,
  closed_at               timestamptz,
  primary key (workspace_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  constraint connect_attempts_pkce_paired check ((pkce_secret_id is null) = (pkce_envelope is null)),
  constraint connect_attempts_closed_recorded check ((status = 'PENDING') = (closed_at is null)),
  -- Single use: once closed, the sealed verifier is gone.
  constraint connect_attempts_pkce_cleared_when_closed check (status = 'PENDING' or pkce_envelope is null),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, reconnect_connection_id) references connections.connections (workspace_id, id) on delete cascade
);
create index connect_attempts_pending_expiry on connections.connect_attempts (expires_at) where status = 'PENDING';

-- ── connections.discovered_assets ─────────────────────────────────────────────────────────────────────
create table connections.discovered_assets (
  id                uuid not null,
  organization_id   uuid not null,
  workspace_id      uuid not null,
  connection_id     uuid not null,
  platform          text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  provider_asset_id text not null check (provider_asset_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  asset_class       text not null check (asset_class in ('content_bearing', 'ad_account')),
  display_name      text not null check (pg_catalog.char_length(display_name) between 1 and 200 and display_name !~ '[[:cntrl:]]'),
  last_seen_at      timestamptz not null,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, connection_id, provider_asset_id),
  unique (workspace_id, connection_id, provider_asset_id, platform, asset_class),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connection_id) references connections.connections (workspace_id, id) on delete cascade
);

-- ── connections.connected_accounts ────────────────────────────────────────────────────────────────────
create table connections.connected_accounts (
  id                  uuid not null,
  organization_id     uuid not null,
  workspace_id        uuid not null,
  connection_id       uuid not null,
  platform            text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  provider_asset_id   text not null check (provider_asset_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  asset_class         text not null check (asset_class in ('content_bearing', 'ad_account')),
  status              text not null check (status in ('ACTIVE', 'INACTIVE')),
  activated_at        timestamptz not null,
  deactivated_at      timestamptz,
  deactivation_reason text check (deactivation_reason in ('UNLINKED', 'MOVED', 'DISCONNECTED', 'REMOVED')),
  move_id             uuid,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  primary key (workspace_id, id),
  constraint connected_accounts_status_consistent check (
    (status = 'ACTIVE' and deactivated_at is null and deactivation_reason is null)
    or (status = 'INACTIVE' and deactivated_at is not null and deactivation_reason is not null)),
  constraint connected_accounts_move_recorded check (deactivation_reason is distinct from 'MOVED' or move_id is not null),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connection_id) references connections.connections (workspace_id, id) on delete cascade,
  -- Only an asset this connection discovered, with exactly its platform and class, can be linked.
  foreign key (workspace_id, connection_id, provider_asset_id, platform, asset_class)
    references connections.discovered_assets (workspace_id, connection_id, provider_asset_id, platform, asset_class) on delete cascade
);

-- M-01 (LOCKED, PD D-50): a content-bearing asset is active in at most one workspace per organization.
create unique index connected_accounts_m01_active_content_asset
  on connections.connected_accounts (organization_id, platform, provider_asset_id)
  where status = 'ACTIVE' and asset_class = 'content_bearing';
comment on index connections.connected_accounts_m01_active_content_asset is
  'M-01 (LOCKED, PD D-50): a content-bearing Social Asset is active in at most one workspace per organization.';

-- TEMPORARY TA-Q-02 safety restriction — NOT M-01. An ad account is active in at most one workspace per
-- organization until TA-Q-02 (still VALIDATE) resolves. Relaxing it = dropping ONLY this index in a reviewed
-- migration; M-01 is unaffected.
create unique index connected_accounts_taq02_tmp_ad_account_single_workspace
  on connections.connected_accounts (organization_id, platform, provider_asset_id)
  where status = 'ACTIVE' and asset_class = 'ad_account';
comment on index connections.connected_accounts_taq02_tmp_ad_account_single_workspace is
  'TEMPORARY TA-Q-02 safety restriction (not M-01): ad account active in at most one workspace per organization until TA-Q-02 resolves.';

-- ── connections.connected_account_events ──────────────────────────────────────────────────────────────
create table connections.connected_account_events (
  id                   uuid not null,
  organization_id      uuid not null,
  workspace_id         uuid not null,
  connected_account_id uuid not null,
  event_type           text not null check (event_type in ('LINKED', 'UNLINKED', 'MOVED_OUT', 'MOVED_IN', 'DEACTIVATED')),
  move_id              uuid,
  reason_code          text not null check (reason_code in (
                         'USER_LINKED', 'USER_UNLINKED', 'MOVE', 'CONNECTION_DISCONNECTED', 'CONNECTION_REMOVED')),
  actor_type           text not null check (actor_type in ('user', 'system')),
  actor_user_id        uuid,
  occurred_at          timestamptz not null,
  primary key (workspace_id, id),
  check ((actor_type = 'user') = (actor_user_id is not null)),
  check ((event_type in ('MOVED_OUT', 'MOVED_IN')) = (move_id is not null)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id) on delete cascade
);
create index connected_account_events_by_account on connections.connected_account_events (workspace_id, connected_account_id, occurred_at);

-- ── connections.asset_moves ───────────────────────────────────────────────────────────────────────────
-- Durable Move coordination (D4): one tenant-local row per side, in its own workspace; the counterpart is only
-- an identifier of another workspace of the SAME organization. No cross-workspace transaction exists.
create table connections.asset_moves (
  organization_id          uuid not null,
  workspace_id             uuid not null,
  move_id                  uuid not null,
  side                     text not null check (side in ('INCOMING', 'OUTGOING')),
  counterpart_workspace_id uuid not null,
  connection_id            uuid,
  connected_account_id     uuid,
  platform                 text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  provider_asset_id        text check (provider_asset_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  initiator_user_id        uuid not null,
  status                   text not null,
  reason_code              text check (reason_code in (
                             'SOURCE_NOT_ACTIVE', 'AUTHORITY_REVOKED', 'DESTINATION_CONNECTION_UNHEALTHY',
                             'ASSET_ACTIVE_ELSEWHERE', 'ASSET_NOT_DISCOVERED', 'ACTIVATION_RETRIES_EXHAUSTED')),
  created_at               timestamptz not null,
  updated_at               timestamptz not null,
  primary key (workspace_id, move_id, side),
  constraint asset_moves_side_status check (
    (side = 'INCOMING' and status in ('REQUESTED', 'COMPLETED', 'ACTIVATION_FAILED', 'REJECTED'))
    or (side = 'OUTGOING' and status in ('RELEASED', 'REJECTED'))),
  constraint asset_moves_incoming_shape check (
    side <> 'INCOMING' or (connection_id is not null and provider_asset_id is not null)),
  constraint asset_moves_outgoing_shape check (side <> 'OUTGOING' or connected_account_id is not null),
  constraint asset_moves_failure_reason check (status not in ('ACTIVATION_FAILED', 'REJECTED') or reason_code is not null),
  constraint asset_moves_counterpart_other check (counterpart_workspace_id <> workspace_id),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- The counterpart must be a workspace of the SAME organization.
  constraint asset_moves_counterpart_same_organization
    foreign key (organization_id, counterpart_workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connection_id) references connections.connections (workspace_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id) on delete cascade
);
create unique index asset_moves_one_requested_incoming_per_asset
  on connections.asset_moves (workspace_id, platform, provider_asset_id)
  where side = 'INCOMING' and status = 'REQUESTED';

-- ── RLS: enabled AND forced; deny by default (R4) ────────────────────────────────────────────────────
alter table connections.connections enable row level security;
alter table connections.connections force row level security;
alter table connections.connection_events enable row level security;
alter table connections.connection_events force row level security;
alter table connections.connect_attempts enable row level security;
alter table connections.connect_attempts force row level security;
alter table connections.discovered_assets enable row level security;
alter table connections.discovered_assets force row level security;
alter table connections.connected_accounts enable row level security;
alter table connections.connected_accounts force row level security;
alter table connections.connected_account_events enable row level security;
alter table connections.connected_account_events force row level security;
alter table connections.asset_moves enable row level security;
alter table connections.asset_moves force row level security;
alter table credentials.provider_credentials enable row level security;
alter table credentials.provider_credentials force row level security;

-- Forced RLS binds the owner too. The credential definer functions reach rows ONLY of the bound workspace,
-- even as the owner: these owner policies are scoped to the sealed context.
create policy owner_bound_read on connections.connections for select to app_owner
  using (workspace_id = (select app.current_workspace()));
create policy owner_bound_read on credentials.provider_credentials for select to app_owner
  using (workspace_id = (select app.current_workspace()));
create policy owner_bound_insert on credentials.provider_credentials for insert to app_owner
  with check (workspace_id = (select app.current_workspace()));
create policy owner_bound_delete on credentials.provider_credentials for delete to app_owner
  using (workspace_id = (select app.current_workspace()));

-- ── Credential definer API (TA §39) ──────────────────────────────────────────────────────────────────
-- The caller's runtime is identified by its LOGIN role's membership (session_user cannot be changed by
-- SET ROLE): web logins are members of `authenticated`, worker logins of `app_worker`. Web callers also need
-- live Owner/Admin authority (connections.manage) in the bound workspace. Every function requires the sealed
-- workspace context and touches only that workspace. Missing/foreign rows are indistinguishable (no oracle).

create function credentials.store_envelope(
  p_connection_id uuid, p_credential_id uuid, p_credential_version integer, p_envelope bytea, p_expires_at timestamptz
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace    uuid := app.current_workspace();
  v_organization uuid;
begin
  if v_workspace is null then
    raise exception 'credential store: tenant context required' using errcode = '42501';
  end if;
  if pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER') then
    if app.my_workspace_role(v_workspace) is distinct from 'OWNER' and app.my_workspace_role(v_workspace) is distinct from 'ADMIN' then
      raise exception 'credential store: not permitted' using errcode = '42501';
    end if;
  elsif not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'credential store: not permitted' using errcode = '42501';
  end if;
  select c.organization_id into v_organization
    from connections.connections c
   where c.workspace_id = v_workspace and c.id = p_connection_id and c.status <> 'REMOVED';
  if v_organization is null then
    raise exception 'credential store: connection not found' using errcode = 'P0002';
  end if;
  insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, expires_at, created_at)
  values (p_credential_id, v_organization, v_workspace, p_connection_id, p_credential_version, p_envelope, p_expires_at, pg_catalog.now());
end $$;

-- Job runtime only (EXECUTE is granted to app_worker alone; the login-role check is defense in depth).
create function credentials.load_envelope(p_credential_id uuid)
returns table (credential_id uuid, connection_id uuid, credential_version integer, envelope bytea, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
begin
  if v_workspace is null or not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'credential load: not permitted' using errcode = '42501';
  end if;
  return query
    select p.id, p.connection_id, p.credential_version, p.envelope, p.expires_at
      from credentials.provider_credentials p
     where p.workspace_id = v_workspace and p.id = p_credential_id;
end $$;

-- Definitive crypto-shred (D8). A credential still referenced as active cannot be deleted: the pointer must be
-- cleared or replaced first, in the same transaction (composite FK, no cascade).
create function credentials.delete_envelope(p_credential_id uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
  v_deleted   integer;
begin
  if v_workspace is null then
    raise exception 'credential delete: tenant context required' using errcode = '42501';
  end if;
  if pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER') then
    if app.my_workspace_role(v_workspace) is distinct from 'OWNER' and app.my_workspace_role(v_workspace) is distinct from 'ADMIN' then
      raise exception 'credential delete: not permitted' using errcode = '42501';
    end if;
  elsif not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'credential delete: not permitted' using errcode = '42501';
  end if;
  delete from credentials.provider_credentials p where p.workspace_id = v_workspace and p.id = p_credential_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end $$;

reset role;

-- ── Runtime policies ─────────────────────────────────────────────────────────────────────────────────
-- read:   non-guest members of the BOUND workspace          manage: Owner/Admin of the bound workspace (connections.manage)
-- worker: the job's bound workspace only                    guests: nothing (operational tables, TA §49)

-- connections
create policy member_read on connections.connections for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy manage_insert on connections.connections for insert to authenticated
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN')
              and status = 'CONNECTING' and authorized_by = (select auth.uid()));
create policy manage_update on connections.connections for update to authenticated
  using (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'));
create policy worker_read on connections.connections for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_update on connections.connections for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- connection_events (append-only)
create policy member_read on connections.connection_events for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy manage_append on connections.connection_events for insert to authenticated
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN')
              and actor_type = 'user' and actor_user_id = (select auth.uid()));
create policy worker_read on connections.connection_events for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_append on connections.connection_events for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and actor_type = 'system');

-- connect_attempts (web only; each Owner/Admin sees and closes only the attempts they started)
create policy creator_read on connections.connect_attempts for select to authenticated
  using (workspace_id = (select app.current_workspace()) and created_by = (select auth.uid())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'));
create policy manage_insert on connections.connect_attempts for insert to authenticated
  with check (workspace_id = (select app.current_workspace()) and created_by = (select auth.uid())
              and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN') and status = 'PENDING');
create policy creator_update on connections.connect_attempts for update to authenticated
  using (workspace_id = (select app.current_workspace()) and created_by = (select auth.uid())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
  with check (workspace_id = (select app.current_workspace()) and created_by = (select auth.uid())
              and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'));

-- discovered_assets (written by discovery jobs)
create policy member_read on connections.discovered_assets for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on connections.discovered_assets for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_insert on connections.discovered_assets for insert to app_worker
  with check (workspace_id = (select app.current_workspace()));
create policy worker_update on connections.discovered_assets for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- connected_accounts
create policy member_read on connections.connected_accounts for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy manage_insert on connections.connected_accounts for insert to authenticated
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN')
              and status = 'ACTIVE');
create policy manage_update on connections.connected_accounts for update to authenticated
  using (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'))
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN'));
create policy worker_read on connections.connected_accounts for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_insert on connections.connected_accounts for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and status = 'ACTIVE');
create policy worker_update on connections.connected_accounts for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- connected_account_events (append-only)
create policy member_read on connections.connected_account_events for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy manage_append on connections.connected_account_events for insert to authenticated
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN')
              and actor_type = 'user' and actor_user_id = (select auth.uid()));
create policy worker_read on connections.connected_account_events for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_append on connections.connected_account_events for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and actor_type = 'system');

-- asset_moves
create policy member_read on connections.asset_moves for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy manage_request on connections.asset_moves for insert to authenticated
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN')
              and side = 'INCOMING' and status = 'REQUESTED' and initiator_user_id = (select auth.uid()));
-- The web may only re-request (retry) an incoming move; every other transition belongs to the saga jobs.
create policy manage_update on connections.asset_moves for update to authenticated
  using (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN')
         and side = 'INCOMING')
  with check (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN')
              and side = 'INCOMING' and status = 'REQUESTED' and reason_code is null);
create policy worker_read on connections.asset_moves for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_insert on connections.asset_moves for insert to app_worker
  with check (workspace_id = (select app.current_workspace()));
create policy worker_update on connections.asset_moves for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- ── Audit vocabulary (widened; existing rows unaffected) ─────────────────────────────────────────────
set role app_owner;

create or replace function audit.is_valid_change(p_change jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_change is null or (
    pg_catalog.jsonb_typeof(p_change) = 'object'
    and (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_change) k) = array['current', 'kind', 'previous']
    and case p_change ->> 'kind'
      when 'workspace_mode' then
        pg_catalog.jsonb_typeof(p_change -> 'previous') = 'string' and pg_catalog.jsonb_typeof(p_change -> 'current') = 'string'
        and (p_change ->> 'previous') in ('STANDARD', 'MONITOR_ONLY') and (p_change ->> 'current') in ('STANDARD', 'MONITOR_ONLY')
      when 'workspace_membership' then
        audit.is_workspace_membership_state(p_change -> 'previous')
        and (pg_catalog.jsonb_typeof(p_change -> 'current') = 'null' or audit.is_workspace_membership_state(p_change -> 'current'))
      when 'organization_membership' then
        audit.is_organization_membership_state(p_change -> 'previous')
        and (pg_catalog.jsonb_typeof(p_change -> 'current') = 'null' or audit.is_organization_membership_state(p_change -> 'current'))
      when 'connection_status' then
        pg_catalog.jsonb_typeof(p_change -> 'previous') = 'string' and pg_catalog.jsonb_typeof(p_change -> 'current') = 'string'
        and (p_change ->> 'previous') in ('CONNECTING', 'ACTIVE', 'DEGRADED', 'FAILED', 'DISCONNECTED', 'REMOVED')
        and (p_change ->> 'current') in ('CONNECTING', 'ACTIVE', 'DEGRADED', 'FAILED', 'DISCONNECTED', 'REMOVED')
      else false
    end
  )
$$;

alter table audit.audit_events drop constraint audit_events_action_check;
alter table audit.audit_events add constraint audit_events_action_check check (action in (
  'organization.created', 'workspace.created', 'workspace.mode_changed',
  'workspace_membership.role_changed', 'workspace_membership.grants_changed', 'workspace_membership.removed',
  'organization_membership.role_changed', 'organization_membership.removed',
  'invitation.created', 'invitation.revoked', 'invitation.accepted',
  'connection.created', 'connection.credential_replaced', 'connection.validated', 'connection.status_changed',
  'connection.removed',
  'connected_account.linked', 'connected_account.unlinked', 'connected_account.move_requested',
  'connected_account.moved_out', 'connected_account.moved_in', 'connected_account.move_failed',
  'connected_account.move_rejected')) not valid;
alter table audit.audit_events validate constraint audit_events_action_check;

alter table audit.audit_events drop constraint audit_events_target_type_check;
alter table audit.audit_events add constraint audit_events_target_type_check check (target_type in (
  'organization', 'workspace', 'organization_membership', 'workspace_membership', 'invitation',
  'connection', 'connected_account', 'asset_move')) not valid;
alter table audit.audit_events validate constraint audit_events_target_type_check;

-- ── Grants (explicit, least privilege; no table privilege at all on credentials) ─────────────────────
grant usage on schema connections, credentials to authenticated, app_worker;

grant select, insert on connections.connections to authenticated;
grant update (status, active_credential_id, authorized_by, authorized_at, last_problem_code, last_problem_at, version, updated_at)
  on connections.connections to authenticated;
grant select on connections.connections to app_worker;
grant update (status, active_credential_id, last_success_at, last_problem_code, last_problem_at, version, updated_at)
  on connections.connections to app_worker;

grant select, insert on connections.connection_events to authenticated, app_worker;      -- append-only

grant select, insert on connections.connect_attempts to authenticated;
grant update (status, closed_at, pkce_secret_id, pkce_envelope) on connections.connect_attempts to authenticated;

grant select on connections.discovered_assets to authenticated;
grant select, insert on connections.discovered_assets to app_worker;
grant update (display_name, last_seen_at, updated_at) on connections.discovered_assets to app_worker;

grant select, insert on connections.connected_accounts to authenticated, app_worker;
grant update (status, deactivated_at, deactivation_reason, move_id, updated_at) on connections.connected_accounts to authenticated, app_worker;

grant select, insert on connections.connected_account_events to authenticated, app_worker;  -- append-only

grant select, insert on connections.asset_moves to authenticated, app_worker;
grant update (status, reason_code, updated_at) on connections.asset_moves to authenticated;
grant update (status, reason_code, connected_account_id, updated_at) on connections.asset_moves to app_worker;

revoke all on function
  credentials.store_envelope(uuid, uuid, integer, bytea, timestamptz),
  credentials.load_envelope(uuid),
  credentials.delete_envelope(uuid)
from public;
grant execute on function credentials.store_envelope(uuid, uuid, integer, bytea, timestamptz) to authenticated, app_worker;
grant execute on function credentials.load_envelope(uuid) to app_worker;
grant execute on function credentials.delete_envelope(uuid) to authenticated, app_worker;

reset role;
