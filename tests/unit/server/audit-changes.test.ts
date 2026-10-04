import { describe, expect, it } from "vitest";
import type { OrganizationId, UserId } from "@/domain/ids";
import { object } from "@/domain/validation";
import type { AuditDraft, WorkspaceCommand } from "@/server/pipeline";
import { createHarness, expectOk } from "../../support/harness";
import { emailOf, userId } from "../../support/in-memory";

const OWNER = userId(1);
const SECOND_OWNER = userId(2);
const RESPONDER = userId(3);

type Harness = ReturnType<typeof createHarness>;

async function setup() {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId);
  return { ...h, organizationId, workspaceId };
}

const lastAudit = (h: Harness) => h.unitOfWork.state.audit.at(-1);

async function joinOrganization(h: Harness & { readonly organizationId: OrganizationId }, user: UserId, role: "OWNER" | "ADMIN" | "MEMBER") {
  h.as(OWNER);
  expectOk(await h.pipeline.run(h.commands.inviteToOrganization, { organizationId: h.organizationId, input: { recipientEmail: emailOf(user), role } }));
  h.as(user);
  expectOk(await h.pipeline.run(h.commands.acceptInvitation, { input: { token: h.delivery.delivered.at(-1)?.rawToken } }));
}

describe("audit records the previous and current state", () => {
  it("records STANDARD → MONITOR_ONLY and back", async () => {
    const h = await setup();
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.changeWorkspaceMode, { workspaceId: h.workspaceId, input: { mode: "MONITOR_ONLY" } }));
    expect(lastAudit(h)).toMatchObject({
      action: "workspace.mode_changed",
      change: { kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" },
    });
    expectOk(await h.pipeline.run(h.commands.changeWorkspaceMode, { workspaceId: h.workspaceId, input: { mode: "STANDARD" } }));
    expect(lastAudit(h)?.change).toEqual({ kind: "workspace_mode", previous: "MONITOR_ONLY", current: "STANDARD" });
  });

  it("records a workspace role change OWNER → ADMIN when another Owner exists", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, SECOND_OWNER, "OWNER");
    h.as(SECOND_OWNER);
    expectOk(await h.pipeline.run(h.commands.changeMemberRole, { workspaceId: h.workspaceId, input: { userId: OWNER, role: "ADMIN" } }));
    expect(lastAudit(h)).toMatchObject({
      action: "workspace_membership.role_changed",
      targetId: `${h.workspaceId}:${OWNER}`,
      change: { kind: "workspace_membership", previous: { role: "OWNER", grants: [] }, current: { role: "ADMIN", grants: [] } },
    });
  });

  it("records an organization role change OWNER → MEMBER when another Owner exists", async () => {
    const h = await setup();
    await joinOrganization(h, SECOND_OWNER, "OWNER");
    h.as(SECOND_OWNER);
    expectOk(await h.pipeline.run(h.commands.changeOrganizationMemberRole, { organizationId: h.organizationId, input: { userId: OWNER, role: "MEMBER" } }));
    expect(lastAudit(h)).toMatchObject({
      action: "organization_membership.role_changed",
      targetId: `${h.organizationId}:${OWNER}`,
      change: { kind: "organization_membership", previous: { role: "OWNER" }, current: { role: "MEMBER" } },
    });
  });

  it("records grants [] → [moderate.delete]", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, RESPONDER, "RESPONDER");
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.setMemberGrants, { workspaceId: h.workspaceId, input: { userId: RESPONDER, grants: ["moderate.delete"] } }));
    expect(lastAudit(h)).toMatchObject({
      action: "workspace_membership.grants_changed",
      change: { kind: "workspace_membership", previous: { role: "RESPONDER", grants: [] }, current: { role: "RESPONDER", grants: ["moderate.delete"] } },
    });
  });

  it("records the removed state for removals", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, RESPONDER, "RESPONDER", ["moderate.block"]);
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaceId, input: { userId: RESPONDER } }));
    expect(lastAudit(h)?.change).toEqual({ kind: "workspace_membership", previous: { role: "RESPONDER", grants: ["moderate.block"] }, current: null });
    expectOk(await h.pipeline.run(h.commands.removeOrganizationMember, { organizationId: h.organizationId, input: { userId: RESPONDER } }));
    expect(lastAudit(h)?.change).toEqual({ kind: "organization_membership", previous: { role: "MEMBER" }, current: null });
  });

  it("keeps emails, names and raw tokens out of every audit event", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, RESPONDER, "RESPONDER");
    const rawTokens = h.delivery.delivered.map((delivery) => delivery.rawToken);
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.setMemberGrants, { workspaceId: h.workspaceId, input: { userId: RESPONDER, grants: ["moderate.delete"] } }));
    expectOk(await h.pipeline.run(h.commands.changeMemberRole, { workspaceId: h.workspaceId, input: { userId: RESPONDER, role: "MANAGER" } }));
    const serialized = JSON.stringify(h.unitOfWork.state.audit);
    expect(serialized).not.toContain("@");
    for (const token of rawTokens) expect(serialized).not.toContain(token);
    expect(serialized).not.toMatch(/Workspace|Organization/);
  });
});

describe("audit change summaries accept closed vocabularies only", () => {
  const commandWithChange = (change: unknown): WorkspaceCommand<object, string, string> => ({
    scope: "workspace",
    name: "test.forged_change",
    permission: "workflow.internal",
    requiresStandardMode: false,
    validate: object({}),
    execute: async () => Promise.resolve("done"),
    audit: (): AuditDraft => ({ action: "workspace_membership.role_changed", targetType: "workspace", targetId: OWNER, change } as unknown as AuditDraft),
    respond: (value) => value,
  });

  it("accepts a well-formed summary through the same path (control)", async () => {
    const h = await setup();
    h.as(OWNER);
    const change = { kind: "workspace_membership", previous: { role: "OWNER", grants: [] }, current: { role: "ADMIN", grants: [] } };
    expectOk(await h.pipeline.run(commandWithChange(change), { workspaceId: h.workspaceId, input: {} }));
    expect(lastAudit(h)?.change).toEqual(change);
  });

  it.each([
    ["a free-form role", { kind: "workspace_membership", previous: { role: "Chief Moderator", grants: [] }, current: { role: "ADMIN", grants: [] } }],
    ["an email in place of a role", { kind: "workspace_membership", previous: { role: "person@example.test", grants: [] }, current: { role: "ADMIN", grants: [] } }],
    ["a token in the grants", { kind: "workspace_membership", previous: { role: "OWNER", grants: ["Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5"] }, current: { role: "ADMIN", grants: [] } }],
    ["an extra field", { kind: "workspace_membership", previous: { role: "OWNER", grants: [], note: "moved to Café Aurora" }, current: { role: "ADMIN", grants: [] } }],
    ["a mismatched kind", { kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" }],
    ["a request body", { kind: "workspace_membership", previous: { role: "OWNER", grants: [] }, current: { role: "ADMIN", grants: [] }, input: { recipientEmail: "person@example.test" } }],
  ])("rejects %s and writes nothing", async (_label, change) => {
    const h = await setup();
    h.as(OWNER);
    const before = h.unitOfWork.state.audit.length;
    await expect(h.pipeline.run(commandWithChange(change), { workspaceId: h.workspaceId, input: {} })).rejects.toThrow(TypeError);
    expect(h.unitOfWork.state.audit.length).toBe(before);
    expect(JSON.stringify(h.unitOfWork.state.audit)).not.toMatch(/person@|Café|Chief/);
  });
});
