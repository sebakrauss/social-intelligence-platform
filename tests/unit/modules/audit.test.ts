import { describe, expect, it } from "vitest";
import { createAuditEvent } from "@/modules/audit";

const valid = {
  id: "00000000-0000-4000-8000-000000000001",
  occurredAt: new Date("2026-10-05T12:00:00Z"),
  action: "workspace.created",
  actorType: "user",
  actorUserId: "10000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
  targetType: "workspace",
  targetId: "00000000-0000-4000-8000-000000000003",
  correlationId: "abcdef01-2345-4678-89ab-cdef01234567",
  requestId: "req-0001-abcdef",
  outcome: "succeeded",
};

describe("audit events", () => {
  it("accept declared, identifier-shaped metadata", () => {
    expect(createAuditEvent(valid)).toEqual(valid);
    expect(Object.isFrozen(createAuditEvent(valid))).toBe(true);
  });

  it("accept membership targets keyed by workspace and user", () => {
    expect(createAuditEvent({ ...valid, targetType: "workspace_membership", targetId: `${valid.workspaceId}:${valid.actorUserId}` }).targetId).toContain(":");
  });

  it.each([
    ["an undeclared field", { ...valid, recipientEmail: "person@example.test" }],
    ["an email as target", { ...valid, targetId: "person@example.test" }],
    ["a name as target", { ...valid, targetId: "Client — Café Aurora" }],
    ["an unknown action", { ...valid, action: "Deleted everything" }],
    ["an unknown actor type", { ...valid, actorType: "María" }],
    ["a malformed correlation ID", { ...valid, correlationId: "has spaces in it" }],
    ["a non-UUID organization", { ...valid, organizationId: "Organization A" }],
    ["a missing outcome", { ...valid, outcome: undefined }],
  ])("reject %s", (_label, input) => {
    expect(() => createAuditEvent(input)).toThrow(TypeError);
  });

  it("never echo rejected values or undeclared keys in the error", () => {
    const message = (input: unknown): string => {
      try {
        createAuditEvent(input);
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
      return "";
    };
    expect(message({ ...valid, recipientEmail: "person@example.test" })).not.toMatch(/recipientEmail|person@/);
    expect(message({ ...valid, targetId: "person@example.test" })).not.toContain("person@");
  });
});

describe("audit change summaries", () => {
  const roleChanged = { ...valid, action: "workspace_membership.role_changed", targetType: "workspace_membership", targetId: `${valid.workspaceId}:${valid.actorUserId}` };
  const roleChange = { kind: "workspace_membership", previous: { role: "OWNER", grants: [] }, current: { role: "ADMIN", grants: ["moderate.delete"] } };

  it("accept catalog values and freeze them", () => {
    const event = createAuditEvent({ ...roleChanged, change: roleChange });
    expect(event.change).toEqual(roleChange);
    expect(Object.isFrozen(event.change)).toBe(true);
    expect(createAuditEvent({ ...valid, action: "workspace.mode_changed", change: { kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" } }).change).toEqual({
      kind: "workspace_mode",
      previous: "STANDARD",
      current: "MONITOR_ONLY",
    });
    expect(
      createAuditEvent({ ...valid, action: "organization_membership.removed", targetType: "organization_membership", change: { kind: "organization_membership", previous: { role: "ADMIN" }, current: null } }).change,
    ).toEqual({ kind: "organization_membership", previous: { role: "ADMIN" }, current: null });
  });

  it.each([
    ["a missing summary on a state change", { ...roleChanged }],
    ["a summary on an action that has none", { ...valid, change: roleChange }],
    ["an unknown mode", { ...valid, action: "workspace.mode_changed", change: { kind: "workspace_mode", previous: "STANDARD", current: "PAUSED" } }],
    ["a free-form role", { ...roleChanged, change: { ...roleChange, current: { role: "Super admin", grants: [] } } }],
    ["an unknown grant", { ...roleChanged, change: { ...roleChange, current: { role: "ADMIN", grants: ["everything"] } } }],
    ["duplicate grants", { ...roleChanged, change: { ...roleChange, current: { role: "ADMIN", grants: ["moderate.delete", "moderate.delete"] } } }],
    ["an email", { ...roleChanged, change: { ...roleChange, previous: { role: "OWNER", grants: [], email: "person@example.test" } } }],
    ["a name", { ...roleChanged, change: { ...roleChange, workspaceName: "Client — Café Aurora" } }],
    ["a removal that keeps a current state", { ...roleChanged, action: "workspace_membership.removed", change: roleChange }],
    ["a role change that drops the current state", { ...roleChanged, change: { ...roleChange, current: null } }],
    ["a string summary", { ...roleChanged, change: "OWNER -> ADMIN" }],
  ])("reject %s", (_label, input) => {
    expect(() => createAuditEvent(input)).toThrow(TypeError);
  });

  it("never echo rejected change values in the error", () => {
    try {
      createAuditEvent({ ...roleChanged, change: { ...roleChange, previous: { role: "person@example.test", grants: [] } } });
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("person@");
      return;
    }
    expect.unreachable();
  });
});
