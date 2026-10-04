import { describe, expect, it } from "vitest";
import { object } from "@/domain/validation";
import type { AuditDraft, WorkspaceCommand } from "@/server/pipeline";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { userId } from "../../support/in-memory";

const OWNER = userId(1);
const ADMIN = userId(2);
const RESPONDER = userId(3);
const MANAGER = userId(4);

const deleteAction: WorkspaceCommand<object, string, string> = {
  scope: "workspace",
  name: "test.delete_action",
  permission: "moderate.delete",
  requiresStandardMode: true,
  validate: object({}),
  execute: async () => Promise.resolve("deleted"),
  audit: (): AuditDraft | undefined => undefined,
  respond: (value) => value,
};

async function setup() {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId);
  await h.addMember(OWNER, workspaceId, ADMIN, "ADMIN");
  await h.addMember(OWNER, workspaceId, RESPONDER, "RESPONDER");
  await h.addMember(OWNER, workspaceId, MANAGER, "MANAGER");
  return { ...h, organizationId, workspaceId };
}

type Harness = Awaited<ReturnType<typeof setup>>;

const changeRole = (h: Harness, as: typeof OWNER, target: typeof OWNER, role: string) => {
  h.as(as);
  return h.pipeline.run(h.commands.changeMemberRole, { workspaceId: h.workspaceId, input: { userId: target, role } });
};

const setGrants = (h: Harness, as: typeof OWNER, target: typeof OWNER, grants: readonly string[]) => {
  h.as(as);
  return h.pipeline.run(h.commands.setMemberGrants, { workspaceId: h.workspaceId, input: { userId: target, grants } });
};

describe("role escalation", () => {
  it("lets an Admin assign roles up to Admin, never Owner", async () => {
    const h = await setup();
    expect(expectOk(await changeRole(h, ADMIN, RESPONDER, "MANAGER")).role).toBe("MANAGER");
    expect(expectOk(await changeRole(h, ADMIN, RESPONDER, "ADMIN")).role).toBe("ADMIN");
    expect(errorCode(await changeRole(h, ADMIN, MANAGER, "OWNER"))).toBe("PERMISSION_DENIED");
  });

  it("lets only an Owner grant Owner", async () => {
    const h = await setup();
    expect(expectOk(await changeRole(h, OWNER, ADMIN, "OWNER")).role).toBe("OWNER");
  });

  it("prevents self-escalation and managing a higher-ranked member", async () => {
    const h = await setup();
    expect(errorCode(await changeRole(h, ADMIN, ADMIN, "OWNER"))).toBe("PERMISSION_DENIED");
    expect(errorCode(await changeRole(h, ADMIN, OWNER, "MANAGER"))).toBe("PERMISSION_DENIED");
    h.as(ADMIN);
    expect(errorCode(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaceId, input: { userId: OWNER } }))).toBe("PERMISSION_DENIED");
  });

  it("denies role management to roles without members.manage", async () => {
    const h = await setup();
    expect(errorCode(await changeRole(h, MANAGER, RESPONDER, "ANALYST_VIEWER"))).toBe("PERMISSION_DENIED");
    expect(errorCode(await changeRole(h, RESPONDER, RESPONDER, "MANAGER"))).toBe("PERMISSION_DENIED");
  });

  it("rejects unknown roles and unknown members", async () => {
    const h = await setup();
    expect(errorCode(await changeRole(h, OWNER, RESPONDER, "SUPERUSER"))).toBe("INVALID_INPUT");
    expect(errorCode(await changeRole(h, OWNER, userId(99), "MANAGER"))).toBe("NOT_FOUND");
  });
});

describe("grants", () => {
  it("deny Responder delete/block by default and allow them once explicitly granted", async () => {
    const h = await setup();
    h.as(RESPONDER);
    expect(errorCode(await h.pipeline.run(deleteAction, { workspaceId: h.workspaceId, input: {} }))).toBe("PERMISSION_DENIED");
    expectOk(await setGrants(h, ADMIN, RESPONDER, ["moderate.delete", "moderate.block"]));
    h.as(RESPONDER);
    expect(expectOk(await h.pipeline.run(deleteAction, { workspaceId: h.workspaceId, input: {} }))).toBe("deleted");
  });

  it("reject arbitrary strings, non-grantable permissions and grants for roles that can't hold them", async () => {
    const h = await setup();
    expect(errorCode(await setGrants(h, OWNER, RESPONDER, ["*"]))).toBe("INVALID_INPUT");
    expect(errorCode(await setGrants(h, OWNER, RESPONDER, ["members.manage"]))).toBe("INVALID_INPUT");
    expect(errorCode(await setGrants(h, OWNER, MANAGER, ["moderate.delete"]))).toBe("INVALID_INPUT");
    expect(errorCode(await setGrants(h, OWNER, RESPONDER, ["moderate.delete", "moderate.delete"]))).toBe("INVALID_INPUT");
  });

  it("are dropped when the role changes to one that can't hold them", async () => {
    const h = await setup();
    expectOk(await setGrants(h, OWNER, RESPONDER, ["moderate.delete"]));
    expectOk(await changeRole(h, OWNER, RESPONDER, "ANALYST_VIEWER"));
    expect(h.unitOfWork.state.workspaceMemberships.get(`${h.workspaceId}:${RESPONDER}`)?.grants).toEqual([]);
  });
});

describe("membership audit", () => {
  it("records role, grant and removal changes with membership targets and no names", async () => {
    const h = await setup();
    expectOk(await changeRole(h, OWNER, MANAGER, "RESPONDER"));
    expectOk(await setGrants(h, OWNER, MANAGER, ["moderate.block"]));
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaceId, input: { userId: MANAGER } }));
    const events = h.unitOfWork.state.audit.slice(-3);
    expect(events.map((event) => event.action)).toEqual([
      "workspace_membership.role_changed",
      "workspace_membership.grants_changed",
      "workspace_membership.removed",
    ]);
    for (const event of events) {
      expect(event.targetType).toBe("workspace_membership");
      expect(event.targetId).toBe(`${h.workspaceId}:${MANAGER}`);
      expect(event.workspaceId).toBe(h.workspaceId);
    }
  });
});
