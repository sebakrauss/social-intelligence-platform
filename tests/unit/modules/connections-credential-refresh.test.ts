/**
 * Capability refresh after a re-authorization (Step 7G-H5.5-P12-C0-R1), offline: the `credential` evaluation reason and
 * its deterministic key, the typed discovery continuation (built only by `discoveryRequest`, read only by
 * `capabilityRefreshOf`), the refresh a validated discovery performs, and the worker's superseded-credential guard —
 * all against in-memory fakes. No database, provider, KMS or network. Synthetic ids only.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { parseOrganizationId, parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { providerCredential, type ProviderReadPort, type SocialAssetDto } from "@/integrations/providers/contract";
import {
  CAPABILITY_EVALUATION_CREDENTIAL_SUBJECT,
  CAPABILITY_REFRESH_SUBJECT,
  capabilityEvaluationDispatchKey,
  capabilityEvaluationRequest,
  capabilityRefreshOf,
  discoverConnectionAssets,
  discoveryRequest,
  refreshAccountCapabilities,
  type CapabilityRefresh,
  type ConnectedAccount,
  type Connection,
  type ConnectionWorkerStore,
  type DiscoveryOutcome,
} from "@/modules/connections";
import type { OutboxMessage } from "@/platform/outbox";

const uuid = (): string => randomUUID();
const WORKSPACE = parseWorkspaceId(uuid()) as WorkspaceId;
const ORGANIZATION = parseOrganizationId(uuid()) ?? (() => { throw new Error("uuid"); })();
const USER = parseUserId(uuid()) ?? (() => { throw new Error("uuid"); })();
const CORRELATION = parseCorrelationId(uuid()) as CorrelationId;
const OUTBOX_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const connection = (patch: Partial<Connection> = {}): Connection => ({
  id: uuid(),
  organizationId: ORGANIZATION,
  workspaceId: WORKSPACE,
  provider: "simulator",
  status: "ACTIVE",
  activeCredentialId: uuid(),
  authorizedBy: USER,
  authorizedAt: new Date(),
  lastSuccessAt: null,
  lastProblemCode: null,
  lastProblemAt: null,
  version: 3,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...patch,
});

const account = (connectionId: string, platform: "facebook" | "instagram", status: "ACTIVE" | "INACTIVE" = "ACTIVE"): ConnectedAccount => ({
  id: uuid(),
  organizationId: ORGANIZATION,
  workspaceId: WORKSPACE,
  connectionId,
  platform,
  providerAssetId: `${platform}_asset_${uuid().slice(0, 8)}`,
  assetClass: "content_bearing",
  status,
  activatedAt: new Date(),
  deactivatedAt: status === "ACTIVE" ? null : new Date(),
  deactivationReason: status === "ACTIVE" ? null : "UNLINKED",
  moveId: null,
});

// ── The reason and its key ───────────────────────────────────────────────────────────────────────────────────

describe("the credential evaluation reason", () => {
  it("keys each (account, replacement credential) once, inside the outbox key grammar, and names the credential as a subject", () => {
    const accountId = uuid();
    const credentialId = uuid();
    const key = capabilityEvaluationDispatchKey(accountId, { kind: "credential", credentialId });
    expect(key).toBe(`capability.evaluate_account:${accountId}:credential.${credentialId}`);
    expect(key).toHaveLength(112);
    expect(key).toMatch(OUTBOX_KEY);
    const message = capabilityEvaluationRequest({
      id: uuid(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, connectedAccountId: accountId,
      reason: { kind: "credential", credentialId }, correlationId: CORRELATION, initiator: { type: "system" }, createdAt: new Date(),
    });
    expect(message.subjectIds).toEqual({ connected_account_id: accountId, [CAPABILITY_EVALUATION_CREDENTIAL_SUBJECT]: credentialId });
    expect(CAPABILITY_EVALUATION_CREDENTIAL_SUBJECT).toBe("credential_id");
    expect(message.initiator).toEqual({ type: "system" });
  });

  it("different credentials of one account, or one credential of different accounts, are different authorities", () => {
    const [a, b, credentialA, credentialB] = [uuid(), uuid(), uuid(), uuid()];
    const keys = new Set([
      capabilityEvaluationDispatchKey(a, { kind: "credential", credentialId: credentialA }),
      capabilityEvaluationDispatchKey(a, { kind: "credential", credentialId: credentialB }),
      capabilityEvaluationDispatchKey(b, { kind: "credential", credentialId: credentialA }),
    ]);
    expect(keys.size).toBe(3);
    // Never the human recovery key, the activation key or the catalog key.
    expect([...keys].every((key) => /:credential\.[0-9a-f-]{36}$/.test(key))).toBe(true);
  });

  it("only a canonical UUID can name the credential (fail closed)", () => {
    for (const credentialId of ["", "not-a-uuid", "../x", `${uuid()}x`]) {
      expect(() => capabilityEvaluationDispatchKey(uuid(), { kind: "credential", credentialId }), credentialId).toThrow(TypeError);
    }
  });

  it("every other reason keeps its exact subjects (no credential subject)", () => {
    const accountId = uuid();
    for (const reason of [{ kind: "activation", activationId: uuid() }, { kind: "unrecorded" }, { kind: "catalog", catalogId: "platform", catalogRevision: 4 }, { kind: "reevaluation", eventId: uuid() }] as const) {
      const message = capabilityEvaluationRequest({ id: uuid(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, connectedAccountId: accountId, reason, correlationId: CORRELATION, initiator: { type: "system" }, createdAt: new Date() });
      expect(message.subjectIds, reason.kind).toEqual({ connected_account_id: accountId });
    }
  });
});

// ── The discovery continuation ───────────────────────────────────────────────────────────────────────────────

describe("the discovery continuation: typed, explicit, never inferred", () => {
  const base = { id: uuid(), organizationId: ORGANIZATION, workspaceId: WORKSPACE, connectionId: uuid(), correlationId: CORRELATION, initiator: { type: "user", userId: USER } as const, createdAt: new Date() };

  it("without a refresh, the discovery authority is exactly the pre-R1 one (topic, subjects, key)", () => {
    const credentialId = uuid();
    const message = discoveryRequest({ ...base, credentialId, capabilityRefresh: null });
    expect(message).toMatchObject({ topic: "connections.discover_assets", subjectIds: { connection_id: base.connectionId }, dispatchKey: `connections.discover_assets:${base.connectionId}:${credentialId}` });
    expect(Object.keys(message.subjectIds)).toEqual(["connection_id"]);
    expect(capabilityRefreshOf(message.subjectIds)).toBeNull();
  });

  it("with a refresh, it carries the validated credential as an identifier-only subject; the key is unchanged", () => {
    const credentialId = uuid();
    const message = discoveryRequest({ ...base, credentialId, capabilityRefresh: { kind: "credential", credentialId } });
    expect(message.subjectIds).toEqual({ connection_id: base.connectionId, [CAPABILITY_REFRESH_SUBJECT]: credentialId });
    expect(CAPABILITY_REFRESH_SUBJECT).toBe("capability_refresh_credential_id");
    expect(message.dispatchKey).toBe(`connections.discover_assets:${base.connectionId}:${credentialId}`);
    expect(capabilityRefreshOf(message.subjectIds)).toEqual({ kind: "credential", credentialId });
  });

  it("can never name a credential other than the one the discovery validates", () => {
    expect(() => discoveryRequest({ ...base, credentialId: uuid(), capabilityRefresh: { kind: "credential", credentialId: uuid() } })).toThrow(TypeError);
  });

  it("is read from the subject only — status, credential version or other subjects never imply it", () => {
    expect(capabilityRefreshOf({ connection_id: uuid() })).toBeNull();
    expect(capabilityRefreshOf({ connection_id: uuid(), credential_id: uuid() })).toBeNull();
    expect(capabilityRefreshOf({ connection_id: uuid(), connected_account_id: uuid() })).toBeNull();
  });
});

// ── The refresh a validated discovery performs ───────────────────────────────────────────────────────────────

interface Fakes {
  readonly store: ConnectionWorkerStore;
  readonly requested: OutboxMessage[];
  readonly listed: string[];
  setActive(credentialId: string): void;
}

/** A worker store fake: one connection, its accounts, an idempotent request primitive keyed like system.outbox. */
function fakes(current: Connection, accounts: readonly ConnectedAccount[], claimed = new Set<string>(), keys = new Set<string>()): Fakes {
  let stored = current;
  const requested: OutboxMessage[] = [];
  const listed: string[] = [];
  const store = {
    connections: {
      get: () => Promise.resolve(stored),
      update: (next: Connection) => {
        stored = next;
        return Promise.resolve(true);
      },
    },
    events: { append: () => Promise.resolve() },
    credentials: { load: (id: string) => Promise.resolve({ connectionId: stored.id, envelope: new Uint8Array([id.length]) }) },
    connectedAccounts: {
      listActiveForConnection: (connectionId: string) => {
        listed.push(connectionId);
        return Promise.resolve(accounts.filter((a) => a.connectionId === connectionId && a.status === "ACTIVE"));
      },
    },
    discoveredAssets: { upsert: () => Promise.resolve() },
    capabilityRequests: {
      requestOnce: (message: OutboxMessage) => {
        if (keys.has(message.dispatchKey)) return Promise.resolve("exists" as const);
        keys.add(message.dispatchKey);
        requested.push(message);
        return Promise.resolve("appended" as const);
      },
    },
    audit: { append: () => Promise.resolve() },
    claimEffect: (key: string) => {
      if (claimed.has(key)) return Promise.resolve("already_applied" as const);
      claimed.add(key);
      return Promise.resolve("claimed" as const);
    },
  } as unknown as ConnectionWorkerStore;
  return { store, requested, listed, setActive: (credentialId) => (stored = { ...stored, activeCredentialId: credentialId }) };
}

const ASSET: SocialAssetDto = { ref: { platform: "facebook", kind: "asset", id: "fb_page_synthetic" }, assetClass: "content_bearing", displayName: "Synthetic", relatedAssets: [], rawReference: { provider: "simulator", apiVersion: "simulator-v1", ref: "asset:fb_page_synthetic" } } as unknown as SocialAssetDto;

function discover(f: Fakes, refresh: CapabilityRefresh, read: Partial<ProviderReadPort> = {}, outboxId = uuid()): Promise<DiscoveryOutcome> {
  const port = { discoverAssets: () => Promise.resolve({ data: [ASSET], budget: { kind: "not_reported" } }), ...read } as unknown as ProviderReadPort;
  return discoverConnectionAssets(
    {
      inScope: (work) => work(f.store),
      access: { withCredential: (_input, use) => use(providerCredential("synthetic", "synthetic-token")) },
      providers: { read: () => port },
      clock: () => new Date(),
      newId: uuid,
    },
    { workspaceId: WORKSPACE, connectionId: "", outboxId, correlationId: CORRELATION, capabilityRefresh: refresh },
  );
}

describe("a discovery's capability refresh", () => {
  it("initial / ordinary discovery (no continuation): validated, ZERO requests, accounts never even listed", async () => {
    const c = connection();
    const f = fakes(c, [account(c.id, "facebook"), account(c.id, "instagram")]);
    const outcome = await discoverConnectionAssetsFor(f, c, null);
    expect(outcome).toMatchObject({ kind: "validated", capabilityRefresh: null });
    expect([f.requested, f.listed]).toEqual([[], []]);
  });

  it("re-authorization discovery, validated, credential still active: one request per ACTIVE account of the connection", async () => {
    const c = connection();
    const fb = account(c.id, "facebook");
    const ig = account(c.id, "instagram");
    const inactive = account(c.id, "facebook", "INACTIVE");
    const other = account(uuid(), "instagram");
    const f = fakes(c, [fb, ig, inactive, other]);
    const outcome = await discoverConnectionAssetsFor(f, c, { kind: "credential", credentialId: c.activeCredentialId ?? "" });
    expect(outcome).toMatchObject({ kind: "validated", capabilityRefresh: { kind: "requested", requested: 2, alreadyRequested: 0 } });
    expect(f.requested.map((m) => m.subjectIds["connected_account_id"]).sort()).toEqual([fb.id, ig.id].sort());
    for (const message of f.requested) {
      expect(message.topic).toBe("capability.evaluate_account");
      expect(message.dispatchKey).toBe(`capability.evaluate_account:${message.subjectIds["connected_account_id"] ?? ""}:credential.${c.activeCredentialId ?? ""}`);
      expect(message.subjectIds[CAPABILITY_EVALUATION_CREDENTIAL_SUBJECT]).toBe(c.activeCredentialId);
      expect(message.initiator).toEqual({ type: "system" });
    }
    expect(f.listed).toEqual([c.id]);
  });

  it("a second discovery authority for the SAME credential requests nothing new (deterministic keys): no storm", async () => {
    const c = connection();
    const keys = new Set<string>();
    const accounts = [account(c.id, "facebook"), account(c.id, "instagram")];
    const refresh = { kind: "credential", credentialId: c.activeCredentialId ?? "" } as const;
    await discoverConnectionAssetsFor(fakes(c, accounts, new Set(), keys), c, refresh);
    const again = fakes(c, accounts, new Set(), keys);
    expect(await discoverConnectionAssetsFor(again, c, refresh)).toMatchObject({ capabilityRefresh: { kind: "requested", requested: 0, alreadyRequested: 2 } });
    expect(again.requested).toEqual([]);
    expect(keys.size).toBe(2);
  });

  it("the same outbox row delivered twice is applied once (R6 claim): the refresh never runs twice", async () => {
    const c = connection();
    const claimed = new Set<string>();
    const f = fakes(c, [account(c.id, "facebook")], claimed);
    const outboxId = uuid();
    const refresh = { kind: "credential", credentialId: c.activeCredentialId ?? "" } as const;
    await discover(withConnection(f, c), refresh, {}, outboxId);
    expect(await discover(withConnection(f, c), refresh, {}, outboxId)).toEqual({ kind: "skipped", reason: "already_applied" });
    expect(f.requested).toHaveLength(1);
  });

  it("a replaced credential (another one became active) requests nothing: superseded", async () => {
    const c = connection();
    const f = fakes(c, [account(c.id, "facebook"), account(c.id, "instagram")]);
    const outcome = await discoverConnectionAssetsFor(f, c, { kind: "credential", credentialId: uuid() });
    expect(outcome).toMatchObject({ kind: "validated", capabilityRefresh: { kind: "superseded" } });
    expect([f.requested, f.listed]).toEqual([[], []]);
  });

  it("a non-validated re-authorization discovery (definite provider failure) requests nothing", async () => {
    const c = connection();
    const f = fakes(c, [account(c.id, "facebook")]);
    const { CredentialInvalidError } = await import("@/integrations/providers/contract");
    const outcome = await discover(withConnection(f, c), { kind: "credential", credentialId: c.activeCredentialId ?? "" }, { discoverAssets: () => Promise.reject(new CredentialInvalidError("discoverAssets", "revoked")) });
    expect(outcome).toMatchObject({ kind: "failed", problem: "CREDENTIAL_REVOKED" });
    expect(f.requested).toEqual([]);
  });
});

/** Runs a discovery of `c` through the fakes (the input's connection id is the fake's). */
function discoverConnectionAssetsFor(f: Fakes, c: Connection, refresh: CapabilityRefresh): Promise<DiscoveryOutcome> {
  return discover(withConnection(f, c), refresh);
}
function withConnection(f: Fakes, c: Connection): Fakes {
  const original = f.store;
  const store = { ...original, connectedAccounts: { ...original.connectedAccounts, listActiveForConnection: (id: string) => original.connectedAccounts.listActiveForConnection(id === "" ? c.id : id) } } as ConnectionWorkerStore;
  return { ...f, store };
}

// ── The worker's superseded-credential guard ─────────────────────────────────────────────────────────────────

describe("capability evaluation of a credential-bound request", () => {
  function evaluation(c: Connection) {
    const acct = account(c.id, "facebook");
    const load = vi.fn((credentialId: string) => Promise.resolve({ connectionId: c.id, envelope: new Uint8Array([credentialId.length]) }));
    const open = vi.fn((_input: unknown, use: (credential: ReturnType<typeof providerCredential>) => Promise<unknown>) => use(providerCredential("synthetic", "synthetic-token")));
    const describeAccount = vi.fn(() => Promise.resolve({ data: { asset: { platform: "simulator", kind: "asset", id: acct.providerAssetId }, assetClass: "content_bearing", displayName: "S", accountIdentity: null, grantedPermissions: ["sim.read_content"], linkedAdAccounts: [], describedAt: new Date().toISOString(), rawReference: { provider: "simulator", apiVersion: "simulator-v1", ref: "account:s" } }, budget: { kind: "not_reported" } }));
    const writes = vi.fn();
    const deps = {
      inScope: <T>(work: (stores: never) => Promise<T>) =>
        work({
          connections: { connectedAccounts: { get: () => Promise.resolve(acct) }, connections: { get: () => Promise.resolve(c) }, credentials: { load } },
          capability: { header: () => Promise.resolve(undefined), entries: () => Promise.resolve([]), write: (...args: unknown[]) => { writes(...args); return Promise.resolve({ kind: "applied", revision: 1 }); } },
        } as never),
      access: { withCredential: open as never },
      providers: { read: () => ({ describeAccount }) as unknown as ProviderReadPort },
      clock: () => new Date(),
      environment: { NODE_ENV: "test" },
    };
    return { acct, load, open, describeAccount, writes, deps };
  }

  it("a request whose credential is no longer active is superseded BEFORE anything is loaded, opened, read or written", async () => {
    const c = connection();
    const e = evaluation(c);
    const outcome = await refreshAccountCapabilities(e.deps, { workspaceId: WORKSPACE, connectedAccountId: e.acct.id, expectedCredentialId: uuid() });
    expect(outcome).toEqual({ kind: "skipped", reason: "superseded" });
    expect([e.load.mock.calls.length, e.open.mock.calls.length, e.describeAccount.mock.calls.length, e.writes.mock.calls.length]).toEqual([0, 0, 0, 0]);
  });

  it("a request whose credential IS still active evaluates through the normal path, with that credential", async () => {
    const c = connection();
    const e = evaluation(c);
    const outcome = await refreshAccountCapabilities(e.deps, { workspaceId: WORKSPACE, connectedAccountId: e.acct.id, expectedCredentialId: c.activeCredentialId ?? "" });
    expect(outcome.kind).toBe("evaluated");
    expect(e.load).toHaveBeenCalledWith(c.activeCredentialId);
    expect(e.describeAccount).toHaveBeenCalledTimes(1);
    expect(e.writes).toHaveBeenCalledTimes(1);
  });

  it("a request without a bound credential (every other reason) is unchanged", async () => {
    const c = connection();
    const e = evaluation(c);
    expect((await refreshAccountCapabilities(e.deps, { workspaceId: WORKSPACE, connectedAccountId: e.acct.id })).kind).toBe("evaluated");
  });
});
