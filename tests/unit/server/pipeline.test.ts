import { describe, expect, it } from "vitest";
import { parseCorrelationId } from "@/domain/correlation";
import { AppError } from "@/domain/errors";
import { object } from "@/domain/validation";
import type { AuditDraft, PipelineRequest, WorkspaceCommand } from "@/server/pipeline";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { emailOf, userId } from "../../support/in-memory";

const OWNER = userId(1);
const OUTSIDER = userId(2);
const MEMBER = userId(3);
const OTHER_OWNER = userId(4);

/** Test-only commands: one platform-mutation-like (needs Standard), one internal workflow action. */
function testCommands() {
  const executed = { platform: 0, internal: 0, delete: 0 };
  const base = { validate: object({}), audit: (): AuditDraft | undefined => undefined, respond: (value: string) => value };
  const platformAction: WorkspaceCommand<object, string, string> = {
    ...base,
    scope: "workspace",
    name: "test.platform_action",
    permission: "reply.public",
    requiresStandardMode: true,
    execute: async () => {
      executed.platform += 1;
      return Promise.resolve("done");
    },
  };
  const internalAction: WorkspaceCommand<object, string, string> = {
    ...base,
    scope: "workspace",
    name: "test.internal_action",
    permission: "workflow.internal",
    requiresStandardMode: false,
    execute: async () => {
      executed.internal += 1;
      return Promise.resolve("done");
    },
  };
  const deleteAction: WorkspaceCommand<object, string, string> = {
    ...base,
    scope: "workspace",
    name: "test.delete_action",
    permission: "moderate.delete",
    requiresStandardMode: true,
    execute: async () => {
      executed.delete += 1;
      return Promise.resolve("done");
    },
  };
  return { executed, platformAction, internalAction, deleteAction };
}

async function setup() {
  const harness = createHarness();
  const organizationId = await harness.createOrganization(OWNER);
  const workspaceId = await harness.createWorkspace(OWNER, organizationId);
  harness.steps.length = 0;
  return { ...harness, organizationId, workspaceId, test: testCommands() };
}

describe("authentication", () => {
  it("denies an unauthenticated request before any tenant work", async () => {
    const h = await setup();
    h.identity.user = undefined;
    const commitsBefore = h.unitOfWork.commits;
    const result = await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {} });
    expect(result.status).toBe("unauthenticated");
    expect(h.steps).toEqual(["authenticate"]);
    expect(h.unitOfWork.commits).toBe(commitsBefore);
    expect(h.test.executed.internal).toBe(0);
  });

  it("denies an unverified identity any organization or workspace access", async () => {
    const h = await setup();
    h.identity.user = { id: OWNER, emailVerified: false };
    const workspaceResult = await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {} });
    const organizationResult = await h.pipeline.run(h.commands.createWorkspace, { organizationId: h.organizationId, input: { name: "X" } });
    expect(workspaceResult.status).toBe("verification_required");
    expect(organizationResult.status).toBe("verification_required");
    expect(h.steps).toEqual(["authenticate", "authenticate"]);
  });

  it("ignores client-supplied roles and permissions: authority comes from live membership", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MEMBER, "ANALYST_VIEWER");
    h.as(MEMBER);
    const forged = {
      workspaceId: h.workspaceId,
      input: { mode: "MONITOR_ONLY" },
      role: "OWNER",
      permissions: ["workspace.mode.change"],
      userId: OWNER,
    } as PipelineRequest;
    expect(errorCode(await h.pipeline.run(h.commands.changeWorkspaceMode, forged))).toBe("PERMISSION_DENIED");

    h.as(OWNER);
    const withRoleInInput = await h.pipeline.run(h.commands.changeWorkspaceMode, {
      workspaceId: h.workspaceId,
      input: { mode: "MONITOR_ONLY", role: "OWNER" },
    });
    expect(errorCode(withRoleInInput)).toBe("INVALID_INPUT");
  });
});

describe("tenant resolution", () => {
  it("resolves a member's workspace", async () => {
    const h = await setup();
    h.as(OWNER);
    expect(expectOk(await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {} }))).toBe("done");
  });

  it("resolves non-member, unknown and malformed workspaces as NOT_FOUND (never PERMISSION_DENIED)", async () => {
    const h = await setup();
    h.as(OUTSIDER);
    expect(errorCode(await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {} }))).toBe("NOT_FOUND");
    h.as(OWNER);
    for (const workspaceId of ["00000000-0000-4000-8000-999999999999", "not-a-uuid", undefined, 42]) {
      expect(errorCode(await h.pipeline.run(h.test.internalAction, { workspaceId, input: {} }))).toBe("NOT_FOUND");
    }
  });

  it("never lets membership in workspace A authorize workspace B", async () => {
    const h = await setup();
    const otherOrganization = await h.createOrganization(OTHER_OWNER);
    const workspaceB = await h.createWorkspace(OTHER_OWNER, otherOrganization);
    h.as(OWNER);
    expect(errorCode(await h.pipeline.run(h.test.internalAction, { workspaceId: workspaceB, input: {} }))).toBe("NOT_FOUND");
  });

  it("applies a removed membership on the very next execution", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MEMBER, "MANAGER");
    h.as(MEMBER);
    expect(expectOk(await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {} }))).toBe("done");
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.removeMember, { workspaceId: h.workspaceId, input: { userId: MEMBER } }));
    h.as(MEMBER);
    expect(errorCode(await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {} }))).toBe("NOT_FOUND");
  });

  it("does not grant workspace access from organization membership alone", async () => {
    const h = await setup();
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.inviteToOrganization, {
      organizationId: h.organizationId,
      input: { recipientEmail: emailOf(MEMBER), role: "ADMIN" },
    }));
    h.as(MEMBER);
    expectOk(await h.pipeline.run(h.commands.acceptInvitation, { input: { token: h.delivery.delivered.at(-1)?.rawToken } }));
    expect(errorCode(await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {} }))).toBe("NOT_FOUND");
    // …while organization authority itself works:
    expect(expectOk(await h.pipeline.run(h.commands.createWorkspace, { organizationId: h.organizationId, input: { name: "B" } })).workspaceId).toBeDefined();
  });

  it("resolves organization scope separately: non-member NOT_FOUND, plain member PERMISSION_DENIED", async () => {
    const h = await setup();
    h.as(OUTSIDER);
    expect(errorCode(await h.pipeline.run(h.commands.createWorkspace, { organizationId: h.organizationId, input: { name: "X" } }))).toBe("NOT_FOUND");
    await h.addMember(OWNER, h.workspaceId, MEMBER, "MANAGER"); // creates an organization MEMBER
    h.as(MEMBER);
    expect(errorCode(await h.pipeline.run(h.commands.createWorkspace, { organizationId: h.organizationId, input: { name: "X" } }))).toBe("PERMISSION_DENIED");
  });
});

describe("workspace mode guard", () => {
  it("allows a Standard-mode action in a Standard workspace when authorized", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MEMBER, "RESPONDER");
    h.as(MEMBER);
    expect(expectOk(await h.pipeline.run(h.test.platformAction, { workspaceId: h.workspaceId, input: {} }))).toBe("done");
  });

  it("returns MODE_BLOCKED for a Standard-mode action in a Monitor-only workspace, without executing", async () => {
    const h = await setup();
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.changeWorkspaceMode, { workspaceId: h.workspaceId, input: { mode: "MONITOR_ONLY" } }));
    h.steps.length = 0;
    expect(errorCode(await h.pipeline.run(h.test.platformAction, { workspaceId: h.workspaceId, input: {} }))).toBe("MODE_BLOCKED");
    expect(h.test.executed.platform).toBe(0);
    expect(h.steps).toEqual(["authenticate", "resolve_tenant", "authorize", "validate", "mode_guard"]);
  });

  it("does not block internal actions merely because the workspace is Monitor-only", async () => {
    const h = await setup();
    const monitorOnly = await h.createWorkspace(OWNER, h.organizationId, "MONITOR_ONLY");
    h.as(OWNER);
    expect(expectOk(await h.pipeline.run(h.test.internalAction, { workspaceId: monitorOnly, input: {} }))).toBe("done");
    expect(errorCode(await h.pipeline.run(h.test.platformAction, { workspaceId: monitorOnly, input: {} }))).toBe("MODE_BLOCKED");
  });

  it("checks permission before mode: an unauthorized role gets PERMISSION_DENIED, not MODE_BLOCKED", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MEMBER, "ANALYST_VIEWER");
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.changeWorkspaceMode, { workspaceId: h.workspaceId, input: { mode: "MONITOR_ONLY" } }));
    h.as(MEMBER);
    expect(errorCode(await h.pipeline.run(h.test.platformAction, { workspaceId: h.workspaceId, input: {} }))).toBe("PERMISSION_DENIED");
  });
});

describe("pipeline ordering and audit", () => {
  it("runs authenticate → resolve tenant → authorize → validate → mode guard → execute → audit", async () => {
    const h = await setup();
    h.as(OWNER);
    expectOk(await h.pipeline.run(h.commands.changeWorkspaceMode, { workspaceId: h.workspaceId, input: { mode: "MONITOR_ONLY" } }));
    expect(h.steps).toEqual(["authenticate", "resolve_tenant", "authorize", "validate", "mode_guard", "execute", "audit"]);
  });

  it.each([
    ["resolve_tenant", { workspaceId: "00000000-0000-4000-8000-999999999999", input: {} }, "NOT_FOUND"],
    ["validate", { input: { unexpected: true } }, "INVALID_INPUT"],
  ] as const)("stops at %s and never executes", async (lastStep, request, code) => {
    const h = await setup();
    h.as(OWNER);
    const result = await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, ...request });
    expect(errorCode(result)).toBe(code);
    expect(h.steps.at(-1)).toBe(lastStep);
    expect(h.test.executed.internal).toBe(0);
  });

  it("stops at authorize when permission is missing", async () => {
    const h = await setup();
    await h.addMember(OWNER, h.workspaceId, MEMBER, "RESPONDER");
    h.as(MEMBER);
    h.steps.length = 0;
    expect(errorCode(await h.pipeline.run(h.test.deleteAction, { workspaceId: h.workspaceId, input: {} }))).toBe("PERMISSION_DENIED");
    expect(h.steps).toEqual(["authenticate", "resolve_tenant", "authorize"]);
    expect(h.test.executed.delete).toBe(0);
  });

  it("writes one safe audit event for a consequential command, in the same unit of work", async () => {
    const h = await setup();
    h.as(OWNER);
    const correlationId = parseCorrelationId("abcdef01-2345-4678-89ab-cdef01234567");
    expectOk(await h.pipeline.run(h.commands.changeWorkspaceMode, {
      workspaceId: h.workspaceId,
      input: { mode: "MONITOR_ONLY" },
      correlationId,
      requestId: "req-0001-abcdef",
    }));
    const event = h.unitOfWork.state.audit.at(-1);
    expect(event).toEqual({
      id: expect.any(String) as unknown,
      occurredAt: expect.any(Date) as unknown,
      action: "workspace.mode_changed",
      actorType: "user",
      actorUserId: OWNER,
      organizationId: h.organizationId,
      workspaceId: h.workspaceId,
      targetType: "workspace",
      targetId: h.workspaceId,
      correlationId,
      requestId: "req-0001-abcdef",
      outcome: "succeeded",
      change: { kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" },
    });
  });

  it("does not audit a no-op and audits nothing when the command fails", async () => {
    const h = await setup();
    h.as(OWNER);
    const before = h.unitOfWork.state.audit.length;
    expectOk(await h.pipeline.run(h.commands.changeWorkspaceMode, { workspaceId: h.workspaceId, input: { mode: "STANDARD" } }));
    expect(errorCode(await h.pipeline.run(h.commands.changeWorkspaceMode, { workspaceId: h.workspaceId, input: { mode: "PAUSED" } }))).toBe("INVALID_INPUT");
    expect(h.unitOfWork.state.audit.length).toBe(before);
  });

  it("never copies undeclared data from a command into the audit event", async () => {
    const h = await setup();
    h.as(OWNER);
    const leaky: WorkspaceCommand<object, string, string> = {
      scope: "workspace",
      name: "test.leaky_audit",
      permission: "workflow.internal",
      requiresStandardMode: false,
      validate: object({}),
      execute: async () => Promise.resolve("done"),
      audit: () =>
        ({
          action: "workspace.mode_changed",
          targetType: "workspace",
          targetId: h.workspaceId,
          change: { kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" },
          recipientEmail: "person@example.test",
          workspaceName: "Client — Café Aurora",
        }) as AuditDraft,
      respond: (value) => value,
    };
    expectOk(await h.pipeline.run(leaky, { workspaceId: h.workspaceId, input: {} }));
    const serialized = JSON.stringify(h.unitOfWork.state.audit);
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("Café Aurora");
  });

  it("rolls back every write when execution fails after writing", async () => {
    const h = await setup();
    h.as(OWNER);
    const failing: WorkspaceCommand<object, string, string> = {
      scope: "workspace",
      name: "test.failing_after_write",
      permission: "workflow.internal",
      requiresStandardMode: false,
      validate: object({}),
      execute: async (context, _input, tx) => {
        await tx.tenancy.workspaces.update({ ...context.workspace, mode: "MONITOR_ONLY" });
        throw new AppError("CONFLICT", {});
      },
      audit: () => ({ action: "workspace.mode_changed", targetType: "workspace", targetId: h.workspaceId }),
      respond: (value) => value,
    };
    const auditBefore = h.unitOfWork.state.audit.length;
    expect(errorCode(await h.pipeline.run(failing, { workspaceId: h.workspaceId, input: {} }))).toBe("CONFLICT");
    expect(h.unitOfWork.state.workspaces.get(h.workspaceId)?.mode).toBe("STANDARD");
    expect(h.unitOfWork.state.audit.length).toBe(auditBefore);
  });

  it("propagates correlation and request IDs to results, errors, audit and logs", async () => {
    const h = await setup();
    h.as(OUTSIDER);
    const correlationId = parseCorrelationId("abcdef01-2345-4678-89ab-cdef01234567");
    const result = await h.pipeline.run(h.test.internalAction, {
      workspaceId: h.workspaceId,
      input: {},
      correlationId,
      requestId: "req-0002-abcdef",
    });
    expect(result.correlationId).toBe(correlationId);
    expect(result.status === "error" ? result.error.correlationId : undefined).toBe(correlationId);
    const line = JSON.parse(h.logLines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ correlationId, requestId: "req-0002-abcdef", operation: "test.internal_action", errorCode: "NOT_FOUND" });
  });

  it("starts a correlation ID when the caller provides none or an invalid one", async () => {
    const h = await setup();
    h.as(OWNER);
    const result = await h.pipeline.run(h.test.internalAction, { workspaceId: h.workspaceId, input: {}, correlationId: "bad id with spaces" });
    expect(parseCorrelationId(result.correlationId)).toBe(result.correlationId);
    expect(result.correlationId).not.toBe("bad id with spaces");
  });
});

describe("resolved contexts", () => {
  it("can't be constructed by callers (private constructor; runtime imports are limited to server/pipeline by boundary rules)", async () => {
    const { WorkspaceContext } = await import("@/server/pipeline/context");
    const construct = (): unknown =>
      // @ts-expect-error the constructor is private: contexts come only from live resolution
      new WorkspaceContext();
    expect(typeof construct).toBe("function");
  });
});
