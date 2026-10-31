-- 0025 · Intelligence persistence (Step H7-D1c; H7-A0 §3, §9–§12, §15, D-H7-1; H7-D1a; H7-D1b contracts in
-- modules/classification/application/ai/understand-ai-contract.ts). Forward-only and expand-only. Nothing is backfilled,
-- rewritten or deleted; no runtime writes these objects yet (H7-D1d wires them, shadow only). Disabling the feature is
-- the operational rollback: the route stays disabled and no row is produced.
--
--   system.outbox                        `intelligence` becomes a known execution plane, bound ONLY for the topic
--                                        `classification.understand_ai` (and that topic only to it); members can't append
--                                        the topic (its own RESTRICTIVE policy — 0021 stays forward-only)
--   classification.understanding_requests  `ai_generation` (the `a{n}` of the dispatch key, 1..1000, monotonic) and
--                                        `ai_failure_class` (the frozen five, iff AI_FAILED); AI states belong to the
--                                        `classification.intelligence.v1` pipeline only, so a deterministic.v1 request can
--                                        never be continued
--   classification.ai_attempts           APPEND-ONLY ledger: one row per provider call (initial / re-ask). Ids, versions,
--                                        counts, times and outcome classes — never a prompt, model input, response,
--                                        reasoning, secret or social text
--   classification.ai_results            APPEND-ONLY: one validated output per request (bounded summary, ≤ 3 evidence
--                                        spans as offsets, route provenance) — the semantic values are the assessments
--                                        that reference it; failures are recorded on the request and the ledger, never here
--   classification.assessments           `acceptance_mode` (shadow | accepting; existing and non-AI rows: accepting) and the
--                                        AI provenance references; every AI row is SHADOW and names its result; members
--                                        can't read shadow rows (RESTRICTIVE)
--   classification.ai_budget_reservations  the pre-call budget authority: one counter row per workspace × task × UTC day,
--                                        reserved atomically by classification.reserve_ai_budget() against caps the caller
--                                        supplies (no amount, price or plan limit is decided here: PD OQ-14, TA-Q-23)
--
-- Every new reference is composite with the workspace (R5). The worker (app_worker, the INTELLIGENCE plane's tenant
-- analysis authority, D-H7-1) is the only runtime role on the new tables; authenticated gets nothing on them. No table
-- here holds an action (hide, delete, reply, block, moderate, alert, automate): Intelligence persists understanding only.
-- Retention follows the workspace: every row cascades only from its workspace's deletion (H7-D1a; durations PD OQ-21).

set role app_owner;

-- ── system.outbox: the intelligence plane (bound only for classification.understand_ai) ─────────────────────────────
-- A pinned widening of 0011's CHECK (main, integration + intelligence), in the reviewed drop / NOT VALID re-add / VALIDATE
-- shape; then the routing rule: an intelligence binding is only ever for that topic, and that topic only binds there.
alter table system.outbox drop constraint outbox_execution_plane_known;
alter table system.outbox add constraint outbox_execution_plane_known check (execution_plane is null or execution_plane in ('main', 'integration', 'intelligence')) not valid;
alter table system.outbox validate constraint outbox_execution_plane_known;
alter table system.outbox
  add constraint outbox_intelligence_routing check (execution_plane is null or ((execution_plane = 'intelligence') = (topic = 'classification.understand_ai')));

-- G6 for intelligence: members never append the model-execution topic themselves; the job runtime (app_worker) does.
create policy no_direct_intelligence_routing on system.outbox as restrictive for insert to authenticated
  with check (topic not in ('classification.understand_ai'));

-- ── classification.understanding_requests: the AI generation of the intelligence pipeline ───────────────────────────
alter table classification.understanding_requests
  add column ai_generation integer,
  add column ai_failure_class text,
  add constraint understanding_requests_ai_generation_range check (ai_generation is null or ai_generation between 1 and 1000),
  add constraint understanding_requests_ai_failure_class check (ai_failure_class is null
    or ai_failure_class in ('AI_INVALID_OUTPUT', 'AI_UNAVAILABLE', 'AI_REFUSED', 'AI_BUDGET', 'AI_INPUT_TOO_LARGE')),
  -- The AI states exist only in the intelligence pipeline and always carry a generation; nothing else carries one.
  add constraint understanding_requests_ai_state check (
    (state in ('AI_PENDING', 'AI_RUNNING', 'COMPLETED', 'AI_FAILED')) = (ai_generation is not null)
    and (ai_generation is null or pipeline_version = 'classification.intelligence.v1')),
  add constraint understanding_requests_ai_failure check ((state = 'AI_FAILED') = (ai_failure_class is not null)),
  -- Target of the ledger / result references: the request, its interaction, its text version and its pipeline at once.
  add constraint understanding_requests_ai_target unique (workspace_id, id, interaction_id, source_text_version_id, pipeline_version);

-- The recovery scan of in-flight AI requests (H7-D1d sweeper): per workspace, oldest first.
create index understanding_requests_ai_inflight on classification.understanding_requests (workspace_id, updated_at)
  where state in ('AI_PENDING', 'AI_RUNNING');

-- 0024's guard, extended: the generation never decreases or disappears and the failure class never changes.
create or replace function classification.understanding_request_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if old.state in ('COMPLETED', 'AI_FAILED', 'DETERMINISTIC_ONLY', 'SKIPPED_OWN_BRAND', 'SKIPPED_SUPERSEDED') then
    raise exception 'a completed understanding request is final' using errcode = '23514';
  end if;
  if new.state = 'PENDING' and old.state <> 'PENDING' then
    raise exception 'an understanding request never returns to PENDING' using errcode = '23514';
  end if;
  if old.ai_generation is not null and (new.ai_generation is null or new.ai_generation < old.ai_generation) then
    raise exception 'an understanding request AI generation never decreases' using errcode = '23514';
  end if;
  if old.ai_failure_class is not null and new.ai_failure_class is distinct from old.ai_failure_class then
    raise exception 'an understanding request failure class is final' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ── classification.ai_attempts (append-only ledger) ────────────────────────────────────────────────────────────
-- Identifiers are bounded tokens (no whitespace, no free text). Outcome ⇔ failure class is the gateway's exact mapping.
create table classification.ai_attempts (
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
  task_version              text not null check (task_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  prompt_version            text not null check (prompt_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  prompt_hash               text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  output_schema_version     text not null check (output_schema_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  transport_schema_version  text not null check (transport_schema_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  taxonomy_version          text not null check (taxonomy_version in ('taxonomy.v1')),
  confidence_policy_version text not null check (confidence_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  language_policy_version   text not null check (language_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  input_contract_version    text not null check (input_contract_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  provider                  text not null check (provider ~ '^[a-z][a-z0-9._-]{0,63}$'),
  model_requested           text not null check (model_requested ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  model_reported            text check (model_reported ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  started_at                timestamptz not null,
  completed_at              timestamptz not null,
  latency_ms                integer not null check (latency_ms >= 0),
  input_chars               integer not null check (input_chars >= 0),
  input_tokens              integer check (input_tokens >= 0),
  output_tokens             integer check (output_tokens >= 0),
  cached_input_tokens       integer check (cached_input_tokens >= 0),
  -- TA-Q-23 OPEN: no pricing table is approved; both stay NULL until one is (then both are set together).
  cost_estimate_usd         numeric(14, 8) check (cost_estimate_usd >= 0),
  pricing_table_version     text check (pricing_table_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  outcome                   text not null check (outcome in ('accepted', 'invalid_output', 'refused', 'unavailable', 'input_too_large')),
  failure_class             text,
  -- The closed A1 validation issues (understanding-output.ts OUTPUT_ISSUES) plus the gateway's MALFORMED_JSON.
  issue_codes               text[] not null default '{}' check (
    pg_catalog.cardinality(issue_codes) <= 32 and pg_catalog.array_position(issue_codes, null) is null
    and issue_codes operator(pg_catalog.<@) array['NOT_AN_OBJECT', 'UNEXPECTED_KEY', 'SCHEMA_VERSION_MISMATCH', 'TAXONOMY_VERSION_MISMATCH', 'DIMENSIONS_INVALID',
      'UNKNOWN_DIMENSION', 'STATUS_INVALID', 'UNKNOWN_VALUE', 'DUPLICATE_VALUE', 'CARDINALITY_VIOLATION', 'EXCLUSIVE_VALUE_COMBINED', 'CONFIDENCE_INVALID',
      'SCORE_INVALID', 'REASON_CODE_INVALID', 'LANGUAGE_TAG_INVALID', 'LANGUAGE_CERTAINTY_INVALID', 'SUMMARY_INVALID', 'EVIDENCE_INVALID', 'QUOTE_NOT_IN_TEXT',
      'MALFORMED_JSON']::text[]),
  correlation_id            text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  trigger_run_id            text not null check (trigger_run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at                timestamptz not null,
  primary key (workspace_id, id),
  -- Idempotency: one row per (request, dispatch generation, attempt) — a redelivered run can't add a second.
  constraint ai_attempts_once unique (workspace_id, understanding_request_id, dispatch_generation, attempt_number),
  -- Target of the result reference: an attempt of the same request and generation, with its outcome.
  constraint ai_attempts_result_target unique (workspace_id, id, understanding_request_id, dispatch_generation, outcome),
  constraint ai_attempts_kind check ((attempt_number = 1) = (attempt_kind = 'initial')),
  constraint ai_attempts_times check (completed_at >= started_at),
  constraint ai_attempts_cost check ((cost_estimate_usd is null) = (pricing_table_version is null)),
  constraint ai_attempts_failure check (failure_class is not distinct from (case outcome
    when 'accepted' then null when 'invalid_output' then 'AI_INVALID_OUTPUT' when 'refused' then 'AI_REFUSED'
    when 'unavailable' then 'AI_UNAVAILABLE' when 'input_too_large' then 'AI_INPUT_TOO_LARGE' end)),
  constraint ai_attempts_issues check (outcome = 'invalid_output' or pg_catalog.cardinality(issue_codes) = 0),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint ai_attempts_request foreign key (workspace_id, understanding_request_id, interaction_id, source_text_version_id, pipeline_version)
    references classification.understanding_requests (workspace_id, id, interaction_id, source_text_version_id, pipeline_version)
);

-- ── classification.ai_results (append-only; one validated output per request) ──────────────────────────────────
-- The per-dimension values are the shadow assessments that reference this row; it holds only what belongs to the output
-- as a whole: the bounded display summary (plain text, rendered as text), the verified evidence offsets into the SOURCE
-- text version (never copied text) and the route provenance (TA §57; the qualified configuration fingerprint).
create table classification.ai_results (
  id                        uuid not null,
  organization_id           uuid not null,
  workspace_id              uuid not null,
  understanding_request_id  uuid not null,
  interaction_id            uuid not null,
  source_text_version_id    uuid not null,
  pipeline_version          text not null check (pipeline_version = 'classification.intelligence.v1'),
  dispatch_generation       integer not null check (dispatch_generation between 1 and 1000),
  attempt_id                uuid not null,
  attempt_outcome           text not null default 'accepted' check (attempt_outcome = 'accepted'),
  acceptance_mode           text not null check (acceptance_mode in ('shadow', 'accepting')),
  provider                  text not null check (provider ~ '^[a-z][a-z0-9._-]{0,63}$'),
  model_requested           text not null check (model_requested ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  model_reported            text check (model_reported ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  route_fingerprint         text not null check (route_fingerprint ~ '^[0-9a-f]{64}$'),
  task_id                   text not null check (task_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
  task_version              text not null check (task_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  prompt_version            text not null check (prompt_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  prompt_hash               text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  output_schema_version     text not null check (output_schema_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  transport_schema_version  text not null check (transport_schema_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  taxonomy_version          text not null check (taxonomy_version in ('taxonomy.v1')),
  confidence_policy_version text not null check (confidence_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  language_policy_version   text not null check (language_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  input_contract_version    text not null check (input_contract_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  -- ≤ 240 characters of plain text (no control characters except tab / newline), or none.
  summary                   text check (pg_catalog.char_length(summary) between 1 and 240
                                        and pg_catalog.translate(summary, E'\t\n', '') !~ '[[:cntrl:]]'),
  evidence_starts           integer[],
  evidence_ends             integer[],
  correlation_id            text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  trigger_run_id            text not null check (trigger_run_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at                timestamptz not null,
  primary key (workspace_id, id),
  -- One validated output per request, whatever the generation that produced it.
  constraint ai_results_once unique (workspace_id, understanding_request_id),
  -- Target of the assessment reference: same text version, pipeline and language policy as the assessment.
  constraint ai_results_assessment_target unique (workspace_id, source_text_version_id, pipeline_version, language_policy_version, id),
  -- H7-D1 is shadow-first: no accepting result exists until a promotion gate replaces this constraint.
  constraint ai_results_shadow_only check (acceptance_mode = 'shadow'),
  constraint ai_results_evidence check ((evidence_starts is null and evidence_ends is null) or classification.source_spans_valid(evidence_starts, evidence_ends, 3)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  constraint ai_results_request foreign key (workspace_id, understanding_request_id, interaction_id, source_text_version_id, pipeline_version)
    references classification.understanding_requests (workspace_id, id, interaction_id, source_text_version_id, pipeline_version),
  -- The accepted attempt of the same request and generation.
  constraint ai_results_attempt foreign key (workspace_id, attempt_id, understanding_request_id, dispatch_generation, attempt_outcome)
    references classification.ai_attempts (workspace_id, id, understanding_request_id, dispatch_generation, outcome)
);

-- ── classification.assessments: acceptance mode + AI provenance ─────────────────────────────────────────────────
-- Existing rows keep their meaning: non-AI rows are product data (accepting). Every AI row is SHADOW, names the
-- validated result it came from (same text version, pipeline and language policy) — nothing else carries them.
alter table classification.assessments
  add column acceptance_mode text not null default 'accepting' check (acceptance_mode in ('shadow', 'accepting')),
  add column pipeline_version text,
  add column language_policy_version text,
  add column ai_result_id uuid,
  add constraint assessments_ai_shadow_only check (
    case when origin = 'ai'
      then acceptance_mode = 'shadow' and pipeline_version is not null and language_policy_version is not null and ai_result_id is not null
      else acceptance_mode = 'accepting' and pipeline_version is null and language_policy_version is null and ai_result_id is null end),
  add constraint assessments_ai_result foreign key (workspace_id, source_text_version_id, pipeline_version, language_policy_version, ai_result_id)
    references classification.ai_results (workspace_id, source_text_version_id, pipeline_version, language_policy_version, id);

-- Internal measurement: the shadow assessments of one result.
create index assessments_ai_result on classification.assessments (workspace_id, ai_result_id) where ai_result_id is not null;

-- ── classification.ai_budget_reservations (pre-call budget authority) ──────────────────────────────────────────
-- Counters only, never decreasing (no refund: a reservation is spent whether or not the call succeeds — fail safe).
create table classification.ai_budget_reservations (
  organization_id      uuid not null,
  workspace_id         uuid not null,
  task_id              text not null check (task_id ~ '^[a-z][a-z0-9._-]{0,99}$'),
  budget_day           date not null,
  reserved_calls       integer not null check (reserved_calls >= 0),
  reserved_input_chars bigint not null check (reserved_input_chars >= 0),
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  primary key (workspace_id, task_id, budget_day),
  constraint ai_budget_reservations_times check (updated_at >= created_at),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade
);

create function classification.ai_budget_reservation_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if new.reserved_calls < old.reserved_calls or new.reserved_input_chars < old.reserved_input_chars then
    raise exception 'an AI budget reservation never decreases' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function classification.ai_budget_reservation_guard() from public;

create trigger ai_budget_reservation_guard before update on classification.ai_budget_reservations
  for each row execute function classification.ai_budget_reservation_guard();

-- Atomic reservation for the BOUND workspace (never a parameter): one statement — insert the day's row, or add to it only
-- while both totals stay within the caller's caps. Concurrent reservations serialize on the row lock and each re-checks
-- the latest committed totals, so no interleaving can exceed a cap. true = reserved (the call may proceed); false =
-- denied (no provider call). Invalid arguments deny. SECURITY INVOKER: RLS and grants of the caller apply.
create function classification.reserve_ai_budget(p_task_id text, p_budget_day date, p_calls integer, p_input_chars bigint, p_max_calls integer, p_max_input_chars bigint)
returns boolean language sql volatile security invoker set search_path = '' as $$
  with reserved as (
    insert into classification.ai_budget_reservations as r (organization_id, workspace_id, task_id, budget_day, reserved_calls, reserved_input_chars, created_at, updated_at)
    select app.current_workspace_organization(), app.current_workspace(), p_task_id, p_budget_day, p_calls, p_input_chars, pg_catalog.now(), pg_catalog.now()
     where app.current_workspace() is not null
       and p_task_id ~ '^[a-z][a-z0-9._-]{0,99}$' and p_budget_day is not null
       and p_calls >= 1 and p_input_chars >= 0 and p_max_calls >= 0 and p_max_input_chars >= 0
       and p_calls <= p_max_calls and p_input_chars <= p_max_input_chars
    on conflict (workspace_id, task_id, budget_day) do update
      set reserved_calls = r.reserved_calls + excluded.reserved_calls,
          reserved_input_chars = r.reserved_input_chars + excluded.reserved_input_chars,
          -- now() is the transaction START: a reservation that began before the row's creator must not move time back.
          updated_at = greatest(r.updated_at, excluded.updated_at)
      where r.reserved_calls + excluded.reserved_calls <= p_max_calls
        and r.reserved_input_chars + excluded.reserved_input_chars <= p_max_input_chars
    returning 1)
  select exists (select 1 from reserved)
$$;
revoke all on function classification.reserve_ai_budget(text, date, integer, bigint, integer, bigint) from public;

alter table classification.ai_attempts enable row level security;
alter table classification.ai_attempts force row level security;
alter table classification.ai_results enable row level security;
alter table classification.ai_results force row level security;
alter table classification.ai_budget_reservations enable row level security;
alter table classification.ai_budget_reservations force row level security;

reset role;

-- The bound worker only (the INTELLIGENCE plane's tenant analysis authority); authenticated / guests: nothing.
create policy worker_read on classification.ai_attempts for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on classification.ai_attempts for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_read on classification.ai_results for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on classification.ai_results for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and acceptance_mode = 'shadow');
create policy worker_read on classification.ai_budget_reservations for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on classification.ai_budget_reservations for insert to app_worker with check (workspace_id = (select app.current_workspace()));
create policy worker_update on classification.ai_budget_reservations for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

-- Members never see shadow assessments (H7-D1 is shadow-first; promotion is a later gate). The worker still reads them.
create policy no_shadow_member_reads on classification.assessments as restrictive for select to authenticated
  using (acceptance_mode = 'accepting');

grant update (ai_generation, ai_failure_class) on classification.understanding_requests to app_worker;
grant select, insert on classification.ai_attempts to app_worker;   -- append-only
grant select, insert on classification.ai_results to app_worker;    -- append-only
grant select, insert on classification.ai_budget_reservations to app_worker;
grant update (reserved_calls, reserved_input_chars, updated_at) on classification.ai_budget_reservations to app_worker;
grant execute on function classification.reserve_ai_budget(text, date, integer, bigint, integer, bigint) to app_worker;
