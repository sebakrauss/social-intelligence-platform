-- TEST ONLY · T-26 isolation fixture. NOT part of the product schema and never applied by migrations.
-- Minimal workspace-content tables (stand-ins for future operational data) that exercise the PRODUCTION
-- context functions, membership helpers, roles and grant model: content readable/writable only in the
-- bound workspace by non-guest members, guest projections readable by any member, workers bound to one
-- workspace, composite workspace foreign keys (R5). Synthetic data only.
--
-- Idempotent and long-lived (R8: no teardown of shared objects): applied once per database by the test
-- harness as the migration role; managed runs delete only their own rows.
do $fixture$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 't26_fixture') then
    return;
  end if;

  execute 'create schema t26_fixture authorization app_owner';
  execute 'revoke all on schema t26_fixture from public';
  execute 'set local role app_owner';
  execute $sql$
    create table t26_fixture.conversations (
      id           uuid primary key,
      workspace_id uuid not null references tenancy.workspaces (id) on delete cascade,
      title        text not null,
      unique (workspace_id, id)
    )$sql$;
  execute $sql$
    create table t26_fixture.interactions (
      id              uuid primary key,
      workspace_id    uuid not null references tenancy.workspaces (id) on delete cascade,
      conversation_id uuid not null,
      body            text not null,
      foreign key (workspace_id, conversation_id) references t26_fixture.conversations (workspace_id, id) on delete cascade
    )$sql$;
  execute $sql$
    create table t26_fixture.guest_projections (
      id           uuid primary key,
      workspace_id uuid not null references tenancy.workspaces (id) on delete cascade,
      statement    text not null
    )$sql$;
  execute 'alter table t26_fixture.conversations enable row level security';
  execute 'alter table t26_fixture.conversations force row level security';
  execute 'alter table t26_fixture.interactions enable row level security';
  execute 'alter table t26_fixture.interactions force row level security';
  execute 'alter table t26_fixture.guest_projections enable row level security';
  execute 'alter table t26_fixture.guest_projections force row level security';
  execute 'grant usage on schema t26_fixture to authenticated, app_worker';
  execute 'grant select, insert, update, delete on t26_fixture.conversations, t26_fixture.interactions to authenticated, app_worker';
  execute 'grant select on t26_fixture.guest_projections to authenticated';
  execute 'grant select, insert, update, delete on t26_fixture.guest_projections to app_worker';
  execute 'reset role';

  -- Policies (created by the migration role, as owner member). Non-guest roles only for content.
  execute $sql$
    create policy user_content on t26_fixture.conversations to authenticated
      using (workspace_id = (select app.current_workspace())
             and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'))
      with check (workspace_id = (select app.current_workspace())
             and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'))$sql$;
  execute $sql$
    create policy user_content on t26_fixture.interactions to authenticated
      using (workspace_id = (select app.current_workspace())
             and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'))
      with check (workspace_id = (select app.current_workspace())
             and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER', 'ANALYST_VIEWER'))$sql$;
  execute $sql$
    create policy member_read on t26_fixture.guest_projections for select to authenticated
      using (workspace_id = (select app.current_workspace()) and app.my_workspace_role(workspace_id) is not null)$sql$;
  execute $sql$
    create policy worker_bound on t26_fixture.conversations to app_worker
      using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()))$sql$;
  execute $sql$
    create policy worker_bound on t26_fixture.interactions to app_worker
      using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()))$sql$;
  execute $sql$
    create policy worker_bound on t26_fixture.guest_projections to app_worker
      using (workspace_id = (select app.current_workspace())) with check (workspace_id = (select app.current_workspace()))$sql$;
end
$fixture$;
