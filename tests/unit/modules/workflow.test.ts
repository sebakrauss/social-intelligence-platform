/**
 * WORKFLOW-WF-2B — the workflow module offline: the pure D1 decision, the projection's order (lock, THEN recompute, THEN
 * write) and idempotence, and the Mark Done / Reopen commands through the real action pipeline over the in-memory unit
 * of work (permission matrix, Monitor-only, stale version, closed input, the boundary owns the audit). The database
 * guarantees behind them are proven by tests/db/suites/workflow-*.ts. Synthetic identities only.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@/domain/access";
import { parseCorrelationId } from "@/domain/correlation";
import { AUDIT_ACTIONS, createAuditEvent } from "@/modules/audit";
import { decideMembersJoined, isAudienceMember, projectMembersJoined, WORK_ITEM_RESOLUTIONS, type LockedWorkItem, type ManualChange, type WorkflowProjectionStore } from "@/modules/workflow";
import { markDoneCommand, reopenCommand, WORKFLOW_CHANGE_AUDIT } from "@/server/commands/workflow";
import type { WorkflowSources } from "@/server/pipeline";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { userId } from "../../support/in-memory";

const OWNER = userId(1);
const ITEM = "0d000000-0000-4000-8000-000000000001";
const correlation = parseCorrelationId("wf2b-unit-correlation") ?? (() => { throw new Error("correlation"); })();

describe("D1 — what joining members do to a work item (pure)", () => {
  const member = (authorRole: string | null, observed = true) => ({ interactionId: `${authorRole ?? "placeholder"}-${String(observed)}`, authorRole, observed });

  it("an observed audience member (user, or an unknown author) reopens a Done item and advances the version", () => {
    for (const role of ["user", "unknown"]) {
      expect(isAudienceMember(member(role))).toBe(true);
      expect(decideMembersJoined("DONE", [member(role)])).toEqual({ audienceJoined: true, reopen: true, cause: `${role}-true` });
      expect(decideMembersJoined("OPEN", [member(role)])).toEqual({ audienceJoined: true, reopen: false, cause: `${role}-true` });
    }
  });

  it("the account's own reply and an unobserved placeholder never reopen and never advance the version", () => {
    for (const joined of [[member("account_identity")], [member(null, false)], [member("user", false)], []]) {
      expect(decideMembersJoined("DONE", joined)).toEqual({ audienceJoined: false, reopen: false, cause: null });
    }
  });

  it("with several members (a late root's subtree), the first audience member in order is the cause", () => {
    const joined = [member("account_identity"), { interactionId: "a1", authorRole: "user", observed: true }, { interactionId: "a2", authorRole: "user", observed: true }];
    expect(decideMembersJoined("DONE", joined).cause).toBe("a1");
  });

  it("D1 takes no `arrival`: the decision has no input through which backfill could suppress a reopen", () => {
    expect(decideMembersJoined.length).toBe(2);
    expect(Object.keys(member("user")).sort()).toEqual(["authorRole", "interactionId", "observed"]);
  });
});

describe("the projection: lock, THEN recompute, THEN write", () => {
  const harness = (item: Partial<LockedWorkItem> = {}) => {
    const steps: string[] = [];
    const applied: Parameters<WorkflowProjectionStore["apply"]>[0][] = [];
    const locked: LockedWorkItem = { id: ITEM, organizationId: "o", workspaceId: "w", state: "DONE", resolution: "no_reply_needed", version: 4, latestActivityAt: new Date("2026-11-01T10:00:00.000Z"), created: false, ...item };
    const store: WorkflowProjectionStore = {
      ensureAndLock: () => { steps.push("lock"); return Promise.resolve(locked); },
      find: () => Promise.resolve(undefined),
      apply: (input) => { steps.push("apply"); applied.push(input); return Promise.resolve(); },
    };
    let n = 0;
    const clock = { newId: () => `id-${String(++n)}`, now: () => new Date("2026-11-02T00:00:00.000Z") };
    return { steps, applied, store, clock };
  };

  it("reads the activity only after the work item is locked, and writes after both", async () => {
    const h = harness();
    const activity = { latestActivity: () => { h.steps.push("recompute"); return Promise.resolve(new Date("2026-11-01T11:00:00.000Z")); } };
    const outcome = await projectMembersJoined(h.store, activity, h.clock, { conversationId: ITEM, organizationId: "o", workspaceId: "w", joined: [{ interactionId: "r", authorRole: "user", observed: true }], correlationId: correlation });
    expect(h.steps).toEqual(["lock", "recompute", "apply"]);
    expect(outcome).toEqual({ kind: "projected", created: false, reopened: true, versionAdvanced: true });
    expect(h.applied[0]?.latestActivityAt.toISOString()).toBe("2026-11-01T11:00:00.000Z");
  });

  it("nothing joined and the same activity: nothing is written (idempotent retry, rebuild without drift)", async () => {
    const h = harness();
    const activity = { latestActivity: () => Promise.resolve(new Date("2026-11-01T10:00:00.000Z")) };
    expect(await projectMembersJoined(h.store, activity, h.clock, { conversationId: ITEM, organizationId: "o", workspaceId: "w", joined: [], correlationId: correlation })).toEqual({ kind: "unchanged" });
    expect(h.steps).toEqual(["lock"]);
  });

  it("an activity may FALL (a placeholder completed with an older platform time): the recomputed value is written, not max(old, new)", async () => {
    const h = harness({ state: "OPEN" });
    const activity = { latestActivity: () => Promise.resolve(new Date("2026-10-01T00:00:00.000Z")) };
    await projectMembersJoined(h.store, activity, h.clock, { conversationId: ITEM, organizationId: "o", workspaceId: "w", joined: [], correlationId: correlation });
    expect(h.applied[0]?.latestActivityAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("the members that CREATE a work item are its initial content: version 1 stays, nothing reopens", async () => {
    const h = harness({ state: "OPEN", version: 1, created: true });
    const activity = { latestActivity: () => Promise.resolve(new Date("2026-11-01T12:00:00.000Z")) };
    const outcome = await projectMembersJoined(h.store, activity, h.clock, { conversationId: ITEM, organizationId: "o", workspaceId: "w", joined: [{ interactionId: "anchor", authorRole: "user", observed: true }], correlationId: correlation });
    expect(outcome).toEqual({ kind: "projected", created: true, reopened: false, versionAdvanced: false });
    expect(h.applied[0]?.decision).toEqual({ audienceJoined: false, reopen: false, cause: null });
  });
});

describe("the audit vocabulary of a workflow change", () => {
  it("work_item.state_changed carries exactly a closed workflow_state summary", () => {
    expect(AUDIT_ACTIONS).toContain("work_item.state_changed");
    const base = { id: "0e000000-0000-4000-8000-000000000001", occurredAt: new Date(), action: "work_item.state_changed", actorType: "system", workspaceId: "0b000000-0000-4000-8000-000000000001", organizationId: "0a000000-0000-4000-8000-000000000001", targetType: "work_item", targetId: ITEM, correlationId: "wf2b-unit-correlation", outcome: "succeeded" };
    expect(createAuditEvent({ ...base, change: { kind: "workflow_state", previous: { state: "DONE", resolution: "reviewed" }, current: { state: "OPEN", resolution: null } } }).change?.kind).toBe("workflow_state");
    for (const change of [
      undefined,
      { kind: "workflow_state", previous: { state: "OPEN", resolution: null }, current: { state: "OPEN", resolution: null } },
      { kind: "workflow_state", previous: { state: "OPEN", resolution: "reviewed" }, current: { state: "DONE", resolution: null } },
      { kind: "workflow_state", previous: { state: "OPEN", resolution: null }, current: { state: "DONE", resolution: "thanks" } },
      { kind: "workflow_state", previous: { state: "OPEN" }, current: { state: "DONE", resolution: null } },
    ]) expect(() => createAuditEvent({ ...base, ...(change === undefined ? {} : { change }) }), JSON.stringify(change)).toThrow();
  });
});

// ── the commands through the pipeline ─────────────────────────────────────────────────────────────────────────────

const ROLES: readonly WorkspaceRole[] = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"];

async function setup(mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD") {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId, mode);
  const members: Partial<Record<WorkspaceRole, ReturnType<typeof userId>>> = { OWNER };
  let n = 2;
  for (const role of ROLES.filter((r) => r !== "OWNER")) {
    const member = userId(n++);
    await h.addMember(OWNER, workspaceId, member, role);
    members[role] = member;
  }
  // A fake boundary that behaves like workflow.change_state: compare-and-set on the version.
  const item = { state: "OPEN" as "OPEN" | "DONE", resolution: null as string | null, version: 1 };
  const asked: { change: ManualChange; expectedVersion: number }[] = [];
  const workflow: WorkflowSources = {
    reads: { queue: () => Promise.resolve([]), findMany: () => Promise.resolve([]) },
    changes: {
      changeState: (input) => {
        asked.push({ change: input.change, expectedVersion: input.expectedVersion });
        if (input.workItemId !== ITEM) return Promise.reject(new Error("unknown"));
        if (input.expectedVersion !== item.version) return Promise.resolve({ outcome: "stale" as const, state: item.state, resolution: null, version: item.version });
        const resolution = input.change.to === "DONE" ? input.change.resolution : null;
        if (item.state === input.change.to && item.resolution === resolution) return Promise.resolve({ outcome: "unchanged" as const, state: item.state, resolution: null, version: item.version });
        item.state = input.change.to;
        item.resolution = resolution;
        item.version += 1;
        return Promise.resolve({ outcome: "changed" as const, state: item.state, resolution, version: item.version });
      },
    },
  };
  h.unitOfWork.workflow = workflow;
  const as = (role: WorkspaceRole): void => {
    const member = members[role];
    if (member === undefined) throw new Error(role);
    h.as(member);
  };
  return { ...h, workspaceId, item, asked, as };
}

describe("workflow.conversation.mark_done / .reopen through the pipeline", () => {
  it("are declared as internal workflow: workflow.internal, no Standard-mode requirement, audited by workflow.change_state only", () => {
    for (const command of [markDoneCommand, reopenCommand]) {
      expect(command.scope).toBe("workspace");
      expect(command.permission).toBe("workflow.internal");
      expect(command.requiresStandardMode).toBe(false);
      expect(command.auditedBy).toBe(WORKFLOW_CHANGE_AUDIT);
      expect(command.audit(undefined as never)).toBeUndefined();
    }
    expect(WORKFLOW_CHANGE_AUDIT).toEqual({ kind: "database_boundary", function: "workflow.change_state", actions: ["work_item.state_changed"] });
  });

  it("OWNER, ADMIN, MANAGER and RESPONDER mark Done and reopen; the pipeline appends no audit event of its own", async () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "RESPONDER"] as const) {
      const h = await setup();
      h.as(role);
      const audit = h.unitOfWork.state.audit.length;
      expect(expectOk(await h.pipeline.run(markDoneCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 1, resolution: "no_reply_needed" } }))).toEqual({ conversationId: ITEM, outcome: "changed", state: "DONE", resolution: "no_reply_needed", version: 2 });
      expect(expectOk(await h.pipeline.run(reopenCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 2 } }))).toMatchObject({ outcome: "changed", state: "OPEN", version: 3 });
      expect(h.unitOfWork.state.audit).toHaveLength(audit);
    }
  });

  it("ANALYST_VIEWER and CLIENT_GUEST are PERMISSION_DENIED before the boundary is asked; another workspace is NOT_FOUND", async () => {
    const h = await setup();
    for (const role of ["ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
      h.as(role);
      expect(errorCode(await h.pipeline.run(markDoneCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 1 } }))).toBe("PERMISSION_DENIED");
      expect(errorCode(await h.pipeline.run(reopenCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 1 } }))).toBe("PERMISSION_DENIED");
    }
    h.as("OWNER");
    expect(errorCode(await h.pipeline.run(markDoneCommand, { workspaceId: "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", input: { conversationId: ITEM, expectedVersion: 1 } }))).toBe("NOT_FOUND");
    expect(h.asked).toEqual([]);
  });

  it("Monitor-only keeps internal workflow: Mark Done works there (no platform action is implied)", async () => {
    const h = await setup("MONITOR_ONLY");
    h.as("RESPONDER");
    expect(expectOk(await h.pipeline.run(markDoneCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 1, resolution: "reviewed" } }))).toMatchObject({ state: "DONE" });
  });

  it("a stale version is CONFLICT and nothing changes; the same state is accepted as unchanged", async () => {
    const h = await setup();
    h.as("MANAGER");
    expect(errorCode(await h.pipeline.run(markDoneCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 7 } }))).toBe("CONFLICT");
    expect(h.item).toEqual({ state: "OPEN", resolution: null, version: 1 });
    expect(expectOk(await h.pipeline.run(reopenCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 1 } }))).toMatchObject({ outcome: "unchanged", version: 1 });
  });

  it("the input is closed: a uuid, a positive integer version, an optional resolution of the vocabulary — nothing else", async () => {
    const h = await setup();
    h.as("OWNER");
    for (const input of [
      { conversationId: "nope", expectedVersion: 1 },
      { conversationId: ITEM, expectedVersion: 0 },
      { conversationId: ITEM, expectedVersion: 1.5 },
      { conversationId: ITEM, expectedVersion: "1" },
      { conversationId: ITEM, expectedVersion: 1, resolution: "thanks" },
      { conversationId: ITEM, expectedVersion: 1, state: "DONE" },
      { conversationId: ITEM, expectedVersion: 1, workspaceId: h.workspaceId },
    ]) expect(errorCode(await h.pipeline.run(markDoneCommand, { workspaceId: h.workspaceId, input })), JSON.stringify(input)).toBe("INVALID_INPUT");
    // Reopen takes no resolution at all.
    expect(errorCode(await h.pipeline.run(reopenCommand, { workspaceId: h.workspaceId, input: { conversationId: ITEM, expectedVersion: 1, resolution: "reviewed" } }))).toBe("INVALID_INPUT");
    for (const resolution of WORK_ITEM_RESOLUTIONS) expect(markDoneCommand.validate({ conversationId: ITEM, expectedVersion: 1, resolution }).resolution).toBe(resolution);
    expect(h.asked).toEqual([]);
  });
});
