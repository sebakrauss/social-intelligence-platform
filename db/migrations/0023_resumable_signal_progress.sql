-- 0023 · Resumable reconciliation traversal, bounded confirmation coalescing and system-wide signal-mark expiry (Step
-- H6-F4b; findings H6-F4a; TL decisions D-F4B-1 … D-F4B-6; design design/h6-ingestion/H6-F0-WEBHOOK-SIGNALS.md §27).
-- Persistence only: no runtime code uses these objects until H6-F4d. Expand-compatible: two nullable columns on
-- reconciliation slices, three nullable columns on signal marks, three pinned CHECK changes and one pinned UNIQUE change
-- (each strictly admits every existing row), one FK, two trigger guards, four SECURITY DEFINER boundaries and the
-- owner policies they need. No row is read or rewritten; no grant to a runtime role is widened; no restrictive policy is
-- touched; no outbox read is granted to anyone; nothing here calls a provider or writes canonical state, coverage or a
-- watermark.
--
-- A. Parked reconciliation cursor (D-F4B-1, D-F4B-2). A content_interactions slice that ends ABANDONED_BUDGET may keep
--    the provider cursor of its next unread page: it stays owned by that historical slice (never copied into a payload,
--    an outbox row, a log, a mark or a webhook row). `cursor_parked_at` is DATABASE time, stamped by a trigger at the
--    abandonment (never supplied by the application); a parked cursor is only ever retired (set NULL), never replaced.
--    At most one parked cursor per (workspace, account, content): the continuation authority is unique, and its window
--    is the parked slice's own (window_start, window_end) — a continuation never adopts a later run's start, so signals
--    after the original traversal began are never satisfied by finishing it. One mechanism for every plan (account and
--    relist): no signal-specific cursor. PARKED_CURSOR_LOCAL_TTL = 90 minutes from cursor_parked_at is Wrenkind's local
--    maximum willingness to attempt reuse — NOT a provider guarantee (Meta's cursor lifetime stays VALIDATE, H6-G); it
--    is enforced by the planner (no wall-clock CHECK); on invalid_cursor the cursor is retired and the existing single
--    safe restart applies, with no coverage or watermark claim.
-- B. Confirmation marks (D-F4B-3 … D-F4B-5). A third mark kind, `confirm`, names one canonical interaction (UUID) and its
--    canonical content: the composite FK to interactions.interactions (workspace_id, id, content_item_id) plus the
--    existing content FK (workspace_id, content_item_id, connected_account_id) prove workspace, account, content and
--    interaction together; no provider id. One pending confirm mark per (workspace, account, interaction).
--      read_started_at       DB time at which the latest direct reread began (monotonic; definer-only).
--      confirmed_through_at  the read_started_at of the latest SUCCESSFULLY completed authoritative reread (monotonic;
--                            definer-only; never advanced by a failed or ambiguous read — the caller decides success,
--                            the database encodes no provider semantics). confirmed_through_at ≤ read_started_at.
--    dispatch_generation is reused as the claim counter (it is already the mark's dispatch identity); it stays
--    worker-immutable — only the claim definer and the 0022 due-mark dispatcher move it.
--    Cooldown CONFIRMATION_COOLDOWN = 5 minutes, fixed in the claim definer: a claim sets deferred_until = now + 5 min;
--    while it cools down a review returns cooling_down; afterwards a caught-up mark (last_signal_at ≤
--    confirmed_through_at) is reported for deletion without a provider call, otherwise exactly one next generation is
--    claimed (the trailing read). Concurrent claims serialize on the row lock: one winner per generation.
-- C. System-wide expiry (D-F4B-6). system.expire_signal_marks: the system login, no workspace, DB clock, a bounded batch
--    (1..5000, skip locked) of marks whose expires_at has passed — whatever the account's status — deleted with counts
--    only. Its owner DELETE policy admits nothing else; app_system gets no table grant.
--
-- Clock authority (frozen here): DB time for persisted operational scheduling — cursor_parked_at, read_started_at,
-- confirmed_through_at, the claim cooldown, the expiry cutoff (and, from H6-F4d, the anchoring of expires_at and
-- deferred_until); provider time is metadata only; the reconciliation run clock (requested_at, started_at) keeps
-- governing the hourly signal-run cap and the relist/account mark satisfaction boundary. A confirm mark's
-- last_signal_at is compared with DB-time read starts, so H6-F4d writes it from DB time.

set role app_owner;

-- ── A. parked reconciliation cursor ──────────────────────────────────────────────────────────────────────────
alter table ingestion.reconciliation_slices add column cursor_parked_at timestamptz;

-- Pinned rewrite: a cursor may also stay on ABANDONED_BUDGET (parked); every other terminal state still holds none.
alter table ingestion.reconciliation_slices drop constraint reconciliation_slices_cursor_open;
alter table ingestion.reconciliation_slices add constraint reconciliation_slices_cursor_open check (cursor is null or state in ('PENDING', 'RUNNING', 'ABANDONED_BUDGET')) not valid;
alter table ingestion.reconciliation_slices validate constraint reconciliation_slices_cursor_open;

-- A parked cursor is exactly an ABANDONED_BUDGET interactions slice that kept its cursor, with its DB parking time.
alter table ingestion.reconciliation_slices add constraint reconciliation_slices_parked check (
  ((cursor_parked_at is not null) = (state = 'ABANDONED_BUDGET' and cursor is not null))
  and (cursor_parked_at is null or unit = 'content_interactions'));

-- One continuation authority per (workspace, account, content); also the planner's bounded lookup.
create unique index reconciliation_slices_one_parked on ingestion.reconciliation_slices (workspace_id, connected_account_id, content_item_id)
  where state = 'ABANDONED_BUDGET' and cursor is not null;

-- SECURITY INVOKER, empty search_path: it reads only OLD/NEW and the statement clock.
create function ingestion.reconciliation_slice_park_cursor() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if new.state = 'ABANDONED_BUDGET' and new.cursor is not null then
    if tg_op = 'UPDATE' and old.state = 'ABANDONED_BUDGET' then
      -- Already terminal: the parked cursor may only be retired, never replaced or parked afresh.
      if new.cursor is distinct from old.cursor or new.cursor_issued_at is distinct from old.cursor_issued_at then
        raise exception 'a parked cursor is only ever retired, never replaced' using errcode = '23514';
      end if;
      new.cursor_parked_at := old.cursor_parked_at;
    else
      new.cursor_parked_at := pg_catalog.statement_timestamp();
    end if;
  else
    new.cursor_parked_at := null;
  end if;
  return new;
end;
$$;
revoke all on function ingestion.reconciliation_slice_park_cursor() from public;
create trigger reconciliation_slice_park_cursor before insert or update on ingestion.reconciliation_slices
  for each row execute function ingestion.reconciliation_slice_park_cursor();

-- ── B. confirmation marks ────────────────────────────────────────────────────────────────────────────────────
alter table ingestion.signal_marks add column interaction_id uuid;
alter table ingestion.signal_marks add column read_started_at timestamptz;
alter table ingestion.signal_marks add column confirmed_through_at timestamptz;

-- Vocabulary widening: relist, account — and confirm.
alter table ingestion.signal_marks drop constraint signal_marks_kind_check;
alter table ingestion.signal_marks add constraint signal_marks_kind_check check (kind in ('relist', 'account', 'confirm')) not valid;
alter table ingestion.signal_marks validate constraint signal_marks_kind_check;

-- Pinned rewrite: the closed target shape of each kind (account: none; relist: content; confirm: content + interaction).
alter table ingestion.signal_marks drop constraint signal_marks_target;
alter table ingestion.signal_marks add constraint signal_marks_target check (((kind = 'account' and content_item_id is null and interaction_id is null) or (kind = 'relist' and content_item_id is not null and interaction_id is null) or (kind = 'confirm' and content_item_id is not null and interaction_id is not null))) not valid;
alter table ingestion.signal_marks validate constraint signal_marks_target;

-- Pinned rewrite: one pending mark per (workspace, account, kind, content, interaction). Account and relist marks keep
-- exactly their 0022 uniqueness (interaction_id is NULL for them, and NULLs are not distinct).
alter table ingestion.signal_marks drop constraint signal_marks_one_pending;
alter table ingestion.signal_marks add constraint signal_marks_one_pending unique nulls not distinct (workspace_id, connected_account_id, kind, content_item_id, interaction_id);

-- Confirmation times belong to confirm marks only; the latest successful read never postdates the latest read start.
alter table ingestion.signal_marks add constraint signal_marks_confirmation check (
  (kind = 'confirm' or (read_started_at is null and confirmed_through_at is null))
  and (confirmed_through_at is null or (read_started_at is not null and confirmed_through_at <= read_started_at)));

-- A confirm mark's interaction IS its content's (and therefore its account's): no cross-account or fabricated target.
alter table ingestion.signal_marks add constraint signal_marks_confirm_interaction
  foreign key (workspace_id, interaction_id, content_item_id) references interactions.interactions (workspace_id, id, content_item_id);

-- The worker inserts marks (table-level INSERT, 0022), so a new mark must start unclaimed and unconfirmed; afterwards
-- the claim counter and the confirmation times only move forward (definers and the 0022 dispatcher).
create function ingestion.signal_mark_confirmation_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.dispatch_generation <> 0 or new.read_started_at is not null or new.confirmed_through_at is not null then
      raise exception 'a signal mark starts unclaimed and unconfirmed' using errcode = '23514';
    end if;
  elsif new.dispatch_generation < old.dispatch_generation
     or (old.read_started_at is not null and (new.read_started_at is null or new.read_started_at < old.read_started_at))
     or (old.confirmed_through_at is not null and (new.confirmed_through_at is null or new.confirmed_through_at < old.confirmed_through_at)) then
    raise exception 'signal mark claims and confirmations never regress' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function ingestion.signal_mark_confirmation_guard() from public;
create trigger signal_mark_confirmation_guard before insert or update on ingestion.signal_marks
  for each row execute function ingestion.signal_mark_confirmation_guard();

-- The three worker definers below read and update the bound workspace's confirm marks only (forced RLS binds the owner).
create policy owner_confirm_read on ingestion.signal_marks for select to app_owner
  using (kind = 'confirm' and workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER'));
create policy owner_confirm_update on ingestion.signal_marks for update to app_owner
  using (kind = 'confirm' and workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER'))
  with check (kind = 'confirm' and workspace_id = (select app.current_workspace()) and pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER'));

-- ── ingestion.claim_signal_confirmation (worker, bound workspace) ────────────────────────────────────────────
-- Decides, under the mark's row lock, whether ONE direct confirmation may be requested now. Outcomes:
--   not_found     no pending confirm mark for (account, interaction) in the bound workspace
--   expired       the mark is past its expiry (the caller drops it; the system expiry would too)
--   cooling_down  a claim in the last 5 minutes: nothing to request (due_at = the cooldown's end)
--   caught_up     the latest successful read began after the latest signal: no provider call (the caller deletes it)
--   claimed       the next generation is claimed and the 5-minute cooldown starts (the caller requests one read)
create function ingestion.claim_signal_confirmation(
  p_connected_account_id uuid, p_interaction_id uuid,
  out outcome text, out signal_mark_id uuid, out claimed_generation integer, out due_at timestamptz
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
  v_at        timestamptz := pg_catalog.statement_timestamp();
  v_mark      ingestion.signal_marks%rowtype;
begin
  outcome := null;
  signal_mark_id := null;
  claimed_generation := null;
  due_at := null;
  if v_workspace is null or not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'signal confirmation claim: not permitted' using errcode = '42501';
  end if;
  if p_connected_account_id is null or p_interaction_id is null then
    raise exception 'signal confirmation claim: invalid target' using errcode = '22023';
  end if;
  select m.* into v_mark from ingestion.signal_marks m
   where m.workspace_id = v_workspace and m.connected_account_id = p_connected_account_id
     and m.kind = 'confirm' and m.interaction_id = p_interaction_id
     for update;
  if v_mark.id is null then
    outcome := 'not_found';
    return;
  end if;
  signal_mark_id := v_mark.id;
  if v_mark.expires_at <= v_at then
    outcome := 'expired';
    return;
  end if;
  if v_mark.deferred_until is not null and v_mark.deferred_until > v_at then
    outcome := 'cooling_down';
    due_at := v_mark.deferred_until;
    return;
  end if;
  if v_mark.confirmed_through_at is not null and v_mark.last_signal_at <= v_mark.confirmed_through_at then
    outcome := 'caught_up';
    return;
  end if;
  update ingestion.signal_marks
     set dispatch_generation = v_mark.dispatch_generation + 1, deferred_until = v_at + interval '5 minutes',
         updated_at = greatest(v_mark.updated_at, v_at)
   where workspace_id = v_workspace and id = v_mark.id;
  outcome := 'claimed';
  claimed_generation := v_mark.dispatch_generation + 1;
  due_at := v_at + interval '5 minutes';
end $$;

-- ── ingestion.begin_signal_confirmation_read (worker, bound workspace) ──────────────────────────────────────
-- Stamps the DB time at which a direct reread of the interaction begins (in the confirmation's prepare transaction,
-- committed before the provider is reached). started | not_found (no pending confirm mark: nothing to record).
create function ingestion.begin_signal_confirmation_read(
  p_connected_account_id uuid, p_interaction_id uuid, out outcome text, out started_at timestamptz
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
  v_at        timestamptz := pg_catalog.statement_timestamp();
  v_mark      ingestion.signal_marks%rowtype;
begin
  outcome := null;
  started_at := null;
  if v_workspace is null or not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'signal confirmation read: not permitted' using errcode = '42501';
  end if;
  if p_connected_account_id is null or p_interaction_id is null then
    raise exception 'signal confirmation read: invalid target' using errcode = '22023';
  end if;
  select m.* into v_mark from ingestion.signal_marks m
   where m.workspace_id = v_workspace and m.connected_account_id = p_connected_account_id
     and m.kind = 'confirm' and m.interaction_id = p_interaction_id
     for update;
  if v_mark.id is null then
    outcome := 'not_found';
    return;
  end if;
  started_at := greatest(coalesce(v_mark.read_started_at, v_at), v_at);
  update ingestion.signal_marks set read_started_at = started_at, updated_at = greatest(v_mark.updated_at, v_at)
   where workspace_id = v_workspace and id = v_mark.id;
  outcome := 'started';
end $$;

-- ── ingestion.complete_signal_confirmation_read (worker, bound workspace) ───────────────────────────────────
-- Called ONLY after an authoritative reread succeeded (the caller decides; no provider semantics live here): the
-- confirmation covers every signal up to the read's start. The read start must be one this mark recorded (never later
-- than its latest read start); an earlier one is only ever more conservative. confirmed | not_found | invalid.
create function ingestion.complete_signal_confirmation_read(
  p_connected_account_id uuid, p_interaction_id uuid, p_read_started_at timestamptz,
  out outcome text, out confirmed_through timestamptz
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
  v_at        timestamptz := pg_catalog.statement_timestamp();
  v_mark      ingestion.signal_marks%rowtype;
begin
  outcome := null;
  confirmed_through := null;
  if v_workspace is null or not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'signal confirmation completion: not permitted' using errcode = '42501';
  end if;
  if p_connected_account_id is null or p_interaction_id is null then
    raise exception 'signal confirmation completion: invalid target' using errcode = '22023';
  end if;
  select m.* into v_mark from ingestion.signal_marks m
   where m.workspace_id = v_workspace and m.connected_account_id = p_connected_account_id
     and m.kind = 'confirm' and m.interaction_id = p_interaction_id
     for update;
  if v_mark.id is null then
    outcome := 'not_found';
    return;
  end if;
  if p_read_started_at is null or v_mark.read_started_at is null or p_read_started_at > v_mark.read_started_at then
    outcome := 'invalid';
    return;
  end if;
  confirmed_through := greatest(coalesce(v_mark.confirmed_through_at, p_read_started_at), p_read_started_at);
  update ingestion.signal_marks set confirmed_through_at = confirmed_through, updated_at = greatest(v_mark.updated_at, v_at)
   where workspace_id = v_workspace and id = v_mark.id;
  outcome := 'confirmed';
end $$;

-- ── C. system-wide expiry ────────────────────────────────────────────────────────────────────────────────────
-- The only cross-workspace DELETE of marks: the system login, no bound workspace, an already expired row.
create policy owner_expiry_delete on ingestion.signal_marks for delete to app_owner
  using ((select app.current_workspace()) is null and pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER')
         and expires_at <= pg_catalog.statement_timestamp());

-- The bounded range scan `expires_at <= DB now` (no clock in the index predicate).
create index signal_marks_by_expiry on ingestion.signal_marks (expires_at, workspace_id, id);

create function system.expire_signal_marks(
  p_limit integer, out expired integer, out account_marks integer, out relist_marks integer, out confirm_marks integer
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_at timestamptz := pg_catalog.statement_timestamp();
begin
  expired := 0;
  account_marks := 0;
  relist_marks := 0;
  confirm_marks := 0;
  if not pg_catalog.pg_has_role(session_user, 'app_system', 'MEMBER') or app.current_workspace() is not null then
    raise exception 'signal mark expiry: not permitted' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'signal mark expiry: invalid limit' using errcode = '22023';
  end if;
  with doomed as (
    select m.workspace_id, m.id from ingestion.signal_marks m
     where m.expires_at <= v_at
     order by m.expires_at, m.workspace_id, m.id
     limit p_limit
       for update skip locked
  ), gone as (
    delete from ingestion.signal_marks m using doomed d
     where m.workspace_id = d.workspace_id and m.id = d.id
    returning m.kind
  )
  select pg_catalog.count(*)::integer,
         (pg_catalog.count(*) filter (where g.kind = 'account'))::integer,
         (pg_catalog.count(*) filter (where g.kind = 'relist'))::integer,
         (pg_catalog.count(*) filter (where g.kind = 'confirm'))::integer
    into expired, account_marks, relist_marks, confirm_marks
    from gone g;
end $$;

-- ── grants ───────────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function ingestion.claim_signal_confirmation(uuid, uuid) from public;
revoke all on function ingestion.begin_signal_confirmation_read(uuid, uuid) from public;
revoke all on function ingestion.complete_signal_confirmation_read(uuid, uuid, timestamptz) from public;
revoke all on function system.expire_signal_marks(integer) from public;
grant execute on function ingestion.claim_signal_confirmation(uuid, uuid) to app_worker;
grant execute on function ingestion.begin_signal_confirmation_read(uuid, uuid) to app_worker;
grant execute on function ingestion.complete_signal_confirmation_read(uuid, uuid, timestamptz) to app_worker;
grant execute on function system.expire_signal_marks(integer) to app_system;

reset role;
