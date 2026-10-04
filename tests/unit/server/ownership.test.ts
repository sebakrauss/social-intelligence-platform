import { describe, expect, it } from "vitest";
import { ORGANIZATION_ROLES } from "@/domain/access";
import type { OrganizationId, UserId, WorkspaceId } from "@/domain/ids";
import { object } from "@/domain/validation";
import { workspaceRoleForCreator } from "@/modules/tenancy";
import type { OrganizationCommand, WorkspaceScopedPermission } from "@/server/pipeline";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { emailOf, userId } from "../../support/in-memory";

const OWNER = userId(1);
const SECOND_OWNER = userId(2);
const ORG_ADMIN = userId(3);
const WORKSPACE_OWNER_ONLY = userId(4);
const MEMBER = userId(5);

type Harness = ReturnType<typeof createHarness>;

async function inviteToOrganization(h: Harness, organizationId: OrganizationId, as: UserId, user: UserId, role: "OWNER" | "ADMIN" | "MEMBER") {
  h.as(as);
  expectOk(await h.pipeline.run(h.commands.inviteToOrganization, { organizationId, input: { recipientEmail: emailOf(user), role } }));
  h.as(user);
  expectOk(await h.pipeline.run(h.commands.acceptInvitation, { input: { token: h.delivery.delivered.at(-1)?.rawToken } }));
}

async function setup() {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId);
  return { ...h, organizationId, workspaceId };
}

const workspaceRole = (h: Harness, workspaceId: WorkspaceId, user: UserId) =>
  h.unitOfWork.state.workspaceMemberships.get(`${workspaceId}:${user}`)?.role;
const organizationRole = (h: Harness, organizationId: OrganizationId, user: UserId) =>
  h.unitOfWork.state.organizationMemberships.get(`${organizationId}:${user}`)?.role;
const workspaceOwners = (h: Harness, workspaceId: WorkspaceId) =>
  [...h.unitOfWork.state.workspaceMemberships.values()].filter((m) => m.workspaceId === workspaceId && m.role === "OWNER").map((m) => m.userId);

/** A stand-in for a future billing command: organization-scoped, Owner-only authority. */
const manageBilling: OrganizationCommand<object, string, string> = {
  scope: "organization",
  name: "test.billing.manage",
  permission: "billing.manage",
  validate: object({}),
  execute: async () => Promise.resolve("done"),
  audit: () => undefined,
  respond: (value) => value,
};

describe("workspace: last-Owner invariant", () => {
  it("refuses to demote or remove the only Owner, including themselves", async () => {
    const h = await setup();
    h.as(OWNER);
    expect(errorCode(await h.pipeline.run(h.commands.changeMemberRole, { workspaceId: h.workspaceId, input: { userId: OWNER, role: "ADMIN" } }))).toBe("CONFLICT");
    expect(errorCode(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaceId, input: { userId: OWNER } }))).toBe("CONFLICT");
    expect(workspaceRole(h, h.workspaceId, OWNER)).toBe("OWNER");
  });

  it("allows ownership transfer: add another Owner first, then demote or remove the previous one", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, SECOND_OWNER, "OWNER");
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.changeMemberRole, { workspaceId: h.workspaceId, input: { userId: OWNER, role: "ADMIN" } }));
    expect(workspaceRole(h, h.workspaceId, OWNER)).toBe("ADMIN");
    h.as(SECOND_OWNER);
    expect(errorCode(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaceId, input: { userId: SECOND_OWNER } }))).toBe("CONFLICT");
    expectOk(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaceId, input: { userId: OWNER } }));
    expect(workspaceRole(h, h.workspaceId, OWNER)).toBeUndefined();
  });
});

describe("organization: last-Owner invariant", () => {
  it("refuses to demote or remove the only Owner, including themselves", async () => {
    const h = await setup();
    h.as(OWNER);
    expect(errorCode(await h.pipeline.run(h.commands.changeOrganizationMemberRole, { organizationId: h.organizationId, input: { userId: OWNER, role: "ADMIN" } }))).toBe("CONFLICT");
    expect(errorCode(await h.pipeline.run(h.commands.removeOrganizationMember, { organizationId: h.organizationId, input: { userId: OWNER } }))).toBe("CONFLICT");
    expect(organizationRole(h, h.organizationId, OWNER)).toBe("OWNER");
  });

  it("allows ownership transfer between organization Owners", async () => {
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, SECOND_OWNER, "OWNER");
    h.as(SECOND_OWNER);
    expectOk(await h.pipeline.run(h.commands.changeOrganizationMemberRole, { organizationId: h.organizationId, input: { userId: OWNER, role: "MEMBER" } }));
    expect(organizationRole(h, h.organizationId, OWNER)).toBe("MEMBER");
  });

  it("refuses to remove an organization member who is the last Owner of one of its workspaces", async () => {
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, SECOND_OWNER, "OWNER");
    h.as(SECOND_OWNER);
    expect(errorCode(await h.pipeline.run(h.commands.removeOrganizationMember, { organizationId: h.organizationId, input: { userId: OWNER } }))).toBe("CONFLICT");
    expect(workspaceRole(h, h.workspaceId, OWNER)).toBe("OWNER");
  });

  it("removes the member's workspace memberships with the organization membership", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MEMBER, "MANAGER");
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.removeOrganizationMember, { organizationId: h.organizationId, input: { userId: MEMBER } }));
    expect(organizationRole(h, h.organizationId, MEMBER)).toBeUndefined();
    expect(workspaceRole(h, h.workspaceId, MEMBER)).toBeUndefined();
    expect(h.unitOfWork.state.audit.slice(-2)).toMatchObject([
      { action: "organization_membership.removed", targetId: `${h.organizationId}:${MEMBER}` },
      { action: "workspace_membership.removed", targetId: `${h.workspaceId}:${MEMBER}` },
    ]);
  });

  it("applies escalation rules to organization roles", async () => {
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, ORG_ADMIN, "ADMIN");
    h.as(ORG_ADMIN);
    expect(errorCode(await h.pipeline.run(h.commands.changeOrganizationMemberRole, { organizationId: h.organizationId, input: { userId: ORG_ADMIN, role: "OWNER" } }))).toBe("PERMISSION_DENIED");
    expect(errorCode(await h.pipeline.run(h.commands.removeOrganizationMember, { organizationId: h.organizationId, input: { userId: OWNER } }))).toBe("PERMISSION_DENIED");
  });
});

describe("workspace Owner bootstrap", () => {
  it("makes an organization Owner the new workspace's only Owner", async () => {
    const h = await setup();
    expect(workspaceOwners(h, h.workspaceId)).toEqual([OWNER]);
  });

  it("makes an organization Admin the new workspace's only Owner: the creator", async () => {
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, ORG_ADMIN, "ADMIN");
    const workspaceId = await h.createWorkspace(ORG_ADMIN, h.organizationId);
    expect(workspaceOwners(h, workspaceId)).toEqual([ORG_ADMIN]);
  });

  it("never grants organization authority to an organization Admin who became Workspace Owner", async () => {
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, ORG_ADMIN, "ADMIN");
    const workspaceId = await h.createWorkspace(ORG_ADMIN, h.organizationId);
    expect(workspaceRole(h, workspaceId, ORG_ADMIN)).toBe("OWNER");
    expect(organizationRole(h, h.organizationId, ORG_ADMIN)).toBe("ADMIN");

    h.as(ORG_ADMIN);
    const organizationId = h.organizationId;
    const attempts = [
      await h.pipeline.run(h.commands.changeOrganizationMemberRole, { organizationId, input: { userId: ORG_ADMIN, role: "OWNER" } }),
      await h.pipeline.run(h.commands.changeOrganizationMemberRole, { organizationId, input: { userId: OWNER, role: "MEMBER" } }),
      await h.pipeline.run(h.commands.removeOrganizationMember, { organizationId, input: { userId: OWNER } }),
      await h.pipeline.run(h.commands.inviteToOrganization, { organizationId, input: { recipientEmail: emailOf(MEMBER), role: "OWNER" } }),
      await h.pipeline.run(manageBilling, { organizationId, input: {} }),
    ];
    expect(attempts.map(errorCode)).toEqual(["PERMISSION_DENIED", "PERMISSION_DENIED", "PERMISSION_DENIED", "PERMISSION_DENIED", "PERMISSION_DENIED"]);
    expect(organizationRole(h, h.organizationId, ORG_ADMIN)).toBe("ADMIN");
    expect(organizationRole(h, h.organizationId, OWNER)).toBe("OWNER");

    h.as(OWNER);
    expectOk(await h.pipeline.run(manageBilling, { organizationId, input: {} }));
  });

  it("keeps normal workspace role rules after creation", async () => {
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, ORG_ADMIN, "ADMIN");
    const workspaceId = await h.createWorkspace(ORG_ADMIN, h.organizationId);
    h.as(ORG_ADMIN);
    expect(errorCode(await h.pipeline.run(h.commands.changeMemberRole, { workspaceId, input: { userId: ORG_ADMIN, role: "ADMIN" } }))).toBe("CONFLICT");
    await h.addMember(ORG_ADMIN, workspaceId, SECOND_OWNER, "ADMIN");
    h.as(SECOND_OWNER);
    expect(errorCode(await h.pipeline.run(h.commands.changeMemberRole, { workspaceId, input: { userId: SECOND_OWNER, role: "OWNER" } }))).toBe("PERMISSION_DENIED");
    expect(workspaceOwners(h, workspaceId)).toEqual([ORG_ADMIN]);
  });

  it("starts every successfully created workspace with at least one Owner", async () => {
    for (const role of ORGANIZATION_ROLES) expect([undefined, "OWNER"]).toContain(workspaceRoleForCreator(role));
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, ORG_ADMIN, "ADMIN");
    const created = [h.workspaceId, await h.createWorkspace(OWNER, h.organizationId), await h.createWorkspace(ORG_ADMIN, h.organizationId)];
    for (const workspaceId of created) expect(workspaceOwners(h, workspaceId).length).toBeGreaterThanOrEqual(1);
  });

  it("refuses workspace creation to plain organization members", async () => {
    const h = await setup();
    await inviteToOrganization(h, h.organizationId, OWNER, MEMBER, "MEMBER");
    h.as(MEMBER);
    expect(errorCode(await h.pipeline.run(h.commands.createWorkspace, { organizationId: h.organizationId, input: { name: "X" } }))).toBe("PERMISSION_DENIED");
  });
});

describe("organization authority stays organization-scoped", () => {
  it("never lets a Workspace Owner without an organization Owner/Admin role act on the organization", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, WORKSPACE_OWNER_ONLY, "OWNER");
    expect(workspaceRole(h, h.workspaceId, WORKSPACE_OWNER_ONLY)).toBe("OWNER");
    expect(organizationRole(h, h.organizationId, WORKSPACE_OWNER_ONLY)).toBe("MEMBER");

    h.as(WORKSPACE_OWNER_ONLY);
    const organizationId = h.organizationId;
    const attempts = [
      await h.pipeline.run(h.commands.createWorkspace, { organizationId, input: { name: "X" } }),
      await h.pipeline.run(h.commands.inviteToOrganization, { organizationId, input: { recipientEmail: emailOf(MEMBER), role: "MEMBER" } }),
      await h.pipeline.run(h.commands.changeOrganizationMemberRole, { organizationId, input: { userId: OWNER, role: "MEMBER" } }),
      await h.pipeline.run(h.commands.removeOrganizationMember, { organizationId, input: { userId: OWNER } }),
    ];
    expect(attempts.map(errorCode)).toEqual(["PERMISSION_DENIED", "PERMISSION_DENIED", "PERMISSION_DENIED", "PERMISSION_DENIED"]);
    expect(organizationRole(h, h.organizationId, OWNER)).toBe("OWNER");
  });

  it("doesn't let a workspace command require organization-scoped permissions (compile-time)", () => {
    // @ts-expect-error organization.manage is resolved only from organization membership
    const organizationManage: WorkspaceScopedPermission = "organization.manage";
    // @ts-expect-error billing.manage is resolved only from organization membership
    const billingManage: WorkspaceScopedPermission = "billing.manage";
    expect([organizationManage, billingManage]).toHaveLength(2);
  });
});
