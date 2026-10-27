-- 0019 · Reconciliation request boundary + persisted provider-operation budget (Step H6-C3b; TL decisions 1–3). Forward-
-- only and expand-only: one column, two CHECKs, one reviewed SECURITY DEFINER function, the owner-only policies it needs
-- (the 0010/0012 precedent) and one RESTRICTIVE policy. No table, no data change beyond the new column's value for any
-- existing run, no runtime grant widened. 0018's runtime policies and grants are unchanged.
--
--   ingestion.reconciliation_runs.max_operations
--       The provider-operation budget that governs the run (TL 2): every provider read attempt reserves one first,
--       retries included, against operations_used. 40 for an ordinary reconciliation (the H6 hard ceiling), 8 for a
--       bounded LIVE acceptance. Immutable: no runtime role may update it (no column grant). An existing run (none on
--       any environment yet) takes 40 — exactly the cap the H6-C3 runtime applied — then the default is dropped, so
--       every new run must name its budget.
--
--   ingestion.request_reconciliation(account, correlation, requested_at, budget)
--       The ONLY web-facing way to start a reconciliation (TL 1). Atomic, in the caller's transaction:
--         - the workspace is the sealed transaction context, never a parameter; the account must be an ACTIVE account
--           of THAT workspace (anything else is `not_found`, never an existence oracle);
--         - a web caller (login member of `authenticated`) must be OWNER or ADMIN of the bound workspace, from the
--           verified claims (app_private.claimed_user) and live membership (app.my_workspace_role) — never a
--           parameter; it may choose neither the budget nor the time (the approved defaults, statement time);
--         - the job runtime (login member of `app_worker`, an internal/operator path) may narrow the budget within
--           the table CHECKs (e.g. the LIVE acceptance's 8 operations) and names the time (its clock);
--         - an open run of the account (REQUESTED / RUNNING) → `already_running` with that run, nothing written; a
--           concurrent duplicate loses on the one-open index and returns the same;
--         - otherwise ONE REQUESTED run (initiator = the user, or the system for the worker path) with its full budget
--           snapshot, ONE audit event `connected_account.reconciliation_requested` attributed to the same initiator,
--           and ONE IDs-only `ingestion.reconcile_account` outbox row (topic fixed here; dispatch key
--           `ingestion.reconcile_account:{run}`) → `requested`.
--       A refused caller raises 42501 and writes nothing.
--
-- The owner policies admit only rows this function writes (bound workspace, its organization, the matching run); no
-- runtime role can SET ROLE app_owner. no_direct_reconciliation_routing removes the reconciliation topics from the web's
-- generic outbox append policy, so a web user can start or re-drive reconciliation only through the function.
--
-- Not here (TL 3): removal detection. Absence from a provider listing is never removal authority; direct removal
-- confirmation is H6-E's stored-provenance re-read.

set role app_owner;

-- ── the persisted provider-operation budget ───────────────────────────────────────────────────────────────
alter table ingestion.reconciliation_runs add column max_operations integer not null default 40;
alter table ingestion.reconciliation_runs alter column max_operations drop default;
alter table ingestion.reconciliation_runs add constraint reconciliation_runs_max_operations check (max_operations between 1 and 40);
alter table ingestion.reconciliation_runs add constraint reconciliation_runs_operations_within_budget check (operations_used <= max_operations);

-- ── owner policies for the definer only (forced RLS binds the owner too) ─────────────────────────────────
create policy owner_request_read on ingestion.reconciliation_runs for select to app_owner
  using (workspace_id = (select app.current_workspace()));
create policy owner_request_insert on ingestion.reconciliation_runs for insert to app_owner
  with check (
    workspace_id = (select app.current_workspace())
    and organization_id = (select app.current_workspace_organization())
    and state = 'REQUESTED' and started_at is null and completed_at is null and operations_used = 0
    and ((initiator_type = 'user' and initiator_user_id = (select app_private.claimed_user()))
      or (initiator_type = 'system' and initiator_user_id is null)));

create policy owner_reconciliation_request on system.outbox for insert to app_owner
  with check (
    status = 'PENDING' and topic = 'ingestion.reconcile_account'
    and workspace_id = (select app.current_workspace())
    and organization_id = (select app.current_workspace_organization())
    and dispatch_key = 'ingestion.reconcile_account:' || (outbox.subject_ids ->> 'reconciliation_run_id')
    and exists (
      select 1 from ingestion.reconciliation_runs r
       where r.workspace_id = (select app.current_workspace())
         and r.id = (outbox.subject_ids ->> 'reconciliation_run_id')::uuid
         and r.connected_account_id = (outbox.subject_ids ->> 'connected_account_id')::uuid
         and r.state = 'REQUESTED'
         and r.initiator_type = outbox.initiator_type
         and r.initiator_user_id is not distinct from outbox.initiator_user_id));

create policy owner_reconciliation_audit on audit.audit_events for insert to app_owner
  with check (
    action = 'connected_account.reconciliation_requested' and target_type = 'connected_account' and outcome = 'succeeded'
    and change is null
    and workspace_id = (select app.current_workspace())
    and organization_id = (select app.current_workspace_organization())
    and exists (
      select 1 from ingestion.reconciliation_runs r
       where r.workspace_id = (select app.current_workspace())
         and r.connected_account_id::text = audit_events.target_id
         and r.state = 'REQUESTED'
         and r.initiator_type = audit_events.actor_type
         and r.initiator_user_id is not distinct from audit_events.actor_user_id));

-- G6 for reconciliation: the web's generic outbox append policy may not carry the reconciliation topics. A web user
-- starts a reconciliation only through ingestion.request_reconciliation; the job runtime keeps its own append path.
create policy no_direct_reconciliation_routing on system.outbox as restrictive for insert to authenticated
  with check (topic not in ('ingestion.reconcile_account', 'ingestion.reconcile_slice', 'interactions.observed'));

-- ── the request boundary ──────────────────────────────────────────────────────────────────────────────────
-- The caller's runtime is its LOGIN role's membership (session_user survives SET ROLE): web logins are members of
-- `authenticated`, worker logins of `app_worker` (the 0007 credential-function convention).
create function ingestion.request_reconciliation(
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
    -- A browser chooses neither the budget nor the time.
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
                     where k not in ('listing_pages_per_slice', 'interaction_pages_per_slice', 'continuations_per_content', 'content_items', 'overlap_seconds', 'max_operations')) then
        raise exception 'reconciliation request: invalid budget' using errcode = '22023';
      end if;
      v_listing := coalesce((p_budget ->> 'listing_pages_per_slice')::integer, v_listing);
      v_pages := coalesce((p_budget ->> 'interaction_pages_per_slice')::integer, v_pages);
      v_continuations := coalesce((p_budget ->> 'continuations_per_content')::integer, v_continuations);
      v_items := coalesce((p_budget ->> 'content_items')::integer, v_items);
      v_overlap := coalesce((p_budget ->> 'overlap_seconds')::integer, v_overlap);
      v_max := coalesce((p_budget ->> 'max_operations')::integer, v_max);
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
      operations_used, pages_used, content_items_used, created_at, updated_at)
    values (
      v_run, v_organization, v_workspace, v_account, 'REQUESTED', v_initiator, v_user, p_correlation_id,
      v_at, v_listing, v_pages, v_continuations, v_pages * (1 + v_continuations), v_items, v_overlap, v_max,
      0, 0, 0, v_at, v_at);
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

revoke all on function ingestion.request_reconciliation(uuid, text, timestamptz, jsonb) from public;
grant execute on function ingestion.request_reconciliation(uuid, text, timestamptz, jsonb) to authenticated, app_worker;

reset role;
