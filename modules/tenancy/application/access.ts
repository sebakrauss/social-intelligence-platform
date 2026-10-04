/**
 * Live access lookups used by the action pipeline's tenant resolution (TA §10.6 step 2).
 * Nothing is cached: removing a membership takes effect on the next request.
 */
import type { OrganizationId, UserId, WorkspaceId } from "@/domain/ids";
import type { Organization, OrganizationMembership, Workspace, WorkspaceMembership } from "../domain/model";
import type { TenancyStore } from "./ports";

export interface WorkspaceAccess {
  readonly workspace: Workspace;
  readonly membership: WorkspaceMembership;
}

export interface OrganizationAccess {
  readonly organization: Organization;
  readonly membership: OrganizationMembership;
}

/**
 * Access to a workspace requires a workspace membership AND continued organization membership.
 * Organization membership alone never grants workspace access. Undefined means "not found" to the
 * caller, whether the workspace doesn't exist or the user isn't a member (no existence leak).
 */
export async function loadWorkspaceAccess(
  store: TenancyStore,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<WorkspaceAccess | undefined> {
  const workspace = await store.workspaces.get(workspaceId);
  if (workspace === undefined) return undefined;
  const membership = await store.workspaceMemberships.find(workspaceId, userId);
  if (membership?.organizationId !== workspace.organizationId) return undefined;
  const organizationMembership = await store.organizationMemberships.find(workspace.organizationId, userId);
  if (organizationMembership === undefined) return undefined;
  return { workspace, membership };
}

export async function loadOrganizationAccess(
  store: TenancyStore,
  organizationId: OrganizationId,
  userId: UserId,
): Promise<OrganizationAccess | undefined> {
  const organization = await store.organizations.get(organizationId);
  if (organization === undefined) return undefined;
  const membership = await store.organizationMemberships.find(organizationId, userId);
  return membership === undefined ? undefined : { organization, membership };
}
