/**
 * Step 7B-1 — the public-reply request command through the REAL action pipeline over the in-memory unit of work (the
 * request sources injected): the role matrix of `reply.public`, Monitor-only refused before anything runs
 * (MODE_BLOCKED), the pipeline's audit event and the IDs-only outbox row of a created request, nothing written for a
 * refusal or a repeated key, and strict input validation. The request sources themselves are proven offline
 * (tests/unit/mutations/request.test.ts) and on PostgreSQL (tests/db/suites/mutations.ts).
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@/domain/access";
import { requestPublicReplyCommand } from "@/server/commands/mutations";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { userId } from "../../support/in-memory";
import { fixedClock, guardState, memoryStores, replyTarget, TARGET } from "../mutations/support";

const OWNER = userId(1);
const KEY = "form-render-0000-0001";

async function setup(mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD", stores = memoryStores()) {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId, mode);
  const members: Partial<Record<WorkspaceRole, ReturnType<typeof userId>>> = { OWNER };
  let n = 2;
  for (const role of ["ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
    const member = userId(n++);
    await h.addMember(OWNER, workspaceId, member, role);
    members[role] = member;
  }
  // The target lives in THIS workspace (the in-memory target carries the workspace the request compares against).
  stores.targetRows.set(TARGET, replyTarget({ workspaceId }));
  h.unitOfWork.mutations = stores;
  const auditBefore = h.unitOfWork.state.audit.length;
  const outboxBefore = h.unitOfWork.state.outbox.length;
  const asUser = h.as;
  const as = (role: WorkspaceRole): void => {
    const member = members[role];
    if (member === undefined) throw new Error(role);
    asUser(member);
  };
  const run = (input: unknown) => h.pipeline.run(requestPublicReplyCommand, { workspaceId, input });
  return { ...h, workspaceId, organizationId, stores, auditBefore, outboxBefore, as, asUser, run, members };
}

const input = (key = KEY) => ({ targetInteractionId: TARGET, text: "Gracias por escribirnos.", idempotencyKey: key });

describe("the command through the pipeline", () => {
  it("OWNER, ADMIN, MANAGER and RESPONDER create an intent; the pipeline audits it as the member and appends the IDs-only outbox row", async () => {
    const h = await setup();
    let n = 0;
    for (const role of ["OWNER", "ADMIN", "MANAGER", "RESPONDER"] as const) {
      h.as(role);
      const result = expectOk(await h.run(input(`${KEY}-${role}`)));
      expect(result.kind).toBe("requested");
      if (result.kind !== "requested") return;
      n += 1;
      const intent = h.stores.intentRows.get(`${h.workspaceId}:${result.intentId}`);
      expect(intent).toMatchObject({ status: "PENDING", initiatorUserId: h.members[role], workspaceId: h.workspaceId, organizationId: h.organizationId });
      const audit = h.unitOfWork.state.audit.at(-1);
      expect(audit).toMatchObject({ action: "mutation_intent.created", actorType: "user", actorUserId: h.members[role], targetType: "mutation_intent", targetId: result.intentId, workspaceId: h.workspaceId, organizationId: h.organizationId, outcome: "succeeded" });
      const row = h.unitOfWork.state.outbox.at(-1);
      expect(row).toMatchObject({ topic: "mutations.execute_intent", workspaceId: h.workspaceId, organizationId: h.organizationId, initiator: { type: "user", userId: h.members[role] } });
      expect(Object.keys(row?.subjectIds ?? {}).sort()).toEqual(["connected_account_id", "mutation_intent_id"]);
      expect(row?.subjectIds["mutation_intent_id"]).toBe(result.intentId);
      expect(JSON.stringify(row)).not.toMatch(/Gracias/);
    }
    expect(h.unitOfWork.state.audit.length - h.auditBefore).toBe(n);
    expect(h.unitOfWork.state.outbox.length - h.outboxBefore).toBe(n);
  });

  it("ANALYST_VIEWER and CLIENT_GUEST are refused before the request runs (PERMISSION_DENIED): nothing written", async () => {
    const h = await setup();
    for (const role of ["ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
      h.as(role);
      expect(errorCode(await h.run(input())), role).toBe("PERMISSION_DENIED");
    }
    expect(h.stores.intentRows.size).toBe(0);
    expect(h.unitOfWork.state.audit.length).toBe(h.auditBefore);
    expect(h.unitOfWork.state.outbox.length).toBe(h.outboxBefore);
  });

  it("a Monitor-only workspace refuses every role before the request runs (MODE_BLOCKED): a platform mutation is never requested", async () => {
    const h = await setup("MONITOR_ONLY");
    for (const role of ["OWNER", "ADMIN", "MANAGER", "RESPONDER"] as const) {
      h.as(role);
      expect(errorCode(await h.run(input())), role).toBe("MODE_BLOCKED");
    }
    expect(h.stores.intentRows.size).toBe(0);
    expect(h.stores.calls).toEqual([]);
    expect(h.unitOfWork.state.audit.length).toBe(h.auditBefore);
    expect(h.unitOfWork.state.outbox.length).toBe(h.outboxBefore);
  });

  it("a member of another workspace is NOT_FOUND (never 'forbidden')", async () => {
    const h = await setup();
    const stranger = userId(99);
    const otherOrganization = await h.createOrganization(stranger);
    await h.createWorkspace(stranger, otherOrganization, "STANDARD");
    h.asUser(stranger);
    expect(errorCode(await h.run(input()))).toBe("NOT_FOUND");
  });

  it("a refusal of the request-time guards is answered, not thrown, and writes no audit event and no outbox row", async () => {
    const h = await setup("STANDARD", memoryStores(guardState({ capability: "UNAVAILABLE" })));
    h.as("RESPONDER");
    expect(expectOk(await h.run(input()))).toEqual({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
    expect(h.unitOfWork.state.audit.length).toBe(h.auditBefore);
    expect(h.unitOfWork.state.outbox.length).toBe(h.outboxBefore);
  });

  it("a repeated idempotency key answers the existing intent and writes nothing more", async () => {
    const h = await setup();
    h.as("RESPONDER");
    const first = expectOk(await h.run(input()));
    const second = expectOk(await h.run(input()));
    expect(first.kind).toBe("requested");
    expect(second).toEqual({ kind: "existing", intentId: first.kind === "requested" ? first.intentId : "", status: "PENDING" });
    expect(h.unitOfWork.state.audit.length - h.auditBefore).toBe(1);
    expect(h.unitOfWork.state.outbox.length - h.outboxBefore).toBe(1);
  });

  it("validates strictly: an unknown field, a non-UUID target, an empty text, an over-long text or a malformed key is INVALID_INPUT", async () => {
    const h = await setup();
    h.as("RESPONDER");
    for (const bad of [
      { ...input(), extra: "x" },
      { ...input(), targetInteractionId: "fb_c_010" },
      { ...input(), text: "" },
      { ...input(), text: "x".repeat(2201) },
      { ...input(), idempotencyKey: "short" },
      { ...input(), idempotencyKey: "has spaces in it" },
    ]) {
      expect(errorCode(await h.run(bad))).toBe("INVALID_INPUT");
    }
    expect(h.stores.intentRows.size).toBe(0);
  });

  it("is a workspace command: reply.public, Standard mode required", () => {
    expect(requestPublicReplyCommand).toMatchObject({ scope: "workspace", permission: "reply.public", requiresStandardMode: true, name: "mutations.reply_public.request" });
    expect(fixedClock().now()).toBeInstanceOf(Date);
  });
});
