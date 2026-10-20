/**
 * Step 7G-H5 — managed accounts of one Meta connection, on the real database. Saving converges the workspace's
 * Connected Accounts of that connection to the checked set in ONE unit of work: activation reuses the asset's existing
 * row (identity and history kept), deactivation is INACTIVE (UNLINKED), never a delete. The connection is re-read FOR
 * UPDATE first, so saves of one connection serialize with each other and with Remove (which takes the same row lock
 * after K): the last committed save wins, and nothing activates under a REMOVED connection.
 *
 * Nothing here can reach Meta, KMS or a job: the pipeline is composed without any provider, sealer or secret. Step
 * 7G-H5.5: each activation transition appends exactly one capability.evaluate_account request (identifiers only, keyed by
 * its LINKED event) in the save's own transaction; reconciliation requests evaluations for ACTIVE accounts whose profile
 * is missing or stale, converging on the same keys; and the availability resolver fails closed on lifecycle and
 * currency. Concurrency is real: one transaction holds the row lock and pg_locks shows the other waiting.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { PLATFORM_CATALOG, SIMULATOR_CATALOG, evaluateAndStore, type CapabilityCatalog, type FactsInput } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import { CAPABILITY_RECONCILE_MAX_BATCH, removeConnection, requestCapabilityReevaluations, saveManagedSelection } from "@/modules/connections";
import { createPostgresConnectionStore } from "@/modules/connections/persistence";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { createLogger, type Logger } from "@/platform/observability";
import { createCapabilityQueries } from "@/server/commands/capability";
import { connectedAccountSelectionCommand, createConnectedAccountCommands } from "@/server/commands/connected-accounts";
import { connectionRemoveCommand } from "@/server/commands/connections";
import { capabilityReconcileStores } from "@/server/persistence/connections";
import { REMOVE_ACKNOWLEDGEMENT, removeMeta, resolveConnectionSettings, saveManagedAccounts } from "@/server/connections/settings";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline, type UnitOfWork } from "@/server/pipeline";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly admin: string;
  readonly manager: string;
}

interface AccountRow {
  readonly id: string;
  readonly platform: string;
  readonly provider_asset_id: string;
  readonly status: string;
  readonly deactivation_reason: string | null;
}

const SAVED = { kind: "status", status: "accounts_saved" } as const;
const NOT_FOUND = { kind: "status", status: "accounts_not_found" } as const;
const NOT_READY = { kind: "status", status: "connection_not_ready" } as const;
const CONFLICT = { kind: "status", status: "accounts_conflict" } as const;

export function defineManagedAccountsSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let logger: Logger;
  const organizations: string[] = [];
  let clockMs = Date.now();
  const clock = (): Date => new Date((clockMs += 1));

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const countOf = async (query: string, values: readonly unknown[]): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const user = (id: string) => {
    const parsed = parseUserId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const ws = (id: string): WorkspaceId => {
    const parsed = parseWorkspaceId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const pipelineFor = (id: string, emailVerified = true): ActionPipeline =>
    createActionPipeline({
      identity: new FakeIdentity(emailVerified ? verifiedUser(user(id)) : { id: user(id), emailVerified: false }),
      unitOfWork: createPostgresUnitOfWork(web),
      clock,
      newId: randomUUID,
      logger,
    });
  const save = (id: string, workspaceId: string, connectionId: unknown, discoveredAssetIds: readonly unknown[], pipeline = pipelineFor(id)) =>
    saveManagedAccounts(pipeline, { workspaceId, connectionId, discoveredAssetIds });
  const scopeOf = (t: Tenant, id: string) => ({ workspaceId: ws(t.workspaceId), organizationId: t.organizationId as never, userId: user(id) });

  // ── Synthetic tenants and rows (privileged bootstrap) ────────────────────────────────────────────────────────
  const tenant = async (organizationId?: string): Promise<Tenant> => {
    const t: Tenant = { organizationId: organizationId ?? randomUUID(), workspaceId: randomUUID(), owner: randomUUID(), admin: randomUUID(), manager: randomUUID() };
    if (organizationId === undefined) {
      organizations.push(t.organizationId);
      await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Managed', now())", [t.organizationId]);
    }
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [t.workspaceId, t.organizationId]);
    for (const [member, orgRole, role] of [[t.owner, "OWNER", "OWNER"], [t.admin, "MEMBER", "ADMIN"], [t.manager, "MEMBER", "MANAGER"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [t.organizationId, member, orgRole]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [t.organizationId, t.workspaceId, member, role]);
    }
    return t;
  };
  /** A Connection in an exact status. No credential: nothing in H5 may need one. */
  const seedConnection = async (t: Tenant, status: string, provider = "meta"): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, null, $6, now(), 1, now(), now())`,
      [id, t.organizationId, t.workspaceId, provider, status, t.owner],
    );
    return id;
  };
  /** A persisted discovered asset of `connection` (what discover_assets would have written). */
  const seedAsset = async (t: Tenant, connection: string, platform: string, shape: { readonly assetClass?: string; readonly providerAssetId?: string } = {}): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())`,
      [id, t.organizationId, t.workspaceId, connection, platform, shape.providerAssetId ?? `${platform}-${randomUUID().slice(0, 12)}`, shape.assetClass ?? "content_bearing", `Synthetic ${platform}`],
    );
    return id;
  };
  /** The live fixture's shape: one ACTIVE Meta connection, one Facebook Page, one Instagram professional account, 0 managed. */
  const fixture = async () => {
    const t = await tenant();
    const connection = await seedConnection(t, "ACTIVE");
    const facebook = await seedAsset(t, connection, "facebook");
    const instagram = await seedAsset(t, connection, "instagram");
    return { t, connection, facebook, instagram };
  };

  // ── Oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  const accounts = (workspace: string) =>
    oracle<AccountRow>("select id, platform, provider_asset_id, status, deactivation_reason from connections.connected_accounts where workspace_id = $1 order by platform", [workspace]);
  const active = async (workspace: string) => (await accounts(workspace)).filter((row) => row.status === "ACTIVE").map((row) => row.platform);
  const audits = (workspace: string, action: string) => countOf("select count(*)::int as n from audit.audit_events where workspace_id = $1 and action = $2", [workspace, action]);
  const events = (workspace: string, type: string) => countOf("select count(*)::int as n from connections.connected_account_events where workspace_id = $1 and event_type = $2", [workspace, type]);
  const outbox = (workspace: string) => countOf("select count(*)::int as n from system.outbox where workspace_id = $1", [workspace]);
  const activeUnderRemoved = (workspace: string) =>
    countOf(
      `select count(*)::int as n from connections.connected_accounts a join connections.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
        where a.workspace_id = $1 and a.status = 'ACTIVE' and c.status = 'REMOVED'`,
      [workspace],
    );
  // ── Capability evaluation requests (Step 7G-H5.5) ─────────────────────────────────────────────────────────────
  const EVALUATE = "capability.evaluate_account";
  interface RequestRow {
    readonly subject_ids: Record<string, string>;
    readonly initiator_type: string;
    readonly initiator_user_id: string | null;
    readonly dispatch_key: string;
    readonly status: string;
    readonly organization_id: string;
  }
  const requests = (workspace: string) =>
    oracle<RequestRow>(
      "select subject_ids, initiator_type, initiator_user_id, dispatch_key, status, organization_id from system.outbox where workspace_id = $1 and topic = $2 order by dispatch_key",
      [workspace, EVALUATE],
    );
  const accountOf = async (workspace: string, platform: string): Promise<AccountRow> => {
    const row = (await accounts(workspace)).find((account) => account.platform === platform);
    if (row === undefined) throw new Error(`no ${platform} account`);
    return row;
  };
  /** The LINKED / MOVED_IN events of an account, oldest first: each is one activation. */
  const activations = async (account: string) =>
    (await oracle<{ id: string }>("select id from connections.connected_account_events where connected_account_id = $1 and event_type in ('LINKED', 'MOVED_IN') order by occurred_at, id", [account])).map(
      (row) => row.id,
    );
  const keyOf = (account: string, ref: string) => `${EVALUATE}:${account}:${ref}`;
  const reconcile = (t: Tenant, options: { readonly after?: string | null; readonly limit?: number } = {}) =>
    withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
      requestCapabilityReevaluations(capabilityReconcileStores({ tx, claimEffect: () => Promise.reject(new Error("unused")), noteOutbox: () => undefined }), {
        organizationId: t.organizationId,
        workspaceId: t.workspaceId,
        after: options.after ?? null,
        limit: options.limit ?? 50,
        correlationId: "corr-h55-reconcile",
        now: clock(),
        newId: randomUUID,
      }),
    );
  /** A profile written by the REAL evaluator in the worker scope (what capability.evaluate_account persists). */
  const writeProfile = (t: Tenant, account: AccountRow, catalog: CapabilityCatalog, facts: FactsInput) =>
    withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
      evaluateAndStore(createPostgresCapabilityStore(tx), {
        organizationId: t.organizationId,
        workspaceId: t.workspaceId,
        connectedAccountId: account.id,
        catalog,
        platform: account.platform as "facebook" | "instagram",
        assetClass: "content_bearing",
        facts,
        observations: [],
        evaluatedAt: clock(),
      }),
    );
  const NO_FACTS = (): FactsInput => ({ kind: "unavailable", observedAt: clock() });
  const PLATFORM_R1: CapabilityCatalog = { ...PLATFORM_CATALOG, revision: 1, label: "platform-catalog-r1" };
  /** An ACTIVE account inserted directly (no activation event): rows that predate the event history. */
  const seedActiveAccount = async (asset: string): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [id, asset],
    );
    return id;
  };
  const availability = async (t: Tenant, account: string, capability: string) => {
    const result = await pipelineFor(t.owner).run(createCapabilityQueries().availability, { workspaceId: t.workspaceId, input: { connectedAccountId: account, capability } });
    if (result.status !== "ok") throw new Error(`availability: ${result.status}`);
    return { state: result.value.state, reason: result.value.reason };
  };

  const managedView = async (t: Tenant) => {
    const state = await resolveConnectionSettings(pipelineFor(t.owner), t.workspaceId);
    if (state.kind !== "ready") throw new Error(`settings: ${state.kind}`);
    return Object.fromEntries(state.manageableAssets.map((asset) => [asset.platform, asset.managed]));
  };

  // ── Locks ────────────────────────────────────────────────────────────────────────────────────────────────────
  const waitForWaiters = async (n: number): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (((await oracle<{ n: number }>("select count(*)::int as n from pg_locks where not granted"))[0]?.n ?? -1) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`expected ${String(n)} waiting transaction(s)`);
  };
  /** Runs `first` in a web transaction held open until `second` is waiting on a lock, then commits it. */
  const holdWhile = async <T>(as: string, workspace: string, first: (tx: DatabaseTransaction) => Promise<unknown>, second: () => Promise<T>): Promise<T> => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let done: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => (done = resolve));
    const held = withUserScope(web, { sub: as, role: "authenticated" }, workspace, async (tx) => {
      await first(tx);
      done();
      await gate;
    });
    await firstDone;
    const racing = second();
    racing.catch(() => undefined);
    await waitForWaiters(1);
    release();
    await held;
    return racing;
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target, 4);
    web = runtimeDatabase(target, "web", 4);
    worker = runtimeDatabase(target, "worker", 4);
    logger = createLogger({ sink: () => undefined, now: clock });
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  describe("first use and the desired-state lifecycle", () => {
    it("the live fixture's shape shows both accounts unmanaged; reading creates nothing", async () => {
      const { t } = await fixture();
      expect(await managedView(t)).toEqual({ facebook: false, instagram: false });
      expect(await accounts(t.workspaceId)).toEqual([]);
      expect(await audits(t.workspaceId, "connected_account.linked")).toBe(0);
      expect(await outbox(t.workspaceId)).toBe(0);
    });

    it("Facebook only → Instagram only → both → repeat → one → none: rows keep their identity, every change is audited once", async () => {
      const { t, connection, facebook, instagram } = await fixture();

      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
      expect(await active(t.workspaceId)).toEqual(["facebook"]);
      expect(await managedView(t)).toEqual({ facebook: true, instagram: false });
      const [facebookRow] = await accounts(t.workspaceId);

      expect(await save(t.admin, t.workspaceId, connection, [instagram])).toEqual(SAVED);
      expect(await active(t.workspaceId)).toEqual(["instagram"]);
      expect((await accounts(t.workspaceId)).find((row) => row.platform === "facebook")).toEqual({ ...facebookRow, status: "INACTIVE", deactivation_reason: "UNLINKED" });

      expect(await save(t.owner, t.workspaceId, connection, [facebook, instagram])).toEqual(SAVED);
      const both = await accounts(t.workspaceId);
      expect(both.map((row) => [row.platform, row.status])).toEqual([["facebook", "ACTIVE"], ["instagram", "ACTIVE"]]);
      // Reactivation reuses the asset's row: no second logical account.
      expect(both.find((row) => row.platform === "facebook")?.id).toBe(facebookRow?.id);
      expect(await managedView(t)).toEqual({ facebook: true, instagram: true });

      const before = { linked: await audits(t.workspaceId, "connected_account.linked"), unlinked: await audits(t.workspaceId, "connected_account.unlinked") };
      expect(before).toEqual({ linked: 3, unlinked: 1 });
      const repeated = await pipelineFor(t.owner).run(connectedAccountSelectionCommand, {
        workspaceId: t.workspaceId,
        input: { connectionId: connection, expectedProvider: "meta", discoveredAssetIds: [instagram, facebook] },
      });
      expect(repeated).toMatchObject({ status: "ok", value: { activated: 0, deactivated: 0, managed: 2 } });
      expect(await accounts(t.workspaceId)).toEqual(both);
      expect(await audits(t.workspaceId, "connected_account.linked")).toBe(3);

      expect(await save(t.owner, t.workspaceId, connection, [instagram])).toEqual(SAVED);
      expect(await active(t.workspaceId)).toEqual(["instagram"]);
      expect(await save(t.owner, t.workspaceId, connection, [])).toEqual(SAVED);
      expect(await active(t.workspaceId)).toEqual([]);
      expect(await managedView(t)).toEqual({ facebook: false, instagram: false });
      // Deselection is a lifecycle transition, not a delete.
      expect((await accounts(t.workspaceId)).map((row) => [row.platform, row.status, row.deactivation_reason])).toEqual([
        ["facebook", "INACTIVE", "UNLINKED"],
        ["instagram", "INACTIVE", "UNLINKED"],
      ]);
      expect(await countOf("select count(*)::int as n from connections.connected_accounts where workspace_id = $1", [t.workspaceId])).toBe(2);

      expect({
        linked: await audits(t.workspaceId, "connected_account.linked"),
        unlinked: await audits(t.workspaceId, "connected_account.unlinked"),
        linkedEvents: await events(t.workspaceId, "LINKED"),
        unlinkedEvents: await events(t.workspaceId, "UNLINKED"),
      }).toEqual({ linked: 3, unlinked: 3, linkedEvents: 3, unlinkedEvents: 3 });
      // Attributed to the person, in this workspace, about connected accounts only.
      const attributed = await oracle<{ actor_type: string; actor_user_id: string; organization_id: string; target_type: string }>(
        "select actor_type, actor_user_id, organization_id, target_type from audit.audit_events where workspace_id = $1 and action like 'connected_account.%' order by occurred_at",
        [t.workspaceId],
      );
      expect(new Set(attributed.map((row) => `${row.actor_type}:${row.organization_id}:${row.target_type}`))).toEqual(new Set([`user:${t.organizationId}:connected_account`]));
      expect(new Set(attributed.map((row) => row.actor_user_id))).toEqual(new Set([t.owner, t.admin]));
      // Step 7G-H5.5: exactly one evaluation request per activation transition (3), none for a deactivation or a
      // retained account; nothing else was queued.
      expect(await outbox(t.workspaceId)).toBe(3);
      const expected: string[] = [];
      for (const account of await accounts(t.workspaceId)) for (const ref of await activations(account.id)) expected.push(keyOf(account.id, ref));
      expect(expected).toHaveLength(3);
      expect((await requests(t.workspaceId)).map((row) => row.dispatch_key)).toEqual(expected.sort());
    });

    it("a repeated id in the form is one choice; an all-unchecked first save is a valid no-op", async () => {
      const { t, connection, facebook } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [])).toEqual(SAVED);
      expect(await accounts(t.workspaceId)).toEqual([]);
      expect(await save(t.owner, t.workspaceId, connection, [facebook, facebook])).toEqual(SAVED);
      expect(await active(t.workspaceId)).toEqual(["facebook"]);
    });
  });

  describe("only this connection's persisted, supported assets; nothing is saved unless all of it is", () => {
    it("unknown, malformed, foreign-workspace, other-connection and unsupported ids refuse the whole save", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      const other = await tenant();
      const theirConnection = await seedConnection(other, "ACTIVE");
      const theirAsset = await seedAsset(other, theirConnection, "facebook");
      const sibling = await tenant(t.organizationId);
      const siblingConnection = await seedConnection(sibling, "ACTIVE");
      const siblingAsset = await seedAsset(sibling, siblingConnection, "instagram");
      const simulator = await seedConnection(t, "ACTIVE", "simulator");
      const simulatorAsset = await seedAsset(t, simulator, "facebook");
      const adAccount = await seedAsset(t, connection, "facebook", { assetClass: "ad_account" });
      const tiktok = await seedAsset(t, connection, "tiktok");

      for (const injected of [randomUUID(), theirAsset, siblingAsset, simulatorAsset, adAccount, tiktok, connection]) {
        expect(await save(t.owner, t.workspaceId, connection, [facebook, injected]), injected).toEqual(NOT_FOUND);
      }
      for (const malformed of ["", "not-a-uuid", facebook.toUpperCase(), null, 7]) {
        expect(await save(t.owner, t.workspaceId, connection, [facebook, malformed])).toEqual(NOT_FOUND);
      }
      expect(await save(t.owner, t.workspaceId, connection, Array.from({ length: 1001 }, () => randomUUID()))).toEqual(NOT_FOUND);
      expect(await accounts(t.workspaceId)).toEqual([]);
      expect(await accounts(other.workspaceId)).toEqual([]);
      expect(await accounts(sibling.workspaceId)).toEqual([]);
      expect(await audits(t.workspaceId, "connected_account.linked")).toBe(0);
      // Only this ACTIVE Meta connection's Facebook Page and Instagram account are offered at all.
      const state = await resolveConnectionSettings(pipelineFor(t.owner), t.workspaceId);
      expect(state.kind === "ready" ? state.manageableAssets.map((asset) => [asset.connectionId, asset.discoveredAssetId]).sort() : state).toEqual(
        [[connection, facebook], [connection, instagram]].sort(),
      );
    });

    it("the connection must be this workspace's ACTIVE Meta connection", async () => {
      const t = await tenant();
      const other = await tenant();
      const theirs = await seedConnection(other, "ACTIVE");
      const theirAsset = await seedAsset(other, theirs, "facebook");
      expect(await save(t.owner, t.workspaceId, theirs, [theirAsset])).toEqual(NOT_FOUND);
      expect(await save(t.owner, t.workspaceId, theirs, [])).toEqual(NOT_FOUND);
      expect(await save(t.owner, t.workspaceId, randomUUID(), [])).toEqual(NOT_FOUND);
      for (const malformed of ["", "not-a-uuid", theirs.toUpperCase(), undefined]) {
        expect(await save(t.owner, t.workspaceId, malformed, [])).toEqual({ kind: "status", status: "connection_not_found" });
      }
      const simulator = await seedConnection(t, "ACTIVE", "simulator");
      expect(await save(t.owner, t.workspaceId, simulator, [await seedAsset(t, simulator, "facebook")])).toEqual(NOT_FOUND);
      expect(await accounts(other.workspaceId)).toEqual([]);
      expect(await accounts(t.workspaceId)).toEqual([]);
    });

    it("a connection that isn't ACTIVE can't be saved, and offers nothing to manage", async () => {
      for (const status of ["CONNECTING", "DEGRADED", "FAILED", "DISCONNECTED", "REMOVED"]) {
        const t = await tenant();
        const connection = await seedConnection(t, status);
        const asset = await seedAsset(t, connection, "facebook");
        expect(await save(t.owner, t.workspaceId, connection, [asset]), status).toEqual(NOT_READY);
        expect(await save(t.owner, t.workspaceId, connection, []), status).toEqual(NOT_READY);
        expect(await accounts(t.workspaceId)).toEqual([]);
        expect(await managedView(t)).toEqual({});
      }
    });

    it("M-01: an account already managed in another workspace of the organization refuses the whole save", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      const sibling = await tenant(t.organizationId);
      const siblingConnection = await seedConnection(sibling, "ACTIVE");
      const providerAssetId = (await oracle<{ id: string }>("select provider_asset_id as id from connections.discovered_assets where id = $1", [instagram]))[0]?.id;
      if (providerAssetId === undefined) throw new Error("no asset");
      const siblingInstagram = await seedAsset(sibling, siblingConnection, "instagram", { providerAssetId });
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [t.organizationId, sibling.workspaceId, t.owner]);
      expect(await save(t.owner, sibling.workspaceId, siblingConnection, [siblingInstagram])).toEqual(SAVED);

      expect(await save(t.owner, t.workspaceId, connection, [facebook, instagram])).toEqual(CONFLICT);
      expect(await accounts(t.workspaceId)).toEqual([]);
      expect(await active(sibling.workspaceId)).toEqual(["instagram"]);
      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
    });
  });

  describe("authorization: the workspace's Owner/Admin only, server side and in RLS", () => {
    it("signed-out, unverified, Manager and outsider callers can neither read nor save; nothing changes", async () => {
      const { t, connection, facebook } = await fixture();
      const outsider = await tenant();
      const signedOut = createActionPipeline({ identity: new FakeIdentity(), unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger });
      expect(await save(t.owner, t.workspaceId, connection, [facebook], signedOut)).toEqual({ kind: "signed_out" });
      expect(await save(t.owner, t.workspaceId, connection, [facebook], pipelineFor(t.owner, false))).toEqual({ kind: "verification_required" });
      expect(await save(t.manager, t.workspaceId, connection, [facebook])).toEqual({ kind: "status", status: "not_allowed" });
      expect(await save(outsider.owner, t.workspaceId, connection, [facebook])).toEqual(NOT_FOUND);

      expect(await resolveConnectionSettings(signedOut, t.workspaceId)).toEqual({ kind: "signed_out" });
      expect(await resolveConnectionSettings(pipelineFor(t.manager), t.workspaceId)).toEqual({ kind: "not_allowed" });
      expect(await resolveConnectionSettings(pipelineFor(outsider.owner), t.workspaceId)).toEqual({ kind: "workspace_not_found" });
      expect(await accounts(t.workspaceId)).toEqual([]);
    });

    it("RLS alone stops a Manager's direct write, even past the pipeline", async () => {
      const { t, connection, facebook } = await fixture();
      const refused = await withUserScope(web, { sub: t.manager, role: "authenticated" }, t.workspaceId, (tx) =>
        saveManagedSelection(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.manager), connectionId: connection, expectedProvider: "meta", discoveredAssetIds: [facebook], now: clock(), newId: randomUUID }),
      ).then(
        () => "saved",
        () => "refused",
      );
      expect(refused).toBe("refused");
      expect(await accounts(t.workspaceId)).toEqual([]);
    });
  });

  describe("concurrency: one connection's saves serialize; the last committed wins; Remove is terminal", () => {
    it("two identical saves at once leave exactly one account per asset and one activation each", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      const results = await Promise.all([
        save(t.owner, t.workspaceId, connection, [facebook, instagram]),
        save(t.admin, t.workspaceId, connection, [instagram, facebook]),
        save(t.owner, t.workspaceId, connection, [facebook, instagram]),
      ]);
      expect(results).toEqual([SAVED, SAVED, SAVED]);
      expect((await accounts(t.workspaceId)).map((row) => [row.platform, row.status])).toEqual([["facebook", "ACTIVE"], ["instagram", "ACTIVE"]]);
      expect(await audits(t.workspaceId, "connected_account.linked")).toBe(2);
      expect(await events(t.workspaceId, "LINKED")).toBe(2);
    });

    it("overlapping tabs: the save that commits last decides the set (the earlier one is not merged in)", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      const second = await holdWhile(
        t.owner,
        t.workspaceId,
        (tx) => saveManagedSelection(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.owner), connectionId: connection, expectedProvider: "meta", discoveredAssetIds: [facebook], now: clock(), newId: randomUUID }),
        () => save(t.admin, t.workspaceId, connection, [instagram]),
      );
      expect(second).toEqual(SAVED);
      expect(await active(t.workspaceId)).toEqual(["instagram"]);
      expect((await accounts(t.workspaceId)).find((row) => row.platform === "facebook")).toMatchObject({ status: "INACTIVE", deactivation_reason: "UNLINKED" });
    });

    it("a stale tab after Remove can't resurrect an account", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
      expect(await removeMeta(pipelineFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection, acknowledgement: REMOVE_ACKNOWLEDGEMENT })).toEqual({ kind: "status", status: "removed" });
      expect(await save(t.admin, t.workspaceId, connection, [facebook, instagram])).toEqual(NOT_READY);
      expect(await save(t.admin, t.workspaceId, connection, [])).toEqual(NOT_READY);
      expect((await accounts(t.workspaceId)).map((row) => [row.platform, row.status, row.deactivation_reason])).toEqual([["facebook", "INACTIVE", "REMOVED"]]);
      expect(await activeUnderRemoved(t.workspaceId)).toBe(0);
    });

    it("Remove in flight first: the waiting save then sees REMOVED and saves nothing", async () => {
      const { t, connection, facebook } = await fixture();
      const saving = await holdWhile(
        t.owner,
        t.workspaceId,
        (tx) => removeConnection(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.owner), connectionId: connection, expectedProvider: "meta", now: clock(), newId: randomUUID }),
        () => save(t.admin, t.workspaceId, connection, [facebook]),
      );
      expect(saving).toEqual(NOT_READY);
      expect(await accounts(t.workspaceId)).toEqual([]);
    });

    it("a save in flight first: the waiting Remove then deactivates what it activated", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      const removing = await holdWhile(
        t.owner,
        t.workspaceId,
        (tx) => saveManagedSelection(createPostgresConnectionStore(tx), { scope: scopeOf(t, t.owner), connectionId: connection, expectedProvider: "meta", discoveredAssetIds: [facebook, instagram], now: clock(), newId: randomUUID }),
        () => removeMeta(pipelineFor(t.admin), { workspaceId: t.workspaceId, connectionId: connection, acknowledgement: REMOVE_ACKNOWLEDGEMENT }),
      );
      expect(removing).toEqual({ kind: "status", status: "removed" });
      expect((await accounts(t.workspaceId)).map((row) => [row.platform, row.status, row.deactivation_reason])).toEqual([
        ["facebook", "INACTIVE", "REMOVED"],
        ["instagram", "INACTIVE", "REMOVED"],
      ]);
      expect(await activeUnderRemoved(t.workspaceId)).toBe(0);
    });
  });

  describe("Step 7G-H5.5: activation requests exactly one capability evaluation, in the same transaction", () => {
    const requestShape = (t: Tenant, account: string, ref: string, user: string): RequestRow => ({
      subject_ids: { connected_account_id: account },
      initiator_type: "user",
      initiator_user_id: user,
      dispatch_key: keyOf(account, ref),
      status: "PENDING",
      organization_id: t.organizationId,
    });

    it("Facebook → one request; Instagram → one; both → two; identifiers only, keyed by the LINKED event", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
      const fb = await accountOf(t.workspaceId, "facebook");
      expect(await requests(t.workspaceId)).toEqual([requestShape(t, fb.id, (await activations(fb.id))[0] ?? "-", t.owner)]);

      const other = await fixture();
      expect(await save(other.t.admin, other.t.workspaceId, other.connection, [other.instagram])).toEqual(SAVED);
      const ig = await accountOf(other.t.workspaceId, "instagram");
      expect(await requests(other.t.workspaceId)).toEqual([requestShape(other.t, ig.id, (await activations(ig.id))[0] ?? "-", other.t.admin)]);

      const both = await fixture();
      expect(await save(both.t.owner, both.t.workspaceId, both.connection, [both.facebook, both.instagram])).toEqual(SAVED);
      expect(await requests(both.t.workspaceId)).toHaveLength(2);
      expect(new Set((await requests(both.t.workspaceId)).map((row) => row.subject_ids["connected_account_id"]))).toEqual(new Set((await accounts(both.t.workspaceId)).map((row) => row.id)));
      // Nothing but identifiers: no token, name, provider id or credential in the payload.
      for (const row of await requests(both.t.workspaceId)) expect(Object.keys(row.subject_ids)).toEqual(["connected_account_id"]);
      expect(instagram).not.toBe(facebook);
    });

    it("a repeated or concurrent identical save requests nothing more; a deselection requests nothing", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [facebook, instagram])).toEqual(SAVED);
      expect(await requests(t.workspaceId)).toHaveLength(2);
      for (let i = 0; i < 3; i += 1) expect(await save(t.owner, t.workspaceId, connection, [instagram, facebook])).toEqual(SAVED);
      expect(await Promise.all([save(t.owner, t.workspaceId, connection, [facebook, instagram]), save(t.admin, t.workspaceId, connection, [facebook, instagram])])).toEqual([SAVED, SAVED]);
      expect(await requests(t.workspaceId)).toHaveLength(2);
      expect(await save(t.owner, t.workspaceId, connection, [instagram])).toEqual(SAVED);
      expect(await save(t.owner, t.workspaceId, connection, [])).toEqual(SAVED);
      expect(await requests(t.workspaceId)).toHaveLength(2);
    });

    it("concurrent identical FIRST saves activate once and request once per account", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      expect(await Promise.all([1, 2, 3].map(() => save(t.owner, t.workspaceId, connection, [facebook, instagram])))).toEqual([SAVED, SAVED, SAVED]);
      expect(await requests(t.workspaceId)).toHaveLength(2);
      expect(await events(t.workspaceId, "LINKED")).toBe(2);
    });

    it("reactivating an INACTIVE account is a new activation: one new request under its new LINKED event", async () => {
      const { t, connection, facebook } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
      expect(await save(t.owner, t.workspaceId, connection, [])).toEqual(SAVED);
      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
      const fb = await accountOf(t.workspaceId, "facebook");
      const refs = await activations(fb.id);
      expect(refs).toHaveLength(2);
      expect((await requests(t.workspaceId)).map((row) => row.dispatch_key)).toEqual(refs.map((ref) => keyOf(fb.id, ref)).sort());
    });

    it("a refused save (foreign asset, non-ACTIVE connection, M-01 after a first activation) leaves neither accounts nor requests", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [facebook, randomUUID()])).toEqual(NOT_FOUND);
      const failed = await tenant();
      const failedConnection = await seedConnection(failed, "FAILED");
      expect(await save(failed.owner, failed.workspaceId, failedConnection, [await seedAsset(failed, failedConnection, "facebook")])).toEqual(NOT_READY);
      expect(await requests(failed.workspaceId)).toEqual([]);
      // M-01 refuses Instagram AFTER Facebook was activated in the same unit of work (key order): the whole unit
      // rolls back, and no request is ever written for a refused save.
      const sibling = await tenant(t.organizationId);
      const siblingConnection = await seedConnection(sibling, "ACTIVE");
      const providerAssetId = (await oracle<{ id: string }>("select provider_asset_id as id from connections.discovered_assets where id = $1", [instagram]))[0]?.id;
      if (providerAssetId === undefined) throw new Error("no asset");
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [t.organizationId, sibling.workspaceId, t.owner]);
      expect(await save(t.owner, sibling.workspaceId, siblingConnection, [await seedAsset(sibling, siblingConnection, "instagram", { providerAssetId })])).toEqual(SAVED);
      expect(await save(t.owner, t.workspaceId, connection, [facebook, instagram])).toEqual(CONFLICT);
      expect(await accounts(t.workspaceId)).toEqual([]);
      expect(await requests(t.workspaceId)).toEqual([]);
      expect(await outbox(t.workspaceId)).toBe(0);
    });

    it("a failure AFTER the requests were appended (the audit step) rolls back activations and requests together", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      const base = createPostgresUnitOfWork(web);
      const auditDown: UnitOfWork = { run: (scope, work) => base.run(scope, (tx) => work({ ...tx, audit: { append: () => Promise.reject(new Error("synthetic audit outage")) } })) };
      const pipeline = createActionPipeline({ identity: new FakeIdentity(verifiedUser(user(t.owner))), unitOfWork: auditDown, clock, newId: randomUUID, logger });
      // An unexpected failure propagates (the Server Action turns it into `unavailable`), after the unit rolled back.
      await expect(save(t.owner, t.workspaceId, connection, [facebook, instagram], pipeline)).rejects.toThrow("synthetic audit outage");
      expect(await accounts(t.workspaceId)).toEqual([]);
      expect(await requests(t.workspaceId)).toEqual([]);
      expect(await events(t.workspaceId, "LINKED")).toBe(0);
    });

    it("the single-account link shares the same request (key = its LINKED event)", async () => {
      const t = await tenant();
      const simulator = await seedConnection(t, "ACTIVE", "simulator");
      const asset = await seedAsset(t, simulator, "facebook");
      const linked = await pipelineFor(t.owner).run(createConnectedAccountCommands().link, { workspaceId: t.workspaceId, input: { discoveredAssetId: asset } });
      if (linked.status !== "ok" || linked.value.kind !== "linked") throw new Error("link failed");
      const account = linked.value.connectedAccountId;
      expect(await requests(t.workspaceId)).toEqual([requestShape(t, account, (await activations(account))[0] ?? "-", t.owner)]);
    });
  });

  describe("Step 7G-H5.5: reconciliation requests only what genuinely needs (re-)evaluation", () => {
    it("ACTIVE + no profile → requested once (an activation's own request is found, not duplicated); current → nothing; stale → once", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      // Activated through the product: its request already exists under the LINKED key.
      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
      const fb = await accountOf(t.workspaceId, "facebook");
      // An ACTIVE account that predates the event history (no activation event, never requested): the H5 situation.
      const legacy = await seedActiveAccount(instagram);

      const first = await reconcile(t);
      expect(first).toMatchObject({ scanned: 2, requested: [legacy], alreadyRequested: [fb.id], current: 0, skipped: 0, next: null });
      expect((await requests(t.workspaceId)).map((row) => row.dispatch_key)).toEqual([keyOf(fb.id, (await activations(fb.id))[0] ?? "-"), keyOf(legacy, "initial")].sort());
      expect((await requests(t.workspaceId)).find((row) => row.dispatch_key === keyOf(legacy, "initial"))).toMatchObject({ initiator_type: "system", initiator_user_id: null, subject_ids: { connected_account_id: legacy } });

      // Repeated: nothing new.
      expect(await reconcile(t)).toMatchObject({ requested: [], alreadyRequested: [fb.id, legacy].sort() });
      expect(await requests(t.workspaceId)).toHaveLength(2);

      // Evaluated on the current catalog → current; then a profile on revision 1 → stale → one request keyed by r2.
      await writeProfile(t, fb, PLATFORM_CATALOG, NO_FACTS());
      const legacyRow = { ...(await accountOf(t.workspaceId, "instagram")) };
      await writeProfile(t, legacyRow, PLATFORM_R1, NO_FACTS());
      expect(await reconcile(t)).toMatchObject({ requested: [legacy], alreadyRequested: [], current: 1 });
      expect((await requests(t.workspaceId)).map((row) => row.dispatch_key)).toContain(keyOf(legacy, `platform.r${String(PLATFORM_CATALOG.revision)}`));
      expect(await reconcile(t)).toMatchObject({ requested: [], alreadyRequested: [legacy], current: 1 });
      expect(await requests(t.workspaceId)).toHaveLength(3);
    });

    it("INACTIVE accounts (with or without an old profile) and accounts under a non-ACTIVE connection produce no work", async () => {
      const { t, connection, facebook, instagram } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [facebook, instagram])).toEqual(SAVED);
      await writeProfile(t, await accountOf(t.workspaceId, "facebook"), PLATFORM_R1, NO_FACTS());
      expect(await save(t.owner, t.workspaceId, connection, [])).toEqual(SAVED);
      const before = await requests(t.workspaceId);
      expect(await reconcile(t)).toMatchObject({ scanned: 0, requested: [], alreadyRequested: [] });

      const removed = await tenant();
      const removedConnection = await seedConnection(removed, "REMOVED");
      await seedActiveAccount(await seedAsset(removed, removedConnection, "facebook"));
      const degraded = await seedConnection(removed, "DEGRADED", "simulator");
      await seedActiveAccount(await seedAsset(removed, degraded, "facebook"));
      expect(await reconcile(removed)).toMatchObject({ scanned: 2, requested: [], alreadyRequested: [], skipped: 2 });
      expect(await requests(removed.workspaceId)).toEqual([]);
      expect(await requests(t.workspaceId)).toEqual(before);
    });

    it("concurrent reconcilers converge on one request per key", async () => {
      const { t, facebook, instagram } = await fixture();
      const a = await seedActiveAccount(facebook);
      const b = await seedActiveAccount(instagram);
      const outcomes = await Promise.all([reconcile(t), reconcile(t), reconcile(t)]);
      expect(outcomes.flatMap((outcome) => outcome.requested).sort()).toEqual([a, b].sort());
      expect(outcomes.flatMap((outcome) => outcome.alreadyRequested)).toHaveLength(4);
      expect((await requests(t.workspaceId)).map((row) => row.dispatch_key)).toEqual([keyOf(a, "initial"), keyOf(b, "initial")].sort());
    });

    it("bounded and resumable: at most `limit` per call, continued by `next`; the batch bound is fixed", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await seedActiveAccount(await seedAsset(t, connection, i % 2 === 0 ? "facebook" : "instagram")));
      const first = await reconcile(t, { limit: 2 });
      expect(first.scanned).toBe(2);
      expect(first.next).not.toBeNull();
      const second = await reconcile(t, { after: first.next, limit: 2 });
      const third = await reconcile(t, { after: second.next, limit: 2 });
      expect(third).toMatchObject({ scanned: 1, next: null });
      expect([...first.requested, ...second.requested, ...third.requested].sort()).toEqual(ids.sort());
      expect(CAPABILITY_RECONCILE_MAX_BATCH).toBe(200);
      expect((await reconcile(t, { limit: 10_000 })).scanned).toBe(5);
    });
  });

  describe("Step 7G-H5.5: downstream availability fails closed on lifecycle and currency", () => {
    it("Meta today: ACTIVE + no profile → PROFILE_NOT_EVALUATED; stale → PROFILE_STALE; current → still not validated", async () => {
      const { t, connection, facebook } = await fixture();
      expect(await save(t.owner, t.workspaceId, connection, [facebook])).toEqual(SAVED);
      const fb = await accountOf(t.workspaceId, "facebook");
      expect(await availability(t, fb.id, "read_content")).toEqual({ state: "UNAVAILABLE", reason: "PROFILE_NOT_EVALUATED" });
      await writeProfile(t, fb, PLATFORM_R1, NO_FACTS());
      expect(await availability(t, fb.id, "read_content")).toEqual({ state: "UNAVAILABLE", reason: "PROFILE_STALE" });
      await writeProfile(t, fb, PLATFORM_CATALOG, NO_FACTS());
      for (const capability of ["read_content", "read_interactions", "hide"]) {
        expect(await availability(t, fb.id, capability), capability).toEqual({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
      }
    });

    it("a supported read is available for that capability only; INACTIVE or REMOVED makes the old profile no authority", async () => {
      const t = await tenant();
      const simulator = await seedConnection(t, "ACTIVE", "simulator");
      const linked = await pipelineFor(t.owner).run(createConnectedAccountCommands().link, { workspaceId: t.workspaceId, input: { discoveredAssetId: await seedAsset(t, simulator, "facebook") } });
      if (linked.status !== "ok" || linked.value.kind !== "linked") throw new Error("link failed");
      const account = await accountOf(t.workspaceId, "facebook");
      const granted: FactsInput = { kind: "available", assetClass: "content_bearing", grantedPermissions: ["sim.read_content", "sim.read_interactions"], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: clock() };
      await writeProfile(t, account, SIMULATOR_CATALOG, granted);
      expect(await availability(t, account.id, "read_content")).toEqual({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED" });
      expect(await availability(t, account.id, "read_interactions")).toEqual({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED" });
      expect(await availability(t, account.id, "hide")).toEqual({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING" });
      expect(await availability(t, account.id, "detect_native_replies")).toEqual({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });

      const unlinked = await pipelineFor(t.owner).run(createConnectedAccountCommands().unlink, { workspaceId: t.workspaceId, input: { connectedAccountId: account.id } });
      expect(unlinked).toMatchObject({ status: "ok", value: { changed: true } });
      expect(await availability(t, account.id, "read_content")).toEqual({ state: "UNAVAILABLE", reason: "ACCOUNT_INACTIVE" });
      // The derived profile is kept (history), never deleted for convenience.
      expect(await countOf("select count(*)::int as n from capability.account_profiles where connected_account_id = $1", [account.id])).toBe(1);

      const relinked = await pipelineFor(t.owner).run(createConnectedAccountCommands().link, { workspaceId: t.workspaceId, input: { discoveredAssetId: (await oracle<{ id: string }>("select id from connections.discovered_assets where connection_id = $1", [simulator]))[0]?.id } });
      expect(relinked).toMatchObject({ status: "ok", value: { kind: "linked" } });
      const removed = await pipelineFor(t.owner).run(connectionRemoveCommand, { workspaceId: t.workspaceId, input: { connectionId: simulator, expectedProvider: undefined } });
      expect(removed).toMatchObject({ status: "ok", value: { changed: true } });
      expect(await availability(t, account.id, "read_content")).toEqual({ state: "UNAVAILABLE", reason: "ACCOUNT_INACTIVE" });
      // Even an ACTIVE row under a REMOVED connection (never produced by the product) is no authority.
      await privileged.query("update connections.connected_accounts set status = 'ACTIVE', deactivated_at = null, deactivation_reason = null where id = $1", [account.id]);
      expect(await availability(t, account.id, "read_content")).toEqual({ state: "UNAVAILABLE", reason: "CONNECTION_REMOVED" });
    });
  });
}
