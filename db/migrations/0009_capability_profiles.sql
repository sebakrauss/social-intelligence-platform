-- 0009 · Account Capability Profiles (Step 5E; TA §16; Model §6). Forward-only and expand-only: one new schema owned
-- by the capability module, two tables, policies and grants. No existing object is changed; no role is created.
--
--   capability.account_profiles   one CURRENT evaluation header per Connected Account: the catalog id and integer
--                                 revision and the normalized inputs it used (account facts snapshot, or the dated
--                                 definite absence of facts, + explicit observations), so every row can be recomputed
--                                 and explained. Freshness (applied by the writer under a row lock): higher
--                                 catalog_revision wins; same revision → newer inputs_as_of wins; same revision and
--                                 same inputs_as_of → same input_digest is the same evaluation, a different one is a
--                                 CONFLICT (rejected). The digest is an equality fingerprint only, never an order.
--                                 inputs_as_of = newest input used (facts_observed_at, observation times); the
--                                 evaluation time never contributes. last_verified_at is bookkeeping only.
--   capability.profile_entries    the current state per (capability × content kind × source) scope of that header.
--
-- Capability Profile state is DERIVED, recomputable current state (TA §13 category C): written only by the job
-- runtime (worker, bound to one workspace), readable by non-guest members of the workspace. The Platform Capability
-- Catalog is code-versioned (TA §16.1) and is NOT stored here. No raw provider payload, no secret, no provider
-- message: facts are opaque permission identifiers and closed vocabularies; observations are closed codes.
-- Composite (workspace_id, …) keys and FKs everywhere (R5): a cross-workspace Connected Account reference fails like
-- a missing one, and an id used in another workspace never collides.

create schema capability authorization app_owner;
revoke all on schema capability from public;

set role app_owner;

create table capability.account_profiles (
  organization_id              uuid not null,
  workspace_id                 uuid not null,
  connected_account_id         uuid not null,
  catalog_id                   text not null check (catalog_id in ('platform', 'simulator')),
  catalog_revision             integer not null check (catalog_revision >= 1),
  facts_available              boolean not null,
  facts_asset_class            text check (facts_asset_class in ('content_bearing', 'ad_account')),
  facts_granted_permissions    text[] not null default '{}' check (pg_catalog.cardinality(facts_granted_permissions) <= 256),
  facts_linked_ad_account_ids  text[] not null default '{}' check (pg_catalog.cardinality(facts_linked_ad_account_ids) <= 256),
  facts_account_identity_known boolean,
  -- When the facts (or their definite absence) were observed, local clock.
  facts_observed_at            timestamptz not null,
  observations                 jsonb not null default '[]'::jsonb check (
                                 pg_catalog.jsonb_typeof(observations) = 'array' and pg_catalog.jsonb_array_length(observations) <= 100),
  inputs_as_of                 timestamptz not null,
  input_digest                 text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  evaluated_at                 timestamptz not null,
  last_verified_at             timestamptz not null,
  revision                     integer not null check (revision >= 1),
  created_at                   timestamptz not null,
  updated_at                   timestamptz not null,
  primary key (workspace_id, connected_account_id),
  constraint account_profiles_facts_shape check (
    (facts_available and facts_asset_class is not null and facts_account_identity_known is not null)
    or (not facts_available and facts_asset_class is null and facts_account_identity_known is null
        and pg_catalog.cardinality(facts_granted_permissions) = 0 and pg_catalog.cardinality(facts_linked_ad_account_ids) = 0)),
  -- inputs_as_of is the newest input used: never older than the facts observation.
  constraint account_profiles_inputs_as_of check (inputs_as_of >= facts_observed_at),
  constraint account_profiles_verified_after_evaluated check (last_verified_at >= evaluated_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references connections.connected_accounts (workspace_id, id) on delete cascade
);

create table capability.profile_entries (
  organization_id      uuid not null,
  workspace_id         uuid not null,
  connected_account_id uuid not null,
  capability           text not null check (capability in (
                         'read_interactions', 'read_history', 'read_paid_context', 'reply_public', 'reply_private', 'hide',
                         'delete', 'block', 'detect_native_replies')),
  content_kind         text not null check (content_kind in ('post', 'reel', 'video', 'carousel', 'story', 'ad_creative', 'other', 'any')),
  source               text not null check (source in ('organic', 'paid', 'mixed', 'unknown', 'any')),
  state                text not null check (state in ('SUPPORTED', 'AVAILABLE_WITH_LIMITATION', 'UNSUPPORTED', 'UNKNOWN_NOT_VALIDATED')),
  reason_codes         text[] not null check (
                         pg_catalog.cardinality(reason_codes) between 1 and 8
                         and reason_codes <@ array[
                           'CATALOG_SUPPORTED', 'CATALOG_LIMITATION', 'CATALOG_UNSUPPORTED', 'CATALOG_NOT_VALIDATED',
                           'ACCOUNT_FACTS_UNAVAILABLE', 'ACCOUNT_FACTS_INCONSISTENT', 'ACCOUNT_PERMISSION_MISSING',
                           'OBSERVED_PERMISSION_MISSING', 'OBSERVED_NOT_ELIGIBLE']::text[]),
  limitation_code      text check (limitation_code in ('HISTORY_DEPTH_LIMITED', 'HIDE_VISIBLE_TO_AUTHOR')),
  limitation_value     integer check (limitation_value >= 0),
  catalog_validation   text not null check (catalog_validation in ('validated', 'not_validated')),
  evidence_ref         text check (evidence_ref ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  observation_refs     text[] not null default '{}' check (pg_catalog.cardinality(observation_refs) <= 100),
  revision             integer not null check (revision >= 1),
  evaluated_at         timestamptz not null,
  primary key (workspace_id, connected_account_id, capability, content_kind, source),
  -- A limitation exists exactly when the state says so; it never disappears from an available-with-limitation row.
  constraint profile_entries_limitation_shape check ((state = 'AVAILABLE_WITH_LIMITATION') = (limitation_code is not null)),
  constraint profile_entries_limitation_value check (limitation_code is not null or limitation_value is null),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, connected_account_id) references capability.account_profiles (workspace_id, connected_account_id) on delete cascade
);

alter table capability.account_profiles enable row level security;
alter table capability.account_profiles force row level security;
alter table capability.profile_entries enable row level security;
alter table capability.profile_entries force row level security;

reset role;

-- read: non-guest members of the BOUND workspace · write: the job runtime, its bound workspace only · guests: nothing
create policy member_read on capability.account_profiles for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on capability.account_profiles for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_insert on capability.account_profiles for insert to app_worker
  with check (workspace_id = (select app.current_workspace()));
create policy worker_update on capability.account_profiles for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

create policy member_read on capability.profile_entries for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on capability.profile_entries for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy worker_insert on capability.profile_entries for insert to app_worker
  with check (workspace_id = (select app.current_workspace()));
create policy worker_update on capability.profile_entries for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));
create policy worker_delete on capability.profile_entries for delete to app_worker
  using (workspace_id = (select app.current_workspace()));

grant usage on schema capability to authenticated, app_worker;
grant select on capability.account_profiles, capability.profile_entries to authenticated;
grant select, insert on capability.account_profiles to app_worker;
grant update (catalog_id, catalog_revision, facts_available, facts_asset_class, facts_granted_permissions, facts_linked_ad_account_ids,
              facts_account_identity_known, facts_observed_at, observations, inputs_as_of, input_digest, evaluated_at, last_verified_at,
              revision, updated_at)
  on capability.account_profiles to app_worker;
grant select, insert, delete on capability.profile_entries to app_worker;
grant update (state, reason_codes, limitation_code, limitation_value, catalog_validation, evidence_ref, observation_refs, revision, evaluated_at)
  on capability.profile_entries to app_worker;
