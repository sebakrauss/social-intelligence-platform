-- 0012 · Remove invalidates open fresh Meta authorization attempts (Step 7G-F4C; TL decisions D1/D2). Forward-only and
-- additive: two owner-only policies on connections.connect_attempts (bound workspace) and ONE reviewed, write-only
-- SECURITY DEFINER function. No runtime policy, grant, column or vocabulary changes: the web keeps creator-only
-- attempt visibility (creator_read / creator_update) for every ordinary read and write.
--
--   connections.invalidate_open_fresh_meta_attempts(closed_at)
--       Called by a Meta Connection removal, under K(workspace, meta), in the same transaction. It closes EVERY open
--       fresh Meta attempt of the BOUND workspace, whoever created it, so an OAuth flow that began before the removal
--       can never complete afterwards (REMOVE_INVALIDATES_OPEN_FRESH_META_ATTEMPTS):
--         PENDING    → CANCELLED                                   (closed_at)
--         EXCHANGING → EXCHANGE_FAILED / CONNECTION_UNAVAILABLE     (closed_at; EXCHANGING → CANCELLED would break
--                                                                   0008's connect_attempts_exchange_recorded)
--       Untouched: reconnect attempts, other providers, other workspaces and every terminal attempt.
--       Write-only: returns void — no rows, no count, no creator, no digest. The workspace is the sealed transaction
--       context, never a parameter; the provider is fixed here. Web callers only, with live Owner/Admin authority in
--       the bound workspace (connections.manage), by the 0007 credential-function convention.

set role app_owner;

-- Forced RLS binds the owner too: these admit only the definer below (no runtime role can SET ROLE app_owner), and
-- only rows of the sealed workspace. An UPDATE that reads columns also needs a SELECT policy.
create policy owner_bound_read on connections.connect_attempts for select to app_owner
  using (workspace_id = (select app.current_workspace()));
create policy owner_bound_invalidate on connections.connect_attempts for update to app_owner
  using (workspace_id = (select app.current_workspace()))
  with check (workspace_id = (select app.current_workspace()));

create function connections.invalidate_open_fresh_meta_attempts(p_closed_at timestamptz) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
begin
  if v_workspace is null then
    raise exception 'attempt invalidation: tenant context required' using errcode = '42501';
  end if;
  if not pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER')
     or (app.my_workspace_role(v_workspace) is distinct from 'OWNER' and app.my_workspace_role(v_workspace) is distinct from 'ADMIN') then
    raise exception 'attempt invalidation: not permitted' using errcode = '42501';
  end if;
  if p_closed_at is null then
    raise exception 'attempt invalidation: closing time required' using errcode = '22023';
  end if;
  update connections.connect_attempts a
     set status = 'CANCELLED', closed_at = p_closed_at
   where a.workspace_id = v_workspace and a.provider = 'meta' and a.reconnect_connection_id is null and a.status = 'PENDING';
  update connections.connect_attempts a
     set status = 'EXCHANGE_FAILED', closed_at = p_closed_at, failure_code = 'CONNECTION_UNAVAILABLE'
   where a.workspace_id = v_workspace and a.provider = 'meta' and a.reconnect_connection_id is null and a.status = 'EXCHANGING';
end $$;

revoke all on function connections.invalidate_open_fresh_meta_attempts(timestamptz) from public;
grant execute on function connections.invalidate_open_fresh_meta_attempts(timestamptz) to authenticated;

reset role;
