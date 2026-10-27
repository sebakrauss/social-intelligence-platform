-- 0020 · Audit provenance: the members' direct audit append is narrowed to the action pipeline's own events (Step
-- H6-C3d; TL decision "narrow allowlist"). Forward-only: the WITH CHECK of 0003's `append_own` is replaced in place,
-- and ONE helper it needs is added (audit.bound_workspace_organization, EXECUTE for authenticated only). No table,
-- column, other grant or other policy changes; no audit row is read, rewritten or deleted (historical rows stay exactly
-- as they are).
--
-- Before: any authenticated member could append a self-attributed event with ANY action the audit CHECK admits, in
-- ANY workspace or organization (0003 checked only actor_type = 'user' and actor_user_id = auth.uid()).
--
-- After, a member's direct append must be one of the action pipeline's events (server/pipeline, step 7), each bound
-- to the transaction's tenant context the way the pipeline writes it:
--   (a) workspace-scoped commands — the SEALED workspace, its organization, and a live member of that workspace
--       (or the actor's own removal from it, while still a member of its organization);
--   (b) organization-scoped commands — no workspace bound, a live member of the organization, and any named workspace
--       one of that organization's (visible to the actor); or the actor's own removal from the organization;
--   (c) user-scoped commands — no workspace bound, the actor's own (new) membership.
-- Every event produced by a reviewed SECURITY DEFINER or the job runtime is OUT of a member's reach:
--   connected_account.reconciliation_requested             only ingestion.request_reconciliation (0019)
--   connected_account.moved_out / moved_in / move_failed / move_rejected   only connections.record_move_audit (0010)
--   connection.validated                                    only the job runtime (actor `system`, 0003 worker policy)
--
-- Residual (documented, pinned by test): the pipeline's own actions remain appendable by a member within the tenant
-- the member belongs to — the database cannot tell the pipeline's INSERT from another one by the same role. Their
-- emission by an authoritative database boundary is a later gate. The self-removal exception admits a self-targeted
-- removal record only.
--
-- The policy is altered by the migration role (USAGE on `auth`, F-S2), as 0003 created it.

set role app_owner;

-- The organization of the transaction's SEALED workspace, answered only to a live member of that organization (NULL
-- otherwise). Members already know their own organization; anyone else learns nothing — no workspace → organization
-- or existence oracle, unlike app.current_workspace_organization(), which stays the job runtime's only.
create function audit.bound_workspace_organization() returns uuid
language sql stable security definer set search_path = '' as $$
  select w.organization_id from tenancy.workspaces w
   where w.id = app.current_workspace() and app.my_organization_role(w.organization_id) is not null
$$;
revoke all on function audit.bound_workspace_organization() from public;
grant execute on function audit.bound_workspace_organization() to authenticated;

reset role;

alter policy append_own on audit.audit_events
  with check (
    actor_type = 'user' and actor_user_id = (select auth.uid()) and organization_id is not null
    and (
      -- (a) workspace-scoped pipeline commands
      (
        workspace_id = (select app.current_workspace())
        and organization_id = (select audit.bound_workspace_organization())
        and action in (
          'workspace.mode_changed',
          'invitation.created', 'invitation.revoked',
          'workspace_membership.role_changed', 'workspace_membership.grants_changed', 'workspace_membership.removed',
          'connection.created', 'connection.credential_replaced', 'connection.status_changed', 'connection.removed',
          'connected_account.linked', 'connected_account.unlinked', 'connected_account.move_requested',
          'connected_account.capability_reevaluation_requested')
        and (
          app.my_workspace_role(workspace_id) is not null
          or (action = 'workspace_membership.removed'
              and target_id = workspace_id::text || ':' || (select auth.uid())::text)
        )
      )
      -- (b) organization-scoped pipeline commands
      or (
        (select app.current_workspace()) is null
        and action in (
          'workspace.created', 'invitation.created', 'invitation.revoked',
          'organization_membership.role_changed', 'organization_membership.removed', 'workspace_membership.removed')
        and (
          (
            app.my_organization_role(organization_id) is not null
            and (workspace_id is null or exists (
              select 1 from tenancy.workspaces w
               where w.id = audit_events.workspace_id and w.organization_id = audit_events.organization_id))
          )
          or (action in ('organization_membership.removed', 'workspace_membership.removed')
              and app.my_organization_role(organization_id) is null
              and target_id = coalesce(workspace_id, organization_id)::text || ':' || (select auth.uid())::text)
        )
      )
      -- (c) user-scoped pipeline commands
      or (
        (select app.current_workspace()) is null
        and action in ('organization.created', 'invitation.accepted')
        and app.my_organization_role(organization_id) is not null
        and (workspace_id is null or (action = 'invitation.accepted' and app.my_workspace_role(workspace_id) is not null))
      )
    )
  );
