/**
 * Role tokens (PD §11.3; IA §18; TA §10.3). Stable, language-independent identifiers; display copy
 * lives in locale catalogs. The role set itself is PD: PROPOSED; permission rules are confirmed per
 * IA §18 / IA-09.
 */

/** Workspace roles, highest authority first. No other workspace roles exist. */
export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Organization roles: authority over organization settings (IA §9.1 / TA §9.1). `MEMBER` is ordinary
 * belonging without organization-management authority. Organization membership never implies access
 * to any workspace: workspace access requires a workspace membership.
 */
export const ORGANIZATION_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

const workspaceRoleSet: ReadonlySet<string> = new Set(WORKSPACE_ROLES);
const organizationRoleSet: ReadonlySet<string> = new Set(ORGANIZATION_ROLES);

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && workspaceRoleSet.has(value);
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === "string" && organizationRoleSet.has(value);
}
