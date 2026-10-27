/**
 * Sync interactions (Step H6-C4), offline: the registered command through the real action pipeline over the in-memory
 * unit of work (the boundary's answer injected), and the pipeline's audit ownership. Proves: Owner/Admin reach the
 * 0019 adapter with ONLY the account and the correlation id (no time, no budget), every lower role is refused before
 * it, the pipeline appends NO audit event for a boundary-audited command (and fails closed if such a command ever
 * returns a draft), the boundary's planner row is reported for the post-commit wake-up, and an incoherent answer fails
 * closed. The boundary itself is proven on PostgreSQL (tests/db/suites/interactions-sync.ts, reconciliation-request.ts).
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@/domain/access";
import { object } from "@/domain/validation";
import type { OutboxNotice } from "@/platform/outbox";
import { RECONCILIATION_REQUEST_AUDIT, requestInteractionsSyncCommand } from "@/server/commands/reconciliation";
import { requestInteractionsSync } from "@/server/connections/settings";
import type { WorkspaceCommand } from "@/server/pipeline";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { userId } from "../../support/in-memory";

const OWNER = userId(1);
const ACCOUNT = "2c3d4e5f-6a7b-4c8d-9e0f-a0b1c2d3e4f5";
const RUN = "4e5f6a7b-8c9d-4e0f-9a1b-c2d3e4f5a6b7";
const ROW = "5f6a7b8c-9d0e-4f1a-8b2c-d3e4f5a6b7c8";

async function setup() {
  const notices: OutboxNotice[] = [];
  const h = createHarness({
    outboxCommitted: (committed) => {
      notices.push(...committed);
      return Promise.resolve();
    },
  });
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId);
  const members: Partial<Record<WorkspaceRole, ReturnType<typeof userId>>> = { OWNER };
  let n = 2;
  for (const role of ["ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
    const member = userId(n++);
    await h.addMember(OWNER, workspaceId, member, role);
    members[role] = member;
  }
  h.unitOfWork.reconciliation = () => Promise.resolve({ outcome: "requested", runId: RUN, outboxId: ROW });
  const auditBefore = h.unitOfWork.state.audit.length;
  const as = (role: WorkspaceRole): void => {
    const member = members[role];
    if (member === undefined) throw new Error(role);
    h.as(member);
  };
  return { ...h, workspaceId, notices, auditBefore, as };
}

describe("the command through the pipeline", () => {
  it("OWNER and ADMIN reach the boundary with ONLY the account and correlation (no time, no budget); the pipeline appends no audit event", async () => {
    const h = await setup();
    for (const role of ["OWNER", "ADMIN"] as const) {
      h.as(role);
      const result = expectOk(await h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: ACCOUNT } }));
      expect(result).toEqual({ kind: "requested", runId: RUN });
    }
    expect(h.unitOfWork.reconciliationRequests).toHaveLength(2);
    for (const request of h.unitOfWork.reconciliationRequests) {
      expect(Object.keys(request).sort()).toEqual(["budget", "connectedAccountId", "correlationId", "requestedAt"]);
      expect(request).toMatchObject({ connectedAccountId: ACCOUNT, requestedAt: null, budget: null });
    }
    // The boundary wrote the audit event in its own statement: nothing was appended by the pipeline.
    expect(h.unitOfWork.state.audit.slice(h.auditBefore)).toEqual([]);
    // Nor any outbox row: only the boundary's row is reported for the post-commit wake-up.
    expect(h.unitOfWork.state.outbox.filter((row) => row.topic.startsWith("ingestion."))).toEqual([]);
    expect(h.notices.map((notice) => notice.id)).toEqual([ROW, ROW]);
  });

  it("MANAGER, RESPONDER, ANALYST_VIEWER and CLIENT_GUEST are refused before the boundary (PERMISSION_DENIED)", async () => {
    const h = await setup();
    for (const role of ["MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
      h.as(role);
      expect(errorCode(await h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: ACCOUNT } })), role).toBe("PERMISSION_DENIED");
    }
    expect(h.unitOfWork.reconciliationRequests).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("unauthenticated: nothing runs", async () => {
    const h = await setup();
    h.identity.user = undefined;
    expect((await h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: ACCOUNT } })).status).toBe("unauthenticated");
    expect(h.unitOfWork.reconciliationRequests).toEqual([]);
  });

  it("the browser can name nothing but the account: any other field (budget, time, scope, topic) is INVALID_INPUT", async () => {
    const h = await setup();
    h.as("OWNER");
    for (const extra of [{ maxOperations: 8 }, { max_operations: 40 }, { budget: {} }, { requestedAt: "2026-01-01T00:00:00Z" }, { workspaceId: h.workspaceId }, { organizationId: "x" }, { userId: "x" }, { role: "OWNER" }, { topic: "ingestion.reconcile_account" }]) {
      expect(errorCode(await h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: ACCOUNT, ...extra } })), Object.keys(extra)[0]).toBe("INVALID_INPUT");
    }
    expect(errorCode(await h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: "not-a-uuid" } }))).toBe("INVALID_INPUT");
    expect(h.unitOfWork.reconciliationRequests).toEqual([]);
  });

  it("already_running and not_found are answers, not failures; neither reports an outbox row", async () => {
    const h = await setup();
    h.as("OWNER");
    h.unitOfWork.reconciliation = () => Promise.resolve({ outcome: "already_running", runId: RUN });
    expect(expectOk(await h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: ACCOUNT } }))).toEqual({ kind: "already_running", runId: RUN });
    h.unitOfWork.reconciliation = () => Promise.resolve({ outcome: "not_found" });
    expect(expectOk(await h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: ACCOUNT } }))).toEqual({ kind: "not_found" });
    expect(h.notices).toEqual([]);
    expect(h.unitOfWork.state.audit.slice(h.auditBefore)).toEqual([]);
  });

  it("an incoherent boundary answer fails closed: the unit of work rolls back (the server action maps the throw to plain unavailable)", async () => {
    const h = await setup();
    h.as("OWNER");
    h.unitOfWork.reconciliation = () => Promise.reject(new Error("reconciliation_request_incoherent"));
    const rollbacks = h.unitOfWork.rollbacks;
    await expect(h.pipeline.run(requestInteractionsSyncCommand, { workspaceId: h.workspaceId, input: { connectedAccountId: ACCOUNT } })).rejects.toThrow("reconciliation_request_incoherent");
    expect(h.unitOfWork.rollbacks).toBe(rollbacks + 1);
    expect(h.notices).toEqual([]);
  });
});

describe("the settings surface's closed outcomes", () => {
  it("maps requested / already_running / not_found / refusals to closed statuses; started ≠ imported", async () => {
    const h = await setup();
    const sync = () => requestInteractionsSync(h.pipeline, { workspaceId: h.workspaceId, connectedAccountId: ACCOUNT });
    h.as("ADMIN");
    expect(await sync()).toEqual({ kind: "status", status: "sync_started" });
    h.unitOfWork.reconciliation = () => Promise.resolve({ outcome: "already_running", runId: RUN });
    expect(await sync()).toEqual({ kind: "status", status: "sync_already_running" });
    h.unitOfWork.reconciliation = () => Promise.resolve({ outcome: "not_found" });
    expect(await sync()).toEqual({ kind: "status", status: "sync_not_found" });
    h.as("RESPONDER");
    expect(await sync()).toEqual({ kind: "status", status: "not_allowed" });
    h.identity.user = undefined;
    expect(await sync()).toEqual({ kind: "signed_out" });
    h.as("OWNER");
    expect(await requestInteractionsSync(h.pipeline, { workspaceId: h.workspaceId, connectedAccountId: "nope" })).toEqual({ kind: "status", status: "sync_not_found" });
    expect(await requestInteractionsSync(h.pipeline, { workspaceId: "nope", connectedAccountId: ACCOUNT })).toEqual({ kind: "status", status: "sync_not_found" });
  });
});

describe("audit ownership in the pipeline (DatabaseBoundaryAudit)", () => {
  it("the request command declares its boundary as the audit owner of exactly reconciliation_requested, and drafts nothing", () => {
    expect(requestInteractionsSyncCommand.auditedBy).toBe(RECONCILIATION_REQUEST_AUDIT);
    expect(RECONCILIATION_REQUEST_AUDIT).toEqual({ kind: "database_boundary", function: "ingestion.request_reconciliation", actions: ["connected_account.reconciliation_requested"] });
    expect(requestInteractionsSyncCommand.audit({ kind: "requested", runId: RUN, outboxId: ROW })).toBeUndefined();
    expect(Object.isFrozen(RECONCILIATION_REQUEST_AUDIT)).toBe(true);
  });

  it("a boundary-audited command that returns a draft fails closed: rolled back, nothing appended", async () => {
    const h = await setup();
    h.as("OWNER");
    const confused: WorkspaceCommand<Record<string, never>, string, string> = {
      scope: "workspace",
      name: "test.boundary_audited_with_draft",
      permission: "connections.manage",
      requiresStandardMode: false,
      validate: object({}),
      execute: () => Promise.resolve(ACCOUNT),
      audit: (id) => ({ action: "connected_account.reconciliation_requested", targetType: "connected_account", targetId: id }),
      auditedBy: RECONCILIATION_REQUEST_AUDIT,
      respond: (id) => id,
    };
    const rollbacks = h.unitOfWork.rollbacks;
    await expect(h.pipeline.run(confused, { workspaceId: h.workspaceId, input: {} })).rejects.toThrow("boundary_audited_command_returned_a_draft");
    expect(h.unitOfWork.rollbacks).toBe(rollbacks + 1);
    expect(h.unitOfWork.state.audit.slice(h.auditBefore)).toEqual([]);
  });
});
