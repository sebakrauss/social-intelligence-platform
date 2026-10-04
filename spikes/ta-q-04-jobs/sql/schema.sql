-- DISPOSABLE SPIKE SCHEMA — TA-Q-04 outbox integration shape. NOT THE PRODUCT SCHEMA. Synthetic data only.
-- (Tenant isolation is covered by the TA-Q-29 spike; this spike focuses on durability and idempotency.)

create table interactions (id uuid primary key, workspace_id uuid not null, body text not null);           -- "comment text" lives ONLY here
create table assessments  (interaction_id uuid not null references interactions(id), task_version text not null,
                           result text not null, primary key (interaction_id, task_version));                -- idempotency key = (entity, task version)
create table handler_log  (id bigserial primary key, task text not null, entity_id uuid not null, attempt int not null,
                           outcome text not null, at timestamptz not null default clock_timestamp());

-- Transactional outbox: written in the SAME transaction as the domain change.
create table outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task text not null,
  entity_id uuid not null,
  dispatch_key text not null unique,            -- doubles as the job runtime idempotency key
  status text not null default 'pending' check (status in ('pending','dispatched')),
  created_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz
);

-- Long-running import with checkpoints (resumable).
create table import_checkpoints (import_id uuid primary key, workspace_id uuid not null, next_page int not null default 1,
                                 total_pages int not null, completed boolean not null default false);
create table imported_items (import_id uuid not null, page int not null, primary key (import_id, page));

-- Mutation intents (TA §26). request_key = duplicate-submission guard.
create table mutation_intents (
  id uuid primary key, workspace_id uuid not null, request_key text not null unique,
  action text not null check (action in ('reply','hide')), target text not null, text_body text,
  status text not null default 'pending' check (status in ('pending','executing','confirmed','failed','outcome_unknown')),
  provider_ref text, updated_at timestamptz not null default clock_timestamp()
);

-- Fault injection switches for the spike.
create table faults (name text primary key, value text not null);

-- Simulated external social platform (stands in for Meta/TikTok; NOT our data).
create schema sim;
create table sim.replies (id bigserial primary key, parent text not null, body text not null, created_at timestamptz not null default clock_timestamp());
create table sim.hidden  (target text primary key, hidden boolean not null);
create table sim.calls   (id bigserial primary key, action text not null, target text not null, at timestamptz not null default clock_timestamp());
