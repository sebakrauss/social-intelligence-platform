/**
 * Step 7B-3 — the publish Server Action through the REAL action pipeline over the in-memory unit of work (the request
 * sources injected): the five fields it reads, the closed states it answers (requested, existing on the same form,
 * refused with the request's reason, blocked by role or Monitor-only, NOT_FOUND for a foreign workspace), that a
 * second submit of the same form never creates a second intent, that the browser cannot choose the account, and that
 * nothing is published from the web (the only write is the PENDING intent and its outbox row).
 */
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/domain/access";
import { createHarness } from "../../support/harness";
import { userId } from "../../support/in-memory";
import { TARGET, guardState, memoryStores, replyTarget } from "../mutations/support";

const env = vi.hoisted((): { pipeline: unknown; auth: unknown; revalidated: string[] } => ({ pipeline: undefined, auth: { id: "set-later" }, revalidated: [] }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => void env.revalidated.push(path) }));
vi.mock("@/server/auth/request-auth", () => ({ requestAuth: () => Promise.resolve(env.auth) }));
vi.mock("@/server/inbox/runtime", () => ({ inboxPipeline: () => env.pipeline }));

const { publishReplyAction } = await import("@/server/inbox/actions");

const OWNER = userId(1);
const CONVERSATION = "11111111-1111-4111-8111-111111111111";

async function setup(mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD", stores = memoryStores()) {
  const h = createHarness();
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId, mode);
  const members: Partial<Record<WorkspaceRole, ReturnType<typeof userId>>> = { OWNER };
  let n = 2;
  for (const role of ["RESPONDER", "ANALYST_VIEWER"] as const) {
    const member = userId(n++);
    await h.addMember(OWNER, workspaceId, member, role);
    members[role] = member;
  }
  stores.targetRows.set(TARGET, replyTarget({ workspaceId }));
  h.unitOfWork.mutations = stores;
  env.pipeline = h.pipeline;
  env.revalidated.length = 0;
  const as = (role: WorkspaceRole): void => {
    const member = members[role];
    if (member === undefined) throw new Error(role);
    env.auth = { id: member, verifiedEmail: undefined };
    h.as(member);
  };
  return { ...h, workspaceId, stores, as, members };
}

const form = (entries: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};
const fields = (workspaceId: string, over: Record<string, string> = {}) => ({ workspaceId, conversationId: CONVERSATION, targetInteractionId: TARGET, idempotencyKey: "rk-0000-0001-form", text: "Gracias por escribirnos.", ...over });

describe("7B-3: the publish action", () => {
  it("a Responder's confirmed review creates ONE PENDING intent; the same form submitted again answers `existing` and writes nothing more", async () => {
    const h = await setup();
    h.as("RESPONDER");
    const first = await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)));
    expect(first.kind).toBe("requested");
    const second = await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)));
    expect(second).toEqual({ kind: "existing", intentId: first.kind === "requested" ? first.intentId : "" });
    expect(h.stores.intentRows.size).toBe(1);
    expect([...h.stores.intentRows.values()][0]).toMatchObject({ status: "PENDING", initiatorUserId: h.members.RESPONDER, connectedAccountId: replyTarget().connectedAccountId });
    expect(h.unitOfWork.state.outbox.filter((row) => row.topic === "mutations.execute_intent")).toHaveLength(1);
    expect(h.unitOfWork.state.audit.filter((row) => row.action === "mutation_intent.created")).toHaveLength(1);
    // The thread is re-rendered from the database: the conversation path was revalidated (without query or fragment).
    expect(env.revalidated).toEqual([`/workspaces/${h.workspaceId}/inbox/${CONVERSATION}`, `/workspaces/${h.workspaceId}/inbox/${CONVERSATION}`]);
  });

  it("the same form with another text is refused as a key reuse; the request-time refusals come back as closed reasons", async () => {
    const h = await setup();
    h.as("RESPONDER");
    expect((await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).kind).toBe("requested");
    expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId, { text: "Otro texto" })))).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    const unavailable = await setup("STANDARD", memoryStores(guardState({ capability: "UNAVAILABLE" })));
    unavailable.as("OWNER");
    expect(await publishReplyAction({ kind: "idle" }, form(fields(unavailable.workspaceId)))).toEqual({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
    expect(unavailable.stores.intentRows.size).toBe(0);
  });

  it("an Analyst is blocked by role, a Monitor-only workspace by mode, a foreign workspace is NOT_FOUND, and a malformed form is INVALID_INPUT — nothing written", async () => {
    const h = await setup();
    h.as("ANALYST_VIEWER");
    expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).toEqual({ kind: "blocked", code: "PERMISSION_DENIED" });
    const monitor = await setup("MONITOR_ONLY");
    monitor.as("OWNER");
    expect(await publishReplyAction({ kind: "idle" }, form(fields(monitor.workspaceId)))).toEqual({ kind: "blocked", code: "MODE_BLOCKED" });
    const other = await setup();
    other.as("OWNER");
    // A workspace this member is not part of: NOT_FOUND, never "forbidden" (no existence oracle).
    expect(await publishReplyAction({ kind: "idle" }, form(fields("0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f")))).toEqual({ kind: "blocked", code: "NOT_FOUND" });
    expect(await publishReplyAction({ kind: "idle" }, form(fields(other.workspaceId, { idempotencyKey: "short" })))).toEqual({ kind: "blocked", code: "INVALID_INPUT" });
    expect(await publishReplyAction({ kind: "idle" }, form(fields("not-a-workspace")))).toEqual({ kind: "blocked", code: "NOT_FOUND" });
    expect(h.stores.intentRows.size + monitor.stores.intentRows.size + other.stores.intentRows.size).toBe(0);
  });

  it("the browser never chooses the account or the destination: extra fields are ignored and the intent binds the target's own account", async () => {
    const h = await setup();
    h.as("OWNER");
    const result = await publishReplyAction({ kind: "idle" }, form({ ...fields(h.workspaceId), connectedAccountId: "0c2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", platform: "facebook", provider: "meta" }));
    expect(result.kind).toBe("requested");
    const intent = [...h.stores.intentRows.values()][0];
    expect(intent?.connectedAccountId).toBe(replyTarget().connectedAccountId);
    expect(intent?.targetInteractionId).toBe(TARGET);
  });

  it("without a session the answer is signed_out and nothing runs", async () => {
    const h = await setup();
    env.auth = undefined;
    expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).toEqual({ kind: "signed_out" });
    expect(h.stores.intentRows.size).toBe(0);
  });
});
