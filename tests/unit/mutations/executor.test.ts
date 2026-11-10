/**
 * Step 7B-1 — the Platform Mutation Executor offline (mutations/executor), against the simulator's REAL mutation port:
 *
 *   R6     EXECUTING is recorded BEFORE the provider is called (asserted from inside the port); one call per intent;
 *          an intent found EXECUTING (crashed, lost or redelivered run) becomes OUTCOME_UNKNOWN without a second call;
 *   guards every re-check refuses with its code, records BLOCKED, and never reaches the provider or the credential;
 *   outcomes CONFIRMED carries the created reply's provider id; a definite provider refusal is FAILED; a request that
 *          never left is FAILED (PROVIDER_UNAVAILABLE), never retried; a lost response is OUTCOME_UNKNOWN;
 *   reconciliation LOOKS through the read port: exactly one unambiguous reply of ours, linked to no other intent →
 *          CONFIRMED (actor reconciliation); nothing found, several candidates, an identity linked elsewhere, an older
 *          identical reply only, or an unreadable listing → the intent STAYS OUTCOME_UNKNOWN (no transition, no FAILED,
 *          no resend); a late receipt after another run recorded OUTCOME_UNKNOWN still confirms, without a second call.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderAccess } from "@/integrations/providers/contract";
import { CredentialUnreadable, executeIntent, type ExecutorDependencies } from "@/mutations/executor/execute";
import { reconcileIntent } from "@/mutations/executor/reconcile";
import { createReadPortReplyLookup } from "@/mutations/executor/reply-lookup";
import type { CredentialUse, OutboundReply, ReplyLookup } from "@/mutations/ports";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";
import { ACCOUNT, ORGANIZATION, SIM_ASSET, TARGET, USER, WORKSPACE, codesOf, fixedClock, guardState, memoryStores, pendingIntent, replyTarget, statusesOf, type MemoryStores } from "./support";

const sim = createBaselineSimulator();
const RUN = "run_7b1_0001";
const TEXT = "Gracias por escribirnos (7B-1).";

function credentials(stores: MemoryStores, opened: string[] = []): CredentialUse {
  return {
    withAccess: (input, use) => {
      opened.push(input.connectedAccountId);
      stores.calls.push("credential:open");
      return use(sim.access("cred_meta_main", SIM_ASSET));
    },
  };
}

function seeded(stores: MemoryStores, clock = fixedClock(), overrides: Parameters<typeof pendingIntent>[1] = {}) {
  const intent = pendingIntent(clock, overrides);
  stores.intentRows.set(`${intent.workspaceId}:${intent.id}`, intent);
  const reply: OutboundReply = { id: clock.newId(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, intentId: intent.id, parentInteractionId: TARGET, connectedAccountId: ACCOUNT, platform: "facebook", text: TEXT, providerReplyId: null, confirmedAt: null, createdAt: clock.now() };
  stores.replyRows.set(`${WORKSPACE}:${intent.id}`, reply);
  stores.history.push({ intentId: intent.id, from: null, to: "PENDING", attempt: 0, actor: "web", code: null, runReference: null });
  return { intent, reply, clock };
}

function deps(stores: MemoryStores, clock: ReturnType<typeof fixedClock>, opened: string[] = [], port = sim.mutation): ExecutorDependencies {
  return {
    inScope: (work) => work(stores),
    credentials: credentials(stores, opened),
    providers: { mutation: (provider) => (provider === "simulator" ? port : undefined) },
    clock,
  };
}

beforeEach(() => {
  sim.world.reset();
});

describe("7B-1 executor: the confirmed path", () => {
  it("records EXECUTING before the call, calls the simulator once, confirms with the created reply's id, and audits both transitions", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores);
    const seenAtCall: string[] = [];
    const port = {
      ...sim.mutation,
      replyPublicly: (access: ProviderAccess, target: Parameters<typeof sim.mutation.replyPublicly>[1], text: string, hint: Parameters<typeof sim.mutation.replyPublicly>[3]) => {
        seenAtCall.push(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)?.status ?? "missing");
        stores.calls.push("provider:replyPublicly");
        return sim.mutation.replyPublicly(access, target, text, hint);
      },
    };
    const opened: string[] = [];
    const result = await executeIntent(deps(stores, clock, opened, port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.providerReplyId).not.toBeNull();
    // The platform shows the brand's reply under the target.
    const created = sim.world.interaction(result.providerReplyId ?? "");
    expect(created?.parent).toBe("fb_c_010");
    // R6: EXECUTING was committed before the provider saw the request; exactly one call; the credential opened once.
    expect(seenAtCall).toEqual(["EXECUTING"]);
    expect(stores.calls.filter((call) => call === "provider:replyPublicly")).toHaveLength(1);
    expect(opened).toEqual([ACCOUNT]);
    expect(stores.calls.indexOf("transition:EXECUTING")).toBeLessThan(stores.calls.indexOf("credential:open"));
    // The intent, its reply, its history and its audit events.
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "CONFIRMED", attempt: 1, runReference: RUN, outcomeCode: null });
    expect(stores.replyRows.get(`${WORKSPACE}:${intent.id}`)?.providerReplyId).toBe(result.providerReplyId);
    expect(stores.replyRows.get(`${WORKSPACE}:${intent.id}`)?.confirmedAt).toBeInstanceOf(Date);
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
    expect(stores.history.slice(1).map((row) => [row.actor, row.attempt, row.runReference])).toEqual([["executor", 1, RUN], ["executor", 1, RUN]]);
    expect(stores.events.map((event) => [event.status, event.actor, event.code])).toEqual([["EXECUTING", "executor", null], ["CONFIRMED", "executor", null]]);
    expect(stores.events.every((event) => event.intent.organizationId === ORGANIZATION && event.intent.initiatorUserId === USER)).toBe(true);
  });

  it("Step 7B-13C (F1): a Facebook reply to a reply (simulator) keeps executing — the top-level rule is Instagram's only", async () => {
    const stores = memoryStores(guardState(), [replyTarget({ kind: "reply", parentProviderInteractionId: "fb_c_009" })]);
    const { intent, clock } = seeded(stores);
    expect((await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).kind).toBe("confirmed");
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
  });

  it("a CONFIRMED, FAILED or BLOCKED intent is a noop: no transition, no call", async () => {
    for (const status of ["CONFIRMED", "FAILED", "BLOCKED"] as const) {
      const stores = memoryStores();
      const { intent, clock } = seeded(stores, fixedClock(), { status, attempt: 1, runReference: "run_old", outcomeCode: status === "CONFIRMED" ? null : "PROVIDER_REJECTED" });
      const result = await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
      expect(result).toEqual({ kind: "noop", status });
      expect(stores.history).toHaveLength(1);
      expect(stores.calls.filter((call) => call.startsWith("transition") || call.startsWith("credential"))).toEqual([]);
    }
    const stores = memoryStores();
    expect(await executeIntent(deps(stores, fixedClock()), { workspaceId: WORKSPACE, intentId: "00000000-0000-4000-8000-000000000000", runReference: RUN })).toEqual({ kind: "noop", status: "missing" });
  });
});

describe("7B-1 executor: R6 — never a second send", () => {
  it("an intent found EXECUTING (crashed, lost or redelivered run) becomes OUTCOME_UNKNOWN (RUN_INTERRUPTED) without touching the provider", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(), { status: "EXECUTING", attempt: 1, runReference: "run_lost" });
    const opened: string[] = [];
    const before = sim.world.interactions().length;
    const result = await executeIntent(deps(stores, clock, opened), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(result).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
    expect(opened).toEqual([]);
    expect(sim.world.interactions()).toHaveLength(before);
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "OUTCOME_UNKNOWN", attempt: 1, runReference: RUN, outcomeCode: "RUN_INTERRUPTED" });
    expect(stores.events.map((event) => [event.status, event.code])).toEqual([["OUTCOME_UNKNOWN", "RUN_INTERRUPTED"]]);
  });

  it("a lost response (the platform applied the reply, the answer never arrived) is OUTCOME_UNKNOWN (RESPONSE_LOST), not a failure and not a retry", async () => {
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
    const stores = memoryStores();
    const { intent, clock } = seeded(stores);
    const result = await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(result).toEqual({ kind: "outcome_unknown", code: "RESPONSE_LOST" });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)?.status).toBe("OUTCOME_UNKNOWN");
    expect(statusesOf(stores)).toEqual(["PENDING", "EXECUTING", "OUTCOME_UNKNOWN"]);
    // The simulator DID create the reply: exactly what reconciliation must find.
    expect(sim.world.interactions().some((state) => state.parent === "fb_c_010" && state.text === TEXT)).toBe(true);
    expect(stores.calls.filter((call) => call === "credential:open")).toHaveLength(1);
  });

  it("a request that never left (timeout before send) is FAILED (PROVIDER_UNAVAILABLE): recorded, never rethrown, never re-sent", async () => {
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "timeout_before_send" } }]);
    const stores = memoryStores();
    const { intent, clock } = seeded(stores);
    const result = await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(result).toEqual({ kind: "failed", code: "PROVIDER_UNAVAILABLE" });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "FAILED", outcomeCode: "PROVIDER_UNAVAILABLE" });
    expect(sim.world.interactions().some((state) => state.text === TEXT)).toBe(false);
    // A second delivery of the same intent does nothing.
    expect(await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: "run_again" })).toEqual({ kind: "noop", status: "FAILED" });
  });

  it("an error the contract does not classify is OUTCOME_UNKNOWN (PROVIDER_ERROR_UNCLASSIFIED), never FAILED: the request may have been sent", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores);
    const port = { ...sim.mutation, replyPublicly: () => Promise.reject(new Error("socket hang up")) };
    expect(await executeIntent(deps(stores, clock, [], port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "outcome_unknown", code: "PROVIDER_ERROR_UNCLASSIFIED" });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "OUTCOME_UNKNOWN", outcomeCode: "PROVIDER_ERROR_UNCLASSIFIED" });
  });

  it("a receipt that arrives after another run recorded OUTCOME_UNKNOWN still confirms (OUTCOME_UNKNOWN → CONFIRMED), with no second call", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores);
    let calls = 0;
    const port = {
      ...sim.mutation,
      replyPublicly: async (access: ProviderAccess, target: Parameters<typeof sim.mutation.replyPublicly>[1], text: string, hint: Parameters<typeof sim.mutation.replyPublicly>[3]) => {
        calls += 1;
        const receipt = await sim.mutation.replyPublicly(access, target, text, hint);
        // Meanwhile a redelivered run found the intent EXECUTING and recorded OUTCOME_UNKNOWN (RUN_INTERRUPTED).
        const row = stores.intentRows.get(`${WORKSPACE}:${intent.id}`);
        if (row !== undefined) stores.intentRows.set(`${WORKSPACE}:${intent.id}`, { ...row, status: "OUTCOME_UNKNOWN", outcomeCode: "RUN_INTERRUPTED" });
        return receipt;
      },
    };
    const result = await executeIntent(deps(stores, clock, [], port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(result.kind).toBe("confirmed");
    expect(calls).toBe(1);
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "CONFIRMED", outcomeCode: null });
    expect(stores.history.at(-1)).toMatchObject({ from: "OUTCOME_UNKNOWN", to: "CONFIRMED", actor: "executor" });
    expect(sim.world.interactions().filter((state) => state.text === TEXT)).toHaveLength(1);
  });

  it("a receipt whose reply identity is already linked to another intent is OUTCOME_UNKNOWN (REPLY_IDENTITY_CONFLICT): the wrong row is never confirmed", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores);
    const other = seeded(stores, fixedClock("2026-11-09T09:00:00.000Z"), { id: "0e2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", idempotencyKey: "form-render-0002", status: "CONFIRMED", attempt: 1, runReference: "run_prior" });
    const port = {
      ...sim.mutation,
      replyPublicly: async (access: ProviderAccess, target: Parameters<typeof sim.mutation.replyPublicly>[1], text: string, hint: Parameters<typeof sim.mutation.replyPublicly>[3]) => {
        const receipt = await sim.mutation.replyPublicly(access, target, text, hint);
        // The other intent already owns this provider identity (the executor can't tell which row the platform meant).
        await stores.replies.confirm(WORKSPACE, other.intent.id, receipt.data.createdInteraction?.id ?? null, clock.now());
        return receipt;
      },
    };
    expect(await executeIntent(deps(stores, clock, [], port), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "outcome_unknown", code: "REPLY_IDENTITY_CONFLICT" });
    expect(stores.replyRows.get(`${WORKSPACE}:${intent.id}`)?.providerReplyId).toBeNull();
  });

  it("a definite provider refusal is FAILED with its code (unknown target → TARGET_NOT_FOUND; a not-eligible target → TARGET_NOT_ELIGIBLE)", async () => {
    const stores = memoryStores(guardState(), [replyTarget({ providerInteractionId: "fb_c_does_not_exist" })]);
    const { intent, clock } = seeded(stores);
    expect(await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "failed", code: "TARGET_NOT_FOUND" });
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "target_not_eligible", reason: "target_state" } }]);
    const stores2 = memoryStores();
    const second = seeded(stores2);
    expect(await executeIntent(deps(stores2, second.clock), { workspaceId: WORKSPACE, intentId: second.intent.id, runReference: RUN })).toEqual({ kind: "failed", code: "TARGET_NOT_ELIGIBLE" });
  });
});

describe("7B-1 executor: every guard is re-checked live and recorded as BLOCKED, before the credential and the provider", () => {
  const cases: readonly [string, Parameters<typeof memoryStores>, string][] = [
    ["the initiator is no longer a member", [guardState({ role: undefined }), [replyTarget()]], "INITIATOR_NOT_MEMBER"],
    ["the initiator's current role cannot reply", [guardState({ role: "ANALYST_VIEWER" }), [replyTarget()]], "PERMISSION_DENIED"],
    ["a guest", [guardState({ role: "CLIENT_GUEST" }), [replyTarget()]], "PERMISSION_DENIED"],
    ["the workspace is Monitor-only NOW (consistent read)", [guardState({ mode: "MONITOR_ONLY" }), [replyTarget()]], "MODE_NOT_STANDARD"],
    ["the workspace is unknown", [guardState({ mode: undefined }), [replyTarget()]], "MODE_NOT_STANDARD"],
    ["the provider-action switch is off (fail-safe)", [guardState({ switchEnabled: false }), [replyTarget()]], "PROVIDER_ACTIONS_DISABLED"],
    ["the account is inactive", [guardState({ account: { status: "INACTIVE", platform: "facebook", provider: "simulator", providerAssetId: SIM_ASSET, connectionStatus: "ACTIVE", credentialId: "c" } }), [replyTarget()]], "ACCOUNT_INACTIVE"],
    ["the connection is not active", [guardState({ account: { status: "ACTIVE", platform: "facebook", provider: "simulator", providerAssetId: SIM_ASSET, connectionStatus: "FAILED", credentialId: "c" } }), [replyTarget()]], "CONNECTION_UNAVAILABLE"],
    ["the connection has no active credential", [guardState({ account: { status: "ACTIVE", platform: "facebook", provider: "simulator", providerAssetId: SIM_ASSET, connectionStatus: "ACTIVE", credentialId: null } }), [replyTarget()]], "CONNECTION_UNAVAILABLE"],
    ["the capability is unavailable now", [guardState({ capability: "UNAVAILABLE" }), [replyTarget()]], "CAPABILITY_UNAVAILABLE"],
    ["the target was hidden since the request", [guardState(), [replyTarget({ presence: "hidden" })]], "TARGET_NOT_PRESENT"],
    ["the target was removed since the request", [guardState(), [replyTarget({ presence: "removed_at_source" })]], "TARGET_NOT_PRESENT"],
    ["the target is gone", [guardState(), []], "TARGET_NOT_PRESENT"],
    ["the target belongs to ANOTHER account of the workspace", [guardState(), [replyTarget({ connectedAccountId: "0c2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" })]], "TARGET_ACCOUNT_MISMATCH"],
    ["no mutation port exists for the provider (Meta today)", [guardState({ account: { status: "ACTIVE", platform: "facebook", provider: "meta", providerAssetId: SIM_ASSET, connectionStatus: "ACTIVE", credentialId: "c" } }), [replyTarget()]], "PROVIDER_MUTATION_UNSUPPORTED"],
  ];
  for (const [name, storeArgs, code] of cases) {
    it(`${name} → BLOCKED ${code}`, async () => {
      const stores = memoryStores(...storeArgs);
      const { intent, clock } = seeded(stores);
      const opened: string[] = [];
      const before = sim.world.interactions().length;
      const result = await executeIntent(deps(stores, clock, opened), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
      expect(result).toEqual({ kind: "blocked", code });
      expect(opened).toEqual([]);
      expect(sim.world.interactions()).toHaveLength(before);
      expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "BLOCKED", attempt: 1, runReference: RUN, outcomeCode: code });
      expect(stores.events.at(-1)).toMatchObject({ status: "BLOCKED", code });
      // The unsupported provider is the one case recorded AFTER the EXECUTING commit (the port is resolved then).
      expect(statusesOf(stores)).toEqual(code === "PROVIDER_MUTATION_UNSUPPORTED" ? ["PENDING", "EXECUTING", "BLOCKED"] : ["PENDING", "BLOCKED"]);
    });
  }

  it("an outbound reply naming another parent or account than its intent is BLOCKED (TARGET_ACCOUNT_MISMATCH)", async () => {
    for (const patch of [{ parentInteractionId: "0d2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" }, { connectedAccountId: "0c2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" }]) {
      const stores = memoryStores();
      const { intent, clock, reply } = seeded(stores);
      stores.replyRows.set(`${WORKSPACE}:${intent.id}`, { ...reply, ...patch });
      const opened: string[] = [];
      expect(await executeIntent(deps(stores, clock, opened), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "TARGET_ACCOUNT_MISMATCH" });
      expect(opened).toEqual([]);
    }
  });

  it("the capability is asked for the target's own content kind and source, after the target is known", async () => {
    const stores = memoryStores(guardState(), [replyTarget({ contentKind: "story", reportedSource: "organic" })]);
    const { intent, clock } = seeded(stores);
    await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(stores.calls).toContain("capability:story/organic");
  });

  it("an unreadable credential is BLOCKED (CREDENTIAL_UNREADABLE) after EXECUTING, with no provider call", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores);
    const failing: ExecutorDependencies = { ...deps(stores, clock), credentials: { withAccess: () => Promise.reject(new CredentialUnreadable()) } };
    const before = sim.world.interactions().length;
    expect(await executeIntent(failing, { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN })).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
    expect(sim.world.interactions()).toHaveLength(before);
    expect(codesOf(stores)).toEqual([null, null, "CREDENTIAL_UNREADABLE"]);
  });
});

describe("7B-1 reconciliation: look, never resend, never fail on absence", () => {
  const lookup = (clock: ReturnType<typeof fixedClock>) => createReadPortReplyLookup({ read: (provider) => (provider === "simulator" ? sim.read : undefined) }, "simulator", () => new Date(clock.now().getTime() + 60 * 60_000));
  const reconcile = (stores: MemoryStores, clock: ReturnType<typeof fixedClock>, intentId: string, look = lookup(clock)) =>
    reconcileIntent({ inScope: (work) => work(stores), credentials: credentials(stores), lookup: look, clock }, { workspaceId: WORKSPACE, intentId, runReference: "run_reconcile" });

  it("after a lost response, the ONE reply the platform applied is found → CONFIRMED by reconciliation, with the provider id; the mutation port is never touched", async () => {
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(new Date(sim.world.nowMs() - 60_000).toISOString()));
    await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)?.status).toBe("OUTCOME_UNKNOWN");
    const opened = stores.calls.filter((call) => call === "credential:open").length;
    const result = await reconcile(stores, clock, intent.id);
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(sim.world.interaction(result.providerReplyId)?.text).toBe(TEXT);
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "CONFIRMED", runReference: "run_reconcile", outcomeCode: null });
    expect(stores.replyRows.get(`${WORKSPACE}:${intent.id}`)?.providerReplyId).toBe(result.providerReplyId);
    expect(stores.history.at(-1)).toMatchObject({ from: "OUTCOME_UNKNOWN", to: "CONFIRMED", actor: "reconciliation" });
    expect(stores.events.at(-1)).toMatchObject({ status: "CONFIRMED", actor: "reconciliation" });
    expect(stores.calls.filter((call) => call === "credential:open")).toHaveLength(opened + 1);
    expect(sim.world.interactions().filter((state) => state.text === TEXT)).toHaveLength(1);
  });

  it("nothing of ours under the parent → the intent STAYS OUTCOME_UNKNOWN: no transition, no history row, no FAILED", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(new Date(sim.world.nowMs() - 60_000).toISOString()), { status: "OUTCOME_UNKNOWN", attempt: 1, runReference: "run_lost", outcomeCode: "RESPONSE_LOST" });
    const historyBefore = stores.history.length;
    expect(await reconcile(stores, clock, intent.id)).toEqual({ kind: "still_unknown", reason: "not_found" });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)).toMatchObject({ status: "OUTCOME_UNKNOWN", outcomeCode: "RESPONSE_LOST", runReference: "run_lost" });
    expect(stores.history).toHaveLength(historyBefore);
    expect(stores.events).toEqual([]);
    expect(sim.world.interactions().some((state) => state.text === TEXT)).toBe(false);
  });

  it("two identical candidates under the parent → ambiguous → STAYS OUTCOME_UNKNOWN (no identity is assigned)", async () => {
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(new Date(sim.world.nowMs() - 60_000).toISOString()));
    // A brand reply with the same text, native or from another path, already sits under the parent.
    sim.world.createBrandReply("fb_c_010", TEXT);
    await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    expect(await reconcile(stores, clock, intent.id)).toEqual({ kind: "still_unknown", reason: "ambiguous" });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)?.status).toBe("OUTCOME_UNKNOWN");
    expect(stores.replyRows.get(`${WORKSPACE}:${intent.id}`)?.providerReplyId).toBeNull();
  });

  it("an identical reply OLDER than the attempt is not ours: ignored, so the newer one confirms alone", async () => {
    sim.world.createBrandReply("fb_c_010", TEXT);
    sim.world.advanceClock(600);
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(new Date(sim.world.nowMs() - 1_000).toISOString()));
    await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    const result = await reconcile(stores, clock, intent.id);
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(Date.parse(sim.world.interaction(result.providerReplyId)?.createdAt ?? "")).toBeGreaterThanOrEqual(intent.createdAt.getTime() - 60_000);
  });

  it("a reply identity already linked to another intent → STAYS OUTCOME_UNKNOWN (identity_linked_elsewhere)", async () => {
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(new Date(sim.world.nowMs() - 60_000).toISOString()));
    await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: intent.id, runReference: RUN });
    const created = sim.world.interactions().find((state) => state.text === TEXT)?.id ?? "";
    const other = seeded(stores, fixedClock("2026-11-09T09:00:00.000Z"), { id: "0e2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", idempotencyKey: "form-render-0002", status: "CONFIRMED", attempt: 1, runReference: "run_prior" });
    await stores.replies.confirm(WORKSPACE, other.intent.id, created, clock.now());
    expect(await reconcile(stores, clock, intent.id)).toEqual({ kind: "still_unknown", reason: "identity_linked_elsewhere" });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)?.status).toBe("OUTCOME_UNKNOWN");
  });

  it("an intent left EXECUTING without an outcome is first recorded OUTCOME_UNKNOWN (RUN_INTERRUPTED), then examined — and stays unknown when nothing is found", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(new Date(sim.world.nowMs() - 60_000).toISOString()), { status: "EXECUTING", attempt: 1, runReference: "run_lost" });
    expect(await reconcile(stores, clock, intent.id)).toEqual({ kind: "still_unknown", reason: "not_found" });
    expect(statusesOf(stores)).toEqual(["PENDING", "OUTCOME_UNKNOWN"]);
    expect(codesOf(stores)).toEqual([null, "RUN_INTERRUPTED"]);
    expect(stores.history.at(-1)?.actor).toBe("reconciliation");
  });

  it("an unreadable or incomplete listing leaves the intent OUTCOME_UNKNOWN; a terminal intent is a noop", async () => {
    const stores = memoryStores();
    const { intent, clock } = seeded(stores, fixedClock(), { status: "OUTCOME_UNKNOWN", attempt: 1, runReference: "run_lost", outcomeCode: "RESPONSE_LOST" });
    const unreadable = createReadPortReplyLookup({ read: () => undefined }, "simulator", () => clock.now());
    expect(await reconcile(stores, clock, intent.id, unreadable)).toEqual({ kind: "still_unknown", reason: "unreadable" });
    const incomplete: ReplyLookup = { findOwnReply: () => Promise.reject(new Error("listing bound exceeded")) };
    expect(await reconcile(stores, clock, intent.id, incomplete)).toEqual({ kind: "still_unknown", reason: "unreadable" });
    expect(stores.intentRows.get(`${WORKSPACE}:${intent.id}`)?.status).toBe("OUTCOME_UNKNOWN");
    const done = memoryStores();
    const terminal = seeded(done, fixedClock(), { status: "CONFIRMED", attempt: 1, runReference: "run_ok" });
    expect(await reconcile(done, terminal.clock, terminal.intent.id)).toEqual({ kind: "noop", status: "CONFIRMED" });
  });
});
