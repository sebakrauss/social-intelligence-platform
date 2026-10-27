-- 0017 · Canonical source model + ingestion coverage (Step H6-B; TA §12 categories A/B, §13, §14.1, §17, §18; Model
-- §10–§13, §45; contracts frozen in H6-A1). Forward-only and expand-only: five module-owned schemas, eight tables, one
-- guard trigger, one added UNIQUE constraint on connections.connected_accounts (an existing key widened by two
-- columns, so the source model can reference an account WITH its platform and asset). No data change, no backfill.
--
--   content.content_items                      canonical provider content (one row per workspace × platform × content id)
--   interactions.authors                       privacy-minimal authors: opaque provider ref, role, provider label only
--   interactions.interactions                  canonical interaction identity + materialized current state, or a
--                                              referenced-but-never-observed PLACEHOLDER (identity and content only)
--   interactions.source_text_versions          APPEND-ONLY exact provider text, one row per (interaction, text hash)
--   interactions.state_observations            APPEND-ONLY visibility × availability history
--   conversations.conversations                the Inbox work item, anchored on its thread's root, created OPEN
--   coverage.coverage_records                  APPEND-ONLY truthful ingestion coverage intervals (never counts)
--   ingestion.ingestion_events                 APPEND-ONLY canonical change events behind the IDs-only
--                                              `interactions.observed` outbox rows
--
-- The provider-event inbox (raw webhook bodies) and sync checkpoints are NOT here: nothing in this gate receives a
-- webhook or schedules a slice. They come with the gates that need them (H6-C / H6-F).
--
-- Written only by ingestion in the job runtime (app_worker, bound to one workspace); readable by non-guest members of
-- the bound workspace; guests read nothing here (TA §49). Every reference is composite with the workspace (R5):
-- a cross-workspace content, parent, author, conversation or text version fails exactly like a missing one.
-- Conversation membership is the interaction's conversation_id (no separate table): a reply's (parent, conversation)
-- must be its parent's (composite FK), so a thread can never span two conversations.

create schema content authorization app_owner;
revoke all on schema content from public;
create schema interactions authorization app_owner;
revoke all on schema interactions from public;
create schema conversations authorization app_owner;
revoke all on schema conversations from public;
create schema coverage authorization app_owner;
revoke all on schema coverage from public;
create schema ingestion authorization app_owner;
revoke all on schema ingestion from public;

set role app_owner;

-- ── an account reference that carries its platform and asset ─────────────────────────────────────────
-- (workspace_id, id) is already the primary key; this widened UNIQUE adds no restriction, it only lets content name
-- the account together with the platform and provider asset it must have.
alter table connections.connected_accounts
  add constraint connected_accounts_source_scope unique (workspace_id, id, platform, provider_asset_id);

-- ── content.content_items ─────────────────────────────────────────────────────────────────────────────
create table content.content_items (
  id                   uuid not null,
  organization_id      uuid not null,
  workspace_id         uuid not null,
  platform             text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  connected_account_id uuid not null,
  provider_asset_id    text not null check (provider_asset_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  provider_content_id  text not null check (provider_content_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  content_kind         text not null check (content_kind in ('post', 'reel', 'video', 'carousel', 'story', 'ad_creative', 'other')),
  reported_source      text not null check (reported_source in ('organic', 'paid', 'mixed', 'unknown')),
  source_state         text not null check (source_state in ('available', 'removed_at_source', 'unknown')),
  first_observed_at    timestamptz not null,
  latest_observed_at   timestamptz not null,
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, platform, provider_content_id),
  unique (workspace_id, id, connected_account_id, platform, provider_asset_id, provider_content_id),
  unique (workspace_id, id, connected_account_id),
  check (latest_observed_at >= first_observed_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id, platform, provider_asset_id)
    references connections.connected_accounts (workspace_id, id, platform, provider_asset_id)
);

-- ── interactions.authors ──────────────────────────────────────────────────────────────────────────────
-- TL decision 2: no contact data, profile URL, demographics, enrichment, or cross-platform / cross-workspace identity.
create table interactions.authors (
  id                 uuid not null,
  organization_id    uuid not null,
  workspace_id       uuid not null,
  platform           text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  provider_author_id text not null check (provider_author_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  role               text not null check (role in ('account_identity', 'user', 'unknown')),
  label              text check (pg_catalog.char_length(label) between 1 and 256),
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, platform, provider_author_id),
  unique (workspace_id, id, platform),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade
);

-- ── interactions.interactions ─────────────────────────────────────────────────────────────────────────
create table interactions.interactions (
  id                             uuid not null,
  organization_id                uuid not null,
  workspace_id                   uuid not null,
  platform                       text not null check (platform in ('facebook', 'instagram', 'tiktok')),
  provider_interaction_id        text not null check (provider_interaction_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  connected_account_id           uuid not null,
  provider_asset_id              text not null,
  content_item_id                uuid not null,
  -- The content's provider id, carried so the canonical row (and its stored provenance) is self-contained; the
  -- composite FK below binds it to the content row.
  provider_content_id            text not null,
  -- A placeholder (observed = false) knows only its identity and content: everything below is NULL for it.
  observed                       boolean not null,
  parent_interaction_id          uuid,
  kind                           text check (kind in ('comment', 'reply')),
  author_id                      uuid,
  author_role                    text check (author_role in ('account_identity', 'user', 'unknown')),
  conversation_id                uuid,
  current_source_text_version_id uuid,
  -- The observed time at which the current text pointer was established (orders a later text against it, even when
  -- the pointer returned to an earlier version's text).
  text_observed_at               timestamptz,
  current_visibility             text check (current_visibility in ('visible', 'hidden', 'unknown')),
  current_availability           text check (current_availability in ('available', 'removed_at_source')),
  current_removal_basis          text check (current_removal_basis in ('explicit_provider_signal', 'direct_fetch_confirmed')),
  provider_created_at            timestamptz,
  provider_edited_at             timestamptz,
  state_observed_at              timestamptz,
  first_observed_at              timestamptz,
  latest_observed_at             timestamptz,
  created_at                     timestamptz not null,
  updated_at                     timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, platform, provider_interaction_id),
  unique (workspace_id, id, content_item_id),
  unique (workspace_id, id, conversation_id),
  constraint interactions_not_self_parent check (parent_interaction_id is distinct from id),
  constraint interactions_placeholder_minimal check (
    observed or (kind is null and author_id is null and author_role is null and current_source_text_version_id is null and text_observed_at is null
      and current_visibility is null and current_availability is null and current_removal_basis is null
      and provider_created_at is null and provider_edited_at is null and state_observed_at is null
      and first_observed_at is null and latest_observed_at is null and parent_interaction_id is null)),
  constraint interactions_observed_complete check (
    not observed or (kind is not null and author_role is not null and current_visibility is not null and current_availability is not null
      and provider_created_at is not null and state_observed_at is not null and first_observed_at is not null and latest_observed_at is not null)),
  constraint interactions_text_pointer_time check ((current_source_text_version_id is null) = (text_observed_at is null)),
  constraint interactions_kind_parent check (not observed or (kind = 'reply') = (parent_interaction_id is not null)),
  constraint interactions_removal_basis check ((current_availability = 'removed_at_source') = (current_removal_basis is not null)),
  constraint interactions_edit_after_creation check (provider_edited_at is null or provider_edited_at >= provider_created_at),
  constraint interactions_latest_after_first check (latest_observed_at is null or latest_observed_at >= first_observed_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- The interaction's account, platform, asset and provider content id ARE its content's (no scope drift).
  foreign key (workspace_id, content_item_id, connected_account_id, platform, provider_asset_id, provider_content_id)
    references content.content_items (workspace_id, id, connected_account_id, platform, provider_asset_id, provider_content_id),
  -- A reply's parent is on the SAME content; when both carry a conversation, the SAME conversation.
  foreign key (workspace_id, parent_interaction_id, content_item_id) references interactions.interactions (workspace_id, id, content_item_id),
  foreign key (workspace_id, parent_interaction_id, conversation_id) references interactions.interactions (workspace_id, id, conversation_id),
  foreign key (workspace_id, author_id, platform) references interactions.authors (workspace_id, id, platform)
);
create index interactions_by_content on interactions.interactions (workspace_id, content_item_id, provider_created_at);
create index interactions_by_parent on interactions.interactions (workspace_id, parent_interaction_id) where parent_interaction_id is not null;
create index interactions_by_conversation on interactions.interactions (workspace_id, conversation_id) where conversation_id is not null;

-- ── interactions.source_text_versions (append-only) ───────────────────────────────────────────────────
-- The text exactly as the provider returned it (Model §13); the hash is verified by the database itself.
create table interactions.source_text_versions (
  id                 uuid not null,
  organization_id    uuid not null,
  workspace_id       uuid not null,
  interaction_id     uuid not null,
  text_hash          text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  source_text        text not null check (pg_catalog.char_length(source_text) <= 32768),
  provider_edited_at timestamptz,
  observed_at        timestamptz not null,
  created_at         timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, interaction_id, text_hash),
  unique (workspace_id, interaction_id, id),
  constraint source_text_versions_hash_matches check (
    text_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(source_text, 'UTF8')), 'hex')),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, interaction_id) references interactions.interactions (workspace_id, id)
);

-- The current text is one of the interaction's OWN versions.
alter table interactions.interactions
  add constraint interactions_current_text_version foreign key (workspace_id, id, current_source_text_version_id)
    references interactions.source_text_versions (workspace_id, interaction_id, id);

-- ── interactions.state_observations (append-only) ─────────────────────────────────────────────────────
create table interactions.state_observations (
  id              uuid not null,
  organization_id uuid not null,
  workspace_id    uuid not null,
  interaction_id  uuid not null,
  visibility      text not null check (visibility in ('visible', 'hidden', 'unknown')),
  availability    text not null check (availability in ('available', 'removed_at_source')),
  removal_basis   text check (removal_basis in ('explicit_provider_signal', 'direct_fetch_confirmed')),
  observed_at     timestamptz not null,
  mechanism       text not null check (mechanism in ('reconciliation', 'webhook_relist', 'stored_reread', 'manual_recovery')),
  operation       text not null check (operation in ('listInteractions', 'getInteraction')),
  provenance      text not null check (provenance in ('listed', 'stored')),
  created_at      timestamptz not null,
  primary key (workspace_id, id),
  -- One observation of a given state at a given time: a replayed (or out-of-order) observation is written once.
  constraint state_observations_once unique (workspace_id, interaction_id, observed_at, visibility, availability),
  constraint state_observations_removal_basis check ((availability = 'removed_at_source') = (removal_basis is not null)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, interaction_id) references interactions.interactions (workspace_id, id)
);

-- ── conversations.conversations ───────────────────────────────────────────────────────────────────────
-- Ingestion creates a conversation OPEN only (TL decision 5); Done, reopen, assignment and SLA belong to the workflow
-- layer and get their own grants when it exists.
create table conversations.conversations (
  id                    uuid not null,
  organization_id       uuid not null,
  workspace_id          uuid not null,
  anchor_interaction_id uuid not null,
  anchor_observed       boolean not null,
  workflow_state        text not null check (workflow_state in ('OPEN', 'DONE')),
  created_by            text not null check (created_by in ('system_ingestion')),
  created_at            timestamptz not null,
  updated_at            timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, anchor_interaction_id),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, anchor_interaction_id) references interactions.interactions (workspace_id, id)
);

alter table interactions.interactions
  add constraint interactions_conversation foreign key (workspace_id, conversation_id) references conversations.conversations (workspace_id, id);

-- ── coverage.coverage_records (append-only) ───────────────────────────────────────────────────────────
-- Truthful coverage (TL decision 4): a state per account × capability × content scope × interaction kind × interval.
-- Absence of a record is UNKNOWN, never zero; an identical record (same correlation) is written once.
create table coverage.coverage_records (
  id                   uuid not null,
  organization_id      uuid not null,
  workspace_id         uuid not null,
  connected_account_id uuid not null,
  capability           text not null check (capability in ('read_interactions')),
  content_item_id      uuid,
  interaction_kind     text not null check (interaction_kind in ('comment', 'reply')),
  interval_start       timestamptz not null,
  interval_end         timestamptz not null,
  state                text not null check (state in ('IMPORTING', 'COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'NOT_REQUESTED', 'FAILED', 'UNKNOWN')),
  reason               text not null check (reason in (
                         'VALIDATED_SCOPE_READ', 'CAPABILITY_LIMITATION', 'CAPABILITY_NOT_VALIDATED', 'CAPABILITY_UNSUPPORTED',
                         'ACCOUNT_PERMISSION_MISSING', 'PROFILE_STALE', 'ACCOUNT_INACTIVE', 'CONNECTION_UNAVAILABLE',
                         'PROVIDER_FAILURE', 'HISTORY_DEPTH_NOT_VALIDATED', 'IN_PROGRESS')),
  limitation_code      text check (limitation_code in ('HISTORY_DEPTH_LIMITED', 'HIDE_VISIBLE_TO_AUTHOR', 'REPLIES_NOT_READ')),
  slice_outcome        text not null check (slice_outcome in (
                         'COMPLETE', 'LIMITED', 'TEMPORARILY_FAILED', 'AUTHORIZATION_MISSING', 'NOT_VALIDATED', 'PLATFORM_UNSUPPORTED', 'IN_PROGRESS')),
  correlation_id       text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  as_of                timestamptz not null,
  created_at           timestamptz not null,
  primary key (workspace_id, id),
  constraint coverage_records_interval check (interval_start < interval_end),
  constraint coverage_records_once unique nulls not distinct
    (workspace_id, connected_account_id, capability, content_item_id, interaction_kind, interval_start, interval_end, state, reason, correlation_id),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id),
  foreign key (workspace_id, content_item_id, connected_account_id) references content.content_items (workspace_id, id, connected_account_id)
);
create index coverage_records_by_scope on coverage.coverage_records (workspace_id, connected_account_id, capability, interaction_kind, interval_start);

-- ── ingestion.ingestion_events (append-only) ──────────────────────────────────────────────────────────
-- The closed facts of one canonical change; the outbox row names this event by id only.
create table ingestion.ingestion_events (
  id                     uuid not null,
  organization_id        uuid not null,
  workspace_id           uuid not null,
  interaction_id         uuid not null,
  conversation_id        uuid,
  source_text_version_id uuid,
  change                 text not null check (change in ('created', 'text_changed', 'state_changed', 'removed_at_source')),
  arrival                text not null check (arrival in ('realtime', 'reconciliation', 'backfill')),
  observed_at            timestamptz not null,
  correlation_id         text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  initiator              text not null check (initiator in ('system')),
  created_at             timestamptz not null,
  primary key (workspace_id, id),
  constraint ingestion_events_text_version check (change <> 'text_changed' or source_text_version_id is not null),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, interaction_id) references interactions.interactions (workspace_id, id),
  foreign key (workspace_id, conversation_id) references conversations.conversations (workspace_id, id),
  foreign key (workspace_id, interaction_id, source_text_version_id) references interactions.source_text_versions (workspace_id, interaction_id, id)
);
create index ingestion_events_by_interaction on ingestion.ingestion_events (workspace_id, interaction_id, created_at);

-- ── canonical scope is immutable ──────────────────────────────────────────────────────────────────────
-- Identity and scope columns aren't granted for UPDATE at all. This guard covers what IS granted: a placeholder may be
-- completed once (observed false → true, setting its kind, parent, author); after that kind, parent and author never
-- change, observed never goes back, and a conversation is set once and never moved. SECURITY INVOKER, empty
-- search_path: it reads only OLD/NEW.
create function interactions.interactions_scope_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if old.observed and not new.observed then
    raise exception 'an observed interaction never becomes a placeholder again' using errcode = '23514';
  end if;
  if old.observed and (new.kind is distinct from old.kind or new.parent_interaction_id is distinct from old.parent_interaction_id
                       or new.author_id is distinct from old.author_id or new.author_role is distinct from old.author_role
                       or new.provider_created_at is distinct from old.provider_created_at) then
    raise exception 'canonical interaction scope is immutable' using errcode = '23514';
  end if;
  if old.conversation_id is not null and new.conversation_id is distinct from old.conversation_id then
    raise exception 'an interaction never moves to another conversation' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function interactions.interactions_scope_guard() from public;

create trigger interactions_scope_guard before update on interactions.interactions
  for each row execute function interactions.interactions_scope_guard();

alter table content.content_items enable row level security;
alter table content.content_items force row level security;
alter table interactions.authors enable row level security;
alter table interactions.authors force row level security;
alter table interactions.interactions enable row level security;
alter table interactions.interactions force row level security;
alter table interactions.source_text_versions enable row level security;
alter table interactions.source_text_versions force row level security;
alter table interactions.state_observations enable row level security;
alter table interactions.state_observations force row level security;
alter table conversations.conversations enable row level security;
alter table conversations.conversations force row level security;
alter table coverage.coverage_records enable row level security;
alter table coverage.coverage_records force row level security;
alter table ingestion.ingestion_events enable row level security;
alter table ingestion.ingestion_events force row level security;

reset role;

-- read: non-guest members of the BOUND workspace · write: the job runtime, its bound workspace only · guests: nothing
create policy member_read on content.content_items for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on content.content_items for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on content.content_items for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on content.content_items for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

create policy member_read on interactions.authors for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on interactions.authors for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on interactions.authors for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on interactions.authors for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

create policy member_read on interactions.interactions for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on interactions.interactions for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on interactions.interactions for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on interactions.interactions for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

create policy member_read on interactions.source_text_versions for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on interactions.source_text_versions for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on interactions.source_text_versions for insert to app_worker with check (workspace_id = (select app.current_workspace()));

create policy member_read on interactions.state_observations for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on interactions.state_observations for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on interactions.state_observations for insert to app_worker with check (workspace_id = (select app.current_workspace()));

create policy member_read on conversations.conversations for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on conversations.conversations for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on conversations.conversations for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and workflow_state = 'OPEN' and created_by = 'system_ingestion');
create policy worker_update on conversations.conversations for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

create policy member_read on coverage.coverage_records for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on coverage.coverage_records for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on coverage.coverage_records for insert to app_worker with check (workspace_id = (select app.current_workspace()));

create policy member_read on ingestion.ingestion_events for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on ingestion.ingestion_events for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on ingestion.ingestion_events for insert to app_worker with check (workspace_id = (select app.current_workspace()));

grant usage on schema content, interactions, conversations, coverage, ingestion to authenticated, app_worker;
grant select on content.content_items, interactions.authors, interactions.interactions, interactions.source_text_versions,
  interactions.state_observations, conversations.conversations, coverage.coverage_records, ingestion.ingestion_events to authenticated;

grant select, insert on content.content_items to app_worker;
grant update (source_state, latest_observed_at, updated_at) on content.content_items to app_worker;
grant select, insert on interactions.authors to app_worker;
grant update (label, updated_at) on interactions.authors to app_worker;
grant select, insert on interactions.interactions to app_worker;
grant update (observed, parent_interaction_id, kind, author_id, author_role, conversation_id, current_source_text_version_id,
              text_observed_at, current_visibility, current_availability, current_removal_basis, provider_created_at, provider_edited_at,
              state_observed_at, first_observed_at, latest_observed_at, updated_at)
  on interactions.interactions to app_worker;
grant select, insert on interactions.source_text_versions to app_worker;   -- append-only
grant select, insert on interactions.state_observations to app_worker;     -- append-only
grant select, insert on conversations.conversations to app_worker;
grant update (anchor_observed, updated_at) on conversations.conversations to app_worker;
grant select, insert on coverage.coverage_records to app_worker;           -- append-only
grant select, insert on ingestion.ingestion_events to app_worker;          -- append-only
