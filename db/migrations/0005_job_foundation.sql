-- 0005 · Job foundation (TA §18.3, §19, §46, §66; R6, R7). Expand-only: new columns and tables; no
-- existing column, constraint, policy or grant is narrowed or removed.
--
--   system.outbox            + dispatch/run-outcome state written only by the system relay and sweepers
--   system.outbox_runs       every vendor run dispatched for an outbox row (current run = latest), so a
--                            crash-recovered row keeps its full, diagnosable run history
--   idempotency.effect_keys  domain idempotency (R6): an effect key claimed in the SAME transaction as the
--                            effect it protects; at most one durable effect per (workspace, key)
--   system.operational_switches / _changes   operational flags and kill switches (TA §66) with an
--                            append-only change history written by trigger, so no change is unaudited

-- ── R7: outbox dispatch and run-outcome state ─────────────────────────────────────────────────────────
set role app_owner;

alter table system.outbox
  add column dispatch_attempts  integer not null default 0 check (dispatch_attempts >= 0),
  add column next_dispatch_at   timestamptz,
  add column claimed_until      timestamptz,
  add column recovery_count     integer not null default 0 check (recovery_count >= 0),
  add column run_outcome        text check (run_outcome in ('COMPLETED', 'FAILED', 'CANCELED', 'RECOVERY_EXHAUSTED')),
  add column run_outcome_at     timestamptz,
  add column last_failure_class text check (last_failure_class in (
    'enqueue_rejected', 'enqueue_unavailable', 'unknown_task', 'invalid_payload',
    'run_failed', 'run_canceled', 'run_crashed', 'run_system_failure', 'run_expired', 'run_timed_out', 'run_not_found')),
  add column slo_breached_at    timestamptz,
  add constraint outbox_outcome_recorded check ((run_outcome is null) = (run_outcome_at is null));

create index outbox_due on system.outbox (next_dispatch_at nulls first, created_at)
  where status = 'PENDING' and run_outcome is null;
create index outbox_awaiting_outcome on system.outbox (dispatched_at)
  where status = 'DISPATCHED' and run_outcome is null;

create table system.outbox_runs (
  outbox_id           uuid not null references system.outbox (id) on delete cascade,
  run_id              text not null check (run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  dispatch_attempt    integer not null check (dispatch_attempt >= 1),
  recovery_generation integer not null check (recovery_generation >= 0),
  dispatched_at       timestamptz not null,
  last_status         text check (last_status in (
    'QUEUED', 'EXECUTING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELED',
    'CRASHED', 'SYSTEM_FAILURE', 'EXPIRED', 'TIMED_OUT', 'UNKNOWN')),
  status_checked_at   timestamptz,
  attempt_count       integer check (attempt_count >= 0),
  terminal_at         timestamptz,
  primary key (outbox_id, run_id)
);
create index outbox_runs_by_run on system.outbox_runs (run_id);

alter table system.outbox_runs enable row level security;
alter table system.outbox_runs force row level security;

-- ── R6: domain idempotency (tenant, append-only) ─────────────────────────────────────────────────────
reset role;
create schema idempotency authorization app_owner;
revoke all on schema idempotency from public;
set role app_owner;

create table idempotency.effect_keys (
  workspace_id uuid not null references tenancy.workspaces (id) on delete cascade,
  effect_key   text not null check (effect_key ~ '^[a-z][a-z0-9_.]{0,63}(:[A-Za-z0-9_-]{1,64}){1,6}$'),
  task         text not null check (task ~ '^[a-z][a-z_]{0,40}(\.[a-z][a-z_]{0,40}){1,3}$'),
  outbox_id    uuid,
  run_id       text check (run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at   timestamptz not null default pg_catalog.now(),
  primary key (workspace_id, effect_key)
);

alter table idempotency.effect_keys enable row level security;
alter table idempotency.effect_keys force row level security;

-- ── TA §66: operational switches (system defaults + permitted overrides) and their audit trail ──────
create table system.operational_switches (
  id              uuid primary key default pg_catalog.gen_random_uuid(),
  switch_key      text not null check (switch_key in (
    'automation.global_kill', 'automation.release_gate', 'mutation.provider_action', 'provider.rollout',
    'ai.task_routing', 'ai.task_kill', 'ingestion.provider_pause')),
  qualifier       text not null default '*' check (qualifier ~ '^(\*|[a-z][a-z0-9_]{0,40}(:[a-z][a-z0-9_]{0,40})?)$'),
  scope           text not null check (scope in ('global', 'organization', 'workspace')),
  organization_id uuid references tenancy.organizations (id) on delete cascade,
  workspace_id    uuid references tenancy.workspaces (id) on delete cascade,
  value           jsonb not null check (pg_catalog.jsonb_typeof(value) = 'object' and pg_catalog.octet_length(value::text) <= 512),
  updated_at      timestamptz not null default pg_catalog.now(),
  check (
    (scope = 'global' and organization_id is null and workspace_id is null)
    or (scope = 'organization' and organization_id is not null and workspace_id is null)
    or (scope = 'workspace' and workspace_id is not null and organization_id is null)
  ),
  -- Overrides only where TA §66.2 permits them: provider rollout per organization, AI routing per workspace.
  check (scope = 'global' or (scope = 'organization' and switch_key = 'provider.rollout') or (scope = 'workspace' and switch_key = 'ai.task_routing')),
  check (switch_key <> 'automation.global_kill' or qualifier = '*'),
  unique nulls not distinct (switch_key, qualifier, scope, organization_id, workspace_id)
);

create table system.operational_switch_changes (
  id              uuid primary key default pg_catalog.gen_random_uuid(),
  switch_key      text not null,
  qualifier       text not null,
  scope           text not null,
  organization_id uuid,
  workspace_id    uuid,
  operation       text not null check (operation in ('set', 'cleared')),
  previous_value  jsonb,
  new_value       jsonb,
  changed_by      text not null check (changed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  reason_code     text not null check (reason_code in ('incident', 'release', 'rollout', 'rollback', 'maintenance', 'test')),
  changed_at      timestamptz not null default pg_catalog.now()
);

-- Every change to a switch writes its history row in the same transaction. The operator tool must declare
-- who and why (transaction-local settings); a change without them is refused, so nothing is unaudited.
-- The one change without an operator: an organization/workspace override removed by the foreign-key
-- cascade of a tenant removal (its organization/workspace row is already gone when this trigger fires).
-- It is recorded, not refused, so the audit trigger never blocks tenant removal. A direct delete of an
-- override whose tenant still exists still needs an operator and a reason.
create function system.record_switch_change() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_operator text := nullif(pg_catalog.current_setting('app.operator_id', true), '');
  v_reason   text := nullif(pg_catalog.current_setting('app.change_reason', true), '');
  v_row      record;
begin
  if (v_operator is null or v_reason is null) and tg_op = 'DELETE' and (
       (old.scope = 'workspace' and not exists (select 1 from tenancy.workspaces w where w.id = old.workspace_id))
    or (old.scope = 'organization' and not exists (select 1 from tenancy.organizations o where o.id = old.organization_id))) then
    v_operator := 'system:tenant_removal';
    v_reason := 'maintenance';
  end if;
  if v_operator is null or v_reason is null then
    raise exception 'operational switch change requires app.operator_id and app.change_reason' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  insert into system.operational_switch_changes
    (switch_key, qualifier, scope, organization_id, workspace_id, operation, previous_value, new_value, changed_by, reason_code)
  values (
    v_row.switch_key, v_row.qualifier, v_row.scope, v_row.organization_id, v_row.workspace_id,
    case when tg_op = 'DELETE' then 'cleared' else 'set' end,
    case when tg_op = 'INSERT' then null else old.value end,
    case when tg_op = 'DELETE' then null else new.value end,
    v_operator, v_reason);
  return null;
end $$;

create trigger operational_switches_audited after insert or update or delete on system.operational_switches
  for each row execute function system.record_switch_change();

alter table system.operational_switches enable row level security;
alter table system.operational_switches force row level security;
alter table system.operational_switch_changes enable row level security;
alter table system.operational_switch_changes force row level security;
-- The definer trigger appends history as the owner.
create policy owner_append on system.operational_switch_changes for insert to app_owner with check (true);

-- The organization of the bound workspace (for workers reading organization-level switch overrides).
create function app.current_workspace_organization() returns uuid
language sql stable security definer set search_path = '' as $$
  select w.organization_id from tenancy.workspaces w where w.id = app.current_workspace()
$$;

reset role;

-- ── Policies ─────────────────────────────────────────────────────────────────────────────────────────
create policy delivery_runs on system.outbox_runs to app_system using (true) with check (true);

create policy worker_claim on idempotency.effect_keys for insert to app_worker
  with check (workspace_id = (select app.current_workspace()));
create policy worker_read on idempotency.effect_keys for select to app_worker
  using (workspace_id = (select app.current_workspace()));

create policy member_read on system.operational_switches for select to authenticated
  using (
    scope = 'global'
    or (scope = 'organization' and app.my_organization_role(organization_id) is not null)
    or (scope = 'workspace' and app.my_workspace_role(workspace_id) is not null)
  );
create policy worker_read on system.operational_switches for select to app_worker
  using (
    scope = 'global'
    or (scope = 'organization' and organization_id = (select app.current_workspace_organization()))
    or (scope = 'workspace' and workspace_id = (select app.current_workspace()))
  );
create policy system_read on system.operational_switches for select to app_system
  using (scope = 'global');

-- ── Grants (explicit; runtime roles never write switches or their history) ──────────────────────────
set role app_owner;

grant update (dispatch_attempts, next_dispatch_at, claimed_until, recovery_count, run_outcome, run_outcome_at,
              last_failure_class, slo_breached_at) on system.outbox to app_system;
grant select, insert on system.outbox_runs to app_system;
grant update (last_status, status_checked_at, attempt_count, terminal_at) on system.outbox_runs to app_system;

grant usage on schema idempotency to app_worker;
grant select, insert on idempotency.effect_keys to app_worker;            -- append-only: no update/delete

grant select on system.operational_switches to authenticated, app_worker, app_system;

grant execute on function app.current_workspace_organization() to app_worker;

reset role;
