-- 0034 · Shared Workflow core, Comments first (WORKFLOW-WF-2B; PD D-57/D-59/D-60; ADR-66, ADR-67; TA §76.3–§76.4).
-- Forward-only and expand-only: ONE new schema with two tables, one trigger guard, one reviewed SECURITY DEFINER entry
-- point (manual Done / Reopen), two audit vocabulary widenings (the exact drop / add NOT VALID / validate pattern), one
-- audit change validator and its dispatcher re-created with one more kind, and a backfill of the existing conversations.
-- No existing column, constraint, grant or policy is narrowed; conversations.workflow_state is left as it is (a later
-- contract gate removes it) and is no longer read by the list.
--
--   workflow.work_items       the AUTHORITY for workflow state (Open / Done, optional resolution, who and when, an
--                             optimistic version) AND the indexed queue row: its projected activity is the Comments
--                             list's own definition — ms-truncated max over the conversation's members of
--                             coalesce(provider_created_at, first_observed_at, created_at) — maintained in the SAME
--                             transaction as the interaction write (lock the item, then recompute: WF-1 §8.2). Typed
--                             subject (ADR-66): one nullable reference column per subject kind; Comments is the only
--                             kind, so no private-message row can exist until a Messages gate adds its own kind.
--   workflow.workflow_events  append-only history of every workflow change (created · state_changed): who, from, to,
--                             resolution, cause, version after. Identifiers and closed vocabularies only (no text).
--
-- Writers (no DELETE path exists for any runtime role; rows go only with their workspace):
--   job runtime (app_worker)  creates a work item OPEN with its conversation, projects activity, and performs the ONLY
--                             automatic transition: Done → Open when a new audience member joins (D1). The trigger
--                             guard refuses every other worker transition — an automatic Done is impossible here.
--   web (authenticated)       no table write grant at all: Mark Done / Reopen go through workflow.change_state, which
--                             re-checks the caller, its role in the BOUND workspace (the workflow.internal set),
--                             compares the expected version, and writes the change, its workflow event and its audit
--                             event together.
--
-- Read policy (measured in WF-2A, results/wf2a-2026-11-21T14-03-57-141Z): ONE indexed equality — the bound workspace
-- when the caller holds a non-guest role in it, NULL otherwise — resolved once per statement. The queue read adds the
-- bound workspace as an explicit predicate (planner statistics); RLS stays authoritative.

create schema workflow authorization app_owner;
revoke all on schema workflow from public;

set role app_owner;

create table workflow.work_items (
  id                    uuid not null,
  organization_id       uuid not null,
  workspace_id          uuid not null,
  subject_kind          text not null check (subject_kind in ('comment_conversation')),
  conversation_id       uuid,
  state                 text not null check (state in ('OPEN', 'DONE')),
  resolution            text check (resolution in ('replied_publicly', 'replied_privately', 'replied_on_platform', 'no_reply_needed',
                                                   'moderated', 'reviewed', 'escalation_closed')),
  state_changed_at      timestamptz not null,
  state_changed_by_kind text not null check (state_changed_by_kind in ('system_ingestion', 'migration', 'user', 'system_auto_reopen')),
  state_changed_by_user uuid,
  -- Bumped by every state change AND by every new audience member (a Done decided on a screen that did not show the
  -- newest audience comment is refused as stale). Activity-only changes (an account reply, a late root) keep it.
  version               integer not null check (version >= 1),
  latest_activity_at    timestamptz not null,
  created_at            timestamptz not null,
  updated_at            timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, conversation_id),
  -- Typed subject: a Comments work item IS its conversation (same id), so the list position is the conversation's.
  constraint work_items_typed_subject check (subject_kind <> 'comment_conversation' or conversation_id = id),
  constraint work_items_resolution_only_when_done check (resolution is null or state = 'DONE'),
  constraint work_items_user_initiator check ((state_changed_by_kind = 'user') = (state_changed_by_user is not null)),
  constraint work_items_activity_ms check (latest_activity_at = pg_catalog.date_trunc('milliseconds', latest_activity_at)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- R5: workspace-scoped; a reference into another workspace fails exactly like a missing one.
  foreign key (workspace_id, conversation_id) references conversations.conversations (workspace_id, id)
);
-- One keyset index per list shape (WF-1 / WF-2A): workspace first, equality columns, then the keyset.
create index work_items_queue_by_state on workflow.work_items (workspace_id, subject_kind, state, latest_activity_at desc, id desc);
create index work_items_queue_all on workflow.work_items (workspace_id, subject_kind, latest_activity_at desc, id desc);

create table workflow.workflow_events (
  id                    uuid not null,
  organization_id       uuid not null,
  workspace_id          uuid not null,
  work_item_id          uuid not null,
  kind                  text not null check (kind in ('created', 'state_changed')),
  from_state            text check (from_state in ('OPEN', 'DONE')),
  to_state              text not null check (to_state in ('OPEN', 'DONE')),
  resolution            text check (resolution in ('replied_publicly', 'replied_privately', 'replied_on_platform', 'no_reply_needed',
                                                   'moderated', 'reviewed', 'escalation_closed')),
  initiator_kind        text not null check (initiator_kind in ('system_ingestion', 'migration', 'user', 'system_auto_reopen')),
  initiator_user_id     uuid,
  -- The interaction whose arrival caused an automatic transition (auto-reopen only).
  cause_interaction_id  uuid,
  version_after         integer not null check (version_after >= 1),
  correlation_id        text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  occurred_at           timestamptz not null,
  primary key (workspace_id, id),
  constraint workflow_events_shape check (
    (kind = 'created' and from_state is null and to_state = 'OPEN' and resolution is null)
    or (kind = 'state_changed' and from_state is not null and from_state <> to_state and (resolution is null or to_state = 'DONE'))),
  constraint workflow_events_user_initiator check ((initiator_kind = 'user') = (initiator_user_id is not null)),
  constraint workflow_events_cause check ((initiator_kind = 'system_auto_reopen') = (cause_interaction_id is not null)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, work_item_id) references workflow.work_items (workspace_id, id) on delete cascade,
  foreign key (workspace_id, cause_interaction_id) references interactions.interactions (workspace_id, id)
);
create index workflow_events_by_item on workflow.workflow_events (workspace_id, work_item_id, occurred_at);

alter table workflow.work_items enable row level security;
alter table workflow.work_items force row level security;
alter table workflow.workflow_events enable row level security;
alter table workflow.workflow_events force row level security;

-- ── transition guard (every writer; SECURITY INVOKER) ────────────────────────────────────────────────────────────
-- A state change always advances the version by exactly one and re-attributes the change; nothing else may rewrite who
-- changed the state or when. The job runtime may perform ONLY the objective reopen (Done → Open, system_auto_reopen,
-- no resolution): an automatic Done, or any other worker transition, is refused here whatever the application does.
create function workflow.work_item_guard() returns trigger
language plpgsql volatile security invoker set search_path = pg_catalog, pg_temp as $$
begin
  if new.version < old.version or new.version > old.version + 1 then
    raise exception 'work item: version moves forward by at most one' using errcode = '42501';
  end if;
  if new.state is distinct from old.state or new.resolution is distinct from old.resolution then
    if new.version <> old.version + 1 then
      raise exception 'work item: a state change advances the version' using errcode = '42501';
    end if;
    if current_user = 'app_worker'
       and not (old.state = 'DONE' and new.state = 'OPEN' and new.resolution is null
                and new.state_changed_by_kind = 'system_auto_reopen' and new.state_changed_by_user is null) then
      raise exception 'work item: the job runtime may only reopen' using errcode = '42501';
    end if;
  elsif new.state_changed_at is distinct from old.state_changed_at
     or new.state_changed_by_kind is distinct from old.state_changed_by_kind
     or new.state_changed_by_user is distinct from old.state_changed_by_user then
    raise exception 'work item: attribution changes only with the state' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function workflow.work_item_guard() from public;
create trigger work_item_guard before update on workflow.work_items
  for each row execute function workflow.work_item_guard();

-- ── audit: the workflow change summary (closed vocabulary) ───────────────────────────────────────────────────────
create function audit.is_workflow_state(p_state jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.jsonb_typeof(p_state) = 'object'
     and (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_state) k) = array['resolution', 'state']
     and pg_catalog.jsonb_typeof(p_state -> 'state') = 'string'
     and (p_state ->> 'state') in ('OPEN', 'DONE')
     and (pg_catalog.jsonb_typeof(p_state -> 'resolution') = 'null'
          or (pg_catalog.jsonb_typeof(p_state -> 'resolution') = 'string' and (p_state ->> 'state') = 'DONE'
              and (p_state ->> 'resolution') in ('replied_publicly', 'replied_privately', 'replied_on_platform', 'no_reply_needed',
                                                 'moderated', 'reviewed', 'escalation_closed')))
$$;
revoke all on function audit.is_workflow_state(jsonb) from public;
grant execute on function audit.is_workflow_state(jsonb) to authenticated, app_worker;

-- 0007's dispatcher, unchanged for every existing kind, plus 'workflow_state'.
create or replace function audit.is_valid_change(p_change jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
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
      when 'workflow_state' then
        audit.is_workflow_state(p_change -> 'previous') and audit.is_workflow_state(p_change -> 'current')
        and (p_change -> 'previous') is distinct from (p_change -> 'current')
      else false
    end
  )
$$;

-- ── Audit vocabulary: the workflow change (widened only; exact pattern, verified by lint) ─────────────────────────
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
  'validation_authorization.issued', 'validation_authorization.revoked',
  'work_item.state_changed')) not valid;
alter table audit.audit_events validate constraint audit_events_action_check;

alter table audit.audit_events drop constraint audit_events_target_type_check;
alter table audit.audit_events add constraint audit_events_target_type_check check (target_type in (
  'organization', 'workspace', 'organization_membership', 'workspace_membership', 'invitation',
  'connection', 'connected_account', 'asset_move', 'mutation_intent', 'validation_authorization',
  'work_item')) not valid;
alter table audit.audit_events validate constraint audit_events_target_type_check;

-- ── web entry point: manual Done / Reopen ────────────────────────────────────────────────────────────────────────
-- THREAT MODEL
--   caller       a WEB login only (session_user is a member of `authenticated`; a worker or operator login is refused).
--                EXECUTE granted to authenticated only.
--   authority    the caller (app_private.claimed_user(), the transaction's verified claims) must hold OWNER, ADMIN,
--                MANAGER or RESPONDER in the BOUND workspace (sealed app.current_workspace(), never a parameter) — the
--                workflow.internal set of platform/permissions/catalog.ts. The action pipeline checks the permission
--                first; this is the database backstop.
--   tenant       every statement is pinned to the bound workspace; an unknown id, another workspace's id and a work item
--                of another kind raise the SAME error (P0002): no existence oracle.
--   inputs       uuid / closed vocabulary / integer / correlation shape; no dynamic SQL; a resolution only with DONE.
--   concurrency  the item is locked (FOR UPDATE), then the expected version is compared: stale → outcome 'stale',
--                nothing written. Same state and resolution → 'unchanged', nothing written.
--   atomicity    the change, its workflow event and its audit event (id = the event's id) in one call.
--   names        search_path = pg_catalog, pg_temp (R4a); every object schema-qualified.
--   mode         no mode check by design: workflow is internal and stays available in Monitor-only (PD UC-18, D-49).
create function workflow.change_state(
  p_work_item_id uuid, p_to_state text, p_resolution text, p_expected_version integer, p_correlation_id text, p_request_id text,
  out outcome text, out item_state text, out item_resolution text, out item_version integer
)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_workspace    uuid := app.current_workspace();
  v_user         uuid;
  v_role         text;
  v_item         record;
  v_event        uuid := pg_catalog.gen_random_uuid();
  v_now          timestamptz := pg_catalog.statement_timestamp();
begin
  if v_workspace is null
     or not pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER')
     or pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'workflow: not permitted' using errcode = '42501';
  end if;
  v_user := app_private.claimed_user();
  v_role := app.my_workspace_role(v_workspace);
  if v_user is null or v_role is null or v_role not in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER') then
    raise exception 'workflow: not permitted' using errcode = '42501';
  end if;
  if p_work_item_id is null or p_to_state is null or p_to_state not in ('OPEN', 'DONE') or p_expected_version is null
     or (p_resolution is not null and (p_to_state <> 'DONE' or p_resolution not in (
           'replied_publicly', 'replied_privately', 'replied_on_platform', 'no_reply_needed', 'moderated', 'reviewed', 'escalation_closed'))) then
    raise exception 'workflow: invalid input' using errcode = '22023';
  end if;

  select w.id, w.organization_id, w.state, w.resolution, w.version into v_item
    from workflow.work_items w
   where w.workspace_id = v_workspace and w.id = p_work_item_id and w.subject_kind = 'comment_conversation'
     for update;
  if not found then
    raise exception 'workflow: not found' using errcode = 'P0002';
  end if;

  if v_item.version <> p_expected_version then
    outcome := 'stale'; item_state := v_item.state; item_resolution := v_item.resolution; item_version := v_item.version;
    return;
  end if;
  if v_item.state = p_to_state and v_item.resolution is not distinct from p_resolution then
    outcome := 'unchanged'; item_state := v_item.state; item_resolution := v_item.resolution; item_version := v_item.version;
    return;
  end if;

  update workflow.work_items w
     set state = p_to_state, resolution = p_resolution, state_changed_at = v_now, state_changed_by_kind = 'user',
         state_changed_by_user = v_user, version = w.version + 1, updated_at = v_now
   where w.workspace_id = v_workspace and w.id = v_item.id;

  insert into workflow.workflow_events (id, organization_id, workspace_id, work_item_id, kind, from_state, to_state, resolution,
                                        initiator_kind, initiator_user_id, cause_interaction_id, version_after, correlation_id, occurred_at)
  values (v_event, v_item.organization_id, v_workspace, v_item.id, 'state_changed', v_item.state, p_to_state, p_resolution,
          'user', v_user, null, v_item.version + 1, p_correlation_id, v_now);

  insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id,
                                  target_type, target_id, correlation_id, request_id, outcome, change)
  values (v_event, v_now, 'work_item.state_changed', 'user', v_user, v_item.organization_id, v_workspace,
          'work_item', v_item.id::text, p_correlation_id, p_request_id, 'succeeded',
          pg_catalog.jsonb_build_object(
            'kind', 'workflow_state',
            'previous', pg_catalog.jsonb_build_object('state', v_item.state, 'resolution', v_item.resolution),
            'current', pg_catalog.jsonb_build_object('state', p_to_state, 'resolution', p_resolution)));

  outcome := 'changed'; item_state := p_to_state; item_resolution := p_resolution; item_version := v_item.version + 1;
end
$$;
revoke all on function workflow.change_state(uuid, text, text, integer, text, text) from public;

reset role;

-- ── Policies ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Members (non-guest) of the BOUND workspace read; nobody else, ever (guests: no row, no grant path).
create policy member_read on workflow.work_items for select to authenticated
  using (workspace_id = (select case when app.my_workspace_role(app.current_workspace()) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER')
                                     then app.current_workspace() end));
create policy member_read on workflow.workflow_events for select to authenticated
  using (workspace_id = (select case when app.my_workspace_role(app.current_workspace()) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER')
                                     then app.current_workspace() end));

-- The bound job runtime: reads, creates a work item ONLY as ingestion does (OPEN, version 1, system_ingestion), updates
-- (the trigger guard limits it to activity, version and the objective reopen) and appends ONLY its own two event shapes.
create policy worker_read on workflow.work_items for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on workflow.work_items for insert to app_worker
  with check (workspace_id = (select app.current_workspace())
              and subject_kind = 'comment_conversation' and conversation_id = id
              and state = 'OPEN' and resolution is null and version = 1
              and state_changed_by_kind = 'system_ingestion' and state_changed_by_user is null);
create policy worker_update on workflow.work_items for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));
create policy worker_read on workflow.workflow_events for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on workflow.workflow_events for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and initiator_user_id is null
              and ((kind = 'created' and initiator_kind = 'system_ingestion' and cause_interaction_id is null)
                   or (kind = 'state_changed' and initiator_kind = 'system_auto_reopen' and from_state = 'DONE' and to_state = 'OPEN')));

-- The owner, i.e. ONLY workflow.change_state (the one definer that touches these tables): the bound workspace, a
-- user-initiated change attributed to the transaction's own verified user. No DELETE policy anywhere.
create policy owner_read on workflow.work_items for select to app_owner using (workspace_id = (select app.current_workspace()));
create policy owner_update on workflow.work_items for update to app_owner
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));
create policy owner_read on workflow.workflow_events for select to app_owner using (workspace_id = (select app.current_workspace()));
create policy owner_append on workflow.workflow_events for insert to app_owner
  with check (workspace_id = (select app.current_workspace()) and kind = 'state_changed'
              and initiator_kind = 'user' and initiator_user_id = (select app_private.claimed_user()));

-- Only workflow.change_state's own event: the workflow event of the same id, by the same user, about the same item.
create policy owner_workflow_audit on audit.audit_events for insert to app_owner
  with check (
    action = 'work_item.state_changed' and target_type = 'work_item' and outcome = 'succeeded' and actor_type = 'user'
    and workspace_id = (select app.current_workspace())
    and organization_id = (select app.current_workspace_organization())
    and exists (
      select 1 from workflow.workflow_events e
       where e.workspace_id = (select app.current_workspace())
         and e.id = audit_events.id
         and e.work_item_id::text = audit_events.target_id
         and e.kind = 'state_changed' and e.initiator_kind = 'user'
         and e.initiator_user_id = audit_events.actor_user_id));

set role app_owner;

grant usage on schema workflow to authenticated, app_worker;
grant select on workflow.work_items to authenticated;
grant select, insert on workflow.work_items to app_worker;
grant update (latest_activity_at, version, state, resolution, state_changed_at, state_changed_by_kind, state_changed_by_user, updated_at)
  on workflow.work_items to app_worker;
grant select on workflow.workflow_events to authenticated;
grant select, insert on workflow.workflow_events to app_worker;   -- append-only
grant execute on function workflow.change_state(uuid, text, text, integer, text, text) to authenticated;

reset role;

-- ── Backfill (expand step) ───────────────────────────────────────────────────────────────────────────────────────
-- Every existing conversation becomes its work item, OPEN, with the activity recomputed from its members, and one
-- 'created' event (initiator 'migration'). No path could write DONE before this migration (0017 grants): a conversation
-- in any other state means an unknown writer, so the migration refuses and changes nothing (the runner rolls back).
do $$
begin
  if exists (select 1 from conversations.conversations c where c.workflow_state <> 'OPEN') then
    raise exception '0034: a conversation is not OPEN; no writer of that state is known (refusing)' using errcode = '55000';
  end if;
end
$$;

insert into workflow.work_items (id, organization_id, workspace_id, subject_kind, conversation_id, state, resolution, state_changed_at,
                                 state_changed_by_kind, state_changed_by_user, version, latest_activity_at, created_at, updated_at)
select c.id, c.organization_id, c.workspace_id, 'comment_conversation', c.id, c.workflow_state, null, c.created_at,
       'migration', null, 1,
       coalesce((select pg_catalog.date_trunc('milliseconds', pg_catalog.max(coalesce(i.provider_created_at, i.first_observed_at, i.created_at)))
                   from interactions.interactions i where i.workspace_id = c.workspace_id and i.conversation_id = c.id),
                pg_catalog.date_trunc('milliseconds', c.created_at)),
       c.created_at, c.created_at
  from conversations.conversations c;

insert into workflow.workflow_events (id, organization_id, workspace_id, work_item_id, kind, from_state, to_state, resolution,
                                      initiator_kind, initiator_user_id, cause_interaction_id, version_after, correlation_id, occurred_at)
select pg_catalog.gen_random_uuid(), w.organization_id, w.workspace_id, w.id, 'created', null, 'OPEN', null,
       'migration', null, null, 1, 'migration.0034_workflow_core', w.created_at
  from workflow.work_items w;
