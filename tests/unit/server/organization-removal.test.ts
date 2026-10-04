import { describe, expect, it } from "vitest";
import type { OrganizationId, WorkspaceId } from "@/domain/ids";
import type { AuditEvent } from "@/modules/audit";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { emailOf, userId } from "../../support/in-memory";

const OWNER = userId(1);
const MEMBER = userId(2);
const OTHER_OWNER = userId(3);

type Harness = ReturnType<typeof createHarness>;

/** OWNER's organization with three workspaces MEMBER belongs to, plus another organization MEMBER also belongs to. */
async function setup() {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaces = [
    await h.createWorkspace(OWNER, organizationId),
    await h.createWorkspace(OWNER, organizationId),
    await h.createWorkspace(OWNER, organizationId),
  ] as const;
  await h.addMember(OWNER, workspaces[0], MEMBER, "RESPONDER", ["moderate.delete"]);
  await h.addMember(OWNER, workspaces[1], MEMBER, "MANAGER");
  await h.addMember(OWNER, workspaces[2], MEMBER, "ANALYST_VIEWER");

  const otherOrganizationId = await h.createOrganization(OTHER_OWNER);
  const otherWorkspaceId = await h.createWorkspace(OTHER_OWNER, otherOrganizationId);
  await h.addMember(OTHER_OWNER, otherWorkspaceId, MEMBER, "MANAGER");
  return { ...h, organizationId, workspaces, otherOrganizationId, otherWorkspaceId };
}

const removeMember = (h: Harness, organizationId: OrganizationId) => {
  h.as(OWNER);
  return h.pipeline.run(h.commands.removeOrganizationMember, { organizationId, input: { userId: MEMBER } });
};

const hasOrganizationMembership = (h: Harness, organizationId: OrganizationId) =>
  h.unitOfWork.state.organizationMemberships.has(`${organizationId}:${MEMBER}`);
const hasWorkspaceMembership = (h: Harness, workspaceId: WorkspaceId) => h.unitOfWork.state.workspaceMemberships.has(`${workspaceId}:${MEMBER}`);
const newEvents = (h: Harness, before: number): readonly AuditEvent[] => h.unitOfWork.state.audit.slice(before);
const removalEvents = (events: readonly AuditEvent[]) => events.filter((event) => event.action.endsWith(".removed"));

describe("organization member removal cascades and audits every removed membership", () => {
  it("removes the organization membership and all three workspace memberships, with one audit event each", async () => {
    const h = await setup();
    const before = h.unitOfWork.state.audit.length;
    expectOk(await removeMember(h, h.organizationId));

    expect(hasOrganizationMembership(h, h.organizationId)).toBe(false);
    for (const workspaceId of h.workspaces) expect(hasWorkspaceMembership(h, workspaceId)).toBe(false);
    const events = newEvents(h, before);
    expect(events.filter((event) => event.action === "organization_membership.removed")).toHaveLength(1);
    expect(events.filter((event) => event.action === "workspace_membership.removed")).toHaveLength(3);
    expect(events).toHaveLength(4);

    // Memberships in another organization are untouched.
    expect(hasOrganizationMembership(h, h.otherOrganizationId)).toBe(true);
    expect(hasWorkspaceMembership(h, h.otherWorkspaceId)).toBe(true);
  });

  it("gives each workspace event its own workspace and the previous role and grants", async () => {
    const h = await setup();
    const before = h.unitOfWork.state.audit.length;
    expectOk(await removeMember(h, h.organizationId));

    const workspaceEvents = newEvents(h, before).filter((event) => event.action === "workspace_membership.removed");
    const expected = [
      { workspaceId: h.workspaces[0], role: "RESPONDER", grants: ["moderate.delete"] },
      { workspaceId: h.workspaces[1], role: "MANAGER", grants: [] },
      { workspaceId: h.workspaces[2], role: "ANALYST_VIEWER", grants: [] },
    ];
    expect(workspaceEvents).toHaveLength(expected.length);
    for (const { workspaceId, role, grants } of expected) {
      const event = workspaceEvents.find((candidate) => candidate.workspaceId === workspaceId);
      expect(event).toMatchObject({
        actorType: "user",
        actorUserId: OWNER,
        organizationId: h.organizationId,
        workspaceId,
        targetType: "workspace_membership",
        targetId: `${workspaceId}:${MEMBER}`,
        outcome: "succeeded",
        change: { kind: "workspace_membership", previous: { role, grants }, current: null },
      });
    }
    const organizationEvent = newEvents(h, before).find((event) => event.action === "organization_membership.removed");
    expect(organizationEvent).toMatchObject({
      organizationId: h.organizationId,
      targetId: `${h.organizationId}:${MEMBER}`,
      change: { kind: "organization_membership", previous: { role: "MEMBER" }, current: null },
    });
    expect(organizationEvent?.workspaceId).toBeUndefined();
    // One request: every event shares its correlation and request IDs.
    expect(new Set(newEvents(h, before).map((event) => `${event.correlationId}|${event.requestId ?? ""}`)).size).toBe(1);
  });

  it("writes only the organization removal event when the user had no workspace membership", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(OWNER);
    await h.createWorkspace(OWNER, organizationId);
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.inviteToOrganization, { organizationId, input: { recipientEmail: emailOf(MEMBER), role: "MEMBER" } }));
    h.as(MEMBER);
    expectOk(await h.pipeline.run(h.commands.acceptInvitation, { input: { token: h.delivery.delivered.at(-1)?.rawToken } }));

    const before = h.unitOfWork.state.audit.length;
    expectOk(await removeMember(h, organizationId));
    expect(newEvents(h, before).map((event) => event.action)).toEqual(["organization_membership.removed"]);
  });

  it("refuses with CONFLICT, removes nothing and audits nothing if any workspace would lose its last Owner", async () => {
    const h = await setup();
    // MEMBER becomes the only Owner of the second workspace.
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.changeMemberRole, { workspaceId: h.workspaces[1], input: { userId: MEMBER, role: "OWNER" } }));
    expectOk(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaces[1], input: { userId: OWNER } }));

    const snapshot = structuredClone(h.unitOfWork.state);
    const rollbacks = h.unitOfWork.rollbacks;
    expect(errorCode(await removeMember(h, h.organizationId))).toBe("CONFLICT");

    expect(h.unitOfWork.rollbacks).toBe(rollbacks + 1);
    expect(h.unitOfWork.state).toEqual(snapshot);
    expect(hasOrganizationMembership(h, h.organizationId)).toBe(true);
    for (const workspaceId of h.workspaces) expect(hasWorkspaceMembership(h, workspaceId)).toBe(true);
  });

  it.each([
    ["a workspace membership removal", { failWorkspaceMembershipRemovalAt: 2 }],
    ["an audit append", { failAuditAppendAt: 3 }],
  ])("rolls everything back when %s fails", async (_label, faults) => {
    const h = await setup();
    const snapshot = structuredClone(h.unitOfWork.state);
    h.unitOfWork.faults = faults;

    await expect(removeMember(h, h.organizationId)).rejects.toThrow("simulated failure");

    expect(h.unitOfWork.state).toEqual(snapshot);
    expect(hasOrganizationMembership(h, h.organizationId)).toBe(true);
    for (const workspaceId of h.workspaces) expect(hasWorkspaceMembership(h, workspaceId)).toBe(true);
    expect(removalEvents(h.unitOfWork.state.audit)).toHaveLength(0);
  });

  it("keeps emails, names, tokens and free-form data out of the removal events", async () => {
    const h = await setup();
    const rawTokens = h.delivery.delivered.map((delivery) => delivery.rawToken);
    const before = h.unitOfWork.state.audit.length;
    expectOk(await removeMember(h, h.organizationId));

    const events = newEvents(h, before);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toMatch(/Workspace|Organization/);
    for (const token of rawTokens) expect(serialized).not.toContain(token);
    const declared = ["id", "occurredAt", "action", "actorType", "actorUserId", "organizationId", "workspaceId", "targetType", "targetId", "correlationId", "requestId", "outcome", "change"];
    for (const event of events) {
      for (const field of Object.keys(event)) expect(declared).toContain(field);
      expect(Object.isFrozen(event)).toBe(true);
    }
    expect(h.logLines.join("\n")).not.toContain("@");
  });
});
