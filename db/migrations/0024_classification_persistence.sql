-- 0024 · Classification persistence (Step H7-A2; Model §13–§16, §43–§44; TA §7.1, §24, §57, §58; H7-A0 §3, §7, §9, §11;
-- the pure domain of H7-A1, `modules/classification/domain`). Forward-only and expand-only: one module-owned schema
-- (`classification`, TA §7.1 owner of assessments, language assessment and protection), five tables, three IMMUTABLE
-- validators and one guard trigger. No data change, no backfill, no runtime writes it yet (H7-B wires it).
--
--   classification.understanding_requests   the idempotency anchor: one request per (source text version, pipeline
--                                            version) — a re-delivered or retried trigger can never start a second
--                                            analysis of the same version under the same pipeline
--   classification.assessments               APPEND-ONLY assessments of one dimension of one immutable source text
--                                            version, any origin (rule · ai · platform_hint · human); human corrections
--                                            are new rows that may name the row they correct
--   classification.signals                   APPEND-ONLY narrow deterministic facts (watch_term_match, link_present,
--                                            text_empty, text_emoji_only, author_own_brand) — no dimension, no value
--   classification.watch_term_revisions      APPEND-ONLY workspace watch-term rule-set revisions
--   classification.watch_terms               APPEND-ONLY terms of one revision (stable term id across revisions)
--
-- NOT here, on purpose: accepted interpretation, Protection Evaluation and Needs review (pure derivations over the
-- assessments — no runtime needs a projection yet); topic values (owned by `topics`, M-10 open: topic assessments are
-- refused until that module exists); priority/value (owned by `workflow`); the AI call ledger, the output-level summary
-- and evidence spans of an AI answer (H7-C/D, with the AI runtime); any purge (product data, not provider receipts).
--
-- Every reference is composite with the workspace (R5): an assessment, signal or request against another workspace's
-- interaction or text version, or a watch-term signal against another workspace's term, fails like a missing row.
-- Assessments, signals and watch terms are append-only: the runtime roles hold SELECT and INSERT only.

create schema classification authorization app_owner;
revoke all on schema classification from public;

set role app_owner;

-- ── validators (IMMUTABLE, SECURITY INVOKER, empty search_path; used by CHECK constraints) ─────────────────────
-- The vocabularies below are taxonomy.v1 of the pure domain (modules/classification/domain/taxonomy.ts) — a test pins
-- them equal. A new taxonomy version is a new migration.

create function classification.assessment_values_valid(p_dimension text, p_origin text, p_keys text[], p_levels text[], p_scores numeric[], p_reasons text[])
returns boolean language sql immutable security invoker set search_path = '' as $$
  select p_keys is not null and p_levels is not null and p_scores is not null and p_reasons is not null
    and pg_catalog.array_ndims(p_keys) = 1 and pg_catalog.cardinality(p_keys) >= 1
    and pg_catalog.cardinality(p_levels) = pg_catalog.cardinality(p_keys)
    and pg_catalog.cardinality(p_scores) = pg_catalog.cardinality(p_keys)
    and pg_catalog.array_position(p_keys, null) is null
    and pg_catalog.array_position(p_levels, null) is null
    and (select pg_catalog.count(distinct k) from pg_catalog.unnest(p_keys) as k) = pg_catalog.cardinality(p_keys)
    and p_levels operator(pg_catalog.<@) (case when p_origin = 'human' then array['high'] else array['low', 'medium', 'high'] end)::text[]
    and not exists (select 1 from pg_catalog.unnest(p_scores) as s where s is not null and (s < 0 or s > 1))
    and (select pg_catalog.count(distinct r) from pg_catalog.unnest(p_reasons) as r) = pg_catalog.cardinality(p_reasons)
    and pg_catalog.array_position(p_reasons, null) is null
    and case p_dimension
      when 'safety' then
        p_keys operator(pg_catalog.<@) array['none', 'obvious_spam', 'malicious_link', 'scam_fraud_content', 'impersonation', 'abuse_insult', 'harassment', 'hate_speech', 'threat']::text[]
        and (pg_catalog.cardinality(p_keys) = 1 or not ('none' = any (p_keys)))
        and pg_catalog.cardinality(p_reasons) = 0
      when 'authenticity' then
        pg_catalog.cardinality(p_keys) = 1 and p_keys operator(pg_catalog.<@) array['likely_human', 'bot_like', 'obvious_bot', 'unknown']::text[]
        and pg_catalog.cardinality(p_reasons) = 0
      when 'intent' then
        p_keys operator(pg_catalog.<@) array['purchase_question', 'product_question', 'service_question', 'complaint', 'product_service_problem',
          'fraud_accusation_against_brand', 'price_objection', 'other_commercial_objection', 'praise', 'advocacy', 'suggestion', 'neutral_conversation']::text[]
        and pg_catalog.cardinality(p_reasons) = 0
      when 'sentiment' then
        pg_catalog.cardinality(p_keys) = 1 and p_keys operator(pg_catalog.<@) array['positive', 'neutral', 'negative', 'mixed']::text[]
        and pg_catalog.cardinality(p_reasons) = 0
      when 'risk' then
        pg_catalog.cardinality(p_keys) = 1 and p_keys operator(pg_catalog.<@) array['low', 'medium', 'high', 'critical']::text[]
        and p_reasons operator(pg_catalog.<@) array['reputation_risk', 'severe_safety_risk']::text[]
      when 'response_need' then
        pg_catalog.cardinality(p_keys) = 1 and p_keys operator(pg_catalog.<@) array['no_response_needed', 'response_recommended', 'response_required', 'escalation_required']::text[]
        and pg_catalog.cardinality(p_reasons) = 0
      when 'language' then
        -- 1..4 canonical-case BCP-47 tags (language, optional script, optional region), as language.ts parses them.
        pg_catalog.cardinality(p_keys) <= 4
        and not exists (select 1 from pg_catalog.unnest(p_keys) as k where k !~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')
        and pg_catalog.cardinality(p_reasons) = 0
      else false
    end
$$;
revoke all on function classification.assessment_values_valid(text, text, text[], text[], numeric[], text[]) from public;

-- Spans are UTF-16 code-unit offsets [start, end) into the SOURCE text version (text-segments.ts); never text.
create function classification.source_spans_valid(p_starts integer[], p_ends integer[], p_max_spans integer)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select p_starts is not null and p_ends is not null
    and pg_catalog.array_ndims(p_starts) = 1
    and pg_catalog.cardinality(p_starts) between 1 and p_max_spans
    and pg_catalog.cardinality(p_ends) = pg_catalog.cardinality(p_starts)
    and not exists (
      select 1 from rows from (pg_catalog.unnest(p_starts), pg_catalog.unnest(p_ends)) as span(s, e)
       where s is null or e is null or s < 0 or e <= s or e > 32768)
$$;
revoke all on function classification.source_spans_valid(integer[], integer[], integer) from public;

-- A term's phrases (the term + explicit variants) or its exclude phrases: bounded, non-blank, no hashtag/mention marks
-- (their behavior is an open product decision; the matcher refuses them too). Tokenization is checked by the matcher.
create function classification.watch_phrases_valid(p_phrases text[], p_min integer)
returns boolean language sql immutable security invoker set search_path = '' as $$
  select p_phrases is not null
    and (pg_catalog.cardinality(p_phrases) = 0 or pg_catalog.array_ndims(p_phrases) = 1)
    and pg_catalog.cardinality(p_phrases) between p_min and 32
    and (select pg_catalog.count(distinct p) from pg_catalog.unnest(p_phrases) as p) = pg_catalog.cardinality(p_phrases)
    and not exists (
      select 1 from pg_catalog.unnest(p_phrases) as p
       where p is null or pg_catalog.char_length(p) not between 1 and 256 or pg_catalog.btrim(p) = '' or p ~ '[#@＃＠]' or p ~ '[[:cntrl:]]')
$$;
revoke all on function classification.watch_phrases_valid(text[], integer) from public;

-- ── classification.understanding_requests ─────────────────────────────────────────────────────────────────
-- One analysis per (immutable source text version, pipeline version): the uniqueness boundary is exactly that, so a
-- new pipeline version (shadow or reprocessing) is a NEW request and a retry is not. Never keyed by a text hash:
-- identical text on two interactions is two analyses (TA §58).
create table classification.understanding_requests (
  id                     uuid not null,
  organization_id        uuid not null,
  workspace_id           uuid not null,
  interaction_id         uuid not null,
  source_text_version_id uuid not null,
  pipeline_version       text not null check (pipeline_version ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  arrival                text not null check (arrival in ('realtime', 'reconciliation', 'backfill')),
  state                  text not null check (state in ('PENDING', 'DETERMINISTIC_DONE', 'AI_PENDING', 'AI_RUNNING', 'COMPLETED', 'AI_FAILED',
                                                        'DETERMINISTIC_ONLY', 'SKIPPED_OWN_BRAND', 'SKIPPED_SUPERSEDED')),
  created_at             timestamptz not null,
  updated_at             timestamptz not null,
  completed_at           timestamptz,
  primary key (workspace_id, id),
  constraint understanding_requests_once unique (workspace_id, source_text_version_id, pipeline_version),
  constraint understanding_requests_completion check (
    (state in ('COMPLETED', 'AI_FAILED', 'DETERMINISTIC_ONLY', 'SKIPPED_OWN_BRAND', 'SKIPPED_SUPERSEDED')) = (completed_at is not null)),
  constraint understanding_requests_times check (updated_at >= created_at and (completed_at is null or completed_at >= created_at)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, interaction_id, source_text_version_id) references interactions.source_text_versions (workspace_id, interaction_id, id)
);

-- A terminal request is final and nothing returns to PENDING (the runtime's own transitions are H7-B's).
-- SECURITY INVOKER, empty search_path: it reads only OLD/NEW.
create function classification.understanding_request_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if old.state in ('COMPLETED', 'AI_FAILED', 'DETERMINISTIC_ONLY', 'SKIPPED_OWN_BRAND', 'SKIPPED_SUPERSEDED') then
    raise exception 'a completed understanding request is final' using errcode = '23514';
  end if;
  if new.state = 'PENDING' and old.state <> 'PENDING' then
    raise exception 'an understanding request never returns to PENDING' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function classification.understanding_request_guard() from public;

create trigger understanding_request_guard before update on classification.understanding_requests
  for each row execute function classification.understanding_request_guard();

-- ── classification.assessments (append-only) ──────────────────────────────────────────────────────────────
-- One row = one assessment of one dimension of one immutable source text version (assessment.ts). The canonical text is
-- never copied: the row references the version. Origin-specific provenance columns are exactly the domain's method
-- identity; a watch term is NOT an origin (D-H7-3, S19). Raw model requests/responses, prompts and reasoning are never
-- stored here.
create table classification.assessments (
  id                        uuid not null,
  organization_id           uuid not null,
  workspace_id              uuid not null,
  interaction_id            uuid not null,
  source_text_version_id    uuid not null,
  dimension                 text not null check (dimension in ('safety', 'authenticity', 'intent', 'sentiment', 'topics', 'risk', 'response_need', 'language')),
  origin                    text not null check (origin in ('rule', 'ai', 'platform_hint', 'human')),
  outcome                   text not null check (outcome in ('values', 'abstained')),
  -- outcome = values: the keys with their per-value confidence (and optional score evidence); closed reason codes.
  value_keys                text[],
  confidence_levels         text[],
  confidence_scores         numeric[],
  reason_codes              text[] not null default '{}',
  -- outcome = abstained: the explicit abstention (never a value).
  abstention                text check (abstention in ('none_fits', 'insufficient_evidence')),
  -- language assessments with values: the detection certainty (language-policy.v1 needs it to tell validated from uncertain).
  language_certainty        text check (language_certainty in ('certain', 'uncertain')),
  taxonomy_version          text not null check (taxonomy_version in ('taxonomy.v1')),
  -- origin = rule: the one narrow fact the rule establishes (RULE_ESTABLISHES).
  rule_kind                 text check (rule_kind in ('link_reputation_malicious')),
  rule_version              text check (pg_catalog.char_length(rule_version) between 1 and 200),
  -- origin = ai: the model/task identity (TA §57); no prompt text, no response, no credential.
  provider                  text check (pg_catalog.char_length(provider) between 1 and 200),
  model                     text check (pg_catalog.char_length(model) between 1 and 200),
  model_version             text check (pg_catalog.char_length(model_version) between 1 and 200),
  task_id                   text check (pg_catalog.char_length(task_id) between 1 and 200),
  task_version              text check (pg_catalog.char_length(task_version) between 1 and 200),
  prompt_version            text check (pg_catalog.char_length(prompt_version) between 1 and 200),
  prompt_hash               text check (pg_catalog.char_length(prompt_hash) between 1 and 200),
  schema_version            text check (pg_catalog.char_length(schema_version) between 1 and 200),
  confidence_policy_version text check (pg_catalog.char_length(confidence_policy_version) between 1 and 200),
  -- origin = platform_hint
  hint_kind                 text check (pg_catalog.char_length(hint_kind) between 1 and 200),
  adapter_version           text check (pg_catalog.char_length(adapter_version) between 1 and 200),
  -- origin = human: the authoring member (no FK: history outlives a membership) and the assessment corrected, if any.
  actor_user_id             uuid,
  corrects_assessment_id    uuid,
  assessed_at               timestamptz not null,
  created_at                timestamptz not null,
  primary key (workspace_id, id),
  unique (workspace_id, interaction_id, dimension, id),
  -- Topic values belong to the `topics` module's catalog (M-10 open): refused until that module exists.
  constraint assessments_topics_deferred check (dimension <> 'topics'),
  constraint assessments_outcome_shape check (
    (outcome = 'values' and abstention is null
       and classification.assessment_values_valid(dimension, origin, value_keys, confidence_levels, confidence_scores, reason_codes))
    or (outcome = 'abstained' and abstention is not null and value_keys is null and confidence_levels is null and confidence_scores is null
       and pg_catalog.cardinality(reason_codes) = 0)),
  constraint assessments_language_certainty check ((dimension = 'language' and outcome = 'values') = (language_certainty is not null)),
  -- Each origin carries exactly its own provenance columns and none of another origin's.
  constraint assessments_rule_shape check (
    case when origin = 'rule'
      then rule_kind is not null and rule_version is not null
           and outcome = 'values' and dimension = 'safety' and rule_kind = 'link_reputation_malicious' and value_keys = array['malicious_link']::text[]
      else rule_kind is null and rule_version is null end),
  constraint assessments_ai_shape check (
    case when origin = 'ai'
      then provider is not null and model is not null and task_id is not null and task_version is not null and prompt_version is not null
           and prompt_hash is not null and schema_version is not null and confidence_policy_version is not null
      else provider is null and model is null and model_version is null and task_id is null and task_version is null and prompt_version is null
           and prompt_hash is null and schema_version is null and confidence_policy_version is null end),
  constraint assessments_hint_shape check (
    case when origin = 'platform_hint' then hint_kind is not null and adapter_version is not null else hint_kind is null and adapter_version is null end),
  constraint assessments_human_shape check (
    case when origin = 'human' then actor_user_id is not null else actor_user_id is null and corrects_assessment_id is null end),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- The assessed version is one of the interaction's OWN versions (never "current text").
  foreign key (workspace_id, interaction_id, source_text_version_id) references interactions.source_text_versions (workspace_id, interaction_id, id),
  -- A correction names an assessment of the SAME interaction and dimension.
  foreign key (workspace_id, interaction_id, dimension, corrects_assessment_id) references classification.assessments (workspace_id, interaction_id, dimension, id)
);
-- A machine assessment is unique per (source text version, dimension, method identity) — assessmentIdentityKey() of the
-- domain: a retried computation can't add a duplicate; a new model/prompt/task/rule version can. Human rows are appended.
create unique index assessments_machine_identity on classification.assessments (
  workspace_id, source_text_version_id, dimension, origin, rule_kind, rule_version, task_id, task_version, prompt_version, prompt_hash, schema_version,
  (case when origin = 'ai' then taxonomy_version end), provider, model, model_version, hint_kind, adapter_version)
  nulls not distinct where origin <> 'human';

-- ── classification.watch_term_revisions / watch_terms (append-only) ─────────────────────────────────────────
-- Workspace-local deterministic rules (H7-A0 §7.2, D-H7-3): a revision is an immutable rule set; a term keeps its id
-- across revisions. No regex, wildcard, stemming, category, priority, protection or moderation field exists. Product
-- limits stay OPEN (the matcher's technical bounds are not plan limits). Who may author a revision is not yet decided:
-- no runtime role may write these tables until that decision adds its policy.
create table classification.watch_term_revisions (
  id                 uuid not null,
  organization_id    uuid not null,
  workspace_id       uuid not null,
  revision           integer not null check (revision >= 1),
  created_by_user_id uuid not null,
  created_at         timestamptz not null,
  primary key (workspace_id, id),
  constraint watch_term_revisions_once unique (workspace_id, revision),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade
);

create table classification.watch_terms (
  organization_id  uuid not null,
  workspace_id     uuid not null,
  revision_id      uuid not null,
  term_id          uuid not null,
  phrases          text[] not null,
  excludes         text[] not null default '{}',
  accent_sensitive boolean not null default false,
  created_at       timestamptz not null,
  primary key (workspace_id, revision_id, term_id),
  constraint watch_terms_phrases check (classification.watch_phrases_valid(phrases, 1)),
  constraint watch_terms_excludes check (classification.watch_phrases_valid(excludes, 0)),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, revision_id) references classification.watch_term_revisions (workspace_id, id)
);

-- ── classification.signals (append-only) ──────────────────────────────────────────────────────────────────
-- Facts, not meaning (signals.ts): there is no dimension, value, category, priority or confidence column. Evidence is
-- source spans only; the matched text is never stored.
create table classification.signals (
  id                     uuid not null,
  organization_id        uuid not null,
  workspace_id           uuid not null,
  interaction_id         uuid not null,
  source_text_version_id uuid not null,
  kind                   text not null check (kind in ('watch_term_match', 'link_present', 'text_empty', 'text_emoji_only', 'author_own_brand')),
  signals_version        text not null check (signals_version in ('signals.v1')),
  -- watch_term_match only: the rule identity (workspace-scoped revision + term) and the matcher that produced it.
  watch_term_revision_id uuid,
  watch_term_id          uuid,
  matcher_version        text check (matcher_version in ('watch-term-matcher.v1')),
  span_starts            integer[],
  span_ends              integer[],
  truncated              boolean not null default false,
  created_at             timestamptz not null,
  primary key (workspace_id, id),
  constraint signals_shape check (
    case kind
      when 'watch_term_match' then watch_term_revision_id is not null and watch_term_id is not null and matcher_version is not null
                                   and classification.source_spans_valid(span_starts, span_ends, 50)
      when 'link_present' then watch_term_revision_id is null and watch_term_id is null and matcher_version is null
                               and classification.source_spans_valid(span_starts, span_ends, 20)
      else watch_term_revision_id is null and watch_term_id is null and matcher_version is null
           and span_starts is null and span_ends is null and not truncated
    end),
  foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  foreign key (workspace_id, interaction_id, source_text_version_id) references interactions.source_text_versions (workspace_id, interaction_id, id),
  -- A watch-term signal names a term of a revision of the SAME workspace.
  foreign key (workspace_id, watch_term_revision_id, watch_term_id) references classification.watch_terms (workspace_id, revision_id, term_id)
);
-- One signal per (text version, kind, versions, rule identity): a re-run of the same matcher on the same version is a
-- no-op; a new matcher or rule-set revision adds history. Also serves "the signals of one text version".
create unique index signals_once on classification.signals (
  workspace_id, source_text_version_id, kind, signals_version, matcher_version, watch_term_revision_id, watch_term_id) nulls not distinct;

alter table classification.understanding_requests enable row level security;
alter table classification.understanding_requests force row level security;
alter table classification.assessments enable row level security;
alter table classification.assessments force row level security;
alter table classification.watch_term_revisions enable row level security;
alter table classification.watch_term_revisions force row level security;
alter table classification.watch_terms enable row level security;
alter table classification.watch_terms force row level security;
alter table classification.signals enable row level security;
alter table classification.signals force row level security;

reset role;

-- read: non-guest members of the BOUND workspace · machine writes: the job runtime, its bound workspace, never `human`
-- · human corrections: the bound workspace's members with `workflow.internal` (TA §10.3 "correct labels": Owner,
-- Admin, Manager, Responder), as themselves · guests: nothing (TA §49) · WEB holds no machine-origin write (D-H7-6).
create policy worker_read on classification.understanding_requests for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_insert on classification.understanding_requests for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and state = 'PENDING' and completed_at is null);
create policy worker_update on classification.understanding_requests for update to app_worker
  using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()));

create policy member_read on classification.assessments for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy member_correct on classification.assessments for insert to authenticated
  with check (workspace_id = (select app.current_workspace()) and origin = 'human' and actor_user_id = (select auth.uid())
              and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER'));
create policy worker_read on classification.assessments for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on classification.assessments for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and origin <> 'human');

create policy member_read on classification.watch_term_revisions for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on classification.watch_term_revisions for select to app_worker using (workspace_id = (select app.current_workspace()));

create policy member_read on classification.watch_terms for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on classification.watch_terms for select to app_worker using (workspace_id = (select app.current_workspace()));

create policy member_read on classification.signals for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'));
create policy worker_read on classification.signals for select to app_worker using (workspace_id = (select app.current_workspace()));
create policy worker_append on classification.signals for insert to app_worker with check (workspace_id = (select app.current_workspace()));

grant usage on schema classification to authenticated, app_worker;
-- The CHECK validators run as the inserting role.
grant execute on function classification.assessment_values_valid(text, text, text[], text[], numeric[], text[]) to authenticated, app_worker;
grant execute on function classification.source_spans_valid(integer[], integer[], integer) to app_worker;
grant execute on function classification.watch_phrases_valid(text[], integer) to app_worker;

grant select, insert on classification.understanding_requests to app_worker;
grant update (state, completed_at, updated_at) on classification.understanding_requests to app_worker;
grant select, insert on classification.assessments to authenticated, app_worker;   -- append-only
grant select on classification.watch_term_revisions, classification.watch_terms to authenticated, app_worker;
grant select on classification.signals to authenticated;
grant select, insert on classification.signals to app_worker;                     -- append-only
