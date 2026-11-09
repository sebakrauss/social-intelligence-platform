-- 0027 · Mutation intents (Step 7B-1; TA §26, CLAUDE.md §9). Forward-only and expand-only: ONE new schema with three
-- tables, ONE reviewed SECURITY DEFINER read, two audit vocabulary widenings (the exact drop / add NOT VALID / validate
-- pattern) and the member audit allowlist of 0020 extended by the request's own event. No existing table, column,
-- grant or policy is narrowed; nothing is backfilled, rewritten or deleted.
--
--   mutations.mutation_intents        the ONE durable identity of a platform mutation (kind reply_public only; request
--                                     type human only). PENDING is written by the member who asked (web, action
--                                     pipeline); every later status is written only by the job runtime (the Platform
--                                     Mutation Executor, integration plane). EXECUTING is committed BEFORE the provider
--                                     call (R6); the idempotency key is unique per workspace (domain idempotency is
--                                     authoritative); the target is a canonical interaction of the SAME workspace (R5:
--                                     composite foreign keys; a foreign target fails like a non-existent one).
--   mutations.mutation_intent_history append-only transitions (who moved the intent, from what, to what, when; the
--                                     outcome code and run reference). Nobody updates or deletes.
--   mutations.outbound_replies        the reply text the member wrote and, once confirmed, the provider id of the
--                                     created reply. Written with the intent, by the member; confirmed by the worker.
--                                     The text is tenant content: members of the bound workspace (non-guest) read it;
--                                     guests read nothing anywhere here.
--   mutations.initiator_workspace_role(uuid)
--                                     the executor's live re-check of the initiator (TA §26.4): the user's CURRENT
--                                     role in the BOUND workspace, or NULL — answered only to the bound worker. It
--                                     reads no other workspace and admits no other caller; tenancy policies stay as
--                                     they are (T-26 unchanged).
--   mutations.workspace_mode_for_execution()
--                                     the BOUND workspace's mode under a SHARE lock (bound worker only): a concurrent
--                                     mode change is either already committed and seen, or waits for the executor's
--                                     transaction. Needs one owner UPDATE policy on tenancy.workspaces (FOR SHARE is
--                                     subject to UPDATE policies) whose WITH CHECK is false: the owner can lock, never
--                                     change, a workspace row through it.
--   mutations.intent_mode_guard()     the Monitor-only DATABASE BACKSTOP (TA §26.6 point 4, ADR-16): no new intent for
--                                     a workspace that is not STANDARD; no transition INTO EXECUTING unless the
--                                     workspace is STANDARD at that moment (mode locked FOR SHARE in the same
--                                     transaction). BLOCKED and every other transition stay possible.
--
-- Authority coherence (R5): an intent's account must OWN its target interaction, and its outbound reply must name
-- exactly that target and account — composite keys, not application discipline. One provider reply identity links to
-- at most one intent per workspace and platform (outbound_replies_provider_identity).
--
-- Audit (TA §41): the request's event `mutation_intent.created` (member, pipeline — 0020 branch (a) extended); the
-- executor's events `mutation_intent.executing / .confirmed / .failed / .blocked / .outcome_unknown / .reconciled`
-- (job runtime, actor `system`, 0003 worker policy). Target type `mutation_intent`.
--
-- Not here (later gates): the automation request type, hide/unhide/delete/block kinds, bulk requests, Meta mutation
-- adapters, and any schedule that sweeps intents left EXECUTING (the reconciliation entry point exists in source).

create schema mutations authorization app_owner;

set role app_owner;

-- The key the authority-coherence foreign keys reference: a canonical interaction's own (workspace, id, account) triple.
-- Expand-only on the interactions module's table (no column, policy or grant changes); the triple is already unique
-- because (workspace_id, id) is the primary key.
create unique index interactions_workspace_account_key on interactions.interactions (workspace_id, id, connected_account_id);

-- ── mutations.mutation_intents ───────────────────────────────────────────────────────────────────────────────────
create table mutations.mutation_intents (
  id                          uuid not null,
  organization_id             uuid not null,
  workspace_id                uuid not null,
  kind                        text not null check (kind in ('reply_public')),
  request_type                text not null check (request_type in ('human')),
  target_interaction_id       uuid not null,
  connected_account_id        uuid not null,
  initiator_user_id           uuid not null,
  idempotency_key             text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  status                      text not null check (status in ('PENDING', 'EXECUTING', 'CONFIRMED', 'FAILED', 'BLOCKED', 'OUTCOME_UNKNOWN')),
  attempt                     integer not null check (attempt between 0 and 1000),
  run_reference               text check (run_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  outcome_code                text check (outcome_code ~ '^[A-Z][A-Z_]{1,63}$'),
  capability_catalog_id       text not null check (capability_catalog_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  capability_catalog_revision integer not null check (capability_catalog_revision >= 1),
  correlation_id              text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at                  timestamptz not null,
  updated_at                  timestamptz not null,
  primary key (workspace_id, id),
  constraint mutation_intents_idempotent unique (workspace_id, idempotency_key),
  -- Referenced by outbound_replies: a reply names exactly its intent's target and account.
  constraint mutation_intents_target_account unique (workspace_id, id, target_interaction_id, connected_account_id),
  -- PENDING carries no outcome and no run; every other status was reached by a run (attempt >= 1).
  constraint mutation_intents_pending_shape check (status <> 'PENDING' or (attempt = 0 and run_reference is null and outcome_code is null)),
  constraint mutation_intents_run_recorded check (status = 'PENDING' or (attempt >= 1 and run_reference is not null)),
  constraint mutation_intents_outcome_shape check (
    (status in ('PENDING', 'EXECUTING', 'CONFIRMED') and outcome_code is null)
    or (status in ('FAILED', 'BLOCKED', 'OUTCOME_UNKNOWN') and outcome_code is not null)),
  constraint mutation_intents_workspace foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint mutation_intents_target foreign key (workspace_id, target_interaction_id) references interactions.interactions (workspace_id, id),
  constraint mutation_intents_account foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id),
  -- The intent's account OWNS the target: (workspace, interaction, account) must be the canonical row's own triple.
  constraint mutation_intents_target_owned foreign key (workspace_id, target_interaction_id, connected_account_id)
    references interactions.interactions (workspace_id, id, connected_account_id)
);
create index mutation_intents_by_target on mutations.mutation_intents (workspace_id, target_interaction_id, created_at);
create index mutation_intents_open on mutations.mutation_intents (workspace_id, updated_at) where status in ('PENDING', 'EXECUTING', 'OUTCOME_UNKNOWN');

alter table mutations.mutation_intents enable row level security;
alter table mutations.mutation_intents force row level security;

-- ── mutations.mutation_intent_history (append-only) ──────────────────────────────────────────────────────────────
create table mutations.mutation_intent_history (
  id              uuid not null,
  organization_id uuid not null,
  workspace_id    uuid not null,
  intent_id       uuid not null,
  from_status     text check (from_status in ('PENDING', 'EXECUTING', 'CONFIRMED', 'FAILED', 'BLOCKED', 'OUTCOME_UNKNOWN')),
  to_status       text not null check (to_status in ('PENDING', 'EXECUTING', 'CONFIRMED', 'FAILED', 'BLOCKED', 'OUTCOME_UNKNOWN')),
  attempt         integer not null check (attempt between 0 and 1000),
  actor           text not null check (actor in ('web', 'executor', 'reconciliation')),
  outcome_code    text check (outcome_code ~ '^[A-Z][A-Z_]{1,63}$'),
  run_reference   text check (run_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  correlation_id  text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  occurred_at     timestamptz not null,
  primary key (workspace_id, id),
  -- The first row is the member's PENDING; every executor row names its run.
  constraint mutation_intent_history_origin check ((from_status is null) = (to_status = 'PENDING' and actor = 'web')),
  constraint mutation_intent_history_run check (actor = 'web' or run_reference is not null),
  constraint mutation_intent_history_workspace foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint mutation_intent_history_intent foreign key (workspace_id, intent_id) references mutations.mutation_intents (workspace_id, id) on delete cascade
);
create index mutation_intent_history_by_intent on mutations.mutation_intent_history (workspace_id, intent_id, occurred_at);

alter table mutations.mutation_intent_history enable row level security;
alter table mutations.mutation_intent_history force row level security;

-- ── mutations.outbound_replies ───────────────────────────────────────────────────────────────────────────────────
create table mutations.outbound_replies (
  id                    uuid not null,
  organization_id       uuid not null,
  workspace_id          uuid not null,
  intent_id             uuid not null,
  parent_interaction_id uuid not null,
  connected_account_id  uuid not null,
  platform              text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  text                  text not null check (char_length(text) between 1 and 2200),
  provider_reply_id     text check (provider_reply_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  confirmed_at          timestamptz,
  created_at            timestamptz not null,
  primary key (workspace_id, id),
  constraint outbound_replies_one_per_intent unique (workspace_id, intent_id),
  constraint outbound_replies_workspace foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint outbound_replies_intent foreign key (workspace_id, intent_id) references mutations.mutation_intents (workspace_id, id) on delete cascade,
  constraint outbound_replies_parent foreign key (workspace_id, parent_interaction_id) references interactions.interactions (workspace_id, id),
  constraint outbound_replies_account foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id),
  -- The reply names exactly its intent's target and account.
  constraint outbound_replies_intent_coherent foreign key (workspace_id, intent_id, parent_interaction_id, connected_account_id)
    references mutations.mutation_intents (workspace_id, id, target_interaction_id, connected_account_id) on delete cascade
);
-- One provider reply identity links to at most one intent per workspace and platform: reconciliation can never
-- attribute the same platform reply to two intents.
create unique index outbound_replies_provider_identity on mutations.outbound_replies (workspace_id, platform, provider_reply_id) where provider_reply_id is not null;

alter table mutations.outbound_replies enable row level security;
alter table mutations.outbound_replies force row level security;

-- ── The executor's live initiator re-check (bound worker only) ───────────────────────────────────────────────────
create function mutations.initiator_workspace_role(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from tenancy.workspace_memberships m
   where m.workspace_id = app.current_workspace() and m.user_id = p_user
$$;
revoke all on function mutations.initiator_workspace_role(uuid) from public;
grant execute on function mutations.initiator_workspace_role(uuid) to app_worker;

-- ── The bound workspace's mode, locked FOR SHARE for the rest of the transaction (bound worker only) ──────────────
create function mutations.workspace_mode_for_execution() returns text
language sql volatile security definer set search_path = '' as $$
  select w.mode from tenancy.workspaces w where w.id = app.current_workspace() for share
$$;
revoke all on function mutations.workspace_mode_for_execution() from public;
grant execute on function mutations.workspace_mode_for_execution() to app_worker;

-- ── Monitor-only database backstop (TA §26.6 point 4): the mode decides, in the database, every time ───────────────
-- INSERT: a new intent exists only for a STANDARD workspace (the mode as committed when the request runs).
-- UPDATE into EXECUTING: the workspace must be STANDARD at that moment; the row is locked FOR SHARE so a concurrent
-- mode change serializes with the transition. Any other transition (BLOCKED, FAILED, OUTCOME_UNKNOWN, CONFIRMED) is
-- untouched: intents queued before a switch end as BLOCKED(mode) by the executor's own re-check.
create function mutations.intent_mode_guard() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_mode text;
begin
  if tg_op = 'INSERT' then
    select w.mode into v_mode from tenancy.workspaces w where w.id = new.workspace_id;
    if v_mode is distinct from 'STANDARD' then
      raise exception 'mutation intents exist only for a STANDARD workspace' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status = 'EXECUTING' and old.status is distinct from 'EXECUTING' then
    select w.mode into v_mode from tenancy.workspaces w where w.id = new.workspace_id for share;
    if v_mode is distinct from 'STANDARD' then
      raise exception 'a mutation intent executes only while its workspace is STANDARD' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
revoke all on function mutations.intent_mode_guard() from public;
create trigger intent_mode_guard before insert or update of status on mutations.mutation_intents
  for each row execute function mutations.intent_mode_guard();

-- ── Audit vocabulary: the request and the executor outcomes (widened only; exact pattern, verified by lint) ───────
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
  'mutation_intent.blocked', 'mutation_intent.outcome_unknown', 'mutation_intent.reconciled')) not valid;
alter table audit.audit_events validate constraint audit_events_action_check;

alter table audit.audit_events drop constraint audit_events_target_type_check;
alter table audit.audit_events add constraint audit_events_target_type_check check (target_type in (
  'organization', 'workspace', 'organization_membership', 'workspace_membership', 'invitation',
  'connection', 'connected_account', 'asset_move', 'mutation_intent')) not valid;
alter table audit.audit_events validate constraint audit_events_target_type_check;

-- FOR SHARE is subject to UPDATE policies (PostgreSQL "policies applied by command type"); the two definers above run
-- as the owner under forced RLS, so they need an owner UPDATE policy to LOCK a workspace row. WITH CHECK (false): no
-- owner UPDATE can ever pass through it — it admits locking, never changing. (Same shape as 0002's owner_read.)
create policy owner_share_lock on tenancy.workspaces for update to app_owner using (true) with check (false);

reset role;

-- ── Policies ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- intents: non-guest members of the BOUND workspace read; a member with a replying role (the `reply.public` roles of
-- the permission catalog, not grantable) inserts ONLY a PENDING intent attributed to themselves; the bound worker reads
-- and transitions. Members never update: every later status is the executor's.
create policy member_read on mutations.mutation_intents for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy member_request on mutations.mutation_intents for insert to authenticated
  with check (workspace_id = (select app.current_workspace())
              and status = 'PENDING' and request_type = 'human'
              and initiator_user_id = (select auth.uid())
              and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER')
              -- Monitor-only backstop at the policy too (the trigger is the authority for every role).
              and exists (select 1 from tenancy.workspaces w where w.id = mutation_intents.workspace_id and w.mode = 'STANDARD'));
create policy worker_read on mutations.mutation_intents for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_update on mutations.mutation_intents for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- history: members read; the member appends ONLY the first (PENDING, web) row of an intent THEY requested and that
-- is still PENDING — never a row about another member's intent or an executed one; the worker appends its own rows.
-- Nobody updates or deletes.
create policy member_read on mutations.mutation_intent_history for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy member_append on mutations.mutation_intent_history for insert to authenticated
  with check (workspace_id = (select app.current_workspace())
              and actor = 'web' and from_status is null and to_status = 'PENDING'
              and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER')
              and exists (select 1 from mutations.mutation_intents i
                           where i.workspace_id = mutation_intent_history.workspace_id and i.id = mutation_intent_history.intent_id
                             and i.initiator_user_id = (select auth.uid()) and i.status = 'PENDING'));
create policy worker_read on mutations.mutation_intent_history for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on mutations.mutation_intent_history for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and actor <> 'web');

-- replies: members read (tenant content: never guests); the requesting member inserts the text with THEIR OWN still-
-- PENDING intent (the composite key binds target and account to that intent); the worker reads and confirms (provider
-- reply id, confirmation time) — the text itself is never updated by anyone.
create policy member_read on mutations.outbound_replies for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy member_request on mutations.outbound_replies for insert to authenticated
  with check (workspace_id = (select app.current_workspace())
              and provider_reply_id is null and confirmed_at is null
              and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER')
              and exists (select 1 from mutations.mutation_intents i
                           where i.workspace_id = outbound_replies.workspace_id and i.id = outbound_replies.intent_id
                             and i.initiator_user_id = (select auth.uid()) and i.status = 'PENDING'));
create policy worker_read on mutations.outbound_replies for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_update on mutations.outbound_replies for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- 0020's narrow member allowlist, extended by the request's own pipeline event (branch (a): the sealed workspace, its
-- organization, a live member). The policy is altered by the migration role, as 0003 created it and 0020 altered it.
alter policy append_own on audit.audit_events
  with check (
    actor_type = 'user' and actor_user_id = (select auth.uid()) and organization_id is not null
    and (
      -- (a) workspace-scoped pipeline commands
      (
        workspace_id = (select app.current_workspace())
        and organization_id = (select audit.bound_workspace_organization())
        and action in (
          'workspace.mode_changed',
          'invitation.created', 'invitation.revoked',
          'workspace_membership.role_changed', 'workspace_membership.grants_changed', 'workspace_membership.removed',
          'connection.created', 'connection.credential_replaced', 'connection.status_changed', 'connection.removed',
          'connected_account.linked', 'connected_account.unlinked', 'connected_account.move_requested',
          'connected_account.capability_reevaluation_requested',
          'mutation_intent.created')
        and (
          app.my_workspace_role(workspace_id) is not null
          or (action = 'workspace_membership.removed'
              and target_id = workspace_id::text || ':' || (select auth.uid())::text)
        )
      )
      -- (b) organization-scoped pipeline commands
      or (
        (select app.current_workspace()) is null
        and action in (
          'workspace.created', 'invitation.created', 'invitation.revoked',
          'organization_membership.role_changed', 'organization_membership.removed', 'workspace_membership.removed')
        and (
          (
            app.my_organization_role(organization_id) is not null
            and (workspace_id is null or exists (
              select 1 from tenancy.workspaces w
               where w.id = audit_events.workspace_id and w.organization_id = audit_events.organization_id))
          )
          or (action in ('organization_membership.removed', 'workspace_membership.removed')
              and app.my_organization_role(organization_id) is null
              and target_id = coalesce(workspace_id, organization_id)::text || ':' || (select auth.uid())::text)
        )
      )
      -- (c) user-scoped pipeline commands
      or (
        (select app.current_workspace()) is null
        and action in ('organization.created', 'invitation.accepted')
        and app.my_organization_role(organization_id) is not null
        and (workspace_id is null or (action = 'invitation.accepted' and app.my_workspace_role(workspace_id) is not null))
      )
    )
  );

-- ── Grants (explicit, least privilege) ───────────────────────────────────────────────────────────────────────────
set role app_owner;

grant usage on schema mutations to authenticated, app_worker;

grant select, insert on mutations.mutation_intents to authenticated;
grant select on mutations.mutation_intents to app_worker;
grant update (status, attempt, run_reference, outcome_code, updated_at) on mutations.mutation_intents to app_worker;

grant select, insert on mutations.mutation_intent_history to authenticated;   -- append-only
grant select, insert on mutations.mutation_intent_history to app_worker;      -- append-only

grant select, insert on mutations.outbound_replies to authenticated;
grant select on mutations.outbound_replies to app_worker;
grant update (provider_reply_id, confirmed_at) on mutations.outbound_replies to app_worker;

reset role;
