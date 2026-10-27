-- 0018 · Reconciliation runtime persistence (Step H6-C2; design H6-C0; TL decisions D-C1…D-C5; TA §14, §17, §19, §47;
-- Model §7). Forward-only and expand-only: four ingestion-owned tables, three guard triggers and two closed-vocabulary
-- widenings. No change to 0017's canonical source model, no data change, no backfill. Safe while the deployed runtime
-- predates it: nothing deployed reads or writes these tables, and both widenings only admit one more value.
--
--   ingestion.reconciliation_runs         one reconciliation request for one connected account, with the budget
--                                         snapshot that governed it; at most one open (REQUESTED / RUNNING) per account
--   ingestion.reconciliation_slices       one bounded unit of provider work (content listing, or one content item's
--                                         interactions); the ONLY place a short-lived provider cursor may live
--   ingestion.reconciliation_watermarks   durable completeness per account × read_interactions scope × content item:
--                                         the epoch (start of the first traversal) and how far a COMPLETE traversal got
--   ingestion.authority_conflicts         APPEND-ONLY record of refused sightings: ids and closed classes only
--
--   coverage.coverage_records.reason      gains 'TRAVERSAL_INCOMPLETE' (TL D-C5): a traversal stopped by its
--                                         page/continuation budget covers nothing (UNKNOWN), never COMPLETE or zero
--   audit.audit_events.action             gains 'connected_account.reconciliation_requested' (TL D-C1: the explicit
--                                         Owner/Admin action that starts a reconciliation)
--
-- Not here (H6-F): no provider-event inbox, raw webhook body, webhook subscription or delivery receipt.
--
-- Written only by the job runtime (app_worker, bound to one workspace). Members (non-guests) of the bound workspace may
-- read RUNS — the status of a reconciliation is user-facing information, like a capability profile. Slices (provider
-- cursors), watermarks and conflicts are internal operational state: no member reads them (like idempotency.effect_keys).
-- Guests read nothing here. Every reference is composite with the workspace (R5): a cross-workspace run, slice,
-- account, content item or interaction fails exactly like a missing one.
--
-- State transitions are the application's (H6-C3). The database only refuses impossible or authority-breaking states:
-- a terminal run or slice never changes again, a slice enters RUNNING only by incrementing its attempt, counters never
-- go down, a terminal slice holds no cursor, a watermark's epoch is fixed and its synced-through never regresses.

set role app_owner;

-- ── ingestion.reconciliation_runs ─────────────────────────────────────────────────────────────────────────
create table ingestion.reconciliation_runs (
  id                                 uuid not null,
  organization_id                    uuid not null,
  workspace_id                       uuid not null,
  connected_account_id               uuid not null,
  state                              text not null check (state in ('REQUESTED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'SKIPPED_UNAVAILABLE', 'FAILED')),
  initiator_type                     text not null check (initiator_type in ('user', 'system')),
  initiator_user_id                  uuid,
  correlation_id                     text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  requested_at                       timestamptz not null,
  started_at                         timestamptz,
  completed_at                       timestamptz,
  -- Budget snapshot (TL D-C3, D-C4) chosen at request time; ceilings: ≤ 10 pages per slice, overlap ≤ 7 days.
  budget_listing_pages_per_slice     integer not null check (budget_listing_pages_per_slice between 1 and 10),
  budget_interaction_pages_per_slice integer not null check (budget_interaction_pages_per_slice between 1 and 10),
  budget_continuations_per_content   integer not null check (budget_continuations_per_content >= 0),
  budget_interaction_pages_per_content integer not null,
  budget_content_items               integer not null check (budget_content_items >= 1),
  budget_overlap_seconds             integer not null check (budget_overlap_seconds between 0 and 604800),
  operations_used                    integer not null default 0 check (operations_used >= 0),
  pages_used                         integer not null default 0 check (pages_used >= 0),
  content_items_used                 integer not null default 0 check (content_items_used >= 0),
  failure_class                      text check (failure_class ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at                         timestamptz not null,
  updated_at                         timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, id, connected_account_id),
  constraint reconciliation_runs_initiator check ((initiator_type = 'user') = (initiator_user_id is not null)),
  constraint reconciliation_runs_pages_per_content
    check (budget_interaction_pages_per_content = budget_interaction_pages_per_slice * (1 + budget_continuations_per_content)),
  constraint reconciliation_runs_lifecycle check (
    case state
      when 'REQUESTED' then started_at is null and completed_at is null
      when 'RUNNING' then started_at is not null and completed_at is null
      when 'SKIPPED_UNAVAILABLE' then completed_at is not null
      else started_at is not null and completed_at is not null
    end),
  constraint reconciliation_runs_failure check (
    (state in ('FAILED', 'SKIPPED_UNAVAILABLE') and failure_class is not null) or (state = 'COMPLETED' and failure_class is null)
    or state in ('REQUESTED', 'RUNNING', 'PARTIAL')),
  constraint reconciliation_runs_times check (
    (started_at is null or started_at >= requested_at)
    and (completed_at is null or completed_at >= coalesce(started_at, requested_at))
    and updated_at >= created_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id)
);
-- At most one open run per connected account (TL D-C3: one open run per account).
create unique index reconciliation_runs_one_open on ingestion.reconciliation_runs (workspace_id, connected_account_id)
  where state in ('REQUESTED', 'RUNNING');
create index reconciliation_runs_by_account on ingestion.reconciliation_runs (workspace_id, connected_account_id, requested_at);

-- ── ingestion.reconciliation_slices ───────────────────────────────────────────────────────────────────────
create table ingestion.reconciliation_slices (
  id                    uuid not null,
  organization_id       uuid not null,
  workspace_id          uuid not null,
  reconciliation_run_id uuid not null,
  connected_account_id  uuid not null,
  unit                  text not null check (unit in ('content_listing', 'content_interactions')),
  content_item_id       uuid,
  sequence              integer not null check (sequence >= 0),
  state                 text not null check (state in ('PENDING', 'RUNNING', 'COMPLETED', 'CONTINUED', 'FAILED_TRANSIENT',
                          'FAILED_RATE_LIMITED', 'FAILED_PERMANENT', 'ABANDONED_BUDGET')),
  attempt               integer not null default 0 check (attempt >= 0),
  leased_until          timestamptz,
  -- Opaque provider continuation, exactly as the provider contract returned it: short-lived slice state only (never a
  -- watermark, never in an outbox row, job payload or log).
  cursor                text check (char_length(cursor) between 1 and 2048),
  cursor_issued_at      timestamptz,
  window_start          timestamptz not null,
  window_end            timestamptz not null,
  max_pages             integer not null check (max_pages between 1 and 10),
  pages_read            integer not null default 0 check (pages_read >= 0),
  operations_used       integer not null default 0 check (operations_used >= 0),
  conflict_count        integer not null default 0 check (conflict_count >= 0),
  failure_class         text check (failure_class ~ '^[a-z][a-z0-9_]{0,63}$'),
  retry_not_before      timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null,
  updated_at            timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, id, reconciliation_run_id),
  constraint reconciliation_slices_once unique nulls not distinct (workspace_id, reconciliation_run_id, unit, content_item_id, sequence),
  constraint reconciliation_slices_unit_content check ((unit = 'content_listing') = (content_item_id is null)),
  constraint reconciliation_slices_window check (window_start < window_end),
  constraint reconciliation_slices_pages check (pages_read <= max_pages),
  constraint reconciliation_slices_cursor_pair check ((cursor is null) = (cursor_issued_at is null)),
  constraint reconciliation_slices_cursor_open check (cursor is null or state in ('PENDING', 'RUNNING')),
  constraint reconciliation_slices_lease check ((state = 'RUNNING') = (leased_until is not null) and (state <> 'RUNNING' or attempt >= 1)),
  constraint reconciliation_slices_terminal check ((state in ('PENDING', 'RUNNING')) = (completed_at is null)),
  constraint reconciliation_slices_failure check (
    (state in ('FAILED_TRANSIENT', 'FAILED_RATE_LIMITED', 'FAILED_PERMANENT')) = (failure_class is not null)
    and (state <> 'FAILED_RATE_LIMITED' or retry_not_before is not null)),
  constraint reconciliation_slices_times check (
    (completed_at is null or completed_at >= created_at) and updated_at >= created_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- The slice's account IS its run's, and an interactions slice's content IS that account's.
  foreign key (workspace_id, reconciliation_run_id, connected_account_id)
    references ingestion.reconciliation_runs (workspace_id, id, connected_account_id),
  foreign key (workspace_id, content_item_id, connected_account_id) references content.content_items (workspace_id, id, connected_account_id)
);
-- At most one RUNNING slice per connected account: provider work for one account is serial (H6-C0; never rely on the
-- job vendor's concurrency key for this).
create unique index reconciliation_slices_one_running on ingestion.reconciliation_slices (workspace_id, connected_account_id)
  where state = 'RUNNING';
-- The next PENDING slice of a run (the serial chain).
create index reconciliation_slices_pending on ingestion.reconciliation_slices (workspace_id, reconciliation_run_id, created_at)
  where state = 'PENDING';

-- ── ingestion.reconciliation_watermarks ───────────────────────────────────────────────────────────────────
create table ingestion.reconciliation_watermarks (
  organization_id            uuid not null,
  workspace_id               uuid not null,
  connected_account_id       uuid not null,
  content_item_id            uuid not null,
  capability                 text not null check (capability in ('read_interactions')),
  content_kind               text not null check (content_kind in ('post', 'reel', 'video', 'carousel', 'story', 'ad_creative', 'other')),
  source                     text not null check (source in ('organic', 'paid', 'mixed', 'unknown')),
  -- The start of the first authoritative traversal: nothing before it is claimed (HISTORY_DEPTH_NOT_VALIDATED).
  epoch_at                   timestamptz not null,
  -- How far a traversal that reached the provider's end of pages got; advances only that way and never regresses.
  synced_through             timestamptz,
  latest_created_at          timestamptz,
  last_reconciliation_run_id uuid,
  consecutive_failures       integer not null default 0 check (consecutive_failures >= 0),
  retry_not_before           timestamptz,
  created_at                 timestamptz not null,
  updated_at                 timestamptz not null,
  primary key (workspace_id, connected_account_id, capability, content_item_id),
  constraint reconciliation_watermarks_synced check (synced_through is null or synced_through >= epoch_at),
  constraint reconciliation_watermarks_times check (updated_at >= created_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, content_item_id, connected_account_id) references content.content_items (workspace_id, id, connected_account_id),
  foreign key (workspace_id, last_reconciliation_run_id, connected_account_id)
    references ingestion.reconciliation_runs (workspace_id, id, connected_account_id)
);

-- ── ingestion.authority_conflicts (append-only) ───────────────────────────────────────────────────────────
-- One row per refused class of one sighting. Identifiers and closed classes only: no text, payload, author label,
-- provider id or URL. The interaction is named only when a canonical row exists.
create table ingestion.authority_conflicts (
  id                       uuid not null,
  organization_id          uuid not null,
  workspace_id             uuid not null,
  connected_account_id     uuid not null,
  reconciliation_run_id    uuid,
  reconciliation_slice_id  uuid,
  interaction_id           uuid,
  conflict_class           text not null check (conflict_class in (
                             'KEY_MISMATCH', 'ACCOUNT_CHANGED', 'ASSET_CHANGED', 'CONTENT_CHANGED', 'PARENT_CHANGED', 'KIND_CHANGED',
                             'CONTENT_SCOPE_CONFLICT', 'PLACEHOLDER_SCOPE_CONFLICT', 'PARENT_SCOPE_CONFLICT',
                             'ANCESTRY_CYCLE', 'ANCESTRY_DEPTH_EXCEEDED', 'DESCENDANT_CONVERSATION_CONFLICT')),
  observed_at              timestamptz not null,
  correlation_id           text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at               timestamptz not null,
  primary key (workspace_id, id),
  constraint authority_conflicts_slice_run check (reconciliation_slice_id is null or reconciliation_run_id is not null),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id),
  foreign key (workspace_id, reconciliation_run_id, connected_account_id)
    references ingestion.reconciliation_runs (workspace_id, id, connected_account_id),
  foreign key (workspace_id, reconciliation_slice_id, reconciliation_run_id)
    references ingestion.reconciliation_slices (workspace_id, id, reconciliation_run_id),
  foreign key (workspace_id, interaction_id) references interactions.interactions (workspace_id, id)
);
create index authority_conflicts_by_run on ingestion.authority_conflicts (workspace_id, reconciliation_run_id, reconciliation_slice_id)
  where reconciliation_run_id is not null;

-- ── transition guards ─────────────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER, empty search_path: they read only OLD/NEW.
create function ingestion.reconciliation_run_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if old.state in ('COMPLETED', 'PARTIAL', 'SKIPPED_UNAVAILABLE', 'FAILED') and new.state is distinct from old.state then
    raise exception 'a finished reconciliation run never changes state again' using errcode = '23514';
  end if;
  if new.operations_used < old.operations_used or new.pages_used < old.pages_used or new.content_items_used < old.content_items_used then
    raise exception 'reconciliation run counters never decrease' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function ingestion.reconciliation_run_guard() from public;
create trigger reconciliation_run_guard before update on ingestion.reconciliation_runs
  for each row execute function ingestion.reconciliation_run_guard();

create function ingestion.reconciliation_slice_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if old.state not in ('PENDING', 'RUNNING') and new.state is distinct from old.state then
    raise exception 'a finished reconciliation slice never changes state again' using errcode = '23514';
  end if;
  if new.state = 'RUNNING' and old.state = 'PENDING' and new.attempt <> old.attempt + 1 then
    raise exception 'a slice is claimed only by incrementing its attempt' using errcode = '23514';
  end if;
  if new.attempt < old.attempt or new.pages_read < old.pages_read or new.operations_used < old.operations_used
     or new.conflict_count < old.conflict_count then
    raise exception 'reconciliation slice counters never decrease' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function ingestion.reconciliation_slice_guard() from public;
create trigger reconciliation_slice_guard before update on ingestion.reconciliation_slices
  for each row execute function ingestion.reconciliation_slice_guard();

create function ingestion.reconciliation_watermark_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if new.epoch_at is distinct from old.epoch_at then
    raise exception 'a reconciliation epoch is fixed' using errcode = '23514';
  end if;
  if old.synced_through is not null and (new.synced_through is null or new.synced_through < old.synced_through) then
    raise exception 'synced-through never regresses' using errcode = '23514';
  end if;
  if old.latest_created_at is not null and (new.latest_created_at is null or new.latest_created_at < old.latest_created_at) then
    raise exception 'the latest provider creation time seen never regresses' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function ingestion.reconciliation_watermark_guard() from public;
create trigger reconciliation_watermark_guard before update on ingestion.reconciliation_watermarks
  for each row execute function ingestion.reconciliation_watermark_guard();

alter table ingestion.reconciliation_runs enable row level security;
alter table ingestion.reconciliation_runs force row level security;
alter table ingestion.reconciliation_slices enable row level security;
alter table ingestion.reconciliation_slices force row level security;
alter table ingestion.reconciliation_watermarks enable row level security;
alter table ingestion.reconciliation_watermarks force row level security;
alter table ingestion.authority_conflicts enable row level security;
alter table ingestion.authority_conflicts force row level security;

-- ── closed-vocabulary widenings (drop · re-add NOT VALID · validate; existing rows unchanged) ─────────────
alter table coverage.coverage_records drop constraint coverage_records_reason_check;
alter table coverage.coverage_records add constraint coverage_records_reason_check check (reason in (
  'VALIDATED_SCOPE_READ', 'CAPABILITY_LIMITATION', 'CAPABILITY_NOT_VALIDATED', 'CAPABILITY_UNSUPPORTED',
  'ACCOUNT_PERMISSION_MISSING', 'PROFILE_STALE', 'ACCOUNT_INACTIVE', 'CONNECTION_UNAVAILABLE',
  'PROVIDER_FAILURE', 'HISTORY_DEPTH_NOT_VALIDATED', 'IN_PROGRESS', 'TRAVERSAL_INCOMPLETE')) not valid;
alter table coverage.coverage_records validate constraint coverage_records_reason_check;

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
  'connected_account.reconciliation_requested')) not valid;
alter table audit.audit_events validate constraint audit_events_action_check;

reset role;

-- runs: non-guest members of the BOUND workspace read · the job runtime writes, its bound workspace only
create policy member_read on ingestion.reconciliation_runs for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on ingestion.reconciliation_runs for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on ingestion.reconciliation_runs for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on ingestion.reconciliation_runs for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- slices, watermarks: the job runtime only
create policy worker_read on ingestion.reconciliation_slices for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on ingestion.reconciliation_slices for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on ingestion.reconciliation_slices for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

create policy worker_read on ingestion.reconciliation_watermarks for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on ingestion.reconciliation_watermarks for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on ingestion.reconciliation_watermarks for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- conflicts: the job runtime appends and reads; nobody updates or deletes
create policy worker_read on ingestion.authority_conflicts for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on ingestion.authority_conflicts for insert to app_worker with check (workspace_id = (select app.current_workspace()));

grant select on ingestion.reconciliation_runs to authenticated;
grant select, insert on ingestion.reconciliation_runs to app_worker;
grant update (state, started_at, completed_at, operations_used, pages_used, content_items_used, failure_class, updated_at)
  on ingestion.reconciliation_runs to app_worker;
grant select, insert on ingestion.reconciliation_slices to app_worker;
grant update (state, attempt, leased_until, cursor, cursor_issued_at, pages_read, operations_used, conflict_count, failure_class,
              retry_not_before, completed_at, updated_at)
  on ingestion.reconciliation_slices to app_worker;
grant select, insert on ingestion.reconciliation_watermarks to app_worker;
grant update (synced_through, latest_created_at, last_reconciliation_run_id, consecutive_failures, retry_not_before, updated_at)
  on ingestion.reconciliation_watermarks to app_worker;
grant select, insert on ingestion.authority_conflicts to app_worker;      -- append-only
