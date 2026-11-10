/**
 * Step 7B-5 — cross-intent reconciliation safety, offline. The pure producer rule, then reconciliation over in-memory
 * stores and the simulator's REAL ports: a reply found on the platform is attributed to an intent only when no other
 * intent of the same workspace, account, target and text could have produced it. Everything else keeps
 * OUTCOME_UNKNOWN, assigns no identity, and sends nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isPlausibleProducer, type CompetingIntent } from "@/mutations/domain/intent";
import { executeIntent, type ExecutorDependencies } from "@/mutations/executor/execute";
import { reconcileIntent } from "@/mutations/executor/reconcile";
import { createReadPortReplyLookup } from "@/mutations/executor/reply-lookup";
import type { CredentialUse, OutboundReply } from "@/mutations/ports";
import type { MutationIntent } from "@/mutations/domain/intent";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";
import { ORGANIZATION, SIM_ASSET, WORKSPACE, fixedClock, memoryStores, pendingIntent, type MemoryStores } from "./support";

const sim = createBaselineSimulator();
const TEXT = "Gracias por escribirnos (7B-5).";
const competitor = (over: Partial<CompetingIntent>): CompetingIntent => ({ id: "c1", status: "OUTCOME_UNKNOWN", hasProviderIdentity: false, ...over });

describe("7B-5: the producer rule (state and identity only)", () => {
  it("EXECUTING, OUTCOME_UNKNOWN and CONFIRMED-without-identity could have produced the reply; PENDING, BLOCKED, FAILED and CONFIRMED-with-identity could not", () => {
    expect(isPlausibleProducer(competitor({ status: "EXECUTING" }))).toBe(true);
    expect(isPlausibleProducer(competitor({ status: "OUTCOME_UNKNOWN" }))).toBe(true);
    expect(isPlausibleProducer(competitor({ status: "CONFIRMED", hasProviderIdentity: false }))).toBe(true);
    expect(isPlausibleProducer(competitor({ status: "CONFIRMED", hasProviderIdentity: true }))).toBe(false);
    expect(isPlausibleProducer(competitor({ status: "PENDING" }))).toBe(false);
    expect(isPlausibleProducer(competitor({ status: "BLOCKED" }))).toBe(false);
    expect(isPlausibleProducer(competitor({ status: "FAILED" }))).toBe(false);
  });

  it("no time is compared: a competitor is plausible whatever its request time or the provider's reply time (independent clocks)", () => {
    expect(Object.keys(competitor({}))).toEqual(["id", "status", "hasProviderIdentity"]);
    expect(isPlausibleProducer.length).toBe(1);
  });
});

// ── Reconciliation scenarios over the simulator ──────────────────────────────────────────────────────────────────────
const RUN = "run_7b5";
function credentials(stores: MemoryStores): CredentialUse {
  return {
    withAccess: (_input, use) => {
      stores.calls.push("credential:open");
      return use(sim.access("cred_meta_main", SIM_ASSET));
    },
  };
}
function seeded(stores: MemoryStores, clock: ReturnType<typeof fixedClock>, over: Partial<MutationIntent>, text = TEXT) {
  const intent = pendingIntent(clock, over);
  stores.intentRows.set(`${intent.workspaceId}:${intent.id}`, intent);
  const reply: OutboundReply = { id: clock.newId(), organizationId: ORGANIZATION, workspaceId: intent.workspaceId, intentId: intent.id, parentInteractionId: intent.targetInteractionId, connectedAccountId: intent.connectedAccountId, platform: "facebook", text, providerReplyId: null, confirmedAt: null, createdAt: intent.createdAt };
  stores.replyRows.set(`${intent.workspaceId}:${intent.id}`, reply);
  stores.history.push({ intentId: intent.id, from: null, to: "PENDING", attempt: 0, actor: "web", code: null, runReference: null });
  return intent;
}
const deps = (stores: MemoryStores, clock: ReturnType<typeof fixedClock>): ExecutorDependencies => ({ inScope: (work) => work(stores), credentials: credentials(stores), providers: { mutation: (provider) => (provider === "simulator" ? sim.mutation : undefined) }, clock });
const lookup = (clock: ReturnType<typeof fixedClock>) => createReadPortReplyLookup({ read: (provider) => (provider === "simulator" ? sim.read : undefined) }, "simulator", () => new Date(clock.now().getTime() + 3_600_000));
const reconcile = (stores: MemoryStores, clock: ReturnType<typeof fixedClock>, intentId: string) =>
  reconcileIntent({ inScope: (work) => work(stores), credentials: credentials(stores), lookup: lookup(clock), clock }, { workspaceId: WORKSPACE, intentId, runReference: "run_reconcile" });
const ID_A = "0a000000-0000-4000-8000-00000000000a";
const ID_B = "0b000000-0000-4000-8000-00000000000b";
const unknown = (id: string, key: string): Partial<MutationIntent> => ({ id, idempotencyKey: key, status: "OUTCOME_UNKNOWN", attempt: 1, runReference: "run_lost", outcomeCode: "RESPONSE_LOST" });

beforeEach(() => {
  sim.world.reset();
});

describe("7B-5: the mandatory A/B scenario", () => {
  it("A unknown without publishing, B published and lost its answer: reconciling A (and B) keeps BOTH unknown, assigns no identity, sends nothing", async () => {
    const stores = memoryStores();
    const clock = fixedClock(new Date(sim.world.nowMs() - 120_000).toISOString());
    // A: requested first; its run was interrupted before any call (OUTCOME_UNKNOWN, nothing published).
    const a = seeded(stores, clock, { id: ID_A, idempotencyKey: "form-a", status: "OUTCOME_UNKNOWN", attempt: 1, runReference: "run_a", outcomeCode: "RUN_INTERRUPTED" });
    // B: same account, target and text, another form; it really publishes, then loses the answer.
    const b = seeded(stores, clock, { id: ID_B, idempotencyKey: "form-b" });
    sim.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
    expect(await executeIntent(deps(stores, clock), { workspaceId: WORKSPACE, intentId: b.id, runReference: RUN })).toEqual({ kind: "outcome_unknown", code: "RESPONSE_LOST" });
    expect(sim.world.interactions().filter((state) => state.text === TEXT)).toHaveLength(1);
    const calls = stores.calls.filter((call) => call === "credential:open").length;
    // Reconciling A finds B's reply — and B is a plausible producer: A stays unknown.
    expect(await reconcile(stores, clock, a.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
    // Reconciling B finds its own reply — but A is a plausible producer too: B stays unknown (symmetric; no guess).
    expect(await reconcile(stores, clock, b.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
    for (const id of [a.id, b.id]) {
      expect(stores.intentRows.get(`${WORKSPACE}:${id}`)?.status).toBe("OUTCOME_UNKNOWN");
      expect(stores.replyRows.get(`${WORKSPACE}:${id}`)?.providerReplyId).toBeNull();
    }
    // Two credential openings for the two READS; no provider mutation beyond B's single call; one reply on the platform.
    expect(stores.calls.filter((call) => call === "credential:open")).toHaveLength(calls + 2);
    expect(sim.world.interactions().filter((state) => state.text === TEXT)).toHaveLength(1);
    expect(stores.events.filter((event) => event.status === "CONFIRMED")).toEqual([]);
  });
});

describe("7B-5: competitor shapes", () => {
  const withReplyOnPlatform = (): string => sim.world.createBrandReply("fb_c_010", TEXT);
  const unknownA = (stores: MemoryStores, clock: ReturnType<typeof fixedClock>) => seeded(stores, clock, unknown(ID_A, "form-a"));
  const clockBefore = () => fixedClock(new Date(sim.world.nowMs() - 120_000).toISOString());

  it("a competitor in EXECUTING keeps A unknown", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = unknownA(stores, clock);
    seeded(stores, clock, { id: ID_B, idempotencyKey: "form-b", status: "EXECUTING", attempt: 1, runReference: "run_b" });
    withReplyOnPlatform();
    expect(await reconcile(stores, clock, a.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
  });

  it("a competitor in OUTCOME_UNKNOWN keeps A unknown", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = unknownA(stores, clock);
    seeded(stores, clock, unknown(ID_B, "form-b"));
    withReplyOnPlatform();
    expect(await reconcile(stores, clock, a.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
  });

  it("a CONFIRMED competitor WITHOUT a provider identity keeps A unknown", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = unknownA(stores, clock);
    seeded(stores, clock, { id: ID_B, idempotencyKey: "form-b", status: "CONFIRMED", attempt: 1, runReference: "run_b" });
    withReplyOnPlatform();
    expect(await reconcile(stores, clock, a.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
  });

  it("a competitor whose identity is already linked to the found reply keeps A unknown (identity linked elsewhere); one linked to ANOTHER reply is no producer", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = unknownA(stores, clock);
    const b = seeded(stores, clock, { id: ID_B, idempotencyKey: "form-b", status: "CONFIRMED", attempt: 1, runReference: "run_b" });
    const found = withReplyOnPlatform();
    await stores.replies.confirm(WORKSPACE, b.id, found, clock.now());
    expect(await reconcile(stores, clock, a.id)).toEqual({ kind: "still_unknown", reason: "identity_linked_elsewhere" });
    // B confirmed with a DIFFERENT identity: it owns another reply, so the found one is A's alone.
    await stores.replies.confirm(WORKSPACE, b.id, "fb_r_other", clock.now());
    expect(await reconcile(stores, clock, a.id)).toMatchObject({ kind: "confirmed", providerReplyId: found });
  });

  it("another comment, another account or another workspace is never a competitor; the same comment with ANOTHER text still is (FIX 2: the platform may normalize text)", async () => {
    for (const over of [
      { targetInteractionId: "0d000000-0000-4000-8000-00000000000d" },
      { connectedAccountId: "0c000000-0000-4000-8000-00000000000c" },
      { workspaceId: "9b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" },
    ] as const) {
      sim.world.reset();
      const stores = memoryStores();
      const clock = clockBefore();
      const a = unknownA(stores, clock);
      seeded(stores, clock, { ...unknown(ID_B, "form-b"), ...over });
      const found = withReplyOnPlatform();
      expect(await reconcile(stores, clock, a.id), JSON.stringify(over)).toMatchObject({ kind: "confirmed", providerReplyId: found });
    }
    sim.world.reset();
    const stores = memoryStores();
    const clock = clockBefore();
    const a = unknownA(stores, clock);
    seeded(stores, clock, unknown(ID_B, "form-b"), "Otro texto distinto");
    withReplyOnPlatform();
    expect(await reconcile(stores, clock, a.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
    expect(stores.replyRows.get(`${WORKSPACE}:${a.id}`)?.providerReplyId).toBeNull();
  });

  it("FIX 1 — the provider's clock lags more than 60 s behind ours: the real producer B is still a competitor, so A stays unknown", async () => {
    const stores = memoryStores();
    // A requested well before; B requested at our time T, but the provider stamps B's reply at T − 2 min (its clock lags).
    const clockA = clockBefore();
    const a = unknownA(stores, clockA);
    const found = withReplyOnPlatform(); // the reply exists at provider time "now"
    const clockB = fixedClock(new Date(sim.world.nowMs() + 120_000).toISOString());
    seeded(stores, clockB, unknown(ID_B, "form-b"));
    expect(await reconcile(stores, clockA, a.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
    expect(stores.replyRows.get(`${WORKSPACE}:${a.id}`)?.providerReplyId).toBeNull();
    expect(sim.world.interaction(found)).toBeDefined();
  });

  it("FIX 2 — the platform normalized A's text ('Hola ' published as 'Hola'); B asked 'Hola' and never published: B cannot take A's reply", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    // A: OUTCOME_UNKNOWN after publishing "Hola " which the platform stored as "Hola".
    seeded(stores, clock, unknown(ID_A, "form-a"), "Hola ");
    sim.world.createBrandReply("fb_c_010", "Hola");
    // B: OUTCOME_UNKNOWN without publishing, text exactly "Hola".
    const b = seeded(stores, clock, unknown(ID_B, "form-b"), "Hola");
    expect(await reconcile(stores, clock, b.id)).toEqual({ kind: "still_unknown", reason: "competing_intents" });
    expect(stores.replyRows.get(`${WORKSPACE}:${b.id}`)?.providerReplyId).toBeNull();
  });

  it("an unambiguous reply with no competitor confirms (the positive path is preserved)", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = unknownA(stores, clock);
    const found = withReplyOnPlatform();
    expect(await reconcile(stores, clock, a.id)).toMatchObject({ kind: "confirmed", providerReplyId: found });
    expect(stores.replyRows.get(`${WORKSPACE}:${a.id}`)?.providerReplyId).toBe(found);
  });

  it("two reconciliations of the same two unknown intents, interleaved, never confirm the same reply: both stay unknown", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = unknownA(stores, clock);
    const b = seeded(stores, clock, unknown(ID_B, "form-b"));
    withReplyOnPlatform();
    const results = await Promise.all([reconcile(stores, clock, a.id), reconcile(stores, clock, b.id)]);
    expect(results).toEqual([{ kind: "still_unknown", reason: "competing_intents" }, { kind: "still_unknown", reason: "competing_intents" }]);
    expect([a.id, b.id].map((id) => stores.replyRows.get(`${WORKSPACE}:${id}`)?.providerReplyId)).toEqual([null, null]);
    expect(stores.calls.filter((call) => call.startsWith("provider:"))).toEqual([]);
  });
});

describe("7B-5 FIX 3: an own match whose time the provider did not state reliably is never dropped", () => {
  const clockBefore = () => fixedClock(new Date(sim.world.nowMs() - 120_000).toISOString());
  /** The simulator's read port with the brand replies' creation time rewritten per provider id. */
  const patchedLookup = (clock: ReturnType<typeof fixedClock>, stamps: Readonly<Record<string, string | null>>) => {
    const read = {
      ...sim.read,
      listInteractions: async (...args: Parameters<typeof sim.read.listInteractions>) => {
        const result = await sim.read.listInteractions(...args);
        const items = result.data.items.map((item) => (item.ref.id in stamps ? { ...item, timestamps: { ...item.timestamps, createdAt: stamps[item.ref.id] as never } } : item));
        return { ...result, data: { ...result.data, items } };
      },
    };
    return createReadPortReplyLookup({ read: (provider) => (provider === "simulator" ? read : undefined) }, "simulator", () => new Date(clock.now().getTime() + 3_600_000));
  };
  const reconcileWith = (stores: MemoryStores, clock: ReturnType<typeof fixedClock>, intentId: string, stamps: Readonly<Record<string, string | null>>) =>
    reconcileIntent({ inScope: (work) => work(stores), credentials: credentials(stores), lookup: patchedLookup(clock, stamps), clock }, { workspaceId: WORKSPACE, intentId, runReference: "run_reconcile" });

  it("1. a match without a timestamp next to a valid one → ambiguous, nothing confirmed", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = seeded(stores, clock, unknown(ID_A, "form-a"));
    const untimed = sim.world.createBrandReply("fb_c_010", TEXT);
    sim.world.createBrandReply("fb_c_010", TEXT);
    expect(await reconcileWith(stores, clock, a.id, { [untimed]: null })).toEqual({ kind: "still_unknown", reason: "ambiguous" });
    expect(stores.replyRows.get(`${WORKSPACE}:${a.id}`)?.providerReplyId).toBeNull();
  });

  it("2. a match with an unparseable timestamp next to a valid one → ambiguous, nothing confirmed", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = seeded(stores, clock, unknown(ID_A, "form-a"));
    const broken = sim.world.createBrandReply("fb_c_010", TEXT);
    sim.world.createBrandReply("fb_c_010", TEXT);
    expect(await reconcileWith(stores, clock, a.id, { [broken]: "not-a-date" })).toEqual({ kind: "still_unknown", reason: "ambiguous" });
    expect(stores.replyRows.get(`${WORKSPACE}:${a.id}`)?.providerReplyId).toBeNull();
  });

  it("3. a single valid match with nothing else → found and confirmed (the positive path)", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = seeded(stores, clock, unknown(ID_A, "form-a"));
    const only = sim.world.createBrandReply("fb_c_010", TEXT);
    expect(await reconcileWith(stores, clock, a.id, {})).toMatchObject({ kind: "confirmed", providerReplyId: only });
  });

  it("4. a single match WITHOUT a timestamp is not a positive attribution either → ambiguous", async () => {
    const stores = memoryStores();
    const clock = clockBefore();
    const a = seeded(stores, clock, unknown(ID_A, "form-a"));
    const untimed = sim.world.createBrandReply("fb_c_010", TEXT);
    expect(await reconcileWith(stores, clock, a.id, { [untimed]: null })).toEqual({ kind: "still_unknown", reason: "ambiguous" });
  });
});
