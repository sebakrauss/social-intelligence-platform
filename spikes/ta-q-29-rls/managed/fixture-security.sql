-- DISPOSABLE MANAGED-SPIKE FIXTURE — part 2: RLS (enabled + forced), policies, least-privilege grants.
-- Executed as the bootstrap role (a member of spike_owner): in Supabase, spike_owner has no USAGE on schema `auth`
-- (and postgres cannot grant it: no grant option), so policies that reference the REAL auth.uid() are created by the
-- bootstrap role. Observed in the managed run as `42501 permission denied for schema auth` when created as spike_owner.

alter table spike29.organizations      enable row level security; alter table spike29.organizations      force row level security;
alter table spike29.workspaces         enable row level security; alter table spike29.workspaces         force row level security;
alter table spike29.memberships        enable row level security; alter table spike29.memberships        force row level security;
alter table spike29.conversations      enable row level security; alter table spike29.conversations      force row level security;
alter table spike29.interactions       enable row level security; alter table spike29.interactions       force row level security;
alter table spike29.guest_insights     enable row level security; alter table spike29.guest_insights     force row level security;
alter table spike29.attention_signals  enable row level security; alter table spike29.attention_signals  force row level security;
alter table spike29_system.outbox_meta enable row level security; alter table spike29_system.outbox_meta force row level security;

-- Forced RLS also binds the owner: definer helpers need an explicit owner read policy (R4).
create policy definer_read on spike29.memberships for select to spike_owner using (true);

-- Users (REAL Supabase role `authenticated`; identity from REAL auth.uid()).
create policy user_ops on spike29.conversations to authenticated
  using      (workspace_id = (select spike29_app.current_workspace())
              and (select spike29_app.member_role((select spike29_app.current_workspace()), (select auth.uid()))) in ('owner','admin','manager','responder','analyst'))
  with check (workspace_id = (select spike29_app.current_workspace())
              and (select spike29_app.member_role((select spike29_app.current_workspace()), (select auth.uid()))) in ('owner','admin','manager','responder','analyst'));
create policy user_ops on spike29.interactions to authenticated
  using      (workspace_id = (select spike29_app.current_workspace())
              and (select spike29_app.member_role((select spike29_app.current_workspace()), (select auth.uid()))) in ('owner','admin','manager','responder','analyst'))
  with check (workspace_id = (select spike29_app.current_workspace())
              and (select spike29_app.member_role((select spike29_app.current_workspace()), (select auth.uid()))) in ('owner','admin','manager','responder','analyst'));
create policy user_guest_read on spike29.guest_insights for select to authenticated
  using (workspace_id = (select spike29_app.current_workspace())
         and (select spike29_app.member_role((select spike29_app.current_workspace()), (select auth.uid()))) is not null);
create policy user_attention on spike29.attention_signals for select to authenticated
  using (spike29_app.member_role(workspace_id, (select auth.uid())) in ('owner','admin','manager','responder','analyst'));
create policy own_memberships on spike29.memberships for select to authenticated using (user_id = (select auth.uid()));

-- Workers
create policy worker_scope on spike29.conversations     to spike_app_worker using (workspace_id = (select spike29_app.current_workspace())) with check (workspace_id = (select spike29_app.current_workspace()));
create policy worker_scope on spike29.interactions      to spike_app_worker using (workspace_id = (select spike29_app.current_workspace())) with check (workspace_id = (select spike29_app.current_workspace()));
create policy worker_scope on spike29.guest_insights    to spike_app_worker using (workspace_id = (select spike29_app.current_workspace())) with check (workspace_id = (select spike29_app.current_workspace()));
create policy worker_scope on spike29.attention_signals to spike_app_worker using (workspace_id = (select spike29_app.current_workspace())) with check (workspace_id = (select spike29_app.current_workspace()));
-- System
create policy system_all on spike29_system.outbox_meta to spike_app_system using (true) with check (true);

grant usage on schema spike29, spike29_app to authenticated, spike_app_worker;
grant usage on schema spike29_system to spike_app_system;
revoke all on all functions in schema spike29_app from public;
grant execute on function spike29_app.current_workspace(), spike29_app.bind_context(uuid), spike29_app.member_role(uuid, uuid) to authenticated, spike_app_worker;
grant select, insert, update, delete on spike29.conversations, spike29.interactions to authenticated, spike_app_worker;
grant select on spike29.guest_insights, spike29.attention_signals, spike29.memberships to authenticated;
grant select, insert, update, delete on spike29.guest_insights, spike29.attention_signals to spike_app_worker;
grant select, insert, update on spike29_system.outbox_meta to spike_app_system;

