/**
 * Tenancy onboarding (Step 7G-F3), offline: the state machine and the two form submissions, driven through the real
 * action pipeline and the real tenancy commands on the in-memory unit of work. Synthetic identities only.
 */
import { describe, expect, it } from "vitest";
import { tenancyOnboardingCommands } from "@/server/commands/tenancy";
import type { ActionPipeline } from "@/server/pipeline";
import { ONBOARDING_STATUSES, parseOnboardingStatus, resolveOnboarding, submitOrganization, submitWorkspace } from "@/server/tenancy/onboarding";
import { createHarness, expectOk } from "../../support/harness";
import { emailOf, userId } from "../../support/in-memory";

const form = (fields: Readonly<Record<string, string>>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

/** Counts every pipeline run (each is one command execution). */
function counting(pipeline: ActionPipeline): { readonly pipeline: ActionPipeline; readonly runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    pipeline: {
      run: (command, request) => {
        runs.push(command.name);
        return pipeline.run(command, request);
      },
    },
  };
}

function snapshot(h: ReturnType<typeof createHarness>) {
  const { state } = h.unitOfWork;
  return {
    organizations: state.organizations.size,
    workspaces: state.workspaces.size,
    organizationMemberships: state.organizationMemberships.size,
    workspaceMemberships: state.workspaceMemberships.size,
    audit: state.audit.length,
  };
}

const ALICE = userId(1);
const BOB = userId(2);
/** A real identity whose email is not verified (the pipeline refuses it). */
const unverifiedUser = (id: typeof ALICE) => ({ id, emailVerified: false });

describe("onboarding state (read only)", () => {
  it("signed out → signed_out; unverified → verification_required; neither touches tenancy", async () => {
    const h = createHarness();
    h.identity.user = undefined;
    expect(await resolveOnboarding(h.pipeline)).toEqual({ kind: "signed_out" });
    h.identity.user = unverifiedUser(ALICE);
    expect(await resolveOnboarding(h.pipeline)).toEqual({ kind: "verification_required" });
    expect(h.unitOfWork.commits).toBe(0);
  });

  it("verified with no organization → create_organization; with one but no workspace → create_workspace; with a workspace → ready", async () => {
    const h = createHarness();
    h.as(ALICE);
    expect(await resolveOnboarding(h.pipeline)).toEqual({ kind: "create_organization" });
    const organizationId = await h.createOrganization(ALICE);
    expect(await resolveOnboarding(h.pipeline)).toEqual({ kind: "create_workspace", organizationId, organizationName: "Organization A" });
    const workspaceId = await h.createWorkspace(ALICE, organizationId);
    expect(await resolveOnboarding(h.pipeline)).toEqual({ kind: "ready", workspaces: [{ id: workspaceId, name: "Workspace", organizationName: "Organization A" }] });
  });

  it("an organization member who can't manage it and has no workspace → awaiting_access (never a create form)", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    expectOk(await h.pipeline.run(h.commands.inviteToOrganization, { organizationId, input: { recipientEmail: emailOf(BOB), role: "MEMBER" } }));
    h.as(BOB);
    expectOk(await h.pipeline.run(h.commands.acceptInvitation, { input: { token: h.delivery.delivered.at(-1)?.rawToken } }));
    expect(await resolveOnboarding(h.pipeline)).toEqual({ kind: "awaiting_access" });
  });

  it("lists only the caller's own tenancy: another user's organization is invisible", async () => {
    const h = createHarness();
    await h.createOrganization(ALICE);
    h.as(BOB);
    expect(await resolveOnboarding(h.pipeline)).toEqual({ kind: "create_organization" });
  });

  it("reading the state is one read-only query: revisiting, reloading, back/forward never create anything", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    await h.createWorkspace(ALICE, organizationId);
    const before = snapshot(h);
    const { pipeline, runs } = counting(h.pipeline);
    h.as(ALICE);
    for (let i = 0; i < 5; i += 1) expect((await resolveOnboarding(pipeline)).kind).toBe("ready");
    expect(runs).toEqual(Array(5).fill("tenancy.membership.list_own"));
    expect(snapshot(h)).toEqual(before);
    // The list query writes no audit: it changes nothing.
    expect(tenancyOnboardingCommands.listOwnTenancy.audit([])).toBeUndefined();
  });
});

describe("create organization", () => {
  it("runs tenancy.organization.create exactly once; the creator is the session user, made OWNER by the command, audited", async () => {
    const h = createHarness();
    h.as(ALICE);
    const { pipeline, runs } = counting(h.pipeline);
    expect(await submitOrganization(pipeline, form({ name: "Acme" }))).toEqual({ kind: "done" });
    expect(runs).toEqual(["tenancy.organization.create"]);
    const [organization] = [...h.unitOfWork.state.organizations.values()];
    expect(organization?.name).toBe("Acme");
    expect([...h.unitOfWork.state.organizationMemberships.values()]).toEqual([expect.objectContaining({ organizationId: organization?.id, userId: ALICE, role: "OWNER" })]);
    expect(h.unitOfWork.state.audit).toEqual([expect.objectContaining({ action: "organization.created", actorUserId: ALICE, targetId: organization?.id })]);
  });

  it("ignores every identity, role or id a form might carry: the owner is always the session user", async () => {
    const h = createHarness();
    h.as(ALICE);
    expect(await submitOrganization(h.pipeline, form({ name: "Acme", userId: BOB, ownerUserId: BOB, role: "MEMBER", organizationId: "00000000-0000-4000-8000-0000000000ff", createdBy: BOB }))).toEqual({ kind: "done" });
    const memberships = [...h.unitOfWork.state.organizationMemberships.values()];
    expect(memberships.map((m) => [m.userId, m.role])).toEqual([[ALICE, "OWNER"]]);
    expect([...h.unitOfWork.state.organizations.keys()]).not.toContain("00000000-0000-4000-8000-0000000000ff");
  });

  it.each([
    ["a missing name", {}],
    ["an empty name", { name: "" }],
    ["a blank name", { name: "   " }],
    ["a name over 120 characters", { name: "x".repeat(121) }],
  ])("%s fails through the command's own validation, creating nothing", async (_label, fields) => {
    const h = createHarness();
    h.as(ALICE);
    expect(await submitOrganization(h.pipeline, form(fields))).toEqual({ kind: "status", status: "invalid_input" });
    expect(snapshot(h)).toEqual({ organizations: 0, workspaces: 0, organizationMemberships: 0, workspaceMemberships: 0, audit: 0 });
  });

  it("a file upload in place of the name is rejected as invalid input", async () => {
    const h = createHarness();
    h.as(ALICE);
    const data = new FormData();
    data.set("name", new Blob(["Acme"]), "name.txt");
    expect(await submitOrganization(h.pipeline, data)).toEqual({ kind: "status", status: "invalid_input" });
  });

  it("signed out or unverified can't create an organization", async () => {
    const h = createHarness();
    h.identity.user = undefined;
    expect(await submitOrganization(h.pipeline, form({ name: "Acme" }))).toEqual({ kind: "signed_out" });
    h.identity.user = unverifiedUser(ALICE);
    expect(await submitOrganization(h.pipeline, form({ name: "Acme" }))).toEqual({ kind: "verification_required" });
    expect(h.unitOfWork.state.organizations.size).toBe(0);
  });

  it("documented: two submissions create two organizations (the domain allows several; the page guides only the first)", async () => {
    const h = createHarness();
    h.as(ALICE);
    await submitOrganization(h.pipeline, form({ name: "Acme" }));
    await submitOrganization(h.pipeline, form({ name: "Acme" }));
    expect(h.unitOfWork.state.organizations.size).toBe(2);
  });
});

describe("create workspace", () => {
  it("runs tenancy.workspace.create exactly once in the caller's organization; STANDARD; the creator becomes its OWNER; audited", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    const before = h.unitOfWork.state.audit.length;
    const { pipeline, runs } = counting(h.pipeline);
    expect(await submitWorkspace(pipeline, form({ organizationId, name: "Brand" }))).toEqual({ kind: "done" });
    expect(runs).toEqual(["tenancy.workspace.create"]);
    const [workspace] = [...h.unitOfWork.state.workspaces.values()];
    expect(workspace).toEqual(expect.objectContaining({ organizationId, name: "Brand", mode: "STANDARD" }));
    expect([...h.unitOfWork.state.workspaceMemberships.values()]).toEqual([expect.objectContaining({ workspaceId: workspace?.id, userId: ALICE, role: "OWNER", grants: [] })]);
    expect(h.unitOfWork.state.audit.slice(before)).toEqual([expect.objectContaining({ action: "workspace.created", actorUserId: ALICE, workspaceId: workspace?.id })]);
  });

  it("the mode is fixed server-side: a submitted mode is ignored", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    expect(await submitWorkspace(h.pipeline, form({ organizationId, name: "Brand", mode: "MONITOR_ONLY" }))).toEqual({ kind: "done" });
    expect([...h.unitOfWork.state.workspaces.values()].map((w) => w.mode)).toEqual(["STANDARD"]);
  });

  it("another user's organization id is no privilege: NOT_FOUND → not_allowed, nothing created", async () => {
    const h = createHarness();
    const foreign = await h.createOrganization(ALICE);
    h.as(BOB);
    expect(await submitWorkspace(h.pipeline, form({ organizationId: foreign, name: "Hijack" }))).toEqual({ kind: "status", status: "not_allowed" });
    expect(h.unitOfWork.state.workspaces.size).toBe(0);
  });

  it("a member without organization.manage is refused (PERMISSION_DENIED → not_allowed)", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    expectOk(await h.pipeline.run(h.commands.inviteToOrganization, { organizationId, input: { recipientEmail: emailOf(BOB), role: "MEMBER" } }));
    h.as(BOB);
    expectOk(await h.pipeline.run(h.commands.acceptInvitation, { input: { token: h.delivery.delivered.at(-1)?.rawToken } }));
    expect(await submitWorkspace(h.pipeline, form({ organizationId, name: "Brand" }))).toEqual({ kind: "status", status: "not_allowed" });
    expect(h.unitOfWork.state.workspaces.size).toBe(0);
  });

  it.each([
    ["a missing organization id", { name: "Brand" }],
    ["a malformed organization id", { organizationId: "not-a-uuid", name: "Brand" }],
    ["an unknown organization id", { organizationId: "00000000-0000-4000-8000-0000000000ff", name: "Brand" }],
  ])("%s → not_allowed, nothing created", async (_label, fields) => {
    const h = createHarness();
    await h.createOrganization(ALICE);
    expect(await submitWorkspace(h.pipeline, form(fields))).toEqual({ kind: "status", status: "not_allowed" });
    expect(h.unitOfWork.state.workspaces.size).toBe(0);
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a name over 120 characters", { name: "y".repeat(121) }],
  ])("%s fails through the command's validation, creating nothing", async (_label, fields) => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    expect(await submitWorkspace(h.pipeline, form({ organizationId, ...fields }))).toEqual({ kind: "status", status: "invalid_input" });
    expect(h.unitOfWork.state.workspaces.size).toBe(0);
  });

  it("signed out or unverified can't create a workspace", async () => {
    const h = createHarness();
    const organizationId = await h.createOrganization(ALICE);
    h.identity.user = undefined;
    expect(await submitWorkspace(h.pipeline, form({ organizationId, name: "Brand" }))).toEqual({ kind: "signed_out" });
    h.identity.user = unverifiedUser(ALICE);
    expect(await submitWorkspace(h.pipeline, form({ organizationId, name: "Brand" }))).toEqual({ kind: "verification_required" });
    expect(h.unitOfWork.state.workspaces.size).toBe(0);
  });
});

describe("closed outcomes", () => {
  it("statuses are a closed vocabulary; anything else in the URL is ignored", () => {
    expect(ONBOARDING_STATUSES).toEqual(["invalid_input", "not_allowed", "unavailable"]);
    for (const value of ["sql error", "PERMISSION_DENIED", "<script>", "", undefined, ["invalid_input"]]) expect(parseOnboardingStatus(value)).toBeUndefined();
    expect(parseOnboardingStatus("not_allowed")).toBe("not_allowed");
  });

  it("an unexpected command error maps to unavailable, carrying no detail", async () => {
    const h = createHarness();
    h.as(ALICE);
    h.unitOfWork.faults = { failAuditAppendAt: 1 };
    // A non-AppError escapes the pipeline (as a database failure would); the action layer turns it into `unavailable`.
    await expect(submitOrganization(h.pipeline, form({ name: "Acme" }))).rejects.toThrow("simulated failure");
    expect(h.unitOfWork.state.organizations.size).toBe(0);
  });
});
