import { describe, expect, it } from "vitest";
import { DEFAULT_INVITATION_TTL_DAYS } from "@/modules/tenancy";
import { digestToken } from "@/platform/crypto";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { emailOf, userId, verifiedUser } from "../../support/in-memory";

const OWNER = userId(1);
const INVITEE = userId(2);
const SECOND = userId(3);
const ADMIN = userId(4);
const MANAGER = userId(5);
const EMAIL = emailOf(INVITEE);
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId);
  return { ...h, organizationId, workspaceId };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function invite(h: Harness, input: Record<string, unknown>, as = OWNER) {
  h.as(as);
  return h.pipeline.run(h.commands.inviteToWorkspace, { workspaceId: h.workspaceId, input });
}

function lastToken(h: Harness): string {
  const token = h.delivery.delivered.at(-1)?.rawToken;
  if (token === undefined) throw new Error("nothing delivered");
  return token;
}

async function accept(h: Harness, token: string, as = INVITEE) {
  h.as(as);
  return h.pipeline.run(h.commands.acceptInvitation, { input: { token } });
}

describe("invitation lifecycle", () => {
  it("accepts a fresh invitation once and creates the intended membership", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "MANAGER" }));
    const token = lastToken(h);
    expect(expectOk(await accept(h, token))).toEqual({ organizationId: h.organizationId, workspaceId: h.workspaceId, outcome: "joined" });
    expect(h.unitOfWork.state.workspaceMemberships.get(`${h.workspaceId}:${INVITEE}`)?.role).toBe("MANAGER");
    expect(h.unitOfWork.state.organizationMemberships.get(`${h.organizationId}:${INVITEE}`)?.role).toBe("MEMBER");
  });

  it("rejects a second acceptance, by the same or another user", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    const token = lastToken(h);
    expectOk(await accept(h, token));
    expect(errorCode(await accept(h, token))).toBe("NOT_FOUND");
    expect(errorCode(await accept(h, token, SECOND))).toBe("NOT_FOUND");
    expect(h.unitOfWork.state.workspaceMemberships.has(`${h.workspaceId}:${SECOND}`)).toBe(false);
  });

  it("rejects an expired invitation", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    h.clock.advance(DEFAULT_INVITATION_TTL_DAYS * DAY - 1);
    const stillValid = h.unitOfWork.state.invitations.values().next().value;
    expect(stillValid?.expiresAt.getTime()).toBe(h.clock.now.getTime() + 1);
    h.clock.advance(1);
    expect(errorCode(await accept(h, lastToken(h)))).toBe("NOT_FOUND");
  });

  it("rejects a revoked invitation; revoking twice conflicts", async () => {
    const h = await setup();
    const { invitationId } = expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    const token = lastToken(h);
    expectOk(await h.pipeline.run(h.commands.revokeWorkspaceInvitation, { workspaceId: h.workspaceId, input: { invitationId } }));
    expect(errorCode(await h.pipeline.run(h.commands.revokeWorkspaceInvitation, { workspaceId: h.workspaceId, input: { invitationId } }))).toBe("CONFLICT");
    expect(errorCode(await accept(h, token))).toBe("NOT_FOUND");
  });

  it("rejects unknown or malformed tokens without revealing anything", async () => {
    const h = await setup();
    expect(errorCode(await accept(h, "A".repeat(43)))).toBe("NOT_FOUND");
    expect(errorCode(await accept(h, "short"))).toBe("INVALID_INPUT");
  });

  it("preserves the invited role and approved grants", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER", grants: ["moderate.delete", "moderate.block"] }));
    expectOk(await accept(h, lastToken(h)));
    const membership = h.unitOfWork.state.workspaceMemberships.get(`${h.workspaceId}:${INVITEE}`);
    expect(membership?.role).toBe("RESPONDER");
    expect([...(membership?.grants ?? [])].sort()).toEqual(["moderate.block", "moderate.delete"]);
  });

  it("keeps an existing membership unchanged when its user accepts another invitation (no duplicate, no silent role change)", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MANAGER, "MANAGER");
    expectOk(await invite(h, { recipientEmail: emailOf(MANAGER), role: "ADMIN" }));
    expect(expectOk(await accept(h, lastToken(h), MANAGER)).outcome).toBe("already_member");
    const memberships = [...h.unitOfWork.state.workspaceMemberships.values()].filter((m) => m.userId === MANAGER);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("MANAGER");
  });

  it("supports organization invitations, which grant no workspace access", async () => {
    const h = await setup();
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.inviteToOrganization, { organizationId: h.organizationId, input: { recipientEmail: EMAIL, role: "ADMIN" } }));
    expect(expectOk(await accept(h, lastToken(h))).workspaceId).toBeUndefined();
    expect(h.unitOfWork.state.organizationMemberships.get(`${h.organizationId}:${INVITEE}`)?.role).toBe("ADMIN");
    expect(h.unitOfWork.state.workspaceMemberships.has(`${h.workspaceId}:${INVITEE}`)).toBe(false);
  });
});

describe("recipient binding", () => {
  it("lets the intended recipient accept (address compared case-insensitively)", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL.toUpperCase(), role: "RESPONDER" }));
    expect(expectOk(await accept(h, lastToken(h))).outcome).toBe("joined");
  });

  it("refuses a different verified user with the same non-disclosing NOT_FOUND", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    const token = lastToken(h);
    const forwarded = await accept(h, token, SECOND);
    const unknown = await accept(h, "B".repeat(43), SECOND);
    expect(errorCode(forwarded)).toBe("NOT_FOUND");
    expect(forwarded.status === "error" ? forwarded.error.toJSON() : undefined).toEqual(
      unknown.status === "error" ? { ...unknown.error.toJSON(), correlationId: forwarded.correlationId } : undefined,
    );
    expect(h.unitOfWork.state.workspaceMemberships.has(`${h.workspaceId}:${SECOND}`)).toBe(false);
  });

  it("keeps a forwarded invitation claimable only by its recipient: the attempt doesn't consume it", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "MANAGER" }));
    const token = lastToken(h);
    expect(errorCode(await accept(h, token, SECOND))).toBe("NOT_FOUND");
    expect(expectOk(await accept(h, token)).outcome).toBe("joined");
  });

  it("refuses a user whose session carries no verified email", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    const token = lastToken(h);
    h.identity.user = { id: INVITEE, emailVerified: true };
    expect(errorCode(await h.pipeline.run(h.commands.acceptInvitation, { input: { token } }))).toBe("NOT_FOUND");
  });

  it("never lets a session claim another address through client input", async () => {
    const h = await setup();
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    const token = lastToken(h);
    h.identity.user = verifiedUser(SECOND);
    const result = await h.pipeline.run(h.commands.acceptInvitation, { input: { token, email: EMAIL } });
    expect(errorCode(result)).toBe("INVALID_INPUT");
  });
});

describe("inviter authority", () => {
  it("rejects inviters without members.manage", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MANAGER, "MANAGER");
    const deliveredBefore = h.delivery.delivered.length;
    expect(errorCode(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }, MANAGER))).toBe("PERMISSION_DENIED");
    expect(h.delivery.delivered.length).toBe(deliveredBefore);
  });

  it("never lets an Admin invite an Owner; only an Owner invites an Owner", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, ADMIN, "ADMIN");
    expect(errorCode(await invite(h, { recipientEmail: EMAIL, role: "OWNER" }, ADMIN))).toBe("PERMISSION_DENIED");
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "OWNER" }, OWNER));
  });

  it("rejects arbitrary grants and grants that the target role can't hold", async () => {
    const h = await setup();
    expect(errorCode(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER", grants: ["superuser"] }))).toBe("INVALID_INPUT");
    expect(errorCode(await invite(h, { recipientEmail: EMAIL, role: "ANALYST_VIEWER", grants: ["moderate.delete"] }))).toBe("INVALID_INPUT");
    expect(errorCode(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER", grants: ["responding.manage"] }))).toBe("INVALID_INPUT");
  });

  it("restricts organization invitations the same way", async () => {
    const h = await setup();
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.inviteToOrganization, { organizationId: h.organizationId, input: { recipientEmail: emailOf(ADMIN), role: "ADMIN" } }));
    expectOk(await accept(h, lastToken(h), ADMIN));
    h.as(ADMIN);
    const result = await h.pipeline.run(h.commands.inviteToOrganization, { organizationId: h.organizationId, input: { recipientEmail: "x@example.test", role: "OWNER" } });
    expect(errorCode(result)).toBe("PERMISSION_DENIED");
  });

  it("only revokes invitations in the actor's own workspace", async () => {
    const h = await setup();
    const { invitationId } = expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    const otherWorkspace = await h.createWorkspace(OWNER, h.organizationId);
    h.as(OWNER);
    expect(errorCode(await h.pipeline.run(h.commands.revokeWorkspaceInvitation, { workspaceId: otherWorkspace, input: { invitationId } }))).toBe("NOT_FOUND");
  });
});

describe("invitation token security", () => {
  it("stores only the token digest, never the raw token", async () => {
    const h = await setup();
    const { invitationId } = expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    const token = lastToken(h);
    const stored = h.unitOfWork.state.invitations.get(invitationId);
    expect(stored?.tokenDigest).toBe(digestToken(token));
    expect(JSON.stringify([...h.unitOfWork.state.invitations.values()])).not.toContain(token);
  });

  it("keeps raw tokens and email addresses out of results, audit events and logs", async () => {
    const h = await setup();
    const result = await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" });
    const token = lastToken(h);
    expectOk(await accept(h, token));
    const surfaces = [JSON.stringify(result), JSON.stringify(h.unitOfWork.state.audit), ...h.logLines];
    for (const text of surfaces) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain("Organization A");
    }
  });

  it("delivers the raw token exactly once, only after the invitation is committed", async () => {
    const h = await setup();
    const before = h.delivery.delivered.length;
    expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    expect(h.delivery.delivered.length).toBe(before + 1);
    expect(h.delivery.delivered.at(-1)?.recipientEmail).toBe(EMAIL);
    expect(h.steps.slice(-2)).toEqual(["audit", "after_commit"]);
  });

  it("audits invitation creation and acceptance", async () => {
    const h = await setup();
    const { invitationId } = expectOk(await invite(h, { recipientEmail: EMAIL, role: "RESPONDER" }));
    expectOk(await accept(h, lastToken(h)));
    const actions = h.unitOfWork.state.audit.filter((event) => event.targetId === invitationId).map((event) => event.action);
    expect(actions).toEqual(["invitation.created", "invitation.accepted"]);
    const accepted = h.unitOfWork.state.audit.at(-1);
    expect(accepted).toMatchObject({ actorUserId: INVITEE, organizationId: h.organizationId, workspaceId: h.workspaceId });
  });
});
