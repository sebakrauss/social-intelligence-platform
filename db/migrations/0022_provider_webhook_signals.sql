-- 0022 · Provider webhook signals: the durable receipt queue, routing hints, tenant signal marks and relist plans (Step
-- H6-F2; design design/h6-ingestion/H6-F0-WEBHOOK-SIGNALS.md, TL decisions D-F1 … D-F5; TA §14.1, §40). Expand-only:
-- three new tables, one new column with a closed CHECK, five SECURITY DEFINER boundaries, one same-signature replacement
-- of 0019's request boundary (TL decision H6-F2: its WORKER branch accepts an optional `plan`), and the policies they
-- need. No row is read or rewritten; no existing grant, policy or function is narrowed; nothing here calls a provider.
--
-- Authority (frozen): a webhook is a SIGNAL. Nothing in this migration writes interaction text, author data,
-- availability or visibility, a removal basis, coverage, a watermark or a conversation. Hints carry provider identifiers
-- and closed enums only; marks are tenant-local coalescing state, never a claim of provider truth.
--
--   system.provider_event_inbox   one row per VERIFIED delivery (D-F1: the durable queue of this system-scoped workflow).
--                                 Delivery dedupe = unique body_sha256 (SHA-256 of the exact bytes). The raw body is
--                                 byte-exact, ≤ 1 MiB, and present only when the receiver said the whole delivery is
--                                 retainable (D-F4); never indexed, never returned, never copied. Retention: 7 days
--                                 from received_at (DB time), purged by system.purge_provider_events.
--   system.provider_event_hints   the identifier-only hints of one receipt (H6-F1 WebhookEventHint, minus delivery-level
--                                 facts). Hint dedupe = unique hint_key (H6-F1 metaHintKey v1). Routing state lives here.
--   ingestion.signal_marks        TENANT coalescing marks (design §13): one row per (account, kind, content-or-null);
--                                 a row exists only while pending — satisfied marks are deleted. A relist mark names a
--                                 canonical content item of the SAME account (composite FK); an account mark names none.
--   ingestion.reconciliation_runs.plan   'account' (every existing and every manual run) | 'relist' (signal runs, F4).
--                                 The budget stays the persisted max_operations (1..40); the default stays 40.
--
-- Definers (owner app_owner, empty search_path, no dynamic SQL, fixed reason codes; system-run ones live in the `system`
-- schema, the only schema app_system holds USAGE on, so no schema grant is widened):
--   system.record_provider_webhook      web login only, NO claims, NO bound workspace (the future provider-signal scope):
--                                       dedupe + receipt + hints, atomically; returns outcome, receipt id and counts.
--   system.route_provider_hint          system login only, no workspace: maps one hint to the ACTIVE content-bearing
--                                       accounts of its (platform, asset). 0 → retry (1, 5, 15 min) then UNMAPPED;
--                                       1..5 → an IDs-only `ingestion.process_signals` row for EVERY match; > 5 →
--                                       MULTI_ORG_LIMIT, zero rows (D-F2: all or none, never ordering-chosen).
--   system.dispatch_due_signal_marks    system login only: re-dispatches marks whose deferral elapsed (D-F5 cap) with an
--                                       account-only `ingestion.process_signals` row; returns a count.
--   ingestion.provider_event_hint       worker login with a bound workspace: the hint's identifiers only if it was routed
--                                       AND its (platform, asset) is the bound workspace's ACTIVE account; else a code.
--   system.purge_provider_events        system login only: deletes receipts (and, by cascade, hints) older than 7 days in
--                                       a bounded batch; returns counts.
-- Owner policies that let the system definers see across workspaces are gated on the CALLER: the session's login must
-- be a member of app_system and no workspace may be bound — no web or worker transaction can ever satisfy them.
--
-- Outbox: `ingestion.process_signals` is an internal topic produced only by the two system definers. A new RESTRICTIVE
-- policy removes it from the members' and the workers' direct append (0021 stays forward-only and untouched; the union
-- of the restrictive policies is the inventory). System tasks (route/purge) are never outbox topics.

set role app_owner;

-- ── system.provider_event_inbox ──────────────────────────────────────────────────────────────────────────────
create table system.provider_event_inbox (
  id                       uuid not null primary key,
  provider                 text not null check (provider in ('meta')),
  object                   text not null check (object in ('page', 'instagram')),
  body_sha256              text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- Byte-exact verified body (D-F4); null when any change of the delivery was outside the allowlist.
  body                     bytea,
  body_bytes               integer not null check (body_bytes between 0 and 1048576),
  raw_body_retainable      boolean not null,
  entry_count              integer not null check (entry_count between 0 and 65536),
  change_count             integer not null check (change_count between 0 and 1000),
  hint_count               integer not null check (hint_count between 0 and 1000),
  ignored_count            integer not null check (ignored_count between 0 and 1000),
  unsupported_count        integer not null check (unsupported_count between 0 and 1000),
  in_delivery_duplicates   integer not null check (in_delivery_duplicates between 0 and 1000),
  new_hint_count           integer not null default 0 check (new_hint_count between 0 and 1000),
  known_hint_count         integer not null default 0 check (known_hint_count between 0 and 1000),
  state                    text not null check (state in ('RECEIVED', 'ROUTED', 'NO_HINTS')),
  received_at              timestamptz not null,
  routed_at                timestamptz,
  constraint provider_event_inbox_delivery unique (body_sha256),
  constraint provider_event_inbox_body check (body is null or (octet_length(body) = body_bytes and octet_length(body) <= 1048576)),
  constraint provider_event_inbox_retainable check (raw_body_retainable or body is null),
  constraint provider_event_inbox_hint_counts check (new_hint_count + known_hint_count <= hint_count),
  constraint provider_event_inbox_routed check ((state = 'ROUTED') = (routed_at is not null))
);
create index provider_event_inbox_by_age on system.provider_event_inbox (received_at, id);

-- ── system.provider_event_hints ──────────────────────────────────────────────────────────────────────────────
create table system.provider_event_hints (
  id                   uuid not null primary key,
  inbox_id             uuid not null references system.provider_event_inbox (id) on delete cascade,
  ordinal              integer not null check (ordinal between 1 and 1000),
  provider             text not null check (provider in ('meta')),
  platform             text not null check (platform in ('facebook', 'instagram')),
  provider_asset_id    text not null check (provider_asset_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  target_kind          text not null check (target_kind in ('content', 'interaction')),
  provider_target_id   text not null check (provider_target_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  provider_content_id  text check (provider_content_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  provider_parent_id   text check (provider_parent_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  change               text not null check (change in ('created', 'edited', 'removed', 'hidden', 'unhidden', 'updated')),
  occurred_at          timestamptz,
  hint_key             text not null check (hint_key ~ '^[0-9a-f]{64}$'),
  state                text not null check (state in ('PENDING', 'RETRYABLE', 'ROUTED', 'UNMAPPED', 'MULTI_ORG_LIMIT')),
  route_attempts       integer not null default 0 check (route_attempts between 0 and 4),
  next_route_at        timestamptz,
  routed_count         integer check (routed_count between 1 and 5),
  decided_at           timestamptz,
  received_at          timestamptz not null,
  constraint provider_event_hints_key unique (hint_key),
  constraint provider_event_hints_ordinal unique (inbox_id, ordinal),
  -- A content target names no content and no parent; only an interaction may name either.
  constraint provider_event_hints_target_shape check (target_kind = 'interaction' or (provider_content_id is null and provider_parent_id is null)),
  constraint provider_event_hints_routed check ((state = 'ROUTED') = (routed_count is not null)),
  constraint provider_event_hints_decided check ((state in ('ROUTED', 'UNMAPPED', 'MULTI_ORG_LIMIT')) = (decided_at is not null)),
  constraint provider_event_hints_retry check (state = 'RETRYABLE' or next_route_at is null)
);
create index provider_event_hints_due on system.provider_event_hints (next_route_at nulls first, received_at)
  where state in ('PENDING', 'RETRYABLE');
create index provider_event_hints_by_inbox on system.provider_event_hints (inbox_id);

-- ── ingestion.signal_marks (tenant) ──────────────────────────────────────────────────────────────────────────
create table ingestion.signal_marks (
  id                    uuid not null,
  organization_id       uuid not null,
  workspace_id          uuid not null,
  connected_account_id  uuid not null,
  kind                  text not null check (kind in ('relist', 'account')),
  content_item_id       uuid,
  first_signal_at       timestamptz not null,
  last_signal_at        timestamptz not null,
  signal_count          integer not null check (signal_count between 1 and 1000000),
  -- D-F5: set while the hourly signal-run cap defers the mark; system.dispatch_due_signal_marks clears it.
  deferred_until        timestamptz,
  dispatch_generation   integer not null default 0 check (dispatch_generation >= 0),
  requested_run_id      uuid,
  expires_at            timestamptz not null,
  created_at            timestamptz not null,
  updated_at            timestamptz not null,
  primary key (workspace_id, id),
  constraint signal_marks_one_pending unique nulls not distinct (workspace_id, connected_account_id, kind, content_item_id),
  constraint signal_marks_target check ((kind = 'relist') = (content_item_id is not null)),
  constraint signal_marks_times check (last_signal_at >= first_signal_at and expires_at > first_signal_at and updated_at >= created_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id),
  -- A relist mark's content belongs to the SAME workspace and account (no fabricated ownership).
  foreign key (workspace_id, content_item_id, connected_account_id) references content.content_items (workspace_id, id, connected_account_id),
  foreign key (workspace_id, requested_run_id, connected_account_id) references ingestion.reconciliation_runs (workspace_id, id, connected_account_id)
);
create index signal_marks_deferred on ingestion.signal_marks (deferred_until) where deferred_until is not null;
create index signal_marks_expiry on ingestion.signal_marks (workspace_id, expires_at);

-- ── reconciliation_runs.plan ─────────────────────────────────────────────────────────────────────────────────
-- Every existing run (and every request that names no plan) is an account run; the budget model is unchanged.
alter table ingestion.reconciliation_runs add column plan text not null default 'account';
alter table ingestion.reconciliation_runs add constraint reconciliation_runs_plan check (plan in ('account', 'relist'));

alter table system.provider_event_inbox enable row level security;
alter table system.provider_event_inbox force row level security;
alter table system.provider_event_hints enable row level security;
alter table system.provider_event_hints force row level security;
alter table ingestion.signal_marks enable row level security;
alter table ingestion.signal_marks force row level security;

-- ── policies ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Inbox and hints: the definers only (forced RLS binds the owner too; no runtime role can SET ROLE app_owner).
create policy owner_receipt_insert on system.provider_event_inbox for insert to app_owner
  with check ((select app.current_workspace()) is null and (select app_private.claimed_user()) is null
              and pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER'));
create policy owner_receipt_read on system.provider_event_inbox for select to app_owner using (true);
create policy owner_receipt_update on system.provider_event_inbox for update to app_owner using (true) with check (true);
create policy owner_receipt_purge on system.provider_event_inbox for delete to app_owner
  using (pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER'));

create policy owner_hint_insert on system.provider_event_hints for insert to app_owner
  with check ((select app.current_workspace()) is null and (select app_private.claimed_user()) is null
              and pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER'));
create policy owner_hint_read on system.provider_event_hints for select to app_owner using (true);
create policy owner_hint_update on system.provider_event_hints for update to app_owner
  using (pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER')) with check (true);
create policy owner_hint_purge on system.provider_event_hints for delete to app_owner
  using (pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER'));
-- The system router lists due hints itself (identifiers only; the inbox, which holds the body, stays definer-only).
create policy system_read on system.provider_event_hints for select to app_system using (true);

-- Marks: the bound workspace's worker; the due-mark sweep (system login, no workspace) through its definer.
create policy worker_read on ingestion.signal_marks for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on ingestion.signal_marks for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on ingestion.signal_marks for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));
create policy worker_delete on ingestion.signal_marks for delete to app_worker using (workspace_id = (select app.current_workspace()));
create policy owner_due_read on ingestion.signal_marks for select to app_owner
  using ((select app.current_workspace()) is null and pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER'));
create policy owner_due_update on ingestion.signal_marks for update to app_owner
  using ((select app.current_workspace()) is null and pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER'))
  with check ((select app.current_workspace()) is null and pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER'));

-- Routing reads ACTIVE content-bearing accounts across workspaces — only for a system login with no workspace bound.
create policy owner_signal_route_read on connections.connected_accounts for select to app_owner
  using (status = 'ACTIVE' and asset_class = 'content_bearing'
         and (select app.current_workspace()) is null and pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER'));

-- The two system definers' IDs-only `ingestion.process_signals` rows: a routed hint for one ACTIVE matching account,
-- or a due mark of that account. Nothing else, from no other caller.
create policy owner_signal_dispatch on system.outbox for insert to app_owner
  with check (
    topic = 'ingestion.process_signals' and status = 'PENDING' and initiator_type = 'system' and initiator_user_id is null
    and workspace_id is not null and organization_id is not null
    and (select app.current_workspace()) is null and pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER')
    and exists (
      select 1 from connections.connected_accounts a
       where a.id = (outbox.subject_ids ->> 'connected_account_id')::uuid
         and a.workspace_id = outbox.workspace_id and a.organization_id = outbox.organization_id
         and a.status = 'ACTIVE' and a.asset_class = 'content_bearing'
         and ((outbox.subject_ids ? 'provider_event_hint_id'
               and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(outbox.subject_ids)) = 2
               and outbox.dispatch_key = 'ingestion.process_signals:' || (outbox.subject_ids ->> 'provider_event_hint_id') || ':' || a.id::text
               and exists (select 1 from system.provider_event_hints h
                            where h.id = (outbox.subject_ids ->> 'provider_event_hint_id')::uuid
                              and h.platform = a.platform and h.provider_asset_id = a.provider_asset_id))
           or (not (outbox.subject_ids ? 'provider_event_hint_id')
               and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(outbox.subject_ids)) = 1
               and exists (select 1 from ingestion.signal_marks m
                            where m.workspace_id = a.workspace_id and m.connected_account_id = a.id
                              and outbox.dispatch_key = 'ingestion.process_signals:mark:' || m.id::text || ':' || m.dispatch_generation::text)))));

-- G6 for webhook signals: neither members nor workers append the internal processing topic themselves.
create policy no_direct_signal_routing on system.outbox as restrictive for insert to authenticated, app_worker
  with check (topic not in ('ingestion.process_signals'));

-- ── system.record_provider_webhook (web, no claims, no workspace) ────────────────────────────────────────────
create function system.record_provider_webhook(
  p_provider text, p_object text, p_body_sha256 text, p_body bytea, p_body_bytes integer, p_raw_body_retainable boolean,
  p_entry_count integer, p_change_count integer, p_ignored_count integer, p_unsupported_count integer,
  p_in_delivery_duplicates integer, p_hints jsonb,
  out outcome text, out receipt_id uuid, out new_hint_count integer, out known_hint_count integer
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_at       timestamptz := pg_catalog.statement_timestamp();
  v_platform text;
  v_receipt  uuid := pg_catalog.gen_random_uuid();
  v_hint     jsonb;
  v_ordinal  bigint;
  v_rows     integer;
  v_count    integer;
begin
  outcome := null;
  receipt_id := null;
  new_hint_count := 0;
  known_hint_count := 0;
  -- The provider-signal scope: a web login, no verified user claims, no bound workspace.
  if not pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER')
     or app_private.claimed_user() is not null or app.current_workspace() is not null then
    raise exception 'provider webhook receipt: not permitted' using errcode = '42501';
  end if;
  -- Bounded receipt facts only (fixed messages: no input value is ever echoed).
  if p_provider is distinct from 'meta' or p_object is null or p_object not in ('page', 'instagram')
     or p_body_sha256 is null or p_body_sha256 !~ '^[0-9a-f]{64}$'
     or p_body_bytes is null or p_body_bytes < 0 or p_body_bytes > 1048576 or p_raw_body_retainable is null
     or p_entry_count is null or p_entry_count < 0 or p_entry_count > 65536
     or p_change_count is null or p_change_count < 0 or p_change_count > 1000
     or p_ignored_count is null or p_ignored_count < 0 or p_ignored_count > 1000
     or p_unsupported_count is null or p_unsupported_count < 0 or p_unsupported_count > 1000
     or p_in_delivery_duplicates is null or p_in_delivery_duplicates < 0 or p_in_delivery_duplicates > 1000
     or p_hints is null or pg_catalog.jsonb_typeof(p_hints) <> 'array' or pg_catalog.jsonb_array_length(p_hints) > 1000 then
    raise exception 'provider webhook receipt: invalid receipt' using errcode = '22023';
  end if;
  if p_body is not null and (not p_raw_body_retainable or pg_catalog.octet_length(p_body) <> p_body_bytes
                             or pg_catalog.encode(pg_catalog.sha256(p_body), 'hex') <> p_body_sha256) then
    raise exception 'provider webhook receipt: invalid body' using errcode = '22023';
  end if;
  v_platform := case p_object when 'page' then 'facebook' else 'instagram' end;
  v_count := pg_catalog.jsonb_array_length(p_hints);

  begin
    insert into system.provider_event_inbox (id, provider, object, body_sha256, body, body_bytes, raw_body_retainable,
                                             entry_count, change_count, hint_count, ignored_count, unsupported_count,
                                             in_delivery_duplicates, state, received_at)
    values (v_receipt, p_provider, p_object, p_body_sha256, p_body, p_body_bytes, p_raw_body_retainable,
            p_entry_count, p_change_count, v_count, p_ignored_count, p_unsupported_count, p_in_delivery_duplicates,
            'NO_HINTS', v_at)
    on conflict on constraint provider_event_inbox_delivery do nothing;
    get diagnostics v_rows = row_count;
  exception when check_violation or not_null_violation or string_data_right_truncation or invalid_text_representation then
    -- Re-raised without the original detail, which could carry the row (and the body).
    raise exception 'provider webhook receipt: invalid receipt' using errcode = '22023';
  end;
  if v_rows = 0 then
    select i.id into receipt_id from system.provider_event_inbox i where i.body_sha256 = p_body_sha256;
    outcome := 'duplicate';
    return;
  end if;

  for v_hint, v_ordinal in select e.value, e.ordinality from pg_catalog.jsonb_array_elements(p_hints) with ordinality e loop
    if pg_catalog.jsonb_typeof(v_hint) <> 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_hint)) <> 9
       or exists (select 1 from pg_catalog.jsonb_object_keys(v_hint) k
                   where k not in ('platform', 'provider_asset_id', 'target_kind', 'provider_target_id', 'provider_content_id',
                                   'provider_parent_id', 'change', 'occurred_at', 'hint_key'))
       or (v_hint ->> 'platform') is distinct from v_platform
       or coalesce(v_hint ->> 'provider_asset_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
       or coalesce(v_hint ->> 'target_kind', '') not in ('content', 'interaction')
       or coalesce(v_hint ->> 'provider_target_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
       or (pg_catalog.jsonb_typeof(v_hint -> 'provider_content_id') <> 'null' and coalesce(v_hint ->> 'provider_content_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
       or (pg_catalog.jsonb_typeof(v_hint -> 'provider_parent_id') <> 'null' and coalesce(v_hint ->> 'provider_parent_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
       or coalesce(v_hint ->> 'change', '') not in ('created', 'edited', 'removed', 'hidden', 'unhidden', 'updated')
       or (pg_catalog.jsonb_typeof(v_hint -> 'occurred_at') <> 'null' and coalesce(v_hint ->> 'occurred_at', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
       or coalesce(v_hint ->> 'hint_key', '') !~ '^[0-9a-f]{64}$' then
      raise exception 'provider webhook receipt: invalid hint' using errcode = '22023';
    end if;
    begin
      insert into system.provider_event_hints (id, inbox_id, ordinal, provider, platform, provider_asset_id, target_kind,
                                               provider_target_id, provider_content_id, provider_parent_id, change, occurred_at,
                                               hint_key, state, received_at)
      values (pg_catalog.gen_random_uuid(), v_receipt, v_ordinal::integer, p_provider, v_platform, v_hint ->> 'provider_asset_id',
              v_hint ->> 'target_kind', v_hint ->> 'provider_target_id', v_hint ->> 'provider_content_id', v_hint ->> 'provider_parent_id',
              v_hint ->> 'change', (v_hint ->> 'occurred_at')::timestamptz, v_hint ->> 'hint_key', 'PENDING', v_at)
      on conflict on constraint provider_event_hints_key do nothing;
      get diagnostics v_rows = row_count;
    exception when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow then
      raise exception 'provider webhook receipt: invalid hint' using errcode = '22023';
    end;
    if v_rows = 1 then
      new_hint_count := new_hint_count + 1;
    else
      known_hint_count := known_hint_count + 1;
    end if;
  end loop;

  update system.provider_event_inbox
     set new_hint_count = record_provider_webhook.new_hint_count,
         known_hint_count = record_provider_webhook.known_hint_count,
         state = case when record_provider_webhook.new_hint_count > 0 then 'RECEIVED' else 'NO_HINTS' end
   where id = v_receipt;
  outcome := 'recorded';
  receipt_id := v_receipt;
end $$;

-- ── system.route_provider_hint (system login, no workspace) ─────────────────────────────────────────────────
create function system.route_provider_hint(p_hint_id uuid, out outcome text, out routed_count integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_at       timestamptz := pg_catalog.statement_timestamp();
  v_hint     system.provider_event_hints%rowtype;
  v_accounts uuid[];
  v_orgs     uuid[];
  v_spaces   uuid[];
  v_matches  integer;
  v_attempts integer;
begin
  outcome := null;
  routed_count := null;
  if not pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER') or app.current_workspace() is not null then
    raise exception 'provider hint routing: not permitted' using errcode = '42501';
  end if;
  select h.* into v_hint from system.provider_event_hints h where h.id = p_hint_id for update;
  if v_hint.id is null then
    outcome := 'not_found';
    return;
  end if;
  if v_hint.state not in ('PENDING', 'RETRYABLE') then
    outcome := 'not_pending';
    return;
  end if;
  if v_hint.next_route_at is not null and v_hint.next_route_at > v_at then
    outcome := 'not_due';
    return;
  end if;
  v_attempts := v_hint.route_attempts + 1;

  -- One snapshot of every legitimate match: ACTIVE, content-bearing, same platform and provider asset. No ordering, no limit.
  select coalesce(pg_catalog.array_agg(a.id), '{}'), coalesce(pg_catalog.array_agg(a.organization_id), '{}'), coalesce(pg_catalog.array_agg(a.workspace_id), '{}')
    into v_accounts, v_orgs, v_spaces
    from connections.connected_accounts a
   where a.status = 'ACTIVE' and a.asset_class = 'content_bearing'
     and a.platform = v_hint.platform and a.provider_asset_id = v_hint.provider_asset_id;
  v_matches := pg_catalog.cardinality(v_accounts);

  if v_matches = 0 then
    if v_attempts >= 4 then
      update system.provider_event_hints set state = 'UNMAPPED', route_attempts = v_attempts, next_route_at = null, decided_at = v_at where id = v_hint.id;
      outcome := 'unmapped';
    else
      update system.provider_event_hints
         set state = 'RETRYABLE', route_attempts = v_attempts,
             next_route_at = v_at + case v_attempts when 1 then interval '1 minute' when 2 then interval '5 minutes' else interval '15 minutes' end
       where id = v_hint.id;
      outcome := 'retry';
    end if;
  elsif v_matches > 5 then
    -- D-F2: never a partial fan-out; no tenant receives anything; terminal and alertable.
    update system.provider_event_hints set state = 'MULTI_ORG_LIMIT', route_attempts = v_attempts, next_route_at = null, decided_at = v_at where id = v_hint.id;
    outcome := 'multi_org_limit';
  else
    insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type,
                               initiator_user_id, dispatch_key, status, created_at)
    select pg_catalog.gen_random_uuid(), 'ingestion.process_signals', m.organization_id, m.workspace_id,
           pg_catalog.jsonb_build_object('connected_account_id', m.account_id::text, 'provider_event_hint_id', v_hint.id::text),
           'whk.' || v_hint.id::text, 'system', null,
           'ingestion.process_signals:' || v_hint.id::text || ':' || m.account_id::text, 'PENDING', v_at
      from rows from (pg_catalog.unnest(v_accounts), pg_catalog.unnest(v_orgs), pg_catalog.unnest(v_spaces)) as m(account_id, organization_id, workspace_id);
    -- No ON CONFLICT: under RLS it would need a SELECT policy app_owner deliberately lacks on the outbox. The hint row is
    -- locked and leaves PENDING/RETRYABLE in this transaction, so its keys can't be written twice; a collision fails closed.
    update system.provider_event_hints
       set state = 'ROUTED', route_attempts = v_attempts, next_route_at = null, routed_count = v_matches, decided_at = v_at
     where id = v_hint.id;
    outcome := 'routed';
    routed_count := v_matches;
  end if;

  update system.provider_event_inbox i
     set state = 'ROUTED', routed_at = v_at
   where i.id = v_hint.inbox_id and i.state = 'RECEIVED'
     and not exists (select 1 from system.provider_event_hints h where h.inbox_id = i.id and h.state in ('PENDING', 'RETRYABLE'));
end $$;

-- ── system.dispatch_due_signal_marks (system login, no workspace) ────────────────────────────────────────────
create function system.dispatch_due_signal_marks(p_limit integer, out dispatched integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_at   timestamptz := pg_catalog.statement_timestamp();
  v_mark record;
begin
  dispatched := 0;
  if not pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER') or app.current_workspace() is not null then
    raise exception 'signal mark dispatch: not permitted' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'signal mark dispatch: invalid limit' using errcode = '22023';
  end if;
  for v_mark in
    select m.id, m.organization_id, m.workspace_id, m.connected_account_id, m.dispatch_generation
      from ingestion.signal_marks m
     where m.deferred_until is not null and m.deferred_until <= v_at
     order by m.deferred_until, m.id
     limit p_limit
       for update skip locked
  loop
    update ingestion.signal_marks
       set deferred_until = null, dispatch_generation = v_mark.dispatch_generation + 1, updated_at = v_at
     where workspace_id = v_mark.workspace_id and id = v_mark.id;
    if exists (select 1 from connections.connected_accounts a
                where a.workspace_id = v_mark.workspace_id and a.id = v_mark.connected_account_id
                  and a.status = 'ACTIVE' and a.asset_class = 'content_bearing') then
      insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type,
                                 initiator_user_id, dispatch_key, status, created_at)
      values (pg_catalog.gen_random_uuid(), 'ingestion.process_signals', v_mark.organization_id, v_mark.workspace_id,
              pg_catalog.jsonb_build_object('connected_account_id', v_mark.connected_account_id::text),
              'whm.' || v_mark.id::text, 'system', null,
              'ingestion.process_signals:mark:' || v_mark.id::text || ':' || (v_mark.dispatch_generation + 1)::text, 'PENDING', v_at);
      -- The key is unique by construction (the locked mark's generation was just incremented); no ON CONFLICT (see routing).
      dispatched := dispatched + 1;
    end if;
  end loop;
end $$;

-- ── ingestion.provider_event_hint (worker login, bound workspace) ────────────────────────────────────────────
create function ingestion.provider_event_hint(
  p_hint_id uuid, p_connected_account_id uuid,
  out outcome text, out platform text, out target_kind text, out provider_target_id text, out provider_content_id text,
  out provider_parent_id text, out change text, out occurred_at timestamptz, out hint_key text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
  v_platform  text;
  v_asset     text;
begin
  outcome := null;
  if v_workspace is null or not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'provider event hint: not permitted' using errcode = '42501';
  end if;
  -- Re-derived from the BOUND workspace's own ACTIVE account, never from the hint or the caller.
  select a.platform, a.provider_asset_id into v_platform, v_asset
    from connections.connected_accounts a
   where a.workspace_id = v_workspace and a.id = p_connected_account_id
     and a.status = 'ACTIVE' and a.asset_class = 'content_bearing';
  if v_asset is null then
    outcome := 'account_inactive';
    return;
  end if;
  select h.platform, h.target_kind, h.provider_target_id, h.provider_content_id, h.provider_parent_id, h.change, h.occurred_at, h.hint_key
    into platform, target_kind, provider_target_id, provider_content_id, provider_parent_id, change, occurred_at, hint_key
    from system.provider_event_hints h
   where h.id = p_hint_id and h.state = 'ROUTED' and h.platform = v_platform and h.provider_asset_id = v_asset;
  if hint_key is null then
    outcome := 'not_found';
    return;
  end if;
  outcome := 'ok';
end $$;

-- ── system.purge_provider_events (system login, no workspace) ────────────────────────────────────────────────
create function system.purge_provider_events(p_limit integer, out inbox_deleted integer, out hints_deleted integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cutoff timestamptz := pg_catalog.statement_timestamp() - interval '7 days';
  v_ids    uuid[];
begin
  inbox_deleted := 0;
  hints_deleted := 0;
  if not pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER') or app.current_workspace() is not null then
    raise exception 'provider event purge: not permitted' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'provider event purge: invalid limit' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(v.id), '{}') into v_ids
    from (select i.id from system.provider_event_inbox i where i.received_at < v_cutoff
           order by i.received_at, i.id limit p_limit for update skip locked) v;
  select pg_catalog.count(*)::integer into hints_deleted from system.provider_event_hints h where h.inbox_id = any (v_ids);
  delete from system.provider_event_inbox i where i.id = any (v_ids);
  get diagnostics inbox_deleted = row_count;
end $$;

-- ── ingestion.request_reconciliation (0019), same signature: the worker branch may name a plan ───────────────
-- Unchanged in every other respect: the web branch still sends no budget and no time (account plan, 40 operations);
-- the worker's budget JSON gains one optional key, `plan` ∈ account | relist. Still the ONE creation path of a run.
create or replace function ingestion.request_reconciliation(
  p_connected_account_id uuid, p_correlation_id text, p_requested_at timestamptz, p_budget jsonb,
  out outcome text, out reconciliation_run_id uuid, out outbox_id uuid
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace    uuid := app.current_workspace();
  v_web          boolean := pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER');
  v_worker       boolean := pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER');
  v_organization uuid;
  v_user         uuid;
  v_initiator    text;
  v_account      uuid;
  v_at           timestamptz;
  v_listing      integer := 1;
  v_pages        integer := 5;
  v_continuations integer := 2;
  v_items        integer := 10;
  v_overlap      integer := 86400;
  v_max          integer := 40;
  v_plan         text := 'account';
  v_run          uuid := pg_catalog.gen_random_uuid();
  v_outbox       uuid := pg_catalog.gen_random_uuid();
  v_constraint   text;
begin
  outcome := null;
  reconciliation_run_id := null;
  outbox_id := null;
  if v_workspace is null then
    raise exception 'reconciliation request: tenant context required' using errcode = '42501';
  end if;
  if v_web = v_worker then
    raise exception 'reconciliation request: not permitted' using errcode = '42501';
  end if;
  if v_web then
    v_user := app_private.claimed_user();
    if v_user is null or app.my_workspace_role(v_workspace) is null
       or (app.my_workspace_role(v_workspace) is distinct from 'OWNER' and app.my_workspace_role(v_workspace) is distinct from 'ADMIN') then
      raise exception 'reconciliation request: not permitted' using errcode = '42501';
    end if;
    -- A browser chooses neither the budget nor the time (nor, therefore, the plan).
    if p_budget is not null or p_requested_at is not null then
      raise exception 'reconciliation request: budget and time are not caller-controlled' using errcode = '42501';
    end if;
    v_initiator := 'user';
    v_at := pg_catalog.statement_timestamp();
  else
    if p_requested_at is null then
      raise exception 'reconciliation request: request time required' using errcode = '22023';
    end if;
    if p_budget is not null then
      if pg_catalog.jsonb_typeof(p_budget) <> 'object'
         or exists (select 1 from pg_catalog.jsonb_object_keys(p_budget) k
                     where k not in ('listing_pages_per_slice', 'interaction_pages_per_slice', 'continuations_per_content', 'content_items', 'overlap_seconds', 'max_operations', 'plan'))
         or (p_budget ? 'plan' and (pg_catalog.jsonb_typeof(p_budget -> 'plan') <> 'string' or (p_budget ->> 'plan') not in ('account', 'relist'))) then
        raise exception 'reconciliation request: invalid budget' using errcode = '22023';
      end if;
      v_listing := coalesce((p_budget ->> 'listing_pages_per_slice')::integer, v_listing);
      v_pages := coalesce((p_budget ->> 'interaction_pages_per_slice')::integer, v_pages);
      v_continuations := coalesce((p_budget ->> 'continuations_per_content')::integer, v_continuations);
      v_items := coalesce((p_budget ->> 'content_items')::integer, v_items);
      v_overlap := coalesce((p_budget ->> 'overlap_seconds')::integer, v_overlap);
      v_max := coalesce((p_budget ->> 'max_operations')::integer, v_max);
      v_plan := coalesce(p_budget ->> 'plan', v_plan);
    end if;
    v_initiator := 'system';
    v_user := null;
    v_at := p_requested_at;
  end if;

  v_organization := app.current_workspace_organization();
  select a.id into v_account
    from connections.connected_accounts a
   where a.workspace_id = v_workspace and a.id = p_connected_account_id and a.status = 'ACTIVE';
  if v_account is null then
    outcome := 'not_found';
    return;
  end if;

  select r.id into reconciliation_run_id
    from ingestion.reconciliation_runs r
   where r.workspace_id = v_workspace and r.connected_account_id = v_account and r.state in ('REQUESTED', 'RUNNING');
  if reconciliation_run_id is not null then
    outcome := 'already_running';
    return;
  end if;

  begin
    insert into ingestion.reconciliation_runs (
      id, organization_id, workspace_id, connected_account_id, state, initiator_type, initiator_user_id, correlation_id,
      requested_at, budget_listing_pages_per_slice, budget_interaction_pages_per_slice, budget_continuations_per_content,
      budget_interaction_pages_per_content, budget_content_items, budget_overlap_seconds, max_operations,
      operations_used, pages_used, content_items_used, plan, created_at, updated_at)
    values (
      v_run, v_organization, v_workspace, v_account, 'REQUESTED', v_initiator, v_user, p_correlation_id,
      v_at, v_listing, v_pages, v_continuations, v_pages * (1 + v_continuations), v_items, v_overlap, v_max,
      0, 0, 0, v_plan, v_at, v_at);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'reconciliation_runs_one_open' then
      raise;
    end if;
    -- A concurrent request committed first: report its run, write nothing.
    select r.id into reconciliation_run_id
      from ingestion.reconciliation_runs r
     where r.workspace_id = v_workspace and r.connected_account_id = v_account and r.state in ('REQUESTED', 'RUNNING');
    outcome := 'already_running';
    return;
  end;

  insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id,
                                  target_type, target_id, correlation_id, outcome, change)
  values (pg_catalog.gen_random_uuid(), v_at, 'connected_account.reconciliation_requested', v_initiator, v_user, v_organization,
          v_workspace, 'connected_account', v_account::text, p_correlation_id, 'succeeded', null);

  insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type,
                             initiator_user_id, dispatch_key, status, created_at)
  values (v_outbox, 'ingestion.reconcile_account', v_organization, v_workspace,
          pg_catalog.jsonb_build_object('connected_account_id', v_account::text, 'reconciliation_run_id', v_run::text),
          p_correlation_id, v_initiator, v_user, 'ingestion.reconcile_account:' || v_run::text, 'PENDING', v_at);

  outcome := 'requested';
  reconciliation_run_id := v_run;
  outbox_id := v_outbox;
end $$;

-- ── grants ───────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function system.record_provider_webhook(text, text, text, bytea, integer, boolean, integer, integer, integer, integer, integer, jsonb) from public;
revoke all on function system.route_provider_hint(uuid) from public;
revoke all on function system.dispatch_due_signal_marks(integer) from public;
revoke all on function ingestion.provider_event_hint(uuid, uuid) from public;
revoke all on function system.purge_provider_events(integer) from public;
revoke all on function ingestion.request_reconciliation(uuid, text, timestamptz, jsonb) from public;
grant execute on function system.record_provider_webhook(text, text, text, bytea, integer, boolean, integer, integer, integer, integer, integer, jsonb) to authenticated;
grant execute on function system.route_provider_hint(uuid) to app_system;
grant execute on function system.dispatch_due_signal_marks(integer) to app_system;
grant execute on function ingestion.provider_event_hint(uuid, uuid) to app_worker;
grant execute on function system.purge_provider_events(integer) to app_system;
grant execute on function ingestion.request_reconciliation(uuid, text, timestamptz, jsonb) to authenticated, app_worker;

grant select on system.provider_event_hints to app_system;
grant select, insert, delete on ingestion.signal_marks to app_worker;
grant update (last_signal_at, signal_count, deferred_until, requested_run_id, expires_at, updated_at) on ingestion.signal_marks to app_worker;

reset role;
