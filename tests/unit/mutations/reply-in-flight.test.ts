/**
 * Step 7B-16B — REPLY_IN_FLIGHT, the request side offline (the database guarantee itself is proven on PostgreSQL in
 * tests/db/suites/reply-in-flight.ts — nothing here is evidence of atomicity):
 *
 *   rule        a target held by a PENDING / EXECUTING / OUTCOME_UNKNOWN public-reply intent refuses a new key
 *               (REPLY_IN_FLIGHT), whoever asks; CONFIRMED / FAILED / BLOCKED release it; nothing is written on refusal
 *   order       every earlier refusal keeps its precedence (REPLY_IN_FLIGHT is the LAST check before the insert)
 *   races       the insert's two recognized conflicts (as the PostgreSQL store reports them after its savepoint):
 *               key_taken → the winner's intent (same payload) or IDEMPOTENCY_KEY_REUSED; target_in_flight →
 *               REPLY_IN_FLIGHT, unless the winner holds this very key; anything else thrown, never mapped
 *   pin         migration 0032's index predicate names exactly REPLY_HOLDING_STATUSES, scoped to reply_public
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTENT_STATUSES, REPLY_HOLDING_STATUSES, holdsReplyTarget, isTerminal, type IntentStatus } from "@/mutations/domain/intent";
import { requestPublicReply, type PublicReplyRequest } from "@/mutations/request";
import type { IntentInsertResult } from "@/mutations/ports";
import { CORRELATION, ORGANIZATION, TARGET, USER, WORKSPACE, fixedClock, guardState, memoryStores, pendingIntent, replyTarget, type MemoryStores } from "./support";

const context = { organizationId: ORGANIZATION, workspaceId: WORKSPACE, userId: USER, correlationId: CORRELATION };
const OTHER_USER = "6b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_TARGET = "4b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4cff";
const request = (overrides: Partial<PublicReplyRequest> = {}): PublicReplyRequest => ({ targetInteractionId: TARGET, text: "Gracias por escribirnos.", idempotencyKey: "form-render-0001", ...overrides });

/** Seeds an intent in `status` for TARGET (as another member's earlier request would have left it). */
function seed(stores: MemoryStores, status: IntentStatus, overrides: Parameters<typeof pendingIntent>[1] = {}): void {
  const clock = fixedClock();
  const intent = pendingIntent(clock, { id: "eb2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", idempotencyKey: `seeded-${status.toLowerCase()}-0001`, initiatorUserId: OTHER_USER, ...overrides });
  const settled = status === "PENDING" ? intent : { ...intent, status, attempt: 1, runReference: "run_seed", outcomeCode: status === "FAILED" ? "PROVIDER_REJECTED" : status === "BLOCKED" ? "MODE_NOT_STANDARD" : status === "OUTCOME_UNKNOWN" ? "RESPONSE_LOST" : null } as const;
  stores.intentRows.set(`${settled.workspaceId}:${settled.id}`, settled);
}

const written = (stores: MemoryStores) => ({ intents: stores.intentRows.size, replies: stores.replyRows.size, history: stores.history.length });

describe("7B-16B: the holding statuses", () => {
  it("are exactly PENDING, EXECUTING and OUTCOME_UNKNOWN — every non-terminal status, and no terminal one", () => {
    expect([...REPLY_HOLDING_STATUSES]).toEqual(["PENDING", "EXECUTING", "OUTCOME_UNKNOWN"]);
    for (const status of INTENT_STATUSES) expect(holdsReplyTarget(status), status).toBe(!isTerminal(status));
  });

  it("migration 0032's partial unique index names exactly these statuses, the reply_public kind and (workspace, target)", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0032_reply_in_flight_admission.sql", import.meta.url), "utf8")
      .split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").replace(/\s+/g, " ").trim();
    const statuses = REPLY_HOLDING_STATUSES.map((status) => `'${status}'`).join(", ");
    expect(sql).toContain(`create unique index mutation_intents_one_open_reply_per_target on mutations.mutation_intents (workspace_id, target_interaction_id) where kind = 'reply_public' and status in (${statuses});`);
    // Nothing else: one index, its comment, the owner role switch.
    expect(sql.match(/\bcreate\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(drop|delete|update|insert|alter|grant|revoke|policy|function|trigger)\b/i);
  });
});

describe("7B-16B: REPLY_IN_FLIGHT at request time", () => {
  for (const status of REPLY_HOLDING_STATUSES) {
    it(`a ${status} public reply on the target refuses a new key — whoever asks — and writes nothing`, async () => {
      const stores = memoryStores();
      seed(stores, status);
      const before = written(stores);
      expect(await requestPublicReply(stores, fixedClock(), context, request())).toEqual({ kind: "refused", reason: "REPLY_IN_FLIGHT" });
      expect(await requestPublicReply(stores, fixedClock(), { ...context, userId: OTHER_USER }, request({ idempotencyKey: "form-render-0002" }))).toEqual({ kind: "refused", reason: "REPLY_IN_FLIGHT" });
      expect(written(stores)).toEqual(before);
    });
  }

  for (const status of ["CONFIRMED", "FAILED", "BLOCKED"] as const) {
    it(`a ${status} public reply releases the target: a new key is admitted`, async () => {
      const stores = memoryStores();
      seed(stores, status);
      const outcome = await requestPublicReply(stores, fixedClock(), context, request());
      expect(outcome.kind).toBe("created");
      expect(written(stores)).toEqual({ intents: 2, replies: 1, history: 1 });
    });
  }

  it("another target, or the same target id in another workspace, is not held", async () => {
    const stores = memoryStores(guardState(), [replyTarget(), replyTarget({ interactionId: OTHER_TARGET })]);
    seed(stores, "OUTCOME_UNKNOWN", { workspaceId: "9b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d" });
    expect((await requestPublicReply(stores, fixedClock(), context, request())).kind).toBe("created");
    expect((await requestPublicReply(stores, fixedClock(), context, request({ targetInteractionId: OTHER_TARGET, idempotencyKey: "form-render-0002" }))).kind).toBe("created");
  });

  it("the same form (same key, same payload) still answers its own in-flight intent; another payload is still a key reuse", async () => {
    const stores = memoryStores();
    const first = await requestPublicReply(stores, fixedClock(), context, request());
    expect(first.kind).toBe("created");
    expect((await requestPublicReply(stores, fixedClock(), context, request())).kind).toBe("existing");
    expect(await requestPublicReply(stores, fixedClock(), context, request({ text: "Otro texto" }))).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(written(stores)).toEqual({ intents: 1, replies: 1, history: 1 });
  });

  it("is the LAST check: target, text, switch, account, connection and capability refusals keep their precedence", async () => {
    const cases: readonly [Parameters<typeof memoryStores>, Partial<PublicReplyRequest>, string][] = [
      [[guardState(), [replyTarget({ presence: "hidden" })]], {}, "TARGET_NOT_PRESENT"],
      [[guardState(), [replyTarget({ ownAccount: true })]], {}, "TARGET_OWN_ACCOUNT"],
      [[guardState(), [replyTarget()]], { text: "   " }, "TEXT_EMPTY"],
      [[guardState({ switchEnabled: false }), [replyTarget()]], {}, "PROVIDER_ACTIONS_DISABLED"],
      [[guardState({ capability: "UNAVAILABLE" }), [replyTarget()]], {}, "CAPABILITY_UNAVAILABLE"],
    ];
    for (const [args, overrides, reason] of cases) {
      const stores = memoryStores(...args);
      seed(stores, "OUTCOME_UNKNOWN");
      expect(await requestPublicReply(stores, fixedClock(), context, request(overrides)), reason).toEqual({ kind: "refused", reason });
    }
  });
});

describe("7B-16B: a request that loses the race after its read", () => {
  /** The read saw nothing (the competitor had not committed); the insert then reports `result`, and the winner is visible. */
  function racing(result: Exclude<IntentInsertResult, "inserted">, winner: { readonly key: string; readonly user: string; readonly text: string }): MemoryStores {
    const stores = memoryStores();
    const clock = fixedClock("2026-11-09T09:00:00.000Z");
    const intent = pendingIntent(clock, { id: "fb2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", idempotencyKey: winner.key, initiatorUserId: winner.user });
    return {
      ...stores,
      intents: {
        ...stores.intents,
        holdsOpenReply: () => Promise.resolve(false),
        insert: () => {
          stores.intentRows.set(`${intent.workspaceId}:${intent.id}`, intent);
          stores.replyRows.set(`${intent.workspaceId}:${intent.id}`, { id: clock.newId(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, intentId: intent.id, parentInteractionId: TARGET, connectedAccountId: intent.connectedAccountId, platform: "facebook", text: winner.text, providerReplyId: null, confirmedAt: null, createdAt: clock.now() });
          return Promise.resolve(result);
        },
      },
    };
  }

  it("a winner with another key → REPLY_IN_FLIGHT; nothing of the loser is written", async () => {
    const stores = racing("target_in_flight", { key: "form-winner-0001", user: OTHER_USER, text: "Hola" });
    expect(await requestPublicReply(stores, fixedClock(), context, request())).toEqual({ kind: "refused", reason: "REPLY_IN_FLIGHT" });
    expect(written(stores)).toEqual({ intents: 1, replies: 1, history: 0 });
  });

  it("a winner with the SAME key and payload → the winner's intent (existing), whichever rule fired first", async () => {
    for (const result of ["key_taken", "target_in_flight"] as const) {
      const stores = racing(result, { key: "form-render-0001", user: USER, text: "Gracias por escribirnos." });
      const outcome = await requestPublicReply(stores, fixedClock(), context, request());
      expect(outcome.kind, result).toBe("existing");
      expect(written(stores).history, result).toBe(0);
    }
  });

  it("a winner with the same key but another payload → IDEMPOTENCY_KEY_REUSED", async () => {
    const stores = racing("key_taken", { key: "form-render-0001", user: OTHER_USER, text: "Gracias por escribirnos." });
    expect(await requestPublicReply(stores, fixedClock(), context, request())).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("a key reported taken whose intent this transaction cannot read is thrown, never mapped to a refusal", async () => {
    const stores = memoryStores();
    const blind: MemoryStores = { ...stores, intents: { ...stores.intents, holdsOpenReply: () => Promise.resolve(false), insert: () => Promise.resolve("key_taken") } };
    await expect(requestPublicReply(blind, fixedClock(), context, request())).rejects.toThrow(/idempotency key taken/);
  });

  it("any other insert failure propagates unchanged (never REPLY_IN_FLIGHT)", async () => {
    const stores = memoryStores();
    const failing: MemoryStores = { ...stores, intents: { ...stores.intents, insert: () => Promise.reject(new Error("unrelated database failure")) } };
    await expect(requestPublicReply(failing, fixedClock(), context, request())).rejects.toThrow("unrelated database failure");
    expect(written(stores)).toEqual({ intents: 0, replies: 0, history: 0 });
  });
});
