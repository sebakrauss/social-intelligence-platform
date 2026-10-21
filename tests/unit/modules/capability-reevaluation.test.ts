/**
 * Step 7G-H5.5-P2-B1, without a database: the explicit capability re-evaluation core. The dispatch key of a recovery
 * authority (reeval.{eventId}, inside system.outbox's real dispatch_key contract, existing keys unchanged), the exact
 * eligibility matrix, the 30-minute server-side cooldown boundary, the refusal order, and the command contract. Every
 * refusal writes nothing; an accepted request writes exactly one event and one request, keyed by that event. The
 * database behavior (RLS, constraints, atomicity, concurrency, old authorities) is proven in
 * tests/db/suites/capability-reevaluation.ts.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { parseOrganizationId, parseUserId, parseWorkspaceId, type OrganizationId, type UserId, type WorkspaceId } from "@/domain/ids";
import { CATALOGS, PLATFORM_CATALOG, SIMULATOR_CATALOG, type FactsInput, type StoredProfileHeader } from "@/modules/capability";
import { ACCOUNT_EVENT_REASONS, ACCOUNT_EVENT_TYPES, type ConnectedAccountEvent } from "@/modules/connections/domain/model";
import {
  CAPABILITY_EVALUATION_TOPIC,
  CAPABILITY_REEVALUATION_COOLDOWN_MS,
  REEVALUATION_COOLDOWN_EVENTS,
  REEVALUATION_REFUSALS,
  capabilityEvaluationDispatchKey,
  profileEligibility,
  requestCapabilityReevaluation,
  withinReevaluationCooldown,
  type CapabilityReevaluationStores,
  type ConnectedAccount,
  type Connection,
} from "@/modules/connections";
import { AUDIT_ACTIONS } from "@/modules/audit";
import type { OutboxMessage } from "@/platform/outbox";
import { createConnectedAccountCommands } from "@/server/commands/connected-accounts";
import type { CommandEnvironment, Transaction, WorkspaceContext } from "@/server/pipeline";

const root = path.resolve(import.meta.dirname, "../../..");
const outboxMigration = readFileSync(path.join(root, "db/migrations/0004_outbox.sql"), "utf8");
const migration = readFileSync(path.join(root, "db/migrations/0014_capability_reevaluation_event.sql"), "utf8");

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("fixture");
  return value;
};
const WORKSPACE: WorkspaceId = must(parseWorkspaceId(randomUUID()));
const ORGANIZATION: OrganizationId = must(parseOrganizationId(randomUUID()));
const USER: UserId = must(parseUserId(randomUUID()));
const SCOPE = { workspaceId: WORKSPACE, organizationId: ORGANIZATION, userId: USER };
const T0 = new Date("2026-10-21T12:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const MIN = 60_000;

const available = (): FactsInput => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: [], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T0 });
const unavailable = (): FactsInput => ({ kind: "unavailable", observedAt: T0 });
type Header = Pick<StoredProfileHeader, "catalogId" | "catalogRevision" | "facts">;
const header = (catalogId: "platform" | "simulator", catalogRevision: number, facts: FactsInput): Header => ({ catalogId, catalogRevision, facts });

/** The dispatch_key CHECK of system.outbox, read from the migration that defines it (never restated here). */
function dispatchKeyContract(): RegExp {
  const match = /dispatch_key\s+text not null unique check \(dispatch_key ~ '([^']+)'\)/.exec(outboxMigration);
  return new RegExp(must(match?.[1]));
}

// ── In-memory fakes of the narrow ports the service uses ──────────────────────────────────────────────────────
interface World {
  account: ConnectedAccount | undefined;
  connection: Connection | undefined;
  header: Header | undefined;
  events: { readonly type: string; readonly at: Date }[];
}
interface Recorder {
  readonly locked: string[];
  readonly appendedEvents: ConnectedAccountEvent[];
  readonly appendedRequests: OutboxMessage[];
  readonly calls: string[];
}

function fixture(overrides: Partial<Pick<World, "header">> & { accountStatus?: "ACTIVE" | "INACTIVE"; connectionStatus?: Connection["status"] | "MISSING"; provider?: Connection["provider"]; events?: World["events"] } = {}) {
  const accountId = randomUUID();
  const connectionId = randomUUID();
  const world: World = {
    account: {
      id: accountId,
      organizationId: ORGANIZATION,
      workspaceId: WORKSPACE,
      connectionId,
      platform: "facebook",
      providerAssetId: "asset-1",
      assetClass: "content_bearing",
      status: overrides.accountStatus ?? "ACTIVE",
      activatedAt: T0,
      deactivatedAt: null,
      deactivationReason: null,
      moveId: null,
    },
    connection:
      overrides.connectionStatus === "MISSING"
        ? undefined
        : {
            id: connectionId,
            organizationId: ORGANIZATION,
            workspaceId: WORKSPACE,
            provider: overrides.provider ?? "meta",
            status: overrides.connectionStatus ?? "ACTIVE",
            activeCredentialId: null,
            authorizedBy: USER,
            authorizedAt: T0,
            lastSuccessAt: null,
            lastProblemCode: null,
            lastProblemAt: null,
            version: 1,
            createdAt: T0,
            updatedAt: T0,
          },
    header: "header" in overrides ? overrides.header : undefined,
    events: overrides.events ?? [],
  };
  const recorder: Recorder = { locked: [], appendedEvents: [], appendedRequests: [], calls: [] };
  const stores: CapabilityReevaluationStores = {
    connections: {
      connectedAccounts: {
        lock: (id) => {
          recorder.calls.push("lock");
          recorder.locked.push(id);
          return Promise.resolve(id === world.account?.id ? world.account : undefined);
        },
      },
      connections: {
        getForShare: (id) => {
          recorder.calls.push("connection");
          return Promise.resolve(id === world.connection?.id ? world.connection : undefined);
        },
      },
      accountEvents: {
        append: (event) => {
          recorder.calls.push("event");
          recorder.appendedEvents.push(event);
          return Promise.resolve();
        },
        latestOccurredAt: (id, types) => {
          recorder.calls.push("cooldown");
          const times = world.events.filter((event) => id === world.account?.id && types.includes(event.type as never)).map((event) => event.at.getTime());
          return Promise.resolve(times.length === 0 ? undefined : new Date(Math.max(...times)));
        },
      },
    },
    capability: {
      header: (id) => {
        recorder.calls.push("header");
        return Promise.resolve(id === world.account?.id && world.header !== undefined ? ({ ...world.header } as StoredProfileHeader) : undefined);
      },
    },
    outbox: {
      append: (message) => {
        recorder.calls.push("request");
        recorder.appendedRequests.push(message);
        return Promise.resolve();
      },
    },
  };
  return { accountId, world, recorder, stores };
}

const run = (f: ReturnType<typeof fixture>, now: Date = T0, connectedAccountId: string = f.accountId) =>
  requestCapabilityReevaluation(f.stores, { scope: SCOPE, connectedAccountId, correlationId: "corr-h55-p2-unit", now, newId: randomUUID });

const wroteNothing = (f: ReturnType<typeof fixture>): void => {
  expect(f.recorder.appendedEvents).toEqual([]);
  expect(f.recorder.appendedRequests).toEqual([]);
};

describe("the recovery authority's dispatch key", () => {
  it("is capability.evaluate_account:{account}:reeval.{eventId}, deterministic, and inside system.outbox's real dispatch_key contract", () => {
    const account = randomUUID();
    const event = randomUUID();
    const key = capabilityEvaluationDispatchKey(account, { kind: "reevaluation", eventId: event });
    expect(key).toBe(`${CAPABILITY_EVALUATION_TOPIC}:${account}:reeval.${event}`);
    expect(capabilityEvaluationDispatchKey(account, { kind: "reevaluation", eventId: event })).toBe(key);
    expect(key).toMatch(dispatchKeyContract());
    expect(key.length).toBe(108);
    expect(key.length).toBeLessThanOrEqual(128);
    // A different event is a different authority.
    expect(capabilityEvaluationDispatchKey(account, { kind: "reevaluation", eventId: randomUUID() })).not.toBe(key);
  });

  it("only a UUID event id can name a recovery authority (fail closed)", () => {
    for (const eventId of ["", "initial", "not-a-uuid", `${randomUUID()}x`, "x".repeat(36), "../../etc"]) {
      expect(() => capabilityEvaluationDispatchKey(randomUUID(), { kind: "reevaluation", eventId })).toThrow(TypeError);
    }
  });

  it("the existing activation, initial and catalog-revision keys are unchanged", () => {
    const account = randomUUID();
    const activation = randomUUID();
    expect(capabilityEvaluationDispatchKey(account, { kind: "activation", activationId: activation })).toBe(`capability.evaluate_account:${account}:${activation}`);
    expect(capabilityEvaluationDispatchKey(account, { kind: "unrecorded" })).toBe(`capability.evaluate_account:${account}:initial`);
    expect(capabilityEvaluationDispatchKey(account, { kind: "catalog", catalogId: "platform", catalogRevision: 2 })).toBe(`capability.evaluate_account:${account}:platform.r2`);
  });
});

describe("eligibility (exact matrix; provider-neutral)", () => {
  const current = PLATFORM_CATALOG.revision;
  it.each([
    ["no profile/header", undefined, "meta", { eligible: true, basis: "NO_PROFILE" }],
    ["stale: older revision of the same catalog", header("platform", current - 1, available()), "meta", { eligible: true, basis: "PROFILE_STALE" }],
    ["stale: older revision with unavailable facts", header("platform", current - 1, unavailable()), "meta", { eligible: true, basis: "PROFILE_STALE" }],
    ["stale: another (earlier) catalog", header("simulator", SIMULATOR_CATALOG.revision, available()), "meta", { eligible: true, basis: "PROFILE_STALE" }],
    ["current with facts unavailable", header("platform", current, unavailable()), "meta", { eligible: true, basis: "FACTS_UNAVAILABLE" }],
    ["current with usable facts", header("platform", current, available()), "meta", { eligible: false, reason: "PROFILE_CURRENT" }],
    ["newer revision than this code", header("platform", current + 1, available()), "meta", { eligible: false, reason: "PROFILE_NEWER_THAN_CODE" }],
    ["newer revision than this code, facts unavailable", header("platform", current + 1, unavailable()), "meta", { eligible: false, reason: "PROFILE_NEWER_THAN_CODE" }],
    ["simulator: current with usable facts", header("simulator", SIMULATOR_CATALOG.revision, available()), "simulator", { eligible: false, reason: "PROFILE_CURRENT" }],
    ["simulator: profile on the platform catalog", header("platform", current, available()), "simulator", { eligible: true, basis: "PROFILE_STALE" }],
  ] as const)("%s", (_label, stored, provider, expected) => {
    expect(profileEligibility(stored, provider)).toEqual(expected);
  });

  it("the catalog a profile should rest on comes from the provider only, like reconciliation (no provider-specific branch)", () => {
    for (const provider of ["meta", "tiktok", "anything"]) {
      expect(profileEligibility(header("platform", CATALOGS.platform.revision, available()), provider)).toEqual({ eligible: false, reason: "PROFILE_CURRENT" });
    }
  });
});

describe("the 30-minute cooldown (server clock)", () => {
  it("29:59 is refused, 30:00 is eligible; no event is never a cooldown; a future-dated event is refused", () => {
    expect(CAPABILITY_REEVALUATION_COOLDOWN_MS).toBe(30 * MIN);
    expect(withinReevaluationCooldown(undefined, T0)).toBe(false);
    expect(withinReevaluationCooldown(T0, at(29 * MIN + 59_000))).toBe(true);
    expect(withinReevaluationCooldown(T0, at(30 * MIN - 1))).toBe(true);
    expect(withinReevaluationCooldown(T0, at(30 * MIN))).toBe(false);
    expect(withinReevaluationCooldown(T0, at(31 * MIN))).toBe(false);
    expect(withinReevaluationCooldown(at(5 * MIN), T0)).toBe(true);
  });

  it("is started by LINKED, MOVED_IN and REEVALUATION_REQUESTED only", () => {
    expect([...REEVALUATION_COOLDOWN_EVENTS].sort()).toEqual(["LINKED", "MOVED_IN", "REEVALUATION_REQUESTED"]);
  });
});

describe("requestCapabilityReevaluation", () => {
  it("eligible without a profile → exactly one event and one request keyed by it, identifiers only", async () => {
    const f = fixture();
    const output = await run(f);
    expect(output.kind).toBe("requested");
    if (output.kind !== "requested") throw new Error("not requested");
    expect(f.recorder.calls).toEqual(["lock", "connection", "header", "cooldown", "event", "request"]);
    expect(f.recorder.appendedEvents).toEqual([
      {
        id: output.eventId,
        organizationId: ORGANIZATION,
        workspaceId: WORKSPACE,
        connectedAccountId: f.accountId,
        eventType: "REEVALUATION_REQUESTED",
        moveId: null,
        reasonCode: "USER_REQUESTED_REEVALUATION",
        actor: { type: "user", userId: USER },
        occurredAt: T0,
      },
    ]);
    const request = must(f.recorder.appendedRequests[0]);
    expect(f.recorder.appendedRequests).toHaveLength(1);
    expect(request).toMatchObject({
      topic: CAPABILITY_EVALUATION_TOPIC,
      organizationId: ORGANIZATION,
      workspaceId: WORKSPACE,
      subjectIds: { connected_account_id: f.accountId },
      correlationId: "corr-h55-p2-unit",
      initiator: { type: "user", userId: USER },
      dispatchKey: `${CAPABILITY_EVALUATION_TOPIC}:${f.accountId}:reeval.${output.eventId}`,
      createdAt: T0,
    });
    expect(Object.keys(request.subjectIds)).toEqual(["connected_account_id"]);
    expect(request.id).not.toBe(output.eventId);
    expect(output).toEqual({ kind: "requested", connectedAccountId: f.accountId, eventId: output.eventId, dispatchKey: request.dispatchKey, basis: "NO_PROFILE" });
  });

  it("stale older profile → accepted (PROFILE_STALE)", async () => {
    const f = fixture({ header: header("platform", PLATFORM_CATALOG.revision - 1, available()) });
    expect(await run(f)).toMatchObject({ kind: "requested", basis: "PROFILE_STALE" });
    expect(f.recorder.appendedRequests).toHaveLength(1);
  });

  it("current profile with facts unavailable → accepted (FACTS_UNAVAILABLE)", async () => {
    const f = fixture({ header: header("platform", PLATFORM_CATALOG.revision, unavailable()) });
    expect(await run(f)).toMatchObject({ kind: "requested", basis: "FACTS_UNAVAILABLE" });
    expect(f.recorder.appendedEvents).toHaveLength(1);
  });

  it("newer-than-code profile → PROFILE_NEWER_THAN_CODE, nothing written", async () => {
    const f = fixture({ header: header("platform", PLATFORM_CATALOG.revision + 1, unavailable()) });
    expect(await run(f)).toEqual({ kind: "refused", connectedAccountId: f.accountId, reason: "PROFILE_NEWER_THAN_CODE" });
    wroteNothing(f);
  });

  it("usable current profile → PROFILE_CURRENT, nothing written", async () => {
    const f = fixture({ header: header("platform", PLATFORM_CATALOG.revision, available()) });
    expect(await run(f)).toEqual({ kind: "refused", connectedAccountId: f.accountId, reason: "PROFILE_CURRENT" });
    wroteNothing(f);
  });

  it("inactive account → ACCOUNT_INACTIVE before anything else is read; nothing written", async () => {
    const f = fixture({ accountStatus: "INACTIVE" });
    expect(await run(f)).toEqual({ kind: "refused", connectedAccountId: f.accountId, reason: "ACCOUNT_INACTIVE" });
    expect(f.recorder.calls).toEqual(["lock"]);
    wroteNothing(f);
  });

  it.each(["DEGRADED", "FAILED", "DISCONNECTED", "REMOVED", "CONNECTING", "MISSING"] as const)("connection %s → CONNECTION_NOT_ACTIVE; nothing written", async (status) => {
    const f = fixture({ connectionStatus: status });
    expect(await run(f)).toEqual({ kind: "refused", connectedAccountId: f.accountId, reason: "CONNECTION_NOT_ACTIVE" });
    expect(f.recorder.calls).toEqual(["lock", "connection"]);
    wroteNothing(f);
  });

  it("cooldown: 29:59 after a LINKED, MOVED_IN or REEVALUATION_REQUESTED → REEVALUATION_TOO_SOON; 30:00 → accepted", async () => {
    for (const type of ["LINKED", "MOVED_IN", "REEVALUATION_REQUESTED"]) {
      const early = fixture({ events: [{ type, at: T0 }] });
      expect(await run(early, at(29 * MIN + 59_000))).toEqual({ kind: "refused", connectedAccountId: early.accountId, reason: "REEVALUATION_TOO_SOON" });
      wroteNothing(early);
      const onTime = fixture({ events: [{ type, at: T0 }] });
      expect(await run(onTime, at(30 * MIN))).toMatchObject({ kind: "requested" });
      expect(onTime.recorder.appendedRequests).toHaveLength(1);
    }
  });

  it("cooldown uses the LATEST relevant event; UNLINKED, MOVED_OUT and DEACTIVATED don't start it", async () => {
    const f = fixture({ events: [{ type: "LINKED", at: at(-60 * MIN) }, { type: "REEVALUATION_REQUESTED", at: at(-10 * MIN) }] });
    expect(await run(f)).toMatchObject({ kind: "refused", reason: "REEVALUATION_TOO_SOON" });
    const g = fixture({ events: [{ type: "UNLINKED", at: T0 }, { type: "MOVED_OUT", at: T0 }, { type: "DEACTIVATED", at: T0 }] });
    expect(await run(g)).toMatchObject({ kind: "requested" });
  });

  it("a retry of an accepted request inside the cooldown is REEVALUATION_TOO_SOON: no second event id or request", async () => {
    const f = fixture();
    const first = await run(f);
    if (first.kind !== "requested") throw new Error("not requested");
    f.world.events.push({ type: "REEVALUATION_REQUESTED", at: T0 });
    expect(await run(f, at(1_000))).toMatchObject({ kind: "refused", reason: "REEVALUATION_TOO_SOON" });
    expect(f.recorder.appendedEvents.map((event) => event.id)).toEqual([first.eventId]);
    expect(f.recorder.appendedRequests).toHaveLength(1);
  });

  it("a later accepted request is a NEW authority: new event id, new dispatch key", async () => {
    const f = fixture();
    const first = await run(f);
    f.world.events.push({ type: "REEVALUATION_REQUESTED", at: T0 });
    const second = await run(f, at(30 * MIN));
    if (first.kind !== "requested" || second.kind !== "requested") throw new Error("not requested");
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.dispatchKey).not.toBe(first.dispatchKey);
    expect(new Set(f.recorder.appendedRequests.map((request) => request.dispatchKey)).size).toBe(2);
  });

  it("an unknown (or another workspace's) account is NOT_FOUND, never a typed refusal; nothing written", async () => {
    const f = fixture();
    await expect(run(f, T0, randomUUID())).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.code === "NOT_FOUND");
    if (f.world.account !== undefined) f.world.account = { ...f.world.account, workspaceId: must(parseWorkspaceId(randomUUID())) };
    await expect(run(f)).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.code === "NOT_FOUND");
    wroteNothing(f);
  });

  it("refusals are a closed vocabulary", () => {
    expect([...REEVALUATION_REFUSALS].sort()).toEqual(["ACCOUNT_INACTIVE", "CONNECTION_NOT_ACTIVE", "PROFILE_CURRENT", "PROFILE_NEWER_THAN_CODE", "REEVALUATION_TOO_SOON"]);
  });
});

describe("the command connections.account.request_capability_reevaluation", () => {
  const command = createConnectedAccountCommands().requestCapabilityReevaluation;
  const context = { workspaceId: WORKSPACE, organizationId: ORGANIZATION, userId: USER } as unknown as WorkspaceContext;
  const env: CommandEnvironment = { now: T0, newId: randomUUID, correlationId: "corr-h55-p2-cmd" as never, requestId: "req-h55-p2-cmd" as never };

  it("is a workspace command: connections.manage, works in Monitor-only (configuration, not a platform mutation)", () => {
    expect(command.scope).toBe("workspace");
    expect(command.name).toBe("connections.account.request_capability_reevaluation");
    expect(command.permission).toBe("connections.manage");
    expect(command.requiresStandardMode).toBe(false);
  });

  it("accepts exactly { connectedAccountId: UUID }: no provider/asset id, no client idempotency key, nothing else", () => {
    const id = randomUUID();
    expect(command.validate({ connectedAccountId: id })).toEqual({ connectedAccountId: id });
    for (const input of [
      {},
      { connectedAccountId: "not-a-uuid" },
      { connectedAccountId: id, idempotencyKey: randomUUID() },
      { connectedAccountId: id, dispatchKey: "capability.evaluate_account:x:initial" },
      { connectedAccountId: id, provider: "meta" },
      { connectedAccountId: id, eventId: randomUUID() },
      null,
      "x",
    ]) {
      expect(() => command.validate(input)).toThrow(AppError);
    }
  });

  it("execute runs the service on the transaction's stores; success → { requested: true } + one audit draft", async () => {
    const f = fixture();
    const tx = { connections: f.stores.connections, capability: f.stores.capability, outbox: f.stores.outbox } as unknown as Transaction;
    const output = await command.execute(context, { connectedAccountId: f.accountId }, tx, env);
    expect(output.kind).toBe("requested");
    expect(command.audit(output)).toEqual({ action: "connected_account.capability_reevaluation_requested", targetType: "connected_account", targetId: f.accountId });
    expect(command.respond(output)).toEqual({ requested: true });
    expect(f.recorder.appendedRequests[0]?.initiator).toEqual({ type: "user", userId: USER });
  });

  it("a refusal → { requested: false, reason } and no audit draft", () => {
    for (const reason of REEVALUATION_REFUSALS) {
      const output = { kind: "refused", connectedAccountId: randomUUID(), reason } as const;
      expect(command.audit(output)).toBeUndefined();
      expect(command.respond(output)).toEqual({ requested: false, reason });
    }
  });

  it("is registered in the existing connected-account command registry (no parallel endpoint)", () => {
    expect(Object.keys(createConnectedAccountCommands()).sort()).toEqual(["link", "list", "requestCapabilityReevaluation", "requestMove", "retry", "unlink"]);
  });
});

describe("vocabulary alignment with migration 0014", () => {
  it("the domain event type, reason and audit action are exactly what 0014 admits", () => {
    expect(ACCOUNT_EVENT_TYPES).toContain("REEVALUATION_REQUESTED");
    expect(ACCOUNT_EVENT_REASONS).toContain("USER_REQUESTED_REEVALUATION");
    expect(AUDIT_ACTIONS).toContain("connected_account.capability_reevaluation_requested");
    const listed = (constraint: string): string[] => {
      const match = new RegExp(`add constraint ${constraint} check \\(\\w+ in \\(([^)]*)\\)\\) not valid;`).exec(migration.replace(/\s+/g, " "));
      return [...must(match?.[1]).matchAll(/'([^']+)'/g)].map((value) => value[1] ?? "").sort();
    };
    expect(listed("connected_account_events_event_type_check")).toEqual([...ACCOUNT_EVENT_TYPES].sort());
    expect(listed("connected_account_events_reason_code_check")).toEqual([...ACCOUNT_EVENT_REASONS].sort());
    expect(listed("audit_events_action_check")).toEqual([...AUDIT_ACTIONS].sort());
  });
});
