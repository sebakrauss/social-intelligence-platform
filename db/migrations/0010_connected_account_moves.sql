-- 0010 · Connected Account linking, M-01 and the Move saga (Step 5F, hardened in Step 5G; TA §8; PD D-50; Model §53-D;
-- decision D4). Forward-only. Owner-only policies for reviewed definer functions, four narrow definer functions, one
-- exact pinned rewrite of a closed vocabulary, and ONE deliberate narrowing (G6): a RESTRICTIVE policy that keeps web
-- and worker from inserting Move saga outbox rows directly. No table, column, grant or other runtime policy changes,
-- no generic organization-wide policy is created for web/worker access, and no role is created.
--
--   connections.locate_active_link(discovered_asset)   where an asset discovered in the BOUND workspace is active in
--                                                       the bound workspace's organization: (workspace, account) or
--                                                       nothing. Not found = active in another organization = absent.
--   connections.route_move_step(move, step, …)          the ONLY way a Move saga outbox row is created. One closed
--                                                       transition per step, derived from the LOCAL asset_moves row
--                                                       (the caller never names the counterpart). Identifier-only
--                                                       payload; deterministic dispatch key per routed step:
--                                                         release_source        INCOMING REQUESTED → source (web, initiator)
--                                                         activate_destination  OUTGOING RELEASED  → destination (worker)
--                                                         reject_destination    OUTGOING REJECTED  → destination (worker)
--                                                         retry_activation      INCOMING ACTIVATION_FAILED → THIS workspace
--                                                                               (web, Owner/Admin; a new durable attempt)
--                                                       Returns (routed, outbox_id): the new row's id lets the caller
--                                                       wake the relay AFTER commit (G5); it is null for a duplicate.
--   connections.move_initiator_can_manage(move)        the worker's re-check of the human initiator's LIVE Owner/Admin
--                                                       authority in the bound workspace (boolean only)
--   connections.record_move_audit(move, step, corr.)    saga audit attributed to the human initiator (TA §41.1), from
--                                                       the LOCAL asset_moves row only; closed step → action/side/state
--
-- Correlation ids passed to the definers are TRACE METADATA ONLY (G1): they never take part in authorization,
-- workspace or initiator resolution, move selection or routing. Every function requires the sealed workspace context,
-- touches only the bound workspace's rows (plus, for locate/route, the organization's ACTIVE connected accounts) and
-- has EXECUTE granted exactly. Owner policies admit only these definer reads/writes: forced RLS binds app_owner too,
-- and no runtime role can SET ROLE app_owner.

set role app_owner;

-- ── TA-Q-02 rejection reason: exact pinned rewrite of the inline reason_code CHECK ───────────────────────────────
-- The TEMPORARY TA-Q-02 ad-account restriction gets its own closed reason, distinct from ASSET_ACTIVE_ELSEWHERE (M-01),
-- so relaxing TA-Q-02 later never touches M-01 semantics. SOURCE_RELEASE_REJECTED (G4) is the destination's closed,
-- non-sensitive outcome when the source refused to release: the precise source reason (AUTHORITY_REVOKED,
-- SOURCE_NOT_ACTIVE) stays on the SOURCE side only. Same values as 0007 plus exactly these two.
alter table connections.asset_moves drop constraint asset_moves_reason_code_check;
alter table connections.asset_moves add constraint asset_moves_reason_code_check check (reason_code in (
  'SOURCE_NOT_ACTIVE', 'AUTHORITY_REVOKED', 'DESTINATION_CONNECTION_UNHEALTHY', 'ASSET_ACTIVE_ELSEWHERE',
  'ASSET_NOT_DISCOVERED', 'ACTIVATION_RETRIES_EXHAUSTED', 'AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION',
  'SOURCE_RELEASE_REJECTED')) not valid;
alter table connections.asset_moves validate constraint asset_moves_reason_code_check;

-- ── Owner-only policies (definer functions only) ─────────────────────────────────────────────────────────────────
-- Bound workspace only.
create policy owner_bound_read on connections.discovered_assets for select to app_owner
  using (workspace_id = (select app.current_workspace()));
create policy owner_bound_read on connections.asset_moves for select to app_owner
  using (workspace_id = (select app.current_workspace()));
-- The M-01 / TA-Q-02 lookup: ACTIVE rows of the bound workspace's organization only. app_owner only — web and worker
-- keep their bound-workspace policies; they learn at most (workspace, account) through locate_active_link.
create policy owner_organization_active_read on connections.connected_accounts for select to app_owner
  using (status = 'ACTIVE' and organization_id = (select app.current_workspace_organization()));

-- Move routing: exactly the three move topics, a human initiator, PENDING, and a LOCAL asset_moves row of the bound
-- workspace matching the routed row: cross-workspace steps go to its counterpart under its stored initiator; the local
-- retry stays in the bound workspace under the retrying user (the caller's verified claims).
create policy owner_move_route on system.outbox for insert to app_owner
  with check (
    status = 'PENDING' and initiator_type = 'user' and workspace_id is not null
    and topic in ('connections.move.release_source', 'connections.move.activate_destination', 'connections.move.reject_destination')
    and exists (
      select 1 from connections.asset_moves m
       where m.workspace_id = (select app.current_workspace())
         and m.move_id = (outbox.subject_ids ->> 'move_id')::uuid
         and m.organization_id = outbox.organization_id
         and ((m.counterpart_workspace_id = outbox.workspace_id and m.initiator_user_id = outbox.initiator_user_id
               and ((outbox.topic = 'connections.move.release_source' and m.side = 'INCOMING' and m.status = 'REQUESTED')
                 or (outbox.topic = 'connections.move.activate_destination' and m.side = 'OUTGOING' and m.status = 'RELEASED')
                 or (outbox.topic = 'connections.move.reject_destination' and m.side = 'OUTGOING' and m.status = 'REJECTED')))
           or (outbox.topic = 'connections.move.activate_destination' and m.side = 'INCOMING' and m.status = 'ACTIVATION_FAILED'
               and outbox.workspace_id = m.workspace_id and outbox.initiator_user_id = app_private.claimed_user()))));

-- G6: Move saga rows are created ONLY by connections.route_move_step. Web and worker keep their generic append
-- policies for every other topic; this RESTRICTIVE policy removes exactly the three saga topics from them, so no
-- runtime caller can release, activate or reject a move by appending a row to its own workspace's outbox.
create policy no_direct_move_routing on system.outbox as restrictive for insert to authenticated, app_worker
  with check (topic not in ('connections.move.release_source', 'connections.move.activate_destination', 'connections.move.reject_destination'));

-- Move audit: the human initiator of a LOCAL move, in the bound workspace and its organization, Move actions only.
-- app_worker's own policy is unchanged: it still cannot append actor_type = 'user'.
create policy owner_move_audit on audit.audit_events for insert to app_owner
  with check (
    actor_type = 'user' and actor_user_id is not null
    and workspace_id = (select app.current_workspace())
    and organization_id = (select app.current_workspace_organization())
    and target_type = 'asset_move'
    and action in ('connected_account.moved_out', 'connected_account.moved_in', 'connected_account.move_failed', 'connected_account.move_rejected')
    and exists (
      select 1 from connections.asset_moves m
       where m.workspace_id = (select app.current_workspace())
         and m.move_id::text = audit_events.target_id
         and m.initiator_user_id = audit_events.actor_user_id));

-- ── Definer functions ────────────────────────────────────────────────────────────────────────────────────────────
-- The caller's runtime is its LOGIN role's membership (session_user survives SET ROLE): web logins are members of
-- `authenticated`, worker logins of `app_worker` (the 0007 credential-function convention).

create function connections.locate_active_link(p_discovered_asset_id uuid)
returns table (active_workspace_id uuid, active_connected_account_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_workspace    uuid := app.current_workspace();
  v_organization uuid := app.current_workspace_organization();
  v_platform     text;
  v_asset        text;
  v_class        text;
begin
  if v_workspace is null or v_organization is null then
    raise exception 'locate active link: tenant context required' using errcode = '42501';
  end if;
  if pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER') then
    if app.my_workspace_role(v_workspace) is distinct from 'OWNER' and app.my_workspace_role(v_workspace) is distinct from 'ADMIN' then
      raise exception 'locate active link: not permitted' using errcode = '42501';
    end if;
  elsif not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'locate active link: not permitted' using errcode = '42501';
  end if;
  -- Asset identity comes from the bound workspace's own discovery, never from the caller.
  select d.platform, d.provider_asset_id, d.asset_class into v_platform, v_asset, v_class
    from connections.discovered_assets d
   where d.workspace_id = v_workspace and d.id = p_discovered_asset_id;
  if v_asset is null then
    return;
  end if;
  return query
    select a.workspace_id, a.id
      from connections.connected_accounts a
     where a.organization_id = v_organization and a.status = 'ACTIVE'
       and a.platform = v_platform and a.provider_asset_id = v_asset and a.asset_class = v_class
     order by a.workspace_id, a.id
     limit 1;
end $$;

create function connections.move_initiator_can_manage(p_move_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_workspace uuid := app.current_workspace();
begin
  if v_workspace is null or not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'move authority: not permitted' using errcode = '42501';
  end if;
  return exists (
    select 1
      from connections.asset_moves m
      join tenancy.workspace_memberships wm
        on wm.workspace_id = m.workspace_id and wm.user_id = m.initiator_user_id and wm.organization_id = m.organization_id
      join tenancy.organization_memberships om
        on om.organization_id = m.organization_id and om.user_id = m.initiator_user_id
     where m.workspace_id = v_workspace and m.move_id = p_move_id and wm.role in ('OWNER', 'ADMIN'));
end $$;

-- p_correlation_id is stored as trace metadata only; actor, workspace, organization, target and action come from the
-- bound workspace and the LOCAL move row.
create function connections.record_move_audit(p_move_id uuid, p_step text, p_correlation_id text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace    uuid := app.current_workspace();
  v_action       text;
  v_side         text;
  v_status       text;
  v_outcome      text;
  v_organization uuid;
  v_initiator    uuid;
begin
  if v_workspace is null or not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
    raise exception 'move audit: not permitted' using errcode = '42501';
  end if;
  case p_step
    when 'moved_out' then v_action := 'connected_account.moved_out'; v_side := 'OUTGOING'; v_status := 'RELEASED'; v_outcome := 'succeeded';
    when 'moved_in' then v_action := 'connected_account.moved_in'; v_side := 'INCOMING'; v_status := 'COMPLETED'; v_outcome := 'succeeded';
    when 'move_failed' then v_action := 'connected_account.move_failed'; v_side := 'INCOMING'; v_status := 'ACTIVATION_FAILED'; v_outcome := 'failed';
    when 'move_rejected' then v_action := 'connected_account.move_rejected'; v_side := null; v_status := 'REJECTED'; v_outcome := 'failed';
    else raise exception 'move audit: unknown step' using errcode = '22023';
  end case;
  select m.organization_id, m.initiator_user_id into v_organization, v_initiator
    from connections.asset_moves m
   where m.workspace_id = v_workspace and m.move_id = p_move_id and m.status = v_status
     and (v_side is null or m.side = v_side);
  if v_initiator is null then
    raise exception 'move audit: no local move in the required state' using errcode = 'P0002';
  end if;
  insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id,
                                  target_type, target_id, correlation_id, outcome, change)
  values (pg_catalog.gen_random_uuid(), pg_catalog.now(), v_action, 'user', v_initiator, v_organization, v_workspace,
          'asset_move', p_move_id::text, p_correlation_id, v_outcome, null);
end $$;

-- p_correlation_id and p_created_at are trace/delivery metadata only (G1): never part of any decision below.
create function connections.route_move_step(
  p_move_id uuid, p_step text, p_correlation_id text, p_created_at timestamptz, out routed boolean, out outbox_id uuid
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_workspace    uuid := app.current_workspace();
  v_side         text;
  v_status       text;
  v_topic        text;
  v_target       uuid;
  v_organization uuid;
  v_counterpart  uuid;
  v_initiator    uuid;
  v_platform     text;
  v_asset        text;
  v_account      uuid;
  v_subjects     jsonb;
  v_id           uuid := pg_catalog.gen_random_uuid();
  v_key          text;
  v_constraint   text;
begin
  routed := false;
  outbox_id := null;
  if v_workspace is null then
    raise exception 'move routing: tenant context required' using errcode = '42501';
  end if;
  case p_step
    when 'release_source' then
      if not pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER') then
        raise exception 'move routing: not permitted' using errcode = '42501';
      end if;
      v_side := 'INCOMING'; v_status := 'REQUESTED'; v_topic := 'connections.move.release_source';
    when 'activate_destination' then
      if not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
        raise exception 'move routing: not permitted' using errcode = '42501';
      end if;
      v_side := 'OUTGOING'; v_status := 'RELEASED'; v_topic := 'connections.move.activate_destination';
    when 'reject_destination' then
      if not pg_catalog.pg_has_role(session_user, 'app_worker', 'MEMBER') then
        raise exception 'move routing: not permitted' using errcode = '42501';
      end if;
      v_side := 'OUTGOING'; v_status := 'REJECTED'; v_topic := 'connections.move.reject_destination';
    when 'retry_activation' then
      if not pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER') then
        raise exception 'move routing: not permitted' using errcode = '42501';
      end if;
      v_side := 'INCOMING'; v_status := 'ACTIVATION_FAILED'; v_topic := 'connections.move.activate_destination';
    else
      raise exception 'move routing: unknown step' using errcode = '22023';
  end case;

  select m.organization_id, m.counterpart_workspace_id, m.initiator_user_id, m.platform, m.provider_asset_id
    into v_organization, v_counterpart, v_initiator, v_platform, v_asset
    from connections.asset_moves m
   where m.workspace_id = v_workspace and m.move_id = p_move_id and m.side = v_side and m.status = v_status;
  if v_counterpart is null then
    return;
  end if;

  v_subjects := pg_catalog.jsonb_build_object('move_id', p_move_id::text);
  v_target := v_counterpart;
  v_key := v_topic || ':' || p_move_id::text;
  if p_step = 'release_source' then
    -- Only the initiator, still Owner/Admin of the destination, routes the request.
    if v_initiator is distinct from app_private.claimed_user()
       or (app.my_workspace_role(v_workspace) is distinct from 'OWNER' and app.my_workspace_role(v_workspace) is distinct from 'ADMIN') then
      raise exception 'move routing: not permitted' using errcode = '42501';
    end if;
    -- The source must hold the active link right now; its account id is derived here, never supplied.
    select a.id into v_account
      from connections.connected_accounts a
     where a.organization_id = v_organization and a.workspace_id = v_counterpart and a.status = 'ACTIVE'
       and a.platform = v_platform and a.provider_asset_id = v_asset;
    if v_account is null then
      return;
    end if;
    v_subjects := pg_catalog.jsonb_build_object('move_id', p_move_id::text, 'connected_account_id', v_account::text,
                                                'counterpart_workspace_id', v_workspace::text);
  elsif p_step = 'retry_activation' then
    -- A human retry: Owner/Admin of THIS (destination) workspace; a NEW durable activation attempt, kept local and
    -- attributed (as initiator of the outbox row) to the retrying user. The move's stored initiator is unchanged.
    if app.my_workspace_role(v_workspace) is distinct from 'OWNER' and app.my_workspace_role(v_workspace) is distinct from 'ADMIN' then
      raise exception 'move routing: not permitted' using errcode = '42501';
    end if;
    v_target := v_workspace;
    v_initiator := app_private.claimed_user();
    v_key := v_topic || ':' || p_move_id::text || ':' || v_id::text;
  end if;

  -- Deterministic dispatch key per routed step: routing the same step twice is a no-op (outbox_id stays null).
  -- (ON CONFLICT would also apply SELECT policies, and app_owner deliberately can't read the outbox: caught instead.)
  begin
    insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type,
                               initiator_user_id, dispatch_key, status, created_at)
    values (v_id, v_topic, v_organization, v_target, v_subjects, p_correlation_id, 'user', v_initiator, v_key, 'PENDING', p_created_at);
    outbox_id := v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'outbox_dispatch_key_key' then
      raise;
    end if;
  end;
  routed := true;
end $$;

revoke all on function
  connections.locate_active_link(uuid),
  connections.move_initiator_can_manage(uuid),
  connections.record_move_audit(uuid, text, text),
  connections.route_move_step(uuid, text, text, timestamptz)
from public;
grant execute on function connections.locate_active_link(uuid) to authenticated, app_worker;
grant execute on function connections.route_move_step(uuid, text, text, timestamptz) to authenticated, app_worker;
grant execute on function connections.move_initiator_can_manage(uuid) to app_worker;
grant execute on function connections.record_move_audit(uuid, text, text) to app_worker;

reset role;
