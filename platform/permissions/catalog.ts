/**
 * The authoritative permission catalog: role → permission matrix, grant policy and escalation rules
 * (TA §10.3, §10.5; IA §18). Every server-side authorization check resolves through this module.
 * Permission and role tokens are defined in `domain/access`.
 *
 * Open questions are NOT settled here:
 * - PD OQ-23 (Responder management of Saved Replies / Brand Context): RESPONDER does not receive
 *   `responding.manage` and it is not grantable until the product owner decides.
 * - IA-09: recommendation decisions stay Owner/Admin/Manager only; Responders view only.
 */
import {
  ORGANIZATION_ROLES,
  WORKSPACE_ROLES,
  isPermissionKey,
  type OrganizationRole,
  type PermissionKey,
  type WorkspaceRole,
} from "@/domain/access";

const OWNER_ADMIN_MANAGER_COMMON: readonly PermissionKey[] = [
  "workspace.read_operational",
  "intelligence.read",
  "reports.read",
  "reply.public",
  "reply.private",
  "moderate.hide_unhide",
  "moderate.delete",
  "moderate.block",
  "workflow.internal",
  "automation.configure",
  "recommendations.decide",
  "responding.manage",
  "escalation.default_contact.set",
  "attention.read",
];

const ADMIN_ONLY: readonly PermissionKey[] = [
  "connections.manage",
  "members.manage",
  "workspace.mode.change",
  "organization.manage",
];

/** Default workspace-role permissions: TA §10.3 matrix, exactly. */
export const WORKSPACE_ROLE_PERMISSIONS: { readonly [R in WorkspaceRole]: ReadonlySet<PermissionKey> } = {
  OWNER: new Set([...OWNER_ADMIN_MANAGER_COMMON, ...ADMIN_ONLY, "billing.manage"]),
  ADMIN: new Set([...OWNER_ADMIN_MANAGER_COMMON, ...ADMIN_ONLY]),
  MANAGER: new Set(OWNER_ADMIN_MANAGER_COMMON),
  RESPONDER: new Set([
    "workspace.read_operational",
    "intelligence.read",
    "reports.read",
    "reply.public",
    "reply.private",
    "moderate.hide_unhide",
    "workflow.internal",
    "attention.read",
  ]),
  ANALYST_VIEWER: new Set(["workspace.read_operational", "intelligence.read", "reports.read", "attention.read"]),
  // Vocabulary only: guest queries must still be served from guest-safe projections (TA §49).
  CLIENT_GUEST: new Set(["intelligence.read", "reports.read"]),
};

/** Organization-scoped authority (organization settings, workspaces, billing). Never workspace content. */
export const ORGANIZATION_ROLE_PERMISSIONS: { readonly [R in OrganizationRole]: ReadonlySet<PermissionKey> } = {
  OWNER: new Set(["organization.manage", "billing.manage"]),
  ADMIN: new Set(["organization.manage"]),
  MEMBER: new Set(),
};

/**
 * Explicit grants: the only permissions a membership may receive beyond its role defaults.
 * Grants only add; they never remove role defaults. Responder delete/block "grant only" (TA §10.3).
 */
export const GRANT_POLICY: { readonly [R in WorkspaceRole]: ReadonlySet<PermissionKey> } = {
  OWNER: new Set(),
  ADMIN: new Set(),
  MANAGER: new Set(),
  RESPONDER: new Set(["moderate.delete", "moderate.block"]),
  ANALYST_VIEWER: new Set(),
  CLIENT_GUEST: new Set(),
};

export function isGrantable(role: WorkspaceRole, permission: unknown): permission is PermissionKey {
  return isPermissionKey(permission) && GRANT_POLICY[role].has(permission);
}

/** Role defaults plus the grants that are valid for this role. Invalid or stale grants are ignored. */
export function effectivePermissions(role: WorkspaceRole, grants: readonly unknown[]): ReadonlySet<PermissionKey> {
  const permissions = new Set(WORKSPACE_ROLE_PERMISSIONS[role]);
  for (const grant of grants) {
    if (isGrantable(role, grant)) {
      permissions.add(grant);
    }
  }
  return permissions;
}

function rank<R extends string>(order: readonly R[], role: R): number {
  return order.length - order.indexOf(role);
}

/**
 * Role escalation (TA §10.5): nobody grants a role above their own; only an Owner grants Owner.
 * Requires `members.manage`, checked separately by the caller.
 */
export function canAssignWorkspaceRole(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  if (target === "OWNER") return actor === "OWNER";
  return rank(WORKSPACE_ROLES, target) <= rank(WORKSPACE_ROLES, actor);
}

/** An actor may change or remove a membership only if its current role isn't above the actor's own. */
export function canManageWorkspaceMember(actor: WorkspaceRole, memberRole: WorkspaceRole): boolean {
  return canAssignWorkspaceRole(actor, memberRole);
}

/** Grants follow the same rule: an actor can only grant permissions it holds itself. */
export function canGrant(actorPermissions: ReadonlySet<PermissionKey>, permission: PermissionKey): boolean {
  return actorPermissions.has(permission);
}

export function canAssignOrganizationRole(actor: OrganizationRole, target: OrganizationRole): boolean {
  if (target === "OWNER") return actor === "OWNER";
  return rank(ORGANIZATION_ROLES, target) <= rank(ORGANIZATION_ROLES, actor);
}

/** An actor may change or remove an organization membership only if its role isn't above the actor's own. */
export function canManageOrganizationMember(actor: OrganizationRole, memberRole: OrganizationRole): boolean {
  return canAssignOrganizationRole(actor, memberRole);
}
