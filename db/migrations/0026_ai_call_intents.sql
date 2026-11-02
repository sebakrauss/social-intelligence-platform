-- 0026 · Durable provider-call intents (Step H7-D1e2b; design H7-D1e2a, Option B). Forward-only and expand-only: one new
-- APPEND-ONLY table and one new foreign key on the (empty) 0025 attempt ledger. Nothing is backfilled, rewritten or
-- deleted; no existing column, constraint, grant or policy changes. Disabling the feature is the operational rollback
-- (the route stays disabled and no row is produced).
--
--   classification.ai_call_intents   the durable IDENTITY of one provider egress, committed BEFORE the call: one row per
--                                    (request, dispatch generation, attempt) — the initial call (1) or the one re-ask (2).
--                                    Ids, versions, counts and times only — never a prompt, model input, response,
--                                    reasoning, secret or social text. It is never updated: what happened to the call is
--                                    DERIVED (RECORDED: its ai_attempts row exists · IN_FLIGHT: no attempt yet, the request
--                                    still runs that generation and is not stale · UNKNOWN_PROVIDER_OUTCOME: otherwise —
--                                    potentially billable, never "not called").
--   classification.ai_attempts       every attempt row now names its prior intent (same workspace, request, generation and
--                                    attempt number): no completed call can exist without a durable pre-egress identity.
--
-- The runtime commits the intent in its own transaction, under the request's row lock, only while the request is still
-- AI_RUNNING at that generation (the egress fence), and calls the provider only after that commit (H7-D1e2b). Every
-- reference is composite with the workspace (R5); the bound worker (app_worker) is the only runtime role on the table;
-- authenticated gets nothing. Retention follows the workspace (cascade on its deletion only; durations PD OQ-21).

set role app_owner;

-- ── classification.ai_call_intents (append-only egress identity) ─────────────────────────────────────────────────
create table classification.ai_call_intents (
  id                        uuid not null,
  organization_id           uuid not null,
  workspace_id              uuid not null,
  understanding_request_id  uuid not null,
  interaction_id            uuid not null,
  source_text_version_id    uuid not null,
  pipeline_version          text not null check (pipeline_version = 'classification.intelligence.v1'),
  dispatch_generation       integer not null check (dispatch_generation between 1 and 1000),
  attempt_number            smallint not null check (attempt_number in (1, 2)),
  attempt_kind              text not null check (attempt_kind in ('initial', 'reask')),
  task_id                   text not null check (task_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
  provider                  text not null check (provider ~ '^[a-z][a-z0-9._-]{0,63}$'),
  model_requested           text not null check (model_requested ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  route_fingerprint         text not null check (route_fingerprint ~ '^[0-9a-f]{64}$'),
  input_chars               integer not null check (input_chars >= 0),
  correlation_id            text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  trigger_run_id            text not null check (trigger_run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at                timestamptz not null,
  primary key (workspace_id, id),
  -- Exactly one egress per (request, generation, attempt): a second authorization of the same call is refused.
  constraint ai_call_intents_once unique (workspace_id, understanding_request_id, dispatch_generation, attempt_number),
  constraint ai_call_intents_kind check ((attempt_number = 1) = (attempt_kind = 'initial')),
  constraint ai_call_intents_workspace foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- The request, its interaction, its text version and its pipeline at once (0025 understanding_requests_ai_target).
  constraint ai_call_intents_request foreign key (workspace_id, understanding_request_id, interaction_id, source_text_version_id, pipeline_version)
    references classification.understanding_requests (workspace_id, id, interaction_id, source_text_version_id, pipeline_version)
);

alter table classification.ai_call_intents enable row level security;
alter table classification.ai_call_intents force row level security;

reset role;

-- ── classification.ai_attempts: every completed call names its prior intent ─────────────────────────────────────────
-- The ledger is empty wherever 0025 runs (no runtime wrote it before H7-D1e2b); a row without an intent fails closed here.
-- Added AFTER `reset role`, as the migration role (a member of app_owner that bypasses RLS): PostgreSQL validates a new
-- foreign key with one query as the CURRENT role, and as app_owner — the owner of a FORCE-RLS table with no owner
-- policy — that query would see no row at all and validate vacuously (proven by migration-0026-upgrade.test.ts).
alter table classification.ai_attempts
  add constraint ai_attempts_intent foreign key (workspace_id, understanding_request_id, dispatch_generation, attempt_number)
    references classification.ai_call_intents (workspace_id, understanding_request_id, dispatch_generation, attempt_number);

-- The bound worker only (the INTELLIGENCE plane's tenant analysis authority); authenticated / guests: nothing.
create policy worker_read on classification.ai_call_intents for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on classification.ai_call_intents for insert to app_worker with check (workspace_id = (select app.current_workspace()));

grant select, insert on classification.ai_call_intents to app_worker;   -- append-only
