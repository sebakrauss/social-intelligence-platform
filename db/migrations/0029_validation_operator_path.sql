-- 0029 · The operator path for ONE-time LIVE validation authorizations (Step 7B-14I2; design 7B-14I1). Forward-only and
-- expand-only: ONE new NOLOGIN role, TWO new tables in the executor's schema, FIVE functions, narrowly scoped owner
-- policies for those functions, and the audit vocabulary widened by two actions and one target type. 0028 is not
-- edited: its tables, triggers, guard and grants stay exactly as they are; nothing here relaxes any of them.
--
--   app_validation_operator   NOLOGIN NOINHERIT NOBYPASSRLS. It holds USAGE on schema `mutations` and EXECUTE on three
--                             functions — and nothing else: no table privilege of any kind, no credential, no switch,
--                             no intent, no KMS. A human operator reaches it ONLY through a dedicated LOGIN role named
--                             validation_operator_<handle> (NOINHERIT, a member of exactly this role, nothing else),
--                             provisioned per person by a later, separately authorized gate; never `postgres`.
--
--   Operator identity         NEVER a declared value. Every operator function derives it from `session_user` — the
--                             authenticated login, which a non-superuser cannot change (SET ROLE changes current_user
--                             only; SET SESSION AUTHORIZATION needs superuser) — and refuses unless that login is a
--                             validation operator login: LOGIN, NOINHERIT, no superuser / BYPASSRLS / CREATEROLE /
--                             CREATEDB / REPLICATION, exactly ONE membership (this role, without ADMIN). The migration
--                             role (`postgres`, BYPASSRLS) is therefore refused here: it stays the root of trust (it can
--                             alter any table), never the ordinary operator.
--
--   mutations.validation_preflights
--                             The PREFLIGHT evidence, written ONLY by the INTEGRATION preflight run itself (the bound
--                             worker, through record_validation_preflight) at the end of a completed preflight: the
--                             run's own reference (from its run context, never the payload), the examined connection and
--                             active credential (identifiers only, re-checked active at write time), the closed check
--                             counts, and recorded_at from the DATABASE clock. `passed` is a generated column — nobody
--                             writes it. Each row authorizes at most ONE issuance (authorization_id write-once).
--
--   mutations.validation_operator_events
--                             The operator's append-only log: who (the session login), what (issued / revoked), why
--                             (closed reason), from which preflight, and whether the unverifiable token type was
--                             explicitly accepted. No UPDATE ever; DELETE only by the tenant-removal cascade. Readable
--                             only by the owner (the status function returns its counts).
--
--   issue_validation_authorization   one transaction: identity → arguments → the preflight row (locked, PASSED, unused,
--                             recorded at most 30 minutes ago by the database clock, token-type acceptance explicit) →
--                             the material state UNCHANGED since the preflight (account ACTIVE, the same connection
--                             ACTIVE with the same active credential, the target still an observed, visible, available,
--                             top-level audience comment of that account) → the 0028 insert (its guard still runs: READ
--                             COMMITTED, advisory lock per target, no open or ever-consumed authorization, replying
--                             initiator) with a lifetime of at most 60 minutes → the preflight marked used → the operator
--                             event → the audit event. All or nothing.
--   revoke_validation_authorization  one transaction: identity → the 0028 revocation (refused after consumption by the
--                             0028 guard: a consumed authorization is never re-armed or recalled) → event → audit.
--   validation_authorization_status  identity → closed state, the bound intent's status, the reply's confirmation —
--                             identifiers, enums, counts and times only; never text.
--   record_validation_preflight      the bound worker (worker login) only; refuses unless the account is an ACTIVE
--                             Instagram account of an ACTIVE Meta connection whose active credential is the one examined.
--
-- The operator functions bind the named workspace for their own transaction (app.bind_workspace), so every owner read
-- below is scoped to that ONE workspace; a transaction already bound to another workspace is refused.

-- ── The operator role (NOLOGIN; created only if absent, otherwise validated — R8: never dropped or recreated) ───────
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_validation_operator') then
    create role app_validation_operator nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles
     where rolname = 'app_validation_operator'
       and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or rolinherit)
  ) then
    raise exception 'role app_validation_operator exists with unexpected attributes; refusing to continue (R1)';
  end if;
end $$;

set role app_owner;

-- ── mutations.validation_preflights: the evidence one completed PREFLIGHT run recorded ─────────────────────────────
create table mutations.validation_preflights (
  id                           uuid not null,
  organization_id              uuid not null,
  workspace_id                 uuid not null,
  connected_account_id         uuid not null,
  target_interaction_id        uuid not null,
  -- The connection and the active credential the run examined (identifiers only; re-checked at issuance).
  connection_id                uuid not null,
  credential_id                uuid not null,
  -- The run's own reference (Trigger.dev run id, from its run context).
  run_reference                text not null check (run_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  -- The reader's closed verdict and the counts it rests on.
  status                       text not null check (status in ('VERIFIED', 'NOT_VERIFIED', 'BLOCKED')),
  checks_verified              smallint not null check (checks_verified between 0 and 10),
  required_permissions_granted boolean not null,
  replies_complete             boolean not null,
  replies_by_managed_account   integer check (replies_by_managed_account >= 0),
  replies_unattributed         integer check (replies_unattributed >= 0),
  stopped_early                boolean not null,
  -- The token type the reply POST requires is not observable with the plane's own credentials (Step 7B-14I2 §4).
  token_type                   text not null check (token_type in ('NOT_VERIFIED')),
  passed                       boolean generated always as (coalesce(
                                 status = 'VERIFIED' and checks_verified = 10 and required_permissions_granted
                                 and replies_complete and replies_by_managed_account = 0 and replies_unattributed = 0
                                 and not stopped_early, false)) stored,
  recorded_at                  timestamptz not null,
  authorization_id             uuid,
  used_at                      timestamptz,
  primary key (workspace_id, id),
  constraint validation_preflights_use_shape check ((authorization_id is null) = (used_at is null) and (used_at is null or used_at >= recorded_at)),
  constraint validation_preflights_one_use unique (workspace_id, authorization_id),
  constraint validation_preflights_workspace foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint validation_preflights_account foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id) on delete cascade,
  constraint validation_preflights_target foreign key (workspace_id, target_interaction_id, connected_account_id)
    references interactions.interactions (workspace_id, id, connected_account_id) on delete cascade,
  constraint validation_preflights_authorization foreign key (workspace_id, authorization_id) references mutations.validation_authorizations (workspace_id, id)
);
create index validation_preflights_by_target on mutations.validation_preflights (workspace_id, target_interaction_id, recorded_at);

alter table mutations.validation_preflights enable row level security;
alter table mutations.validation_preflights force row level security;

-- ── mutations.validation_operator_events: the operator's append-only log ────────────────────────────────────────────
create table mutations.validation_operator_events (
  id                               uuid not null default pg_catalog.gen_random_uuid(),
  organization_id                  uuid not null,
  workspace_id                     uuid not null,
  authorization_id                 uuid not null,
  event                            text not null check (event in ('issued', 'revoked')),
  operator_login                   text not null check (operator_login ~ '^validation_operator_[a-z0-9_]{2,40}$'),
  reason                           text not null check (reason in ('live_validation', 'test', 'incident', 'rollback', 'maintenance', 'superseded')),
  preflight_id                     uuid,
  token_type_not_verified_accepted boolean,
  recorded_at                      timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (workspace_id, id),
  constraint validation_operator_events_once unique (workspace_id, authorization_id, event),
  constraint validation_operator_events_issue_shape check (
    (event = 'issued') = (preflight_id is not null) and (event = 'issued') = (token_type_not_verified_accepted is not null)
    and (event <> 'issued' or reason in ('live_validation', 'test'))
    and (event <> 'revoked' or reason in ('incident', 'rollback', 'maintenance', 'superseded', 'test'))),
  constraint validation_operator_events_workspace foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint validation_operator_events_authorization foreign key (workspace_id, authorization_id)
    references mutations.validation_authorizations (workspace_id, id) on delete cascade
);

alter table mutations.validation_operator_events enable row level security;
alter table mutations.validation_operator_events force row level security;

-- ── Guards: the evidence's only change is its single use; the log never changes ──────────────────────────────────
create function mutations.validation_preflight_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from tenancy.workspaces w where w.id = old.workspace_id) then
      raise exception 'preflight evidence is never deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  -- `passed` is generated from the other columns: comparing those is comparing it.
  if (to_jsonb(new) - 'authorization_id' - 'used_at' - 'passed') is distinct from (to_jsonb(old) - 'authorization_id' - 'used_at' - 'passed') then
    raise exception 'preflight evidence never changes' using errcode = '42501';
  end if;
  if old.authorization_id is not null or new.authorization_id is null then
    raise exception 'preflight evidence is used once, write-once' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function mutations.validation_preflight_guard() from public;
create trigger validation_preflight_guard before update or delete on mutations.validation_preflights
  for each row execute function mutations.validation_preflight_guard();

create function mutations.validation_operator_event_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from tenancy.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  raise exception 'the validation operator log is append-only' using errcode = '42501';
end
$$;
revoke all on function mutations.validation_operator_event_guard() from public;
create trigger validation_operator_event_guard before update or delete on mutations.validation_operator_events
  for each row execute function mutations.validation_operator_event_guard();

-- ── Operator identity: the authenticated session login, never a declared value ───────────────────────────────────
-- SECURITY INVOKER, executed by nobody but the owner's definers below (no EXECUTE grant). It reads only pg_catalog.
create function mutations.validation_operator_login() returns text
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_role record;
begin
  select r.oid, r.rolname::text as name, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit
    into v_role
    from pg_catalog.pg_roles r where r.rolname = session_user;
  if not found
     or v_role.name !~ '^validation_operator_[a-z0-9_]{2,40}$'
     or not v_role.rolcanlogin or v_role.rolsuper or v_role.rolbypassrls or v_role.rolcreaterole
     or v_role.rolcreatedb or v_role.rolreplication or v_role.rolinherit then
    raise exception 'validation operator: the session login is not a validation operator login' using errcode = '42501';
  end if;
  -- Exactly ONE membership: app_validation_operator, without ADMIN (no inherited or borrowed privilege of any kind).
  if (select pg_catalog.count(*) from pg_catalog.pg_auth_members m where m.member = v_role.oid) <> 1
     or not exists (
       select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles g on g.oid = m.roleid
        where m.member = v_role.oid and g.rolname = 'app_validation_operator' and not m.admin_option) then
    raise exception 'validation operator: the session login is not a validation operator login' using errcode = '42501';
  end if;
  return v_role.name;
end
$$;
revoke all on function mutations.validation_operator_login() from public;

-- Binds the named workspace for THIS transaction (or accepts the same binding); another binding is refused.
create function mutations.validation_operator_bind(p_workspace_id uuid) returns void
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_bound uuid := app.current_workspace();
begin
  if p_workspace_id is null then
    raise exception 'validation operator: workspace required' using errcode = '22023';
  end if;
  if v_bound is null then
    perform app.bind_workspace(p_workspace_id);
  elsif v_bound <> p_workspace_id then
    raise exception 'validation operator: the transaction is bound to another workspace' using errcode = '42501';
  end if;
end
$$;
revoke all on function mutations.validation_operator_bind(uuid) from public;

-- ── record_validation_preflight: the INTEGRATION preflight run's own evidence (bound worker only) ─────────────────
create function mutations.record_validation_preflight(
  p_id uuid, p_connected_account_id uuid, p_target_interaction_id uuid, p_credential_id uuid, p_run_reference text,
  p_status text, p_checks_verified integer, p_required_permissions_granted boolean, p_replies_complete boolean,
  p_replies_by_managed_account integer, p_replies_unattributed integer, p_stopped_early boolean
) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace    uuid := app.current_workspace();
  v_organization uuid := app.current_workspace_organization();
  v_connection   uuid;
  v_now          timestamptz := pg_catalog.clock_timestamp();
begin
  if v_workspace is null or v_organization is null then
    raise exception 'preflight evidence: no bound workspace' using errcode = '42501';
  end if;
  if not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'preflight evidence is recorded by the bound worker only' using errcode = '42501';
  end if;
  select a.connection_id into v_connection
    from connections.connected_accounts a
   where a.workspace_id = v_workspace and a.id = p_connected_account_id
     and a.status = 'ACTIVE' and a.platform = 'instagram' and a.asset_class = 'content_bearing';
  if v_connection is null or not exists (
    select 1 from connections.connections c
     where c.workspace_id = v_workspace and c.id = v_connection and c.provider = 'meta' and c.status = 'ACTIVE'
       and c.active_credential_id = p_credential_id) then
    raise exception 'preflight evidence: the examined account, connection or credential is no longer the active one' using errcode = '42501';
  end if;
  insert into mutations.validation_preflights (
    id, organization_id, workspace_id, connected_account_id, target_interaction_id, connection_id, credential_id,
    run_reference, status, checks_verified, required_permissions_granted, replies_complete,
    replies_by_managed_account, replies_unattributed, stopped_early, token_type, recorded_at)
  values (
    p_id, v_organization, v_workspace, p_connected_account_id, p_target_interaction_id, v_connection, p_credential_id,
    p_run_reference, p_status, p_checks_verified, p_required_permissions_granted, p_replies_complete,
    p_replies_by_managed_account, p_replies_unattributed, p_stopped_early, 'NOT_VERIFIED', v_now);
  return v_now;
end
$$;
revoke all on function mutations.record_validation_preflight(uuid, uuid, uuid, uuid, text, text, integer, boolean, boolean, integer, integer, boolean) from public;

-- ── issue_validation_authorization ───────────────────────────────────────────────────────────────────────────────
create function mutations.issue_validation_authorization(
  p_workspace_id uuid, p_preflight_id uuid, p_initiator_user_id uuid, p_reason text, p_lifetime_minutes integer,
  p_accept_token_type_not_verified boolean
) returns table (authorization_id uuid, expires_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_operator     text := mutations.validation_operator_login();
  v_now          timestamptz := pg_catalog.clock_timestamp();
  v_id           uuid := pg_catalog.gen_random_uuid();
  v_pre          record;
  v_organization uuid;
  v_expires      timestamptz;
begin
  if p_reason is null or p_reason not in ('live_validation', 'test') then
    raise exception 'validation operator: issue reason must be live_validation or test' using errcode = '22023';
  end if;
  if p_lifetime_minutes is null or p_lifetime_minutes < 1 or p_lifetime_minutes > 60 then
    raise exception 'validation operator: lifetime must be between 1 and 60 minutes' using errcode = '22023';
  end if;
  if p_preflight_id is null or p_initiator_user_id is null then
    raise exception 'validation operator: preflight and initiator are required' using errcode = '22023';
  end if;
  perform mutations.validation_operator_bind(p_workspace_id);

  select p.* into v_pre from mutations.validation_preflights p
   where p.workspace_id = p_workspace_id and p.id = p_preflight_id
   for update;
  if not found then
    raise exception 'validation operator: no such preflight evidence' using errcode = 'P0002';
  end if;
  if v_pre.authorization_id is not null then
    raise exception 'validation operator: this preflight evidence was already used' using errcode = '23505';
  end if;
  if not v_pre.passed then
    raise exception 'validation operator: the preflight did not pass' using errcode = '42501';
  end if;
  if v_pre.recorded_at > v_now or v_pre.recorded_at < v_now - interval '30 minutes' then
    raise exception 'validation operator: the preflight is not fresh (30 minutes at most)' using errcode = '42501';
  end if;
  if v_pre.token_type = 'NOT_VERIFIED' and p_accept_token_type_not_verified is not true then
    raise exception 'validation operator: the token type is NOT_VERIFIED; explicit acceptance is required' using errcode = '42501';
  end if;
  -- Nothing material changed since the preflight: the same ACTIVE account, connection and active credential.
  if not exists (
    select 1 from connections.connected_accounts a
      join connections.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
     where a.workspace_id = p_workspace_id and a.id = v_pre.connected_account_id
       and a.status = 'ACTIVE' and a.platform = 'instagram' and a.asset_class = 'content_bearing'
       and c.id = v_pre.connection_id and c.provider = 'meta' and c.status = 'ACTIVE'
       and c.active_credential_id = v_pre.credential_id) then
    raise exception 'validation operator: the account, connection or credential changed since the preflight' using errcode = '42501';
  end if;
  -- The target is still an observed, visible, available, top-level audience comment of that account.
  if not exists (
    select 1 from interactions.interactions i
     where i.workspace_id = p_workspace_id and i.id = v_pre.target_interaction_id
       and i.connected_account_id = v_pre.connected_account_id and i.platform = 'instagram'
       and i.observed and i.kind = 'comment' and i.parent_interaction_id is null
       and i.author_role = 'user' and i.current_visibility = 'visible' and i.current_availability = 'available') then
    raise exception 'validation operator: the target changed since the preflight' using errcode = '42501';
  end if;

  select w.organization_id into v_organization from tenancy.workspaces w where w.id = p_workspace_id;
  v_expires := pg_catalog.now() + pg_catalog.make_interval(mins => p_lifetime_minutes);
  -- The 0028 guard reads the declaration; it is the session login, never a value the caller supplied.
  perform pg_catalog.set_config('app.operator_id', v_operator, true);
  perform pg_catalog.set_config('app.change_reason', p_reason, true);
  insert into mutations.validation_authorizations (
    id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id,
    provider, platform, kind, preflight_run_reference, preflight_completed_at, expires_at)
  values (
    v_id, v_organization, p_workspace_id, v_pre.connected_account_id, v_pre.target_interaction_id, p_initiator_user_id,
    'meta', 'instagram', 'reply_public', v_pre.run_reference, v_pre.recorded_at, v_expires);
  update mutations.validation_preflights set authorization_id = v_id, used_at = v_now
   where workspace_id = p_workspace_id and id = p_preflight_id;
  insert into mutations.validation_operator_events (organization_id, workspace_id, authorization_id, event, operator_login, reason, preflight_id, token_type_not_verified_accepted)
  values (v_organization, p_workspace_id, v_id, 'issued', v_operator, p_reason, p_preflight_id, v_pre.token_type = 'NOT_VERIFIED');
  insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id,
                                  target_type, target_id, correlation_id, outcome, change)
  values (pg_catalog.gen_random_uuid(), v_now, 'validation_authorization.issued', 'system', null, v_organization, p_workspace_id,
          'validation_authorization', v_id::text, 'validation-authorization:' || v_id::text, 'succeeded', null);
  return query select v_id, v_expires;
end
$$;
revoke all on function mutations.issue_validation_authorization(uuid, uuid, uuid, text, integer, boolean) from public;

-- ── revoke_validation_authorization ──────────────────────────────────────────────────────────────────────────────
create function mutations.revoke_validation_authorization(p_workspace_id uuid, p_authorization_id uuid, p_reason text) returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_operator     text := mutations.validation_operator_login();
  v_now          timestamptz := pg_catalog.clock_timestamp();
  v_organization uuid;
begin
  if p_reason is null or p_reason not in ('incident', 'rollback', 'maintenance', 'superseded', 'test') then
    raise exception 'validation operator: invalid revocation reason' using errcode = '22023';
  end if;
  perform mutations.validation_operator_bind(p_workspace_id);
  select v.organization_id into v_organization from mutations.validation_authorizations v
   where v.workspace_id = p_workspace_id and v.id = p_authorization_id;
  if v_organization is null then
    raise exception 'validation operator: no such authorization' using errcode = 'P0002';
  end if;
  perform pg_catalog.set_config('app.operator_id', v_operator, true);
  perform pg_catalog.set_config('app.change_reason', p_reason, true);
  -- The 0028 guard decides: declared, direct, before consumption, write-once.
  update mutations.validation_authorizations set revoked_at = pg_catalog.now()
   where workspace_id = p_workspace_id and id = p_authorization_id;
  insert into mutations.validation_operator_events (organization_id, workspace_id, authorization_id, event, operator_login, reason)
  values (v_organization, p_workspace_id, p_authorization_id, 'revoked', v_operator, p_reason);
  insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id,
                                  target_type, target_id, correlation_id, outcome, change)
  values (pg_catalog.gen_random_uuid(), v_now, 'validation_authorization.revoked', 'system', null, v_organization, p_workspace_id,
          'validation_authorization', p_authorization_id::text, 'validation-authorization:' || p_authorization_id::text, 'succeeded', null);
  return v_now;
end
$$;
revoke all on function mutations.revoke_validation_authorization(uuid, uuid, text) from public;

-- ── validation_authorization_status: identifiers, enums, counts and times only ──────────────────────────────────
create function mutations.validation_authorization_status(p_workspace_id uuid, p_authorization_id uuid)
returns table (
  state text, issued_by text, issue_reason text, issued_at timestamptz, expires_at timestamptz,
  revoked_at timestamptz, revocation_reason text, bound_at timestamptz, consumed_at timestamptz,
  intent_id uuid, intent_status text, intent_attempt integer, intent_outcome_code text, intent_updated_at timestamptz,
  reply_provider_identity boolean, reply_confirmed_at timestamptz, preflight_id uuid, operator_events integer
)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_operator text := mutations.validation_operator_login();
begin
  perform mutations.validation_operator_bind(p_workspace_id);
  return query
    select case when v.consumed_at is not null then 'CONSUMED'
                when v.revoked_at is not null then 'REVOKED'
                when pg_catalog.clock_timestamp() >= v.expires_at then 'EXPIRED'
                when v.intent_id is not null then 'BOUND'
                else 'ISSUED' end,
           v.issued_by, v.issue_reason, v.issued_at, v.expires_at, v.revoked_at, v.revocation_reason, v.bound_at, v.consumed_at,
           i.id, i.status, i.attempt, i.outcome_code, i.updated_at,
           (r.provider_reply_id is not null), r.confirmed_at,
           (select p.id from mutations.validation_preflights p where p.workspace_id = v.workspace_id and p.authorization_id = v.id),
           (select pg_catalog.count(*)::integer from mutations.validation_operator_events e where e.workspace_id = v.workspace_id and e.authorization_id = v.id)
      from mutations.validation_authorizations v
      left join mutations.mutation_intents i on i.workspace_id = v.workspace_id and i.id = v.intent_id
      left join mutations.outbound_replies r on r.workspace_id = v.workspace_id and r.intent_id = v.intent_id
     where v.workspace_id = p_workspace_id and v.id = p_authorization_id;
  if not found then
    raise exception 'validation operator: no such authorization' using errcode = 'P0002';
  end if;
end
$$;
revoke all on function mutations.validation_authorization_status(uuid, uuid) from public;

reset role;

-- ── Audit vocabulary: two operator actions and their target type (widened only; exact pattern) ───────────────────
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
  'connected_account.move_rejected', 'connected_account.capability_reevaluation_requested',
  'connected_account.reconciliation_requested',
  'mutation_intent.created', 'mutation_intent.executing', 'mutation_intent.confirmed', 'mutation_intent.failed',
  'mutation_intent.blocked', 'mutation_intent.outcome_unknown', 'mutation_intent.reconciled',
  'validation_authorization.issued', 'validation_authorization.revoked')) not valid;
alter table audit.audit_events validate constraint audit_events_action_check;

alter table audit.audit_events drop constraint audit_events_target_type_check;
alter table audit.audit_events add constraint audit_events_target_type_check check (target_type in (
  'organization', 'workspace', 'organization_membership', 'workspace_membership', 'invitation',
  'connection', 'connected_account', 'asset_move', 'mutation_intent', 'validation_authorization')) not valid;
alter table audit.audit_events validate constraint audit_events_target_type_check;

-- ── Policies (owner only, scoped to the BOUND workspace; nothing for any runtime role) ─────────────────────────────
-- The operator definers insert an authorization only for the bound workspace, from a validation operator session.
create policy owner_issue on mutations.validation_authorizations for insert to app_owner
  with check (workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER'));
-- The issuance re-check reads the target interaction of the bound workspace (operator sessions only).
create policy owner_validation_read on interactions.interactions for select to app_owner
  using (workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER'));
-- The status read: AUTHORIZED intents and their replies of the bound workspace only (operator sessions only).
create policy owner_validation_read on mutations.mutation_intents for select to app_owner
  using (workspace_id = (select app.current_workspace()) and validation_authorization_id is not null
         and pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER'));
create policy owner_validation_read on mutations.outbound_replies for select to app_owner
  using (workspace_id = (select app.current_workspace())
         and pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER')
         and exists (select 1 from mutations.mutation_intents i
                      where i.workspace_id = outbound_replies.workspace_id and i.id = outbound_replies.intent_id
                        and i.validation_authorization_id is not null));
-- The evidence: recorded by the worker's definer; read and used once by the operator's.
create policy owner_record on mutations.validation_preflights for insert to app_owner
  with check (workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER'));
create policy owner_read on mutations.validation_preflights for select to app_owner
  using (workspace_id = (select app.current_workspace()));
create policy owner_use on mutations.validation_preflights for update to app_owner
  using (workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER'))
  with check (workspace_id = (select app.current_workspace()));
-- The log: appended and read by the operator's definers only.
create policy owner_append on mutations.validation_operator_events for insert to app_owner
  with check (workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER'));
create policy owner_read on mutations.validation_operator_events for select to app_owner
  using (workspace_id = (select app.current_workspace()));
-- The audit ledger: exactly the two operator actions, each only alongside its own log row (same workspace, same id).
create policy owner_validation_audit on audit.audit_events for insert to app_owner
  with check (
    action in ('validation_authorization.issued', 'validation_authorization.revoked')
    and actor_type = 'system' and actor_user_id is null and target_type = 'validation_authorization'
    and outcome = 'succeeded' and change is null
    and workspace_id = (select app.current_workspace())
    and pg_catalog.pg_has_role(session_user, 'app_validation_operator', 'MEMBER')
    and exists (
      select 1 from mutations.validation_operator_events e
       where e.workspace_id = audit_events.workspace_id and e.authorization_id::text = audit_events.target_id
         and e.event = pg_catalog.split_part(audit_events.action, '.', 2)));

-- ── Grants (explicit, least privilege) ──────────────────────────────────────────────────────────────────────────
set role app_owner;

grant usage on schema mutations to app_validation_operator;
grant execute on function mutations.issue_validation_authorization(uuid, uuid, uuid, text, integer, boolean) to app_validation_operator;
grant execute on function mutations.revoke_validation_authorization(uuid, uuid, text) to app_validation_operator;
grant execute on function mutations.validation_authorization_status(uuid, uuid) to app_validation_operator;
grant execute on function mutations.record_validation_preflight(uuid, uuid, uuid, uuid, text, text, integer, boolean, boolean, integer, integer, boolean) to app_worker;

reset role;
