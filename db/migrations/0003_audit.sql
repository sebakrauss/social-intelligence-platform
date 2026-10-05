-- 0003 · Audit events: append-only accountability ledger (TA §41; §11.2 append-only history; §12 D).
--
-- Written in the same transaction as the change it records. Runtime roles may INSERT only: no SELECT,
-- UPDATE or DELETE grant exists for any runtime role (reads arrive later through an audited surface).
-- Closed vocabularies and identifier shapes are checked here as defense in depth; the application's
-- createAuditEvent remains the authoritative validator. No email, names, tokens or request bodies.

create schema audit authorization app_owner;
revoke all on schema audit from public;

set role app_owner;

-- Closed-vocabulary previous/current state summaries (Step 1 kinds).
create function audit.is_workspace_membership_state(p_state jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_typeof(p_state) = 'object'
     and (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_state) k) = array['grants', 'role']
     and (p_state ->> 'role') in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER', 'CLIENT_GUEST')
     and pg_catalog.jsonb_typeof(p_state -> 'grants') = 'array'
     and pg_catalog.jsonb_array_length(p_state -> 'grants') = (
       select pg_catalog.count(distinct g) from pg_catalog.jsonb_array_elements_text(p_state -> 'grants') g
       where g in (
         'workspace.read_operational', 'intelligence.read', 'reports.read', 'reply.public', 'reply.private',
         'moderate.hide_unhide', 'moderate.delete', 'moderate.block', 'workflow.internal', 'automation.configure',
         'recommendations.decide', 'responding.manage', 'escalation.default_contact.set', 'connections.manage',
         'members.manage', 'workspace.mode.change', 'organization.manage', 'billing.manage', 'attention.read'
       )
     )
     and (select pg_catalog.bool_and(pg_catalog.jsonb_typeof(e) = 'string') from pg_catalog.jsonb_array_elements(p_state -> 'grants') e) is not false
$$;

create function audit.is_organization_membership_state(p_state jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_typeof(p_state) = 'object'
     and (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_state) k) = array['role']
     and pg_catalog.jsonb_typeof(p_state -> 'role') = 'string'
     and (p_state ->> 'role') in ('OWNER', 'ADMIN', 'MEMBER')
$$;

create function audit.is_valid_change(p_change jsonb) returns boolean
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
      else false
    end
  )
$$;

create table audit.audit_events (
  id              uuid primary key,
  occurred_at     timestamptz not null,
  action          text not null check (action in (
                    'organization.created', 'workspace.created', 'workspace.mode_changed',
                    'workspace_membership.role_changed', 'workspace_membership.grants_changed', 'workspace_membership.removed',
                    'organization_membership.role_changed', 'organization_membership.removed',
                    'invitation.created', 'invitation.revoked', 'invitation.accepted')),
  actor_type      text not null check (actor_type in ('user', 'policy', 'system', 'native_platform', 'ai_assisted_user')),
  actor_user_id   uuid,
  organization_id uuid,
  workspace_id    uuid,
  target_type     text not null check (target_type in ('organization', 'workspace', 'organization_membership', 'workspace_membership', 'invitation')),
  target_id       text not null check (target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'),
  correlation_id  text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_id      text check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  outcome         text not null check (outcome in ('succeeded', 'failed')),
  change          jsonb check (audit.is_valid_change(change)),
  recorded_at     timestamptz not null default pg_catalog.now()
);
-- No foreign keys: the ledger must outlive the rows it describes (and never become an existence oracle).
create index audit_events_by_workspace on audit.audit_events (workspace_id, occurred_at) where workspace_id is not null;
create index audit_events_by_organization on audit.audit_events (organization_id, occurred_at) where organization_id is not null;

alter table audit.audit_events enable row level security;
alter table audit.audit_events force row level security;

reset role;

-- Users append events attributed to themselves; workers append events for their bound workspace only.
create policy append_own on audit.audit_events for insert to authenticated
  with check (actor_type = 'user' and actor_user_id = (select auth.uid()));
create policy append_bound_workspace on audit.audit_events for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and actor_type in ('policy', 'system', 'native_platform'));

set role app_owner;

grant usage on schema audit to authenticated, app_worker;
grant insert on audit.audit_events to authenticated, app_worker;          -- append-only: no select/update/delete
-- CHECK constraints run with the inserting role's privileges; the validators are pure and side-effect free.
grant execute on function
  audit.is_valid_change(jsonb),
  audit.is_workspace_membership_state(jsonb),
  audit.is_organization_membership_state(jsonb)
to authenticated, app_worker;

reset role;
