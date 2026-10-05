-- 0004 · Transactional outbox foundation (TA §10.6 step 8; CLAUDE.md §10). Table and grants only:
-- the relay, dispatch, retries and sweepers are Step 3.
--
-- A row is written in the same transaction as the state change it follows up, and describes the async
-- work by identifiers only (no content, credentials, secrets or request payloads). Web users may append
-- but never read; workers append for their bound workspace; the system role reads and updates delivery
-- metadata only, and has no access to any tenant table.

create schema system authorization app_owner;
revoke all on schema system from public;

set role app_owner;

-- Subject IDs are a flat map of snake_case names to UUIDs: identifiers only, by construction.
create function system.is_identifier_map(p_subject_ids jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_typeof(p_subject_ids) = 'object'
     and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_subject_ids)) <= 16
     and not exists (
       select 1 from pg_catalog.jsonb_each(p_subject_ids) e
       where e.key !~ '^[a-z][a-z0-9_]{0,62}$'
          or pg_catalog.jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     )
$$;

create table system.outbox (
  id                uuid primary key,
  topic             text not null check (topic ~ '^[a-z][a-z_]{0,40}(\.[a-z][a-z_]{0,40}){1,3}$'),
  organization_id   uuid,
  workspace_id      uuid,
  subject_ids       jsonb not null default '{}' check (system.is_identifier_map(subject_ids)),
  correlation_id    text not null check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  initiator_type    text not null check (initiator_type in ('user', 'policy', 'system')),
  initiator_user_id uuid,
  dispatch_key      text not null unique check (dispatch_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  status            text not null default 'PENDING' check (status in ('PENDING', 'DISPATCHED')),
  created_at        timestamptz not null,
  dispatched_at     timestamptz,
  check ((initiator_type = 'user') = (initiator_user_id is not null)),
  check ((status = 'DISPATCHED') = (dispatched_at is not null))
);
create index outbox_pending on system.outbox (created_at) where status = 'PENDING';

alter table system.outbox enable row level security;
alter table system.outbox force row level security;

reset role;

create policy append_own on system.outbox for insert to authenticated
  with check (
    initiator_type = 'user' and initiator_user_id = (select auth.uid()) and status = 'PENDING'
    and (workspace_id is null or workspace_id = (select app.current_workspace()))
  );
create policy append_bound_workspace on system.outbox for insert to app_worker
  with check (workspace_id = (select app.current_workspace()) and initiator_type in ('policy', 'system') and status = 'PENDING');
create policy delivery_metadata on system.outbox for select to app_system using (true);
create policy delivery_status on system.outbox for update to app_system using (true) with check (true);

set role app_owner;

grant usage on schema system to authenticated, app_worker, app_system;
grant insert on system.outbox to authenticated, app_worker;                -- no read for web users or workers
grant select on system.outbox to app_system;
grant update (status, dispatched_at) on system.outbox to app_system;
grant execute on function system.is_identifier_map(jsonb) to authenticated, app_worker, app_system;

reset role;
