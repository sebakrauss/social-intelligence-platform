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

const env = vi.hoisted((): { pipeline: unknown; auth: unknown; revalidated: string[]; failRevalidation: boolean } => ({ pipeline: undefined, auth: { id: "set-later" }, revalidated: [], failRevalidation: false }));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    if (env.failRevalidation) throw new Error("revalidation failed");
    env.revalidated.push(path);
  },
}));
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

  it("7B-14I2: an authorization identifier injected by the browser is ignored; the validation flag only asks the SERVER to resolve one (none here → refused, nothing written)", async () => {
    const h = await setup();
    h.as("OWNER");
    const injected = "c1c2c3c4-5f60-4a7b-8c9d-0e1f2a3b4c5d";
    // An injected identifier alone: ignored — the ordinary request runs (allowed in this in-memory world).
    expect((await publishReplyAction({ kind: "idle" }, form({ ...fields(h.workspaceId), validationAuthorizationId: injected }))).kind).toBe("requested");
    expect([...h.stores.intentRows.values()][0]?.validationAuthorizationId).toBeNull();
    // The flag (with or without an injected identifier): the server looks for the member's own live authorization —
    // none is readable here — and refuses with the one closed reason; nothing more is written.
    for (const extra of [{ validation: "1" }, { validation: "1", validationAuthorizationId: injected }]) {
      const result = await publishReplyAction({ kind: "idle" }, form({ ...fields(h.workspaceId, { idempotencyKey: `rk-14i2-${String(Object.keys(extra).length)}-form` }), ...extra }));
      expect(result).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
    }
    expect(h.stores.intentRows.size).toBe(1);
  });

  it("without a session the answer is signed_out and nothing runs", async () => {
    const h = await setup();
    env.auth = undefined;
    expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).toEqual({ kind: "signed_out" });
    expect(h.stores.intentRows.size).toBe(0);
  });
});

/**
 * Step 7B-15L (audit 7B-15K K22) — an UNKNOWN outcome keeps the composer's form key. The conversation page issues the
 * idempotency key; a revalidation re-renders the page and would hand the open composer a NEW key, so a retry of a
 * request that may already have been accepted would be admitted as a second, independent reply. On `unavailable` —
 * a pipeline error that is not a known block, or a failure thrown at any point, even after the commit — the action
 * revalidates nothing, and the same form submitted again is answered from the first intent.
 */
describe("7B-15L: an unknown outcome never revalidates the conversation (the form key stays with the submission)", () => {
  interface Pipeline {
    run(command: unknown, request: unknown): Promise<unknown>;
  }
  const real = (): Pipeline => env.pipeline as Pipeline;

  it.each(["PROVIDER_TRANSIENT", "OUTCOME_UNKNOWN", "CONFLICT", "STALE_STATE"])("a pipeline error that is not a known block (%s) answers `unavailable` and revalidates nothing", async (code) => {
    const h = await setup();
    h.as("RESPONDER");
    env.pipeline = { run: () => Promise.resolve({ status: "error", error: { code } }) };
    expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).toEqual({ kind: "unavailable" });
    expect(env.revalidated).toEqual([]);
  });

  it("a failure thrown BEFORE anything was written answers `unavailable`, writes nothing and revalidates nothing", async () => {
    const h = await setup();
    h.as("RESPONDER");
    env.pipeline = { run: () => Promise.reject(new Error("connection lost")) };
    expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).toEqual({ kind: "unavailable" });
    expect(env.revalidated).toEqual([]);
    expect(h.stores.intentRows.size).toBe(0);
  });

  it("a failure thrown AFTER the intent was committed: `unavailable`, no revalidation — and the SAME form key then finds that one intent (existing), a changed text is refused, never a second intent", async () => {
    const h = await setup();
    h.as("RESPONDER");
    const pipeline = real();
    // The request commits (the real pipeline ran), then the answer is lost on the way back.
    env.pipeline = {
      run: async (command: unknown, request: unknown) => {
        await pipeline.run(command, request);
        throw new Error("answer lost after the commit");
      },
    };
    expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).toEqual({ kind: "unavailable" });
    expect(h.stores.intentRows.size).toBe(1);
    const intentId = [...h.stores.intentRows.values()][0]?.id;
    // Nothing re-rendered the page: the open composer still holds the key it submitted with.
    expect(env.revalidated).toEqual([]);

    env.pipeline = pipeline;
    expect(await publishReplyAction({ kind: "unavailable" }, form(fields(h.workspaceId)))).toEqual({ kind: "existing", intentId });
    expect(await publishReplyAction({ kind: "unavailable" }, form(fields(h.workspaceId, { text: "Texto editado tras el resultado incierto" })))).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(h.stores.intentRows.size).toBe(1);
    expect(h.unitOfWork.state.outbox.filter((row) => row.topic === "mutations.execute_intent")).toHaveLength(1);
  });

  it("a failure thrown by the revalidation itself (after the commit) is still `unavailable`, and the same key still answers `existing`", async () => {
    const h = await setup();
    h.as("RESPONDER");
    env.failRevalidation = true;
    try {
      expect(await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).toEqual({ kind: "unavailable" });
    } finally {
      env.failRevalidation = false;
    }
    expect(h.stores.intentRows.size).toBe(1);
    expect((await publishReplyAction({ kind: "unavailable" }, form(fields(h.workspaceId)))).kind).toBe("existing");
    expect(h.stores.intentRows.size).toBe(1);
  });

  it("the known answers are unchanged: signed_out and blocked revalidate nothing; requested, existing and refused re-render the thread", async () => {
    const h = await setup();
    h.as("ANALYST_VIEWER");
    expect((await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).kind).toBe("blocked");
    env.auth = undefined;
    expect((await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).kind).toBe("signed_out");
    expect(env.revalidated).toEqual([]);
    h.as("RESPONDER");
    expect((await publishReplyAction({ kind: "idle" }, form(fields(h.workspaceId)))).kind).toBe("requested");
    expect(env.revalidated).toHaveLength(1);
  });
});
