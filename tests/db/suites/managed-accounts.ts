/**
 * Step 7G-H5 — managed accounts of one Meta connection, on the real database. Saving converges the workspace's
 * Connected Accounts of that connection to the checked set in ONE unit of work: activation reuses the asset's existing
 * row (identity and history kept), deactivation is INACTIVE (UNLINKED), never a delete. The connection is re-read FOR
 * UPDATE first, so saves of one connection serialize with each other and with Remove (which takes the same row lock
 * after K): the last committed save wins, and nothing activates under a REMOVED connection.
 *
 * Nothing here can reach Meta, KMS or a job: the pipeline is composed without any provider, sealer or secret, and the
 * save appends no outbox row. Concurrency is real: one transaction holds the row lock and pg_locks shows the other waiting.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { removeConnection, saveManagedSelection } from "@/modules/connections";
import { createPostgresConnectionStore } from "@/modules/connections/persistence";
import { withUserScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { createLogger, type Logger } from "@/platform/observability";
import { connectedAccountSelectionCommand } from "@/server/commands/connected-accounts";
import { REMOVE_ACKNOWLEDGEMENT, removeMeta, resolveConnectionSettings, saveManagedAccounts } from "@/server/connections/settings";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
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
    logger = createLogger({ sink: () => undefined, now: clock });
  });

  afterAll(async () => {
    await web.end();
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
      // No provider work was queued: not even the capability evaluation the single-account link enqueues.
      expect(await outbox(t.workspaceId)).toBe(0);
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
}
