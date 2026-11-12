/**
 * Step 7B-12A — the operational authorization in the mutation path (request → executor), over the in-memory stores and
 * the simulator: the executor re-checks `providerActionAllowed(platform, "public_reply")` in the transaction that would
 * commit EXECUTING, before any credential is opened; a revocation between request and execution blocks with zero
 * provider calls; and an "allowed" authorization never substitutes any other guard.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { executeIntent, type ExecutorDependencies } from "@/mutations/executor/execute";
import { requestPublicReply } from "@/mutations/request";
import type { CredentialUse, ExecutionGuards, ProviderActionDecision } from "@/mutations/ports";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";
import { CORRELATION, ORGANIZATION, OTHER_WORKSPACE, SIM_ASSET, TARGET, USER, WORKSPACE, fixedClock, guardState, memoryStores, replyTarget, type GuardState, type MemoryStores } from "./support";

const sim = createBaselineSimulator();
const context = { organizationId: ORGANIZATION, workspaceId: WORKSPACE, userId: USER, correlationId: CORRELATION };

function credentials(stores: MemoryStores, opened: string[]): CredentialUse {
  return {
    withAccess: (input, use) => {
      opened.push(input.connectedAccountId);
      stores.calls.push("credential:open");
      return use(sim.access("cred_meta_main", SIM_ASSET), { credentialId: "cred-1" });
    },
  };
}

function harness(state: Partial<GuardState> = {}, target = replyTarget()) {
  const stores = memoryStores(guardState(state), [target]);
  const clock = fixedClock();
  const opened: string[] = [];
  let providerCalls = 0;
  const port = { ...sim.mutation, replyPublicly: (...args: Parameters<typeof sim.mutation.replyPublicly>) => {
    providerCalls += 1;
    stores.calls.push("provider:replyPublicly");
    return sim.mutation.replyPublicly(...args);
  } };
  const deps: ExecutorDependencies = { inScope: (work) => work(stores), credentials: credentials(stores, opened), providers: { mutation: (provider) => (provider === "simulator" ? port : undefined) }, clock };
  const request = () => requestPublicReply(stores, clock, context, { targetInteractionId: TARGET, text: "Gracias por escribirnos.", idempotencyKey: "form-render-7b12a" });
  const execute = (intentId: string) => executeIntent(deps, { workspaceId: WORKSPACE, intentId, runReference: "run_7b12a" });
  return { stores, opened, request, execute, providerCalls: () => providerCalls };
}

beforeEach(() => {
  sim.world.reset();
});

describe("Step 7B-12A · the executor re-validates the authorization before any external operation", () => {
  it("allowed at request AND at execution: the guard is read for the exact pair BEFORE the credential opens and the ONE provider call", async () => {
    const h = harness();
    const created = await h.request();
    if (created.kind !== "created") throw new Error(`unexpected ${created.kind}`);
    const result = await h.execute(created.intent.id);
    expect(result.kind).toBe("confirmed");
    const switchAt = h.stores.calls.lastIndexOf("switch:facebook:public_reply");
    expect(switchAt).toBeGreaterThan(-1);
    expect(switchAt).toBeLessThan(h.stores.calls.indexOf("credential:open"));
    expect(h.stores.calls.indexOf("credential:open")).toBeLessThan(h.stores.calls.indexOf("provider:replyPublicly"));
    expect(h.providerCalls()).toBe(1);
  });

  it("revoked between the request and the execution → BLOCKED PROVIDER_ACTIONS_DISABLED, no credential opened, ZERO provider calls", async () => {
    const h = harness();
    const created = await h.request();
    if (created.kind !== "created") throw new Error(`unexpected ${created.kind}`);
    h.stores.guardState.switchEnabled = false; // e.g. the "*" emergency block was set, or the exact grant cleared
    expect(await h.execute(created.intent.id)).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
    expect(h.opened).toEqual([]);
    expect(h.providerCalls()).toBe(0);
  });

  it("not authorized at request time → refused before anything is written", async () => {
    const h = harness({ switchEnabled: false });
    expect(await h.request()).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
    expect(h.stores.intentRows.size).toBe(0);
  });

  it("a guard that cannot read the authorization (throws) never reaches the provider", async () => {
    const h = harness();
    const created = await h.request();
    if (created.kind !== "created") throw new Error(`unexpected ${created.kind}`);
    const guards = h.stores.guards as { providerActionAllowed: ExecutionGuards["providerActionAllowed"] };
    guards.providerActionAllowed = () => Promise.reject(new Error("switch store unreadable"));
    await expect(h.execute(created.intent.id)).rejects.toThrow("switch store unreadable");
    expect(h.opened).toEqual([]);
    expect(h.providerCalls()).toBe(0);
  });

  it.each<[ProviderActionDecision]>([["not_enabled"], ["paused"]])("any decision other than 'allowed' (%s) blocks", async (decision) => {
    const h = harness();
    const created = await h.request();
    if (created.kind !== "created") throw new Error(`unexpected ${created.kind}`);
    const guards = h.stores.guards as { providerActionAllowed: ExecutionGuards["providerActionAllowed"] };
    guards.providerActionAllowed = () => Promise.resolve(decision);
    expect(await h.execute(created.intent.id)).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
    expect(h.providerCalls()).toBe(0);
  });
});

describe("Step 7B-12A · an 'allowed' authorization never substitutes another guard (all with the switch allowed)", () => {
  async function executeWith(state: Partial<GuardState>, target = replyTarget()) {
    // The request runs with the default guards; the execution sees the changed state (or target).
    const h = harness({}, target);
    const created = await harness().request();
    if (created.kind !== "created") throw new Error(`unexpected ${created.kind}`);
    h.stores.intentRows.set(`${created.intent.workspaceId}:${created.intent.id}`, created.intent);
    h.stores.replyRows.set(`${WORKSPACE}:${created.intent.id}`, { ...created.reply });
    Object.assign(h.stores.guardState, state);
    const result = await h.execute(created.intent.id);
    return { result, providerCalls: h.providerCalls(), opened: h.opened };
  }

  it.each<[string, Partial<GuardState>, string]>([
    ["capability unavailable", { capability: "UNAVAILABLE" }, "CAPABILITY_UNAVAILABLE"],
    ["Monitor-only", { mode: "MONITOR_ONLY" }, "MODE_NOT_STANDARD"],
    ["a role without reply.public", { role: "ANALYST" }, "PERMISSION_DENIED"],
    ["the initiator left the workspace", { role: undefined }, "INITIATOR_NOT_MEMBER"],
  ])("%s → BLOCKED, zero provider calls", async (_label, state, code) => {
    const { result, providerCalls } = await executeWith({ switchEnabled: true, ...state });
    expect(result).toEqual({ kind: "blocked", code });
    expect(providerCalls).toBe(0);
  });

  it("a target owned by another account, or another workspace → BLOCKED TARGET_ACCOUNT_MISMATCH, zero provider calls", async () => {
    for (const target of [replyTarget({ connectedAccountId: "8b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" }), replyTarget({ workspaceId: OTHER_WORKSPACE })]) {
      const { result, providerCalls } = await executeWith({ switchEnabled: true }, target);
      expect(result).toEqual({ kind: "blocked", code: "TARGET_ACCOUNT_MISMATCH" });
      expect(providerCalls).toBe(0);
    }
  });
});
