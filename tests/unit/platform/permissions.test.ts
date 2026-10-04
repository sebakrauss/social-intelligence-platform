import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS, WORKSPACE_ROLES, type PermissionKey, type WorkspaceRole } from "@/domain/access";
import {
  GRANT_POLICY,
  ORGANIZATION_ROLE_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
  canAssignOrganizationRole,
  canAssignWorkspaceRole,
  canGrant,
  canManageWorkspaceMember,
  effectivePermissions,
  isGrantable,
} from "@/platform/permissions";

const Y = true;
const N = false;

/** TA §10.3 default matrix, transcribed row by row: Owner, Admin, Manager, Responder, Analyst/Viewer, Client guest. */
const MATRIX: { readonly [P in PermissionKey]: readonly [boolean, boolean, boolean, boolean, boolean, boolean] } = {
  "workspace.read_operational": [Y, Y, Y, Y, Y, N],
  "intelligence.read": [Y, Y, Y, Y, Y, Y],
  "reports.read": [Y, Y, Y, Y, Y, Y],
  "reply.public": [Y, Y, Y, Y, N, N],
  "reply.private": [Y, Y, Y, Y, N, N],
  "moderate.hide_unhide": [Y, Y, Y, Y, N, N],
  "moderate.delete": [Y, Y, Y, N, N, N], // Responder: grant only
  "moderate.block": [Y, Y, Y, N, N, N], // Responder: grant only
  "workflow.internal": [Y, Y, Y, Y, N, N],
  "automation.configure": [Y, Y, Y, N, N, N],
  "recommendations.decide": [Y, Y, Y, N, N, N],
  "responding.manage": [Y, Y, Y, N, N, N], // Responder: PD OQ-23 open — not granted by default
  "escalation.default_contact.set": [Y, Y, Y, N, N, N],
  "connections.manage": [Y, Y, N, N, N, N],
  "members.manage": [Y, Y, N, N, N, N],
  "workspace.mode.change": [Y, Y, N, N, N, N],
  "organization.manage": [Y, Y, N, N, N, N],
  "billing.manage": [Y, N, N, N, N, N],
  "attention.read": [Y, Y, Y, Y, Y, N],
};

describe("permission catalog (TA §10.3)", () => {
  it("covers every permission key exactly once", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it.each(WORKSPACE_ROLES.map((role, column) => [role, column] as const))("default permissions for %s match the matrix", (role, column) => {
    const expected = PERMISSION_KEYS.filter((permission) => MATRIX[permission][column]).sort();
    expect([...WORKSPACE_ROLE_PERMISSIONS[role]].sort()).toEqual(expected);
  });

  it("gives Client guests intelligence/report vocabulary only and no operational read", () => {
    expect([...WORKSPACE_ROLE_PERMISSIONS.CLIENT_GUEST].sort()).toEqual(["intelligence.read", "reports.read"]);
    expect(WORKSPACE_ROLE_PERMISSIONS.CLIENT_GUEST.has("workspace.read_operational")).toBe(false);
    expect(WORKSPACE_ROLE_PERMISSIONS.CLIENT_GUEST.has("attention.read")).toBe(false);
  });

  it("keeps PD OQ-23 open: Responder neither has nor can be granted responding.manage", () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.RESPONDER.has("responding.manage")).toBe(false);
    expect(isGrantable("RESPONDER", "responding.manage")).toBe(false);
  });

  it("keeps recommendation decisions Owner/Admin/Manager only (IA-09)", () => {
    expect(WORKSPACE_ROLE_PERMISSIONS.RESPONDER.has("recommendations.decide")).toBe(false);
    expect(isGrantable("RESPONDER", "recommendations.decide")).toBe(false);
  });

  it("separates organization authority from workspace access", () => {
    expect([...ORGANIZATION_ROLE_PERMISSIONS.OWNER].sort()).toEqual(["billing.manage", "organization.manage"]);
    expect([...ORGANIZATION_ROLE_PERMISSIONS.ADMIN]).toEqual(["organization.manage"]);
    expect(ORGANIZATION_ROLE_PERMISSIONS.MEMBER.size).toBe(0);
    for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
      expect(ORGANIZATION_ROLE_PERMISSIONS[role].has("workspace.read_operational")).toBe(false);
    }
  });
});

describe("grants", () => {
  it("allow only delete/block, and only for Responders", () => {
    expect([...GRANT_POLICY.RESPONDER].sort()).toEqual(["moderate.block", "moderate.delete"]);
    for (const role of WORKSPACE_ROLES.filter((r) => r !== "RESPONDER")) {
      expect(GRANT_POLICY[role].size).toBe(0);
    }
  });

  it("add to role defaults and never remove them", () => {
    const granted = effectivePermissions("RESPONDER", ["moderate.delete", "moderate.block"]);
    expect(granted.has("moderate.delete")).toBe(true);
    expect(granted.has("moderate.block")).toBe(true);
    for (const permission of WORKSPACE_ROLE_PERMISSIONS.RESPONDER) {
      expect(granted.has(permission)).toBe(true);
    }
  });

  it("ignore arbitrary, unknown or non-grantable values", () => {
    const permissions = effectivePermissions("RESPONDER", ["*", "admin", "members.manage", "billing.manage", 42, null]);
    expect([...permissions].sort()).toEqual([...WORKSPACE_ROLE_PERMISSIONS.RESPONDER].sort());
    expect(effectivePermissions("ANALYST_VIEWER", ["moderate.delete"]).has("moderate.delete")).toBe(false);
    expect(effectivePermissions("CLIENT_GUEST", ["moderate.block"]).has("moderate.block")).toBe(false);
  });

  it("can only be given by an actor who holds the permission", () => {
    expect(canGrant(WORKSPACE_ROLE_PERMISSIONS.ADMIN, "moderate.delete")).toBe(true);
    expect(canGrant(WORKSPACE_ROLE_PERMISSIONS.RESPONDER, "moderate.delete")).toBe(false);
  });
});

describe("role escalation (TA §10.5)", () => {
  const order: readonly WorkspaceRole[] = WORKSPACE_ROLES;

  it("never lets anyone assign a role above their own", () => {
    order.forEach((actor, actorIndex) => {
      order.forEach((target, targetIndex) => {
        expect(canAssignWorkspaceRole(actor, target), `${actor} → ${target}`).toBe(targetIndex >= actorIndex);
      });
    });
  });

  it("lets only an Owner assign Owner", () => {
    expect(canAssignWorkspaceRole("OWNER", "OWNER")).toBe(true);
    for (const actor of order.filter((role) => role !== "OWNER")) {
      expect(canAssignWorkspaceRole(actor, "OWNER")).toBe(false);
    }
  });

  it("protects higher-ranked members from being managed by lower ones", () => {
    expect(canManageWorkspaceMember("ADMIN", "OWNER")).toBe(false);
    expect(canManageWorkspaceMember("ADMIN", "ADMIN")).toBe(true);
    expect(canManageWorkspaceMember("OWNER", "OWNER")).toBe(true);
  });

  it("applies the same rules to organization roles", () => {
    expect(canAssignOrganizationRole("OWNER", "OWNER")).toBe(true);
    expect(canAssignOrganizationRole("ADMIN", "OWNER")).toBe(false);
    expect(canAssignOrganizationRole("ADMIN", "ADMIN")).toBe(true);
    expect(canAssignOrganizationRole("MEMBER", "ADMIN")).toBe(false);
  });
});
