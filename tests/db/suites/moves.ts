/**
 * Step 5F — Connected Account linking, M-01, the TEMPORARY TA-Q-02 restriction and the Move saga on the real
 * database (migration 0010): the real action pipeline and PostgreSQL unit of work for the web steps, the real tenant
 * job wrapper (worker login → app_worker + sealed workspace) for the saga steps, and the real outbox delivery
 * (relay, dispatch sweeper, R7 run-outcome sweeper) against the FakeJobRuntime for durability. Connections and
 * discovered assets are bootstrapped synthetically (privileged); no provider is called. Synthetic data only.
 *
 *   linking     Owner/Admin, ACTIVE connection, locally discovered asset; reactivation; idempotent; unlink frees the slot
 *   M-01        one active content asset per organization; presentation identified only to readers of the source
 *   TA-Q-02     ad accounts: a DISTINCT index and closed reason, never M-01's
 *   Move        request → release → activate | reject; authority re-checks; failures; retry; idempotency; two
 *               destinations; one workspace per transaction; routing and audit through the 0010 definers only
 *   security    locate / route / authority / audit definers: exact callers, sealed context, no oracle, no forgery
 *   R7          crash after the source release, before dispatch → sweepers redeliver → activation exactly once
 *   Step 5G     G1 trace-only correlation · G2 owner-only organization read · G3 per-attempt activation effects ·
 *               G4 generic destination rejection · G5 post-commit wake-up vs sweeper recovery · G6 no direct saga
 *               outbox rows · G7 the list query · G8 convergence on an account already active in the destination
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { MOVE_REASON_CODES, releaseSource, requestMove } from "@/modules/connections";
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import { createPostgresConnectionStore, createPostgresConnectionWorkerStore } from "@/modules/connections/persistence";
import { claimEffect, createPostgresOutbox, withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { runTenantJob, type TenantJobContext } from "@/platform/jobs";
import { DEFAULT_DELIVERY_CONFIG, relayPass, sweepDispatch, sweepRunOutcomes, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger } from "@/platform/observability";
import { createConnectedAccountCommands } from "@/server/commands/connected-accounts";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline } from "@/server/pipeline";
import { runActivateDestination, runRejectDestination, runReleaseSource } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { errorCode, expectOk } from "../../support/harness";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";
import { quietPendingOutbox, sqlState } from "./helpers";

const RELEASE = "connections.move.release_source";
const ACTIVATE = "connections.move.activate_destination";
const REJECT = "connections.move.reject_destination";
const EVALUATE = "capability.evaluate_account";

interface OutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly organization_id: string;
  readonly workspace_id: string;
  readonly subject_ids: Record<string, string>;
  readonly correlation_id: string;
  readonly initiator_type: "user" | "policy" | "system";
  readonly initiator_user_id: string | null;
  readonly dispatch_key: string;
  readonly status: string;
}

const STEP_HANDLERS: Readonly<Record<string, (context: TenantJobContext) => Promise<unknown>>> = {
  [RELEASE]: runReleaseSource,
  [ACTIVATE]: runActivateDestination,
  [REJECT]: runRejectDestination,
};

export function defineMovesSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let world: World;
  let A3: string;
  /** mover: Org A MEMBER, ADMIN of A1, A2, A3 · destAdmin: Org A MEMBER, ADMIN of A2 only. */
  const extra = { mover: randomUUID(), destAdmin: randomUUID() };
  const connections: Record<string, string> = {};
  const identity = new FakeIdentity();
  const logLines: string[] = [];
  let clockMs = Date.now();
  const clock = (): Date => new Date((clockMs += 1));
  const logger = createLogger({ sink: (line) => logLines.push(line), now: clock });
  const commands = createConnectedAccountCommands();
  let pipeline: ReturnType<typeof createActionPipeline>;

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const ws = (id: string): WorkspaceId => parseWorkspaceId(id) ?? (() => { throw new Error("uuid"); })();
  const as = (user: string): void => {
    const id = parseUserId(user);
    if (id === undefined) throw new Error("uuid");
    identity.user = verifiedUser(id, `user-${user.slice(0, 8)}@example.test`);
  };
  const orgOf = (workspace: string): string => (workspace === world.B1 ? world.orgB : world.orgA);
  const ownerOf = (workspace: string): string => (workspace === world.B1 ? world.users.ownerB : world.users.ownerA);
  const assetName = (): string => `sim_asset_${randomUUID().slice(0, 12)}`;

  /** Bootstrap (privileged, synthetic): a Connection of `workspace` in `status`. */
  const newConnection = async (workspace: string, status = "ACTIVE"): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'simulator', $4, $5, now(), 1, now(), now())`,
      [id, orgOf(workspace), workspace, status, ownerOf(workspace)],
    );
    return id;
  };
  /** Bootstrap (privileged, synthetic): an asset discovered by `workspace`'s connection. Returns the discovered asset id. */
  const discover = async (workspace: string, providerAssetId: string, assetClass: "content_bearing" | "ad_account" = "content_bearing", connection = connections[workspace]): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, $6, 'Synthetic asset', now(), now(), now())`,
      [id, orgOf(workspace), workspace, connection, providerAssetId, assetClass],
    );
    return id;
  };

  const link = (workspace: string, discoveredAssetId: string) => pipeline.run(commands.link, { workspaceId: workspace, input: { discoveredAssetId } });
  const unlink = (workspace: string, connectedAccountId: string) => pipeline.run(commands.unlink, { workspaceId: workspace, input: { connectedAccountId } });
  const request = (workspace: string, discoveredAssetId: string) => pipeline.run(commands.requestMove, { workspaceId: workspace, input: { discoveredAssetId } });
  const retry = (workspace: string, moveId: string) => pipeline.run(commands.retry, { workspaceId: workspace, input: { moveId } });

  /** An asset ACTIVE in `source` (linked through the real command) and discovered by `destinations` too. */
  const activeIn = async (source: string, destinations: readonly string[], assetClass: "content_bearing" | "ad_account" = "content_bearing") => {
    const name = assetName();
    const sourceAsset = await discover(source, name, assetClass);
    as(ownerOf(source));
    const linked = expectOk(await link(source, sourceAsset));
    if (linked.kind !== "linked") throw new Error("not linked");
    const discovered: Record<string, string> = {};
    for (const destination of destinations) discovered[destination] = await discover(destination, name, assetClass);
    return { name, sourceAccount: linked.connectedAccountId, discovered };
  };
  const requested = async (destination: string, discoveredAssetId: string, user = world.users.ownerA): Promise<string> => {
    as(user);
    const output = expectOk(await request(destination, discoveredAssetId));
    if (output.kind !== "requested") throw new Error(`not requested: ${output.kind}`);
    return output.moveId;
  };

  const accounts = (providerAssetId: string) =>
    oracle<{ id: string; workspace_id: string; status: string; deactivation_reason: string | null; move_id: string | null }>(
      "select id, workspace_id, status, deactivation_reason, move_id from connections.connected_accounts where provider_asset_id = $1 order by created_at, id", [providerAssetId]);
  const activeAccounts = async (providerAssetId: string) => (await accounts(providerAssetId)).filter((row) => row.status === "ACTIVE");
  const moveSides = (moveId: string) =>
    oracle<{ workspace_id: string; side: string; status: string; reason_code: string | null; counterpart_workspace_id: string; connected_account_id: string | null; initiator_user_id: string }>(
      "select workspace_id, side, status, reason_code, counterpart_workspace_id, connected_account_id, initiator_user_id from connections.asset_moves where move_id = $1 order by side", [moveId]);
  const side = async (moveId: string, which: "INCOMING" | "OUTGOING") => (await moveSides(moveId)).find((row) => row.side === which);
  const audits = (targetId: string) =>
    oracle<{ action: string; actor_type: string; actor_user_id: string | null; workspace_id: string; organization_id: string; outcome: string; target_type: string }>(
      "select action, actor_type, actor_user_id, workspace_id, organization_id, outcome, target_type from audit.audit_events where target_id = $1 order by recorded_at, action", [targetId]);
  const accountEvents = (accountId: string) =>
    oracle<{ event_type: string; reason_code: string; actor_type: string; actor_user_id: string | null; move_id: string | null }>(
      "select event_type, reason_code, actor_type, actor_user_id, move_id from connections.connected_account_events where connected_account_id = $1 order by occurred_at, id", [accountId]);
  /**
   * The move's outbox rows in saga order, independent of clocks (the web test clock and the job runtime's clock differ,
   * by seconds over a remote pooler): the release first, then the routed step rows (deterministic key
   * `<topic>:<move>`), then human retry attempts (key `<topic>:<move>:<attempt>`) in creation order.
   */
  const outboxOf = (moveId: string) =>
    oracle<OutboxRow>(
      `select id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status
         from system.outbox where subject_ids->>'move_id' = $1
        order by case when topic = '${RELEASE}' then 0 when dispatch_key = topic || ':' || $1 then 1 else 2 end, created_at, id`, [moveId]);
  const evaluations = (accountId: string) =>
    oracle<OutboxRow>(
      `select id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status
         from system.outbox where topic = $2 and subject_ids->>'connected_account_id' = $1`, [accountId, EVALUATE]);

  const payloadOf = (row: OutboxRow) => ({
    v: 1,
    scope: "workspace",
    task: row.topic,
    workspaceId: row.workspace_id,
    outboxId: row.id,
    subjectIds: row.subject_ids,
    correlationId: row.correlation_id,
    initiator: row.initiator_type === "user" ? { type: "user", userId: row.initiator_user_id } : { type: row.initiator_type },
  });
  const runRow = (row: OutboxRow, runId = `run_${randomUUID()}`) => {
    const handler = STEP_HANDLERS[row.topic];
    if (handler === undefined) throw new Error(`no handler for ${row.topic}`);
    return runTenantJob({ registry: PRODUCTION_TASKS, worker, logger }, row.topic, payloadOf(row), { runId, attempt: 1 }, handler) as Promise<{ readonly kind: string; readonly reason?: string }>;
  };
  /** Runs the single (latest) outbox row of `topic` for this move. */
  const step = async (moveId: string, topic: string) => {
    const rows = (await outboxOf(moveId)).filter((row) => row.topic === topic);
    const row = rows.at(-1);
    if (row === undefined) throw new Error(`no ${topic} row`);
    return runRow(row);
  };
  /** Release, then whatever the source routed (activation or rejection). */
  const drive = async (moveId: string) => {
    const release = await step(moveId, RELEASE);
    const next = await step(moveId, release.kind === "released" ? ACTIVATE : REJECT);
    return { release, next };
  };
  const setRole = (workspace: string, user: string, role: string) =>
    privileged.query("update tenancy.workspace_memberships set role = $3 where workspace_id = $1 and user_id = $2", [workspace, user, role]);

  // Direct runtime-role access for the security tests.
  const asWeb = <T>(user: string, workspace: string | undefined, work: (tx: DatabaseTransaction) => Promise<T>) => withUserScope(web, { sub: user, role: "authenticated" }, workspace, work);
  const asWorker = <T>(workspace: string, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, workspace, work);
  const asUnboundWorker = <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
    worker.db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_worker`);
      return work(tx);
    });
  const asSystem = <T>(work: (tx: DatabaseTransaction) => Promise<T>) => withSystemScope(system, work);
  const route = (tx: DatabaseTransaction, moveId: string, stepName: string, correlation = "corr-test-route-0001") =>
    tx.execute<{ routed: boolean; outbox_id: string | null }>(sql`select routed, outbox_id from connections.route_move_step(${moveId}::uuid, ${stepName}, ${correlation}, now())`);
  const NOT_ROUTED = { routed: false, outbox_id: null };
  const recordAudit = (tx: DatabaseTransaction, moveId: string, stepName: string) =>
    tx.execute(sql`select connections.record_move_audit(${moveId}::uuid, ${stepName}, 'corr-test-audit-0001')`);
  const canManage = (tx: DatabaseTransaction, moveId: string) =>
    tx.execute<{ allowed: boolean }>(sql`select connections.move_initiator_can_manage(${moveId}::uuid) as allowed`);
  const locate = (tx: DatabaseTransaction, discoveredAssetId: string) =>
    tx.execute<Record<string, string>>(sql`select * from connections.locate_active_link(${discoveredAssetId}::uuid)`);

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 3);
    worker = runtimeDatabase(target, "worker", 3);
    system = runtimeDatabase(target, "system", 1);
    world = await seedWorld(privileged);
    A3 = randomUUID();
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'A3', 'MONITOR_ONLY', now())", [A3, world.orgA]);
    await privileged.query("insert into tenancy.workspace_memberships (organization_id, workspace_id, user_id, role, grants, created_at) values ($1, $2, $3, 'OWNER', '{}', now())", [world.orgA, A3, world.users.ownerA]);
    for (const user of [extra.mover, extra.destAdmin]) {
      await privileged.query("insert into tenancy.organization_memberships (organization_id, user_id, role, created_at) values ($1, $2, 'MEMBER', now())", [world.orgA, user]);
    }
    const memberships: [string, string][] = [[world.A1, extra.mover], [world.A2, extra.mover], [A3, extra.mover], [world.A2, extra.destAdmin]];
    for (const [workspace, user] of memberships) {
      await privileged.query("insert into tenancy.workspace_memberships (organization_id, workspace_id, user_id, role, grants, created_at) values ($1, $2, $3, 'ADMIN', '{}', now())", [world.orgA, workspace, user]);
    }
    for (const workspace of [world.A1, world.A2, A3, world.B1]) connections[workspace] = await newConnection(workspace);
    pipeline = createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger });
  });

  beforeEach(() => {
    clockMs = Date.now();
    as(world.users.ownerA);
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.query("delete from idempotency.effect_keys where workspace_id = any($1::uuid[])", [[world.A1, world.A2, A3, world.B1]]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
  });

  // ── Linking ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe("linking and unlinking", () => {
    it("links a locally discovered asset: ACTIVE row, LINKED history and audit by the user, capability evaluation enqueued (IDs only); idempotent", async () => {
      const name = assetName();
      const discovered = await discover(world.A1, name);
      const linked = expectOk(await link(world.A1, discovered));
      expect(linked.kind).toBe("linked");
      const id = linked.kind === "active_elsewhere" ? "" : linked.connectedAccountId;
      expect(await accounts(name)).toEqual([{ id, workspace_id: world.A1, status: "ACTIVE", deactivation_reason: null, move_id: null }]);
      expect(await accountEvents(id)).toEqual([{ event_type: "LINKED", reason_code: "USER_LINKED", actor_type: "user", actor_user_id: world.users.ownerA, move_id: null }]);
      expect(await audits(id)).toEqual([
        { action: "connected_account.linked", actor_type: "user", actor_user_id: world.users.ownerA, workspace_id: world.A1, organization_id: world.orgA, outcome: "succeeded", target_type: "connected_account" },
      ]);
      const [evaluation, ...others] = await evaluations(id);
      expect(others).toEqual([]);
      expect(evaluation).toMatchObject({ workspace_id: world.A1, subject_ids: { connected_account_id: id }, initiator_type: "user", initiator_user_id: world.users.ownerA, status: "PENDING" });

      // Idempotent: nothing new is written.
      expect(expectOk(await link(world.A1, discovered))).toEqual({ kind: "already_linked", connectedAccountId: id });
      expect(await accounts(name)).toHaveLength(1);
      expect(await accountEvents(id)).toHaveLength(1);
      expect(await audits(id)).toHaveLength(1);
      expect(await evaluations(id)).toHaveLength(1);
    });

    it("requires Owner/Admin, the workspace's own discovered asset, and an ACTIVE connection", async () => {
      const name = assetName();
      const discovered = await discover(world.A1, name);
      for (const user of [world.users.a1, world.users.a12, world.users.guest]) {
        as(user);
        expect(errorCode(await link(world.A1, discovered))).toMatch(/PERMISSION_DENIED|NOT_FOUND/);
      }
      as(world.users.ownerA);
      // Another workspace's discovered asset id is simply not found (no existence oracle).
      expect(errorCode(await link(world.A2, discovered))).toBe("NOT_FOUND");
      const degraded = await newConnection(world.A1, "DEGRADED");
      const throughDegraded = await discover(world.A1, assetName(), "content_bearing", degraded);
      expect(errorCode(await link(world.A1, throughDegraded))).toBe("CONNECTION_PROBLEM");
      expect(await accounts(name)).toEqual([]);
    });

    it("unlinks ACTIVE → INACTIVE (UNLINKED) with history and audit, idempotently, without touching credentials or data, and frees the slot", async () => {
      const name = assetName();
      const discovered = await discover(world.A1, name);
      const linked = expectOk(await link(world.A1, discovered));
      const id = linked.kind === "active_elsewhere" ? "" : linked.connectedAccountId;
      const before = await oracle<{ active_credential_id: string | null; version: number }>("select active_credential_id, version from connections.connections where id = $1", [connections[world.A1]]);

      expect(expectOk(await unlink(world.A1, id))).toEqual({ changed: true });
      expect(expectOk(await unlink(world.A1, id))).toEqual({ changed: false });
      expect(await accounts(name)).toEqual([{ id, workspace_id: world.A1, status: "INACTIVE", deactivation_reason: "UNLINKED", move_id: null }]);
      expect((await accountEvents(id)).map((e) => [e.event_type, e.reason_code, e.actor_type])).toEqual([["LINKED", "USER_LINKED", "user"], ["UNLINKED", "USER_UNLINKED", "user"]]);
      expect((await audits(id)).map((a) => a.action)).toEqual(["connected_account.linked", "connected_account.unlinked"]);
      expect(await oracle("select active_credential_id, version from connections.connections where id = $1", [connections[world.A1]])).toEqual(before);
      expect(await oracle("select id from connections.discovered_assets where id = $1", [discovered])).toHaveLength(1);

      // The slot is free: another workspace of the organization can link the same asset now.
      const elsewhere = await discover(world.A2, name);
      expect(expectOk(await link(world.A2, elsewhere)).kind).toBe("linked");
      // …and re-linking here is refused by M-01 again, while the INACTIVE row stays.
      expect(expectOk(await link(world.A1, discovered)).kind).toBe("active_elsewhere");
    });

    it("re-linking reactivates the workspace's existing INACTIVE row (same id), with new LINKED history", async () => {
      const name = assetName();
      const discovered = await discover(world.A1, name);
      const first = expectOk(await link(world.A1, discovered));
      const id = first.kind === "active_elsewhere" ? "" : first.connectedAccountId;
      expectOk(await unlink(world.A1, id));
      expect(expectOk(await link(world.A1, discovered))).toEqual({ kind: "linked", connectedAccountId: id });
      expect(await accounts(name)).toEqual([{ id, workspace_id: world.A1, status: "ACTIVE", deactivation_reason: null, move_id: null }]);
      expect((await accountEvents(id)).map((e) => e.event_type)).toEqual(["LINKED", "UNLINKED", "LINKED"]);
    });

    it("the list query shows identifiers, dimensions and status to non-guest members only", async () => {
      as(world.users.a1);
      expect(expectOk(await pipeline.run(commands.list, { workspaceId: world.A1, input: {} })).length).toBeGreaterThan(0);
      as(world.users.guest);
      expect(errorCode(await pipeline.run(commands.list, { workspaceId: world.A1, input: {} }))).toBe("PERMISSION_DENIED");
    });
  });

  // ── M-01 and TA-Q-02 ───────────────────────────────────────────────────────────────────────────────────────
  describe("M-01 (content assets) and the TEMPORARY TA-Q-02 ad-account restriction", () => {
    it("M-01: active in A1 → linking in A2 is refused; identified to a reader of A1, generic to anyone else; nothing written", async () => {
      const { name, discovered } = await activeIn(world.A1, [world.A2]);
      const target = discovered[world.A2] ?? "";
      as(world.users.ownerA);
      expect(expectOk(await link(world.A2, target))).toEqual({ kind: "active_elsewhere", rule: "M-01", location: { kind: "identified", workspaceId: world.A1, workspaceName: "A1" } });
      as(extra.destAdmin); // Admin of A2, no membership in A1
      expect(expectOk(await link(world.A2, target))).toEqual({ kind: "active_elsewhere", rule: "M-01", location: { kind: "organization" } });
      expect((await accounts(name)).map((row) => row.workspace_id)).toEqual([world.A1]);
    });

    it("M-01 is per organization: the same provider asset active in Organization B neither conflicts nor leaks", async () => {
      const name = assetName();
      const inB = await discover(world.B1, name);
      as(world.users.ownerB);
      expect(expectOk(await link(world.B1, inB)).kind).toBe("linked");
      const inA = await discover(world.A2, name);
      as(world.users.ownerA);
      const located = await asWeb(world.users.ownerA, world.A2, (tx) => locate(tx, inA));
      expect(located.rows).toEqual([]);
      expect(expectOk(await link(world.A2, inA)).kind).toBe("linked");
      expect((await activeAccounts(name)).map((row) => row.workspace_id).sort()).toEqual([world.A2, world.B1].sort());
    });

    it("TA-Q-02: an ad account active in A1 is refused in A2 with the TA-Q-02 rule, by its own index, never as M-01", async () => {
      const { name, discovered } = await activeIn(world.A1, [world.A2], "ad_account");
      as(world.users.ownerA);
      expect(expectOk(await link(world.A2, discovered[world.A2] ?? ""))).toMatchObject({ kind: "active_elsewhere", rule: "TA-Q-02" });
      // The database itself refuses through the separately named TA-Q-02 index (a direct insert bypassing the service).
      const refused = await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => tx.execute(sql`insert into connections.connected_accounts
        (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
        values (${randomUUID()}, ${world.orgA}, ${world.A2}, ${connections[world.A2]}, 'facebook', ${name}, 'ad_account', 'ACTIVE', now(), now(), now())`)));
      expect(refused).toEqual({ code: "23505", constraint: "connected_accounts_taq02_tmp_ad_account_single_workspace" });
    });

    it.each([
      ["content_bearing", "M-01"],
      ["ad_account", "TA-Q-02"],
    ] as const)("the database is the final arbiter of concurrent activations (%s → %s, mapped from the refusing index inside a savepoint)", async (assetClass, rule) => {
      const name = assetName();
      await discover(world.A2, name, assetClass);
      await discover(A3, name, assetClass);
      const activation = (workspace: string) => ({
        newId: randomUUID(),
        reactivateId: null,
        organizationId: world.orgA as never,
        workspaceId: ws(workspace),
        connectionId: connections[workspace] ?? "",
        platform: "facebook" as const,
        providerAssetId: name,
        assetClass,
        now: new Date(),
      });
      let open!: () => void;
      let inserted!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const firstInserted = new Promise<void>((resolve) => (inserted = resolve));
      const first = asWeb(world.users.ownerA, world.A2, async (tx) => {
        const outcome = await createPostgresConnectionStore(tx).connectedAccounts.activate(activation(world.A2));
        inserted(); // the uncommitted ACTIVE row now holds the unique-index slot
        await gate;
        return outcome;
      });
      await firstInserted;
      const second = asWeb(world.users.ownerA, A3, async (tx) => {
        const outcome = await createPostgresConnectionStore(tx).connectedAccounts.activate(activation(A3));
        // The refusal was contained in the savepoint: the transaction is still usable.
        await tx.execute(sql`select 1`);
        return outcome;
      });
      // Whether the second insert is already waiting on the index or arrives after the commit, it is refused.
      await new Promise((resolve) => setTimeout(resolve, 300));
      open();
      const [won, lost] = await Promise.all([first, second]);
      expect(won.kind).toBe("activated");
      expect(lost).toEqual({ kind: "conflict", rule });
      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([world.A2]);
    });

    it("two concurrent link commands for one asset: exactly one ACTIVE row, the other explained", async () => {
      const name = assetName();
      const d2 = await discover(world.A2, name);
      const d3 = await discover(A3, name);
      as(world.users.ownerA);
      const results = (await Promise.all([link(world.A2, d2), link(A3, d3)])).map((result) => expectOk(result).kind);
      expect(results.sort()).toEqual(["active_elsewhere", "linked"]);
      expect(await activeAccounts(name)).toHaveLength(1);
    });
  });

  // ── The Move saga ──────────────────────────────────────────────────────────────────────────────────────────
  describe("Move: happy path", () => {
    it("request (A2) → release (A1) → activate (A2): one workspace per transaction, human-attributed audit, IDs-only routing", async () => {
      const { name, sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");

      // Request: only the destination's incoming row exists; release routed to the SOURCE workspace.
      expect(await moveSides(moveId)).toEqual([
        { workspace_id: world.A2, side: "INCOMING", status: "REQUESTED", reason_code: null, counterpart_workspace_id: world.A1, connected_account_id: null, initiator_user_id: world.users.ownerA },
      ]);
      expect(await audits(moveId)).toEqual([
        { action: "connected_account.move_requested", actor_type: "user", actor_user_id: world.users.ownerA, workspace_id: world.A2, organization_id: world.orgA, outcome: "succeeded", target_type: "asset_move" },
      ]);
      const [release] = await outboxOf(moveId);
      expect(release).toMatchObject({
        topic: RELEASE,
        workspace_id: world.A1,
        organization_id: world.orgA,
        subject_ids: { move_id: moveId, connected_account_id: sourceAccount, counterpart_workspace_id: world.A2 },
        initiator_type: "user",
        initiator_user_id: world.users.ownerA,
        dispatch_key: `${RELEASE}:${moveId}`,
        status: "PENDING",
      });

      const { release: released, next } = await drive(moveId);
      expect(released).toEqual({ kind: "released" });
      expect(next).toMatchObject({ kind: "completed", evaluationEnqueued: true, converged: false });

      const rows = await accounts(name);
      const destination = rows.find((row) => row.workspace_id === world.A2);
      expect(rows.find((row) => row.workspace_id === world.A1)).toEqual({ id: sourceAccount, workspace_id: world.A1, status: "INACTIVE", deactivation_reason: "MOVED", move_id: moveId });
      expect(destination).toMatchObject({ status: "ACTIVE", deactivation_reason: null });
      expect(await moveSides(moveId)).toEqual([
        { workspace_id: world.A2, side: "INCOMING", status: "COMPLETED", reason_code: null, counterpart_workspace_id: world.A1, connected_account_id: destination?.id, initiator_user_id: world.users.ownerA },
        { workspace_id: world.A1, side: "OUTGOING", status: "RELEASED", reason_code: null, counterpart_workspace_id: world.A2, connected_account_id: sourceAccount, initiator_user_id: world.users.ownerA },
      ]);
      expect((await accountEvents(sourceAccount)).at(-1)).toEqual({ event_type: "MOVED_OUT", reason_code: "MOVE", actor_type: "system", actor_user_id: null, move_id: moveId });
      expect(await accountEvents(destination?.id ?? "")).toEqual([{ event_type: "MOVED_IN", reason_code: "MOVE", actor_type: "system", actor_user_id: null, move_id: moveId }]);
      // Audit: always the human initiator, each in its own workspace.
      expect((await audits(moveId)).map((a) => [a.action, a.actor_type, a.actor_user_id, a.workspace_id, a.outcome])).toEqual([
        ["connected_account.move_requested", "user", world.users.ownerA, world.A2, "succeeded"],
        ["connected_account.moved_out", "user", world.users.ownerA, world.A1, "succeeded"],
        ["connected_account.moved_in", "user", world.users.ownerA, world.A2, "succeeded"],
      ]);
      const routed = await outboxOf(moveId);
      expect(routed.map((row) => [row.topic, row.workspace_id, row.dispatch_key])).toEqual([
        [RELEASE, world.A1, `${RELEASE}:${moveId}`],
        [ACTIVATE, world.A2, `${ACTIVATE}:${moveId}`],
      ]);
      for (const row of routed) {
        expect(Object.keys(row.subject_ids).every((key) => ["move_id", "connected_account_id", "counterpart_workspace_id"].includes(key))).toBe(true);
      }
      // Capability evaluation is enqueued in the destination for the new account (no profile copied).
      expect(await evaluations(destination?.id ?? "")).toEqual([expect.objectContaining({ workspace_id: world.A2, initiator_type: "system", subject_ids: { connected_account_id: destination?.id } })]);
      expect(await oracle("select 1 from capability.account_profiles where connected_account_id = $1", [destination?.id])).toEqual([]);
    });

    it("a duplicate request reuses the move: one incoming row, one routed release, one audit", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const first = await requested(world.A2, discovered[world.A2] ?? "");
      as(world.users.ownerA);
      expect(expectOk(await request(world.A2, discovered[world.A2] ?? ""))).toEqual({ kind: "requested", moveId: first, reused: true });
      expect(await moveSides(first)).toHaveLength(1);
      expect(await outboxOf(first)).toHaveLength(1);
      expect(await audits(first)).toHaveLength(1);
    });

    it("nothing to move when the asset isn't active elsewhere; already here when it is active in the destination", async () => {
      const name = assetName();
      const d2 = await discover(world.A2, name);
      as(world.users.ownerA);
      expect(expectOk(await request(world.A2, d2))).toEqual({ kind: "not_active_elsewhere" });
      const linked = expectOk(await link(world.A2, d2));
      expect(expectOk(await request(world.A2, d2))).toEqual({ kind: "already_here", connectedAccountId: linked.kind === "active_elsewhere" ? "" : linked.connectedAccountId });
    });

    it("the requester must be Owner/Admin of the source too (own membership, read live); nothing is written otherwise", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      as(extra.destAdmin);
      expect(errorCode(await request(world.A2, discovered[world.A2] ?? ""))).toBe("PERMISSION_DENIED");
      expect(await oracle("select 1 from connections.asset_moves where workspace_id = $1 and initiator_user_id = $2", [world.A2, extra.destAdmin])).toEqual([]);
    });
  });

  describe("Move: authority, source state and activation failures", () => {
    it("authority lost in the SOURCE before release: nothing is released, both sides REJECTED (AUTHORITY_REVOKED), audited as the initiator", async () => {
      const { name, sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "", extra.mover);
      await setRole(world.A1, extra.mover, "MANAGER");
      try {
        const { release, next } = await drive(moveId);
        expect(release).toEqual({ kind: "rejected", reason: "AUTHORITY_REVOKED" });
        expect(next).toEqual({ kind: "rejected", reason: "SOURCE_RELEASE_REJECTED" });
      } finally {
        await setRole(world.A1, extra.mover, "ADMIN");
      }
      expect(await activeAccounts(name)).toEqual([expect.objectContaining({ id: sourceAccount, workspace_id: world.A1 })]);
      // G4: the precise reason stays on the SOURCE side; the destination only learns the generic, closed outcome.
      expect((await moveSides(moveId)).map((row) => [row.side, row.status, row.reason_code])).toEqual([["INCOMING", "REJECTED", "SOURCE_RELEASE_REJECTED"], ["OUTGOING", "REJECTED", "AUTHORITY_REVOKED"]]);
      expect((await audits(moveId)).map((a) => [a.action, a.actor_user_id, a.workspace_id, a.outcome])).toEqual([
        ["connected_account.move_requested", extra.mover, world.A2, "succeeded"],
        ["connected_account.move_rejected", extra.mover, world.A1, "failed"],
        ["connected_account.move_rejected", extra.mover, world.A2, "failed"],
      ]);
      expect((await accountEvents(sourceAccount)).map((e) => e.event_type)).toEqual(["LINKED"]);
    });

    it("source no longer active at release (unlinked meanwhile): SOURCE_NOT_ACTIVE in the source, the generic outcome in the destination", async () => {
      const { sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expectOk(await unlink(world.A1, sourceAccount));
      const { release, next } = await drive(moveId);
      expect(release).toEqual({ kind: "rejected", reason: "SOURCE_NOT_ACTIVE" });
      expect(next).toEqual({ kind: "rejected", reason: "SOURCE_RELEASE_REJECTED" });
      expect((await moveSides(moveId)).map((row) => [row.side, row.reason_code])).toEqual([["INCOMING", "SOURCE_RELEASE_REJECTED"], ["OUTGOING", "SOURCE_NOT_ACTIVE"]]);
    });

    it("authority lost in the DESTINATION before activation: ACTIVATION_FAILED, source NOT reactivated; a human retry completes the same move", async () => {
      const { name, sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "", extra.mover);
      expect(await step(moveId, RELEASE)).toEqual({ kind: "released" });
      await setRole(world.A2, extra.mover, "MANAGER");
      try {
        expect(await step(moveId, ACTIVATE)).toEqual({ kind: "failed", reason: "AUTHORITY_REVOKED" });
      } finally {
        await setRole(world.A2, extra.mover, "ADMIN");
      }
      expect(await activeAccounts(name)).toEqual([]);
      expect(await accounts(name)).toEqual([expect.objectContaining({ id: sourceAccount, status: "INACTIVE", deactivation_reason: "MOVED" })]);
      expect(await side(moveId, "INCOMING")).toMatchObject({ status: "ACTIVATION_FAILED", reason_code: "AUTHORITY_REVOKED" });
      expect((await audits(moveId)).at(-1)).toMatchObject({ action: "connected_account.move_failed", actor_user_id: extra.mover, workspace_id: world.A2, outcome: "failed" });

      // Human retry (another Owner/Admin of the destination): same move, fresh local activation, no source restoration.
      as(world.users.ownerA);
      expect(expectOk(await retry(world.A2, moveId))).toEqual({ moveId });
      expect(await side(moveId, "INCOMING")).toMatchObject({ status: "REQUESTED", reason_code: null });
      const activations = (await outboxOf(moveId)).filter((row) => row.topic === ACTIVATE);
      expect(activations).toHaveLength(2);
      expect(activations[1]).toMatchObject({ workspace_id: world.A2, initiator_user_id: world.users.ownerA });
      expect(await step(moveId, ACTIVATE)).toMatchObject({ kind: "completed" });
      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([world.A2]);
      expect(await audits(moveId)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "connected_account.moved_in", actor_user_id: extra.mover })]));
      // Retrying a COMPLETED move is refused.
      expect(errorCode(await retry(world.A2, moveId))).toBe("STALE_STATE");
    });

    it("destination connection unhealthy at activation → DESTINATION_CONNECTION_UNHEALTHY", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect(await step(moveId, RELEASE)).toEqual({ kind: "released" });
      await privileged.query("update connections.connections set status = 'DEGRADED' where id = $1", [connections[world.A2]]);
      try {
        expect(await step(moveId, ACTIVATE)).toEqual({ kind: "failed", reason: "DESTINATION_CONNECTION_UNHEALTHY" });
      } finally {
        await privileged.query("update connections.connections set status = 'ACTIVE' where id = $1", [connections[world.A2]]);
      }
    });

    it.each([
      ["content_bearing", "ASSET_ACTIVE_ELSEWHERE"],
      ["ad_account", "AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION"],
    ] as const)("linked into a third workspace between release and activation (%s) → ACTIVATION_FAILED %s", async (assetClass, reason) => {
      const { name, discovered } = await activeIn(world.A1, [world.A2, A3], assetClass);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect(await step(moveId, RELEASE)).toEqual({ kind: "released" });
      as(world.users.ownerA);
      expect(expectOk(await link(A3, discovered[A3] ?? "")).kind).toBe("linked");
      expect(await step(moveId, ACTIVATE)).toEqual({ kind: "failed", reason });
      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([A3]);
    });

    it("the asset no longer discovered by the destination connection → ASSET_NOT_DISCOVERED", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect(await step(moveId, RELEASE)).toEqual({ kind: "released" });
      await privileged.query("delete from connections.discovered_assets where id = $1", [discovered[world.A2]]);
      expect(await step(moveId, ACTIVATE)).toEqual({ kind: "failed", reason: "ASSET_NOT_DISCOVERED" });
    });
  });

  describe("Move: idempotency and concurrency", () => {
    it("redelivered steps apply once: effect keys, state guards, one event and one audit per step", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      const [releaseRow] = await outboxOf(moveId);
      if (releaseRow === undefined) throw new Error("no release");
      expect(await runRow(releaseRow)).toEqual({ kind: "released" });
      expect(await runRow(releaseRow)).toEqual({ kind: "skipped", reason: "already_applied" });
      const activation = (await outboxOf(moveId)).find((row) => row.topic === ACTIVATE);
      if (activation === undefined) throw new Error("no activation");
      expect(await runRow(activation)).toMatchObject({ kind: "completed" });
      expect(await runRow(activation)).toEqual({ kind: "skipped", reason: "already_applied" });
      // A forged second activation row for a completed move changes nothing (state guard).
      expect(await runRow({ ...activation, id: randomUUID() })).toEqual({ kind: "skipped", reason: "not_pending" });
      expect((await audits(moveId)).map((a) => a.action)).toEqual(["connected_account.move_requested", "connected_account.moved_out", "connected_account.moved_in"]);
      expect((await outboxOf(moveId)).map((row) => row.topic)).toEqual([RELEASE, ACTIVATE]);
    });

    it("two destinations request the same asset: the source releases exactly once (row lock), the other is rejected; one ACTIVE account", async () => {
      const { name, discovered } = await activeIn(world.A1, [world.A2, A3]);
      const toA2 = await requested(world.A2, discovered[world.A2] ?? "");
      const toA3 = await requested(A3, discovered[A3] ?? "");
      const [first, second] = await Promise.all([step(toA2, RELEASE), step(toA3, RELEASE)]);
      expect([first.kind, second.kind].sort()).toEqual(["rejected", "released"]);
      const winner = first.kind === "released" ? toA2 : toA3;
      const loser = winner === toA2 ? toA3 : toA2;
      expect([first, second].find((outcome) => outcome.kind === "rejected")).toEqual({ kind: "rejected", reason: "SOURCE_NOT_ACTIVE" });
      expect(await step(winner, ACTIVATE)).toMatchObject({ kind: "completed" });
      expect(await step(loser, REJECT)).toEqual({ kind: "rejected", reason: "SOURCE_RELEASE_REJECTED" });
      expect(await activeAccounts(name)).toEqual([expect.objectContaining({ workspace_id: winner === toA2 ? world.A2 : A3 })]);
    });
  });

  describe("Move: transaction boundaries", () => {
    it("the request's incoming row, audit and routed release commit together or not at all", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = randomUUID();
      await expect(
        asWeb(world.users.ownerA, world.A2, async (tx) => {
          const store = createPostgresConnectionStore(tx);
          await requestMove(store, {
            scope: { workspaceId: ws(world.A2), organizationId: world.orgA as never, userId: world.users.ownerA as never },
            discoveredAssetId: discovered[world.A2] ?? "",
            canManageSource: () => Promise.resolve(true),
            correlationId: "corr-test-boundary-01" as never,
            now: new Date(),
            newId: () => moveId,
          });
          expect(await outboxOf(moveId)).toEqual([]); // not visible outside the transaction yet
          throw new Error("abort after routing");
        }),
      ).rejects.toThrow("abort after routing");
      expect(await moveSides(moveId)).toEqual([]);
      expect(await outboxOf(moveId)).toEqual([]);
    });

    it("the source release (deactivation, outgoing row, MOVED_OUT, audit, routed activation) rolls back as one", async () => {
      const { name, sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      await expect(
        asWorker(world.A1, async (tx) => {
          const store = createPostgresConnectionWorkerStore(tx, {
            audit: createPostgresAuditLog(tx),
            outbox: createPostgresOutbox(tx),
            claimEffect: (key) => claimEffect(tx, { workspaceId: world.A1, effectKey: key, task: RELEASE }),
          });
          const outcome = await releaseSource(store, {
            workspaceId: ws(world.A1),
            moveId,
            outboxId: randomUUID(),
            correlationId: "corr-test-boundary-02" as never,
            now: new Date(),
            newId: randomUUID,
            connectedAccountId: sourceAccount,
            destinationWorkspaceId: ws(world.A2),
            initiator: world.users.ownerA as never,
          });
          expect(outcome).toEqual({ kind: "released" });
          throw new Error("crash before commit");
        }),
      ).rejects.toThrow("crash before commit");
      expect(await activeAccounts(name)).toEqual([expect.objectContaining({ id: sourceAccount })]);
      expect(await side(moveId, "OUTGOING")).toBeUndefined();
      expect((await outboxOf(moveId)).map((row) => row.topic)).toEqual([RELEASE]);
      expect((await audits(moveId)).map((a) => a.action)).toEqual(["connected_account.move_requested"]);
      // …and the real step still applies afterwards (the rolled-back effect key didn't stick).
      expect(await step(moveId, RELEASE)).toEqual({ kind: "released" });
    });
  });

  // ── Security of the 0010 definers ──────────────────────────────────────────────────────────────────────────
  describe("locate_active_link: same organization, Owner/Admin or worker, at most (workspace, account)", () => {
    it("returns exactly two identifier columns; not found and foreign/other-organization assets are indistinguishable (empty)", async () => {
      const { sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const located = await asWeb(world.users.ownerA, world.A2, (tx) => locate(tx, discovered[world.A2] ?? ""));
      expect(located.rows).toEqual([{ active_workspace_id: world.A1, active_connected_account_id: sourceAccount }]);
      expect(Object.keys(located.rows[0] ?? {})).toHaveLength(2);
      // The A2 discovered-asset id presented in A3 (another workspace's row): empty, exactly like a random id.
      expect((await asWeb(world.users.ownerA, A3, (tx) => locate(tx, discovered[world.A2] ?? ""))).rows).toEqual([]);
      expect((await asWeb(world.users.ownerA, A3, (tx) => locate(tx, randomUUID()))).rows).toEqual([]);
      expect((await asWorker(world.A2, (tx) => locate(tx, discovered[world.A2] ?? ""))).rows).toHaveLength(1);
    });

    it("refuses non-managers, missing context and the system role", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      expect((await sqlState(asWeb(world.users.a12, world.A2, (tx) => locate(tx, discovered[world.A2] ?? "")))).code).toBe("42501");
      expect((await sqlState(asWeb(world.users.ownerA, undefined, (tx) => locate(tx, discovered[world.A2] ?? "")))).code).toBe("42501");
      expect((await sqlState(asUnboundWorker((tx) => locate(tx, discovered[world.A2] ?? "")))).code).toBe("42501");
      expect((await sqlState(asSystem((tx) => locate(tx, discovered[world.A2] ?? "")))).code).toBe("42501");
    });

    it("generic RLS is unchanged: web and worker still see no connected account of another workspace", async () => {
      await activeIn(world.A1, [world.A2]);
      const count = (tx: DatabaseTransaction) => tx.execute<{ n: number }>(sql`select count(*)::int as n from connections.connected_accounts where workspace_id = ${world.A1}`);
      expect((await asWeb(world.users.ownerA, world.A2, count)).rows[0]?.n).toBe(0);
      expect((await asWorker(world.A2, count)).rows[0]?.n).toBe(0);
      expect((await asWeb(world.users.ownerA, world.A2, (tx) => tx.execute(sql`select count(*)::int as n from connections.asset_moves where workspace_id <> ${world.A2}`))).rows[0]).toEqual({ n: 0 });
      // No runtime role can assume the owner role whose policies admit the definers.
      expect((await sqlState(asWorker(world.A2, (tx) => tx.execute(sql`set local role app_owner`)))).code).toBe("42501");
      expect((await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => tx.execute(sql`set local role app_owner`)))).code).toBe("42501");
    });
  });

  describe("route_move_step: closed transitions, derived counterpart, exact callers", () => {
    it("refuses the wrong runtime per step, unknown steps, missing context and the system role", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect((await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => route(tx, moveId, "activate_destination")))).code).toBe("42501");
      expect((await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => route(tx, moveId, "reject_destination")))).code).toBe("42501");
      expect((await sqlState(asWorker(world.A2, (tx) => route(tx, moveId, "release_source")))).code).toBe("42501");
      expect((await sqlState(asWorker(world.A2, (tx) => route(tx, moveId, "retry_activation")))).code).toBe("42501");
      expect((await sqlState(asWorker(world.A2, (tx) => route(tx, moveId, "restore_source")))).code).toBe("22023");
      expect((await sqlState(asUnboundWorker((tx) => route(tx, moveId, "activate_destination")))).code).toBe("42501");
      expect((await sqlState(asSystem((tx) => route(tx, moveId, "activate_destination")))).code).toBe("42501");
      expect((await outboxOf(moveId)).map((row) => row.topic)).toEqual([RELEASE]);
    });

    it("only the initiator, Owner/Admin of the destination, routes the release; another workspace's or another state's move routes nothing", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect((await sqlState(asWeb(extra.destAdmin, world.A2, (tx) => route(tx, moveId, "release_source")))).code).toBe("42501");
      // Bound to a workspace that holds no side of this move: nothing to route (the counterpart is never caller-supplied).
      expect((await asWeb(world.users.ownerA, A3, (tx) => route(tx, moveId, "release_source"))).rows[0]).toEqual(NOT_ROUTED);
      expect((await asWorker(A3, (tx) => route(tx, moveId, "activate_destination"))).rows[0]).toEqual(NOT_ROUTED);
      expect((await asWorker(world.B1, (tx) => route(tx, moveId, "activate_destination"))).rows[0]).toEqual(NOT_ROUTED);
      // The source has no OUTGOING row yet: neither transition is available there.
      expect((await asWorker(world.A1, (tx) => route(tx, moveId, "activate_destination"))).rows[0]).toEqual(NOT_ROUTED);
      // Re-routing the same step is idempotent (deterministic dispatch key): still one row.
      expect((await asWeb(world.users.ownerA, world.A2, (tx) => route(tx, moveId, "release_source"))).rows[0]).toEqual({ routed: true, outbox_id: null });
      expect(await outboxOf(moveId)).toHaveLength(1);
      await drive(moveId);
      // RELEASED source: reject is not a valid transition from it.
      expect((await asWorker(world.A1, (tx) => route(tx, moveId, "reject_destination"))).rows[0]).toEqual(NOT_ROUTED);
      expect((await outboxOf(moveId)).map((row) => row.topic)).toEqual([RELEASE, ACTIVATE]);
    });

    it("direct outbox inserts for another workspace stay refused for web and worker (no generic organization-level insert)", async () => {
      const insert = (tx: DatabaseTransaction, initiatorType: string, initiatorUser: string | null) =>
        tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
          values (${randomUUID()}, ${RELEASE}, ${world.orgA}, ${world.A1}, ${JSON.stringify({ move_id: randomUUID() })}::jsonb, 'corr-test-forge-0001', ${initiatorType}, ${initiatorUser}, ${`forged:${randomUUID()}`}, 'PENDING', now())`);
      expect((await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => insert(tx, "user", world.users.ownerA)))).code).toBe("42501");
      expect((await sqlState(asWorker(world.A2, (tx) => insert(tx, "system", null)))).code).toBe("42501");
      expect((await sqlState(asWorker(world.A2, (tx) => insert(tx, "user", world.users.ownerA)))).code).toBe("42501");
    });
  });

  describe("move_initiator_can_manage: worker only, local move only, boolean only", () => {
    it("answers for the bound workspace's own move and nothing else", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "", extra.mover);
      expect((await asWorker(world.A2, (tx) => canManage(tx, moveId))).rows).toEqual([{ allowed: true }]);
      expect((await asWorker(A3, (tx) => canManage(tx, moveId))).rows).toEqual([{ allowed: false }]);
      expect((await asWorker(world.B1, (tx) => canManage(tx, moveId))).rows).toEqual([{ allowed: false }]);
      await setRole(world.A2, extra.mover, "MANAGER");
      try {
        expect((await asWorker(world.A2, (tx) => canManage(tx, moveId))).rows).toEqual([{ allowed: false }]);
      } finally {
        await setRole(world.A2, extra.mover, "ADMIN");
      }
      expect((await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => canManage(tx, moveId)))).code).toBe("42501");
      expect((await sqlState(asUnboundWorker((tx) => canManage(tx, moveId)))).code).toBe("42501");
      expect((await sqlState(asSystem((tx) => canManage(tx, moveId)))).code).toBe("42501");
    });
  });

  describe("record_move_audit: the human initiator, the local move, the closed step", () => {
    it("the worker still cannot append a user-attributed audit row directly", async () => {
      const forged = (tx: DatabaseTransaction) =>
        tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id, target_type, target_id, correlation_id, outcome)
          values (${randomUUID()}, now(), 'connected_account.moved_out', 'user', ${world.users.ownerA}, ${world.orgA}, ${world.A1}, 'asset_move', ${randomUUID()}, 'corr-test-forge-0002', 'succeeded')`);
      expect((await sqlState(asWorker(world.A1, forged))).code).toBe("42501");
    });

    it("web, system and unbound callers cannot execute; foreign moves, invalid steps, wrong sides and wrong states are refused", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect((await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => recordAudit(tx, moveId, "move_rejected")))).code).toBe("42501");
      expect((await sqlState(asSystem((tx) => recordAudit(tx, moveId, "move_rejected")))).code).toBe("42501");
      expect((await sqlState(asUnboundWorker((tx) => recordAudit(tx, moveId, "move_rejected")))).code).toBe("42501");
      expect((await sqlState(asWorker(world.A2, (tx) => recordAudit(tx, moveId, "moved_sideways")))).code).toBe("22023");
      // INCOMING REQUESTED: moved_in (needs COMPLETED), move_failed (ACTIVATION_FAILED), move_rejected (REJECTED), moved_out (OUTGOING) all refused.
      for (const stepName of ["moved_in", "move_failed", "move_rejected", "moved_out"]) {
        expect((await sqlState(asWorker(world.A2, (tx) => recordAudit(tx, moveId, stepName)))).code, stepName).toBe("P0002");
      }
      // Another workspace (same or other organization) can't use this move.
      expect((await sqlState(asWorker(A3, (tx) => recordAudit(tx, moveId, "move_rejected")))).code).toBe("P0002");
      expect((await sqlState(asWorker(world.B1, (tx) => recordAudit(tx, moveId, "move_rejected")))).code).toBe("P0002");
      await drive(moveId);
      // COMPLETED incoming: moved_out is the OUTGOING side's step → refused here; the source can't record moved_in.
      expect((await sqlState(asWorker(world.A2, (tx) => recordAudit(tx, moveId, "moved_out")))).code).toBe("P0002");
      expect((await sqlState(asWorker(world.A1, (tx) => recordAudit(tx, moveId, "moved_in")))).code).toBe("P0002");
      expect((await audits(moveId)).map((a) => a.action)).toEqual(["connected_account.move_requested", "connected_account.moved_out", "connected_account.moved_in"]);
    });

    it("actor_user_id is always the initiator stored on the LOCAL row of each side", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "", extra.mover);
      await drive(moveId);
      const sides = await moveSides(moveId);
      expect(sides.map((row) => row.initiator_user_id)).toEqual([extra.mover, extra.mover]);
      for (const audit of await audits(moveId)) {
        expect(audit.actor_type).toBe("user");
        expect(audit.actor_user_id).toBe(sides.find((row) => row.workspace_id === audit.workspace_id)?.initiator_user_id);
      }
    });

  });

  describe("reason vocabulary (0010)", () => {
    it("the live reason_code CHECK is validated and equals the application's closed list (TA-Q-02 reason distinct from M-01's)", async () => {
      const rows = await oracle<{ definition: string; validated: boolean }>(
        "select pg_get_constraintdef(oid) as definition, convalidated as validated from pg_constraint where conname = 'asset_moves_reason_code_check' and conrelid = 'connections.asset_moves'::regclass");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.validated).toBe(true);
      const values = [...(rows[0]?.definition ?? "").matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
      expect(values.sort()).toEqual([...MOVE_REASON_CODES].sort());
      expect(values).toContain("AD_ACCOUNT_SINGLE_WORKSPACE_PENDING_VALIDATION");
      expect(values).toContain("ASSET_ACTIVE_ELSEWHERE");
    });
  });

  // ── R7 durability ──────────────────────────────────────────────────────────────────────────────────────────
  describe("R7: crash after the source release, before the activation is dispatched", () => {
    it("the outcome sweeper recovers the crashed release run, the dispatch sweeper delivers the activation, and it applies exactly once", async () => {
      // Only this test's rows may be delivered by this runtime.
      await quietPendingOutbox((text, values) => privileged.query(text, values), "organization_id = any($1::uuid[])", [[world.orgA, world.orgB]]);
      const { name, sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      await quietPendingOutbox((text, values) => privileged.query(text, values), "topic = $1 and organization_id = $2", [EVALUATE, world.orgA]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");

      let now = new Date();
      const handlers = new Map<string, FakeHandler>([
        ...Object.entries(STEP_HANDLERS).map(([task, handler]): [string, FakeHandler] => [task, (payload, run) => runTenantJob({ registry: PRODUCTION_TASKS, worker, logger }, task, payload, run, handler)]),
        [EVALUATE, () => Promise.resolve("evaluation not under test")],
      ]);
      const runtime = new FakeJobRuntime(handlers, (task) => PRODUCTION_TASKS.get(task)?.retry ?? (() => { throw new Error("unknown task"); })());
      const deps: DeliveryDependencies = { system, runtime, registry: PRODUCTION_TASKS, logger, clock: () => now, config: DEFAULT_DELIVERY_CONFIG };

      // 1 · The release run commits its effect (and routes the activation row), then the worker process dies.
      runtime.fault = (run, attempt) => (run.request.task === RELEASE && attempt === 1 && run.id === [...runtime.runs.keys()][0] ? "crash_after" : undefined);
      expect((await relayPass(deps)).dispatched).toBe(1);
      await runtime.drain();
      expect([...runtime.runs.values()].map((run) => [run.request.task, run.status])).toEqual([[RELEASE, "CRASHED"]]);
      expect(await activeAccounts(name)).toEqual([]);
      const activation = (await outboxOf(moveId)).find((row) => row.topic === ACTIVATE);
      expect(activation?.status).toBe("PENDING"); // routed in the release transaction, never dispatched (relay "crashed" too)

      // 2 · The run-outcome sweeper sees CRASHED and re-dispatches the release: it applies nothing twice.
      runtime.fault = () => undefined;
      await sweepRunOutcomes(deps);
      await runtime.drain();
      expect((await accounts(name)).filter((row) => row.id === sourceAccount)).toEqual([expect.objectContaining({ status: "INACTIVE", deactivation_reason: "MOVED", move_id: moveId })]);

      // 3 · The dispatch sweeper picks up the never-dispatched activation once it is old enough; it runs exactly once.
      now = new Date(now.getTime() + (DEFAULT_DELIVERY_CONFIG.dispatchSweepMinAgeSeconds + 5) * 1000);
      expect((await sweepDispatch(deps)).dispatched).toBeGreaterThanOrEqual(1);
      await runtime.drain();
      await sweepRunOutcomes(deps);
      await relayPass(deps);
      await runtime.drain();

      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([world.A2]);
      expect(await side(moveId, "INCOMING")).toMatchObject({ status: "COMPLETED" });
      expect((await audits(moveId)).map((a) => a.action)).toEqual(["connected_account.move_requested", "connected_account.moved_out", "connected_account.moved_in"]);
      const destination = (await activeAccounts(name))[0];
      expect((await accountEvents(destination?.id ?? "")).map((e) => e.event_type)).toEqual(["MOVED_IN"]);
      expect((await accountEvents(sourceAccount)).filter((e) => e.event_type === "MOVED_OUT")).toHaveLength(1);
      expect(await oracle("select effect_key from idempotency.effect_keys where effect_key like $1 order by effect_key", [`connections.move.%:${moveId}%`])).toHaveLength(2);
      expect([...runtime.runs.values()].filter((run) => run.request.task === ACTIVATE && run.status === "COMPLETED")).toHaveLength(1);
    });
  });

  // ── Step 5G hardening ─────────────────────────────────────────────────────────────────────────────────────
  describe("G1 · correlation ids are trace metadata only", () => {
    it("a spoofed correlation id never changes the audit target, actor, workspace or the routing target", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "", extra.mover);
      await drive(moveId);
      const other = await requested(world.A2, (await activeIn(world.A1, [world.A2])).discovered[world.A2] ?? "");
      // A correlation id crafted to look like another move / workspace / user.
      const spoof = `spoof:${other}:${A3}:${world.users.ownerA}`.slice(0, 120);
      await asWorker(world.A2, (tx) => tx.execute(sql`select connections.record_move_audit(${moveId}::uuid, 'moved_in', ${spoof})`));
      const recorded = await oracle<{ target_id: string; actor_user_id: string; workspace_id: string; correlation_id: string }>(
        "select target_id, actor_user_id, workspace_id, correlation_id from audit.audit_events where correlation_id = $1", [spoof]);
      expect(recorded).toEqual([{ target_id: moveId, actor_user_id: extra.mover, workspace_id: world.A2, correlation_id: spoof }]);
      // The same spoof from another workspace still finds no move; routing with it still derives the counterpart.
      expect((await sqlState(asWorker(A3, (tx) => tx.execute(sql`select connections.record_move_audit(${moveId}::uuid, 'moved_in', ${spoof})`)))).code).toBe("P0002");
      expect((await asWorker(A3, (tx) => route(tx, other, "activate_destination", spoof))).rows[0]).toEqual(NOT_ROUTED);
      const routed = (await asWeb(world.users.ownerA, world.A2, (tx) => route(tx, other, "release_source", spoof))).rows[0];
      expect(routed).toEqual({ routed: true, outbox_id: null }); // already routed by the request: nothing new, nowhere else
      expect((await outboxOf(other)).map((row) => row.workspace_id)).toEqual([world.A1]);
    });
  });

  describe("G2 · the owner-only organization read stays owner-only and minimal", () => {
    it("only app_owner holds the organization-scoped policy; web/worker policies on link tables stay bound to one workspace", async () => {
      const owner = await oracle<{ roles: string[]; permissive: boolean }>(
        `select array(select pg_get_userbyid(r)::text from unnest(p.polroles) r)::text[] as roles, p.polpermissive as permissive
           from pg_policy p where p.polname = 'owner_organization_active_read' and p.polrelid = 'connections.connected_accounts'::regclass`);
      expect(owner).toEqual([{ roles: ["app_owner"], permissive: true }]);
      const runtime = await oracle<{ table: string; policy: string; expression: string }>(
        `select p.polrelid::regclass::text as table, p.polname as policy,
                coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expression
           from pg_policy p
          where p.polrelid in ('connections.connected_accounts'::regclass, 'connections.asset_moves'::regclass, 'connections.discovered_assets'::regclass)
            and exists (select 1 from unnest(p.polroles) r where pg_get_userbyid(r) in ('authenticated', 'app_worker'))`);
      expect(runtime.length).toBeGreaterThan(0);
      for (const row of runtime) {
        expect(row.expression, `${row.table}.${row.policy}`).toContain("current_workspace()");
        expect(row.expression, `${row.table}.${row.policy}`).not.toMatch(/organization/);
      }
      // No PUBLIC execution path to any 0010 definer.
      const publicAcl = await oracle<{ name: string }>(
        `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'connections' and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`);
      expect(publicAcl).toEqual([]);
    });

    it("the definer derives the organization from the bound workspace: other organizations are invisible, results minimal", async () => {
      const name = assetName();
      const inB = await discover(world.B1, name);
      as(world.users.ownerB);
      expectOk(await link(world.B1, inB));
      const inA = await discover(world.A2, name);
      expect((await asWorker(world.A2, (tx) => locate(tx, inA))).rows).toEqual([]);
      expect((await asWeb(world.users.ownerA, world.A2, (tx) => locate(tx, inA))).rows).toEqual([]);
      const columns = await oracle<{ name: string }>(
        `select unnest(p.proargnames[2:]) as name from pg_proc p where p.proname = 'locate_active_link'`);
      expect(columns.map((c) => c.name)).toEqual(["active_workspace_id", "active_connected_account_id"]);
    });
  });

  describe("G3 · activation effect identity = one durable dispatch attempt", () => {
    it("duplicate delivery → one effect; explicit retry → a new effect; redelivery of the retry → still one", async () => {
      const { name, discovered } = await activeIn(world.A1, [world.A2, A3]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect(await step(moveId, RELEASE)).toEqual({ kind: "released" });
      as(world.users.ownerA);
      expectOk(await link(A3, discovered[A3] ?? "")); // makes the first attempt fail
      const [first] = (await outboxOf(moveId)).filter((row) => row.topic === ACTIVATE);
      if (first === undefined) throw new Error("no activation");
      expect(await runRow(first)).toMatchObject({ kind: "failed", reason: "ASSET_ACTIVE_ELSEWHERE" });
      expect(await runRow(first)).toEqual({ kind: "skipped", reason: "already_applied" }); // 1 · duplicate delivery
      expect((await audits(moveId)).filter((a) => a.action === "connected_account.move_failed")).toHaveLength(1);

      const linkedA3 = (await activeAccounts(name))[0];
      expectOk(await unlink(A3, linkedA3?.id ?? ""));
      expectOk(await retry(world.A2, moveId)); // 2 · explicit retry → a NEW durable attempt
      const attempts = (await outboxOf(moveId)).filter((row) => row.topic === ACTIVATE);
      expect(attempts).toHaveLength(2);
      const second = attempts[1];
      if (second === undefined) throw new Error("no retry attempt");
      expect(second.dispatch_key).not.toBe(first.dispatch_key);
      expect(await runRow(second)).toMatchObject({ kind: "completed", converged: false });
      expect(await runRow(second)).toEqual({ kind: "skipped", reason: "already_applied" }); // 3 · redelivery of the retry
      expect(await runRow(first)).toEqual({ kind: "skipped", reason: "already_applied" });
      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([world.A2]);
      expect((await audits(moveId)).filter((a) => a.action === "connected_account.moved_in")).toHaveLength(1);
      const effects = await oracle<{ effect_key: string }>("select effect_key from idempotency.effect_keys where effect_key like $1", [`connections.move.activate:${moveId}:%`]);
      expect(effects.map((e) => e.effect_key).sort()).toEqual([`connections.move.activate:${moveId}:${first.id}`, `connections.move.activate:${moveId}:${second.id}`].sort());
    });

    it("duplicate routing of the same step never creates another attempt, and a retry is only possible from ACTIVATION_FAILED", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      await step(moveId, RELEASE);
      expect((await asWorker(world.A1, (tx) => route(tx, moveId, "activate_destination"))).rows[0]).toEqual({ routed: true, outbox_id: null });
      expect((await asWeb(world.users.ownerA, world.A2, (tx) => route(tx, moveId, "retry_activation"))).rows[0]).toEqual(NOT_ROUTED); // REQUESTED, not failed
      expect((await outboxOf(moveId)).filter((row) => row.topic === ACTIVATE)).toHaveLength(1);
      as(world.users.ownerA);
      expect(errorCode(await retry(world.A2, moveId))).toBe("STALE_STATE");
    });
  });

  describe("G4 · the destination never learns the source's precise refusal", () => {
    it.each(["authority", "inactive"] as const)("source refusal (%s) → destination SOURCE_RELEASE_REJECTED only; the source keeps the exact reason and audit", async (cause) => {
      const { sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "", extra.mover);
      if (cause === "authority") await setRole(world.A1, extra.mover, "MANAGER");
      else expectOk(await unlink(world.A1, sourceAccount));
      try {
        await drive(moveId);
      } finally {
        await setRole(world.A1, extra.mover, "ADMIN");
      }
      const exact = cause === "authority" ? "AUTHORITY_REVOKED" : "SOURCE_NOT_ACTIVE";
      expect(await side(moveId, "OUTGOING")).toMatchObject({ workspace_id: world.A1, status: "REJECTED", reason_code: exact });
      expect(await side(moveId, "INCOMING")).toMatchObject({ workspace_id: world.A2, status: "REJECTED", reason_code: "SOURCE_RELEASE_REJECTED" });
      // Nothing visible to the destination carries the source's reason (its own rows and its routed rows).
      const destinationView = await asWeb(world.users.ownerA, world.A2, (tx) => tx.execute<{ reason_code: string | null }>(sql`select reason_code from connections.asset_moves where move_id = ${moveId}`));
      expect(destinationView.rows).toEqual([{ reason_code: "SOURCE_RELEASE_REJECTED" }]);
      for (const row of (await outboxOf(moveId)).filter((r) => r.workspace_id === world.A2)) {
        expect(JSON.stringify(row.subject_ids)).not.toMatch(/AUTHORITY|ACTIVE/);
        expect(Object.keys(row.subject_ids)).toEqual(["move_id"]);
      }
      expect((await audits(moveId)).filter((a) => a.action === "connected_account.move_rejected").map((a) => a.workspace_id).sort()).toEqual([world.A1, world.A2].sort());
    });
  });

  describe("G5 · routed rows are delivered by the post-commit wake-up; the sweeper only recovers", () => {
    const quiet = async (): Promise<void> => {
      await quietPendingOutbox((text, values) => privileged.query(text, values), "organization_id = any($1::uuid[])", [[world.orgA, world.orgB]]);
    };
    /** A delivery world: kicks recorded from the web pipeline and from committed job transactions. */
    const deliveryWorld = (options: { readonly jobKick: "deliver" | "lost" }) => {
      const kicks: string[][] = [];
      let now = new Date(Date.now() + 5_000); // a few seconds after the rows: well below the sweeper's minimum age
      const kick = (notices: readonly { readonly id: string }[]) => {
        kicks.push(notices.map((notice) => notice.id));
        return Promise.resolve();
      };
      const jobKick = options.jobKick === "deliver" ? kick : () => Promise.reject(new Error("process died before the wake-up"));
      const handlers = new Map<string, FakeHandler>([
        ...Object.entries(STEP_HANDLERS).map(([task, handler]): [string, FakeHandler] => [
          task,
          (payload, run) => runTenantJob({ registry: PRODUCTION_TASKS, worker, logger, outboxCommitted: jobKick }, task, payload, run, handler),
        ]),
        [EVALUATE, () => Promise.resolve("evaluation not under test")],
      ]);
      const runtime = new FakeJobRuntime(handlers, (task) => PRODUCTION_TASKS.get(task)?.retry ?? (() => { throw new Error("unknown task"); })());
      const deps = (): DeliveryDependencies => ({ system, runtime, registry: PRODUCTION_TASKS, logger, clock: () => now, config: DEFAULT_DELIVERY_CONFIG });
      const kickingPipeline = createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger, outboxCommitted: kick });
      /** What the woken relay does (outbox.relay task): one relay pass, then the runtime executes what it dispatched. */
      const wake = async (): Promise<void> => {
        while (kicks.length > 0) {
          kicks.shift();
          await relayPass(deps());
          await runtime.drain();
        }
      };
      return { kicks, runtime, deps, kickingPipeline, wake, advance: (seconds: number) => (now = new Date(now.getTime() + seconds * 1000)) };
    };

    it("normal path: request → release → activation → capability evaluation, each woken after its commit; no sweeper, no clock advance", async () => {
      await quiet();
      const { name, discovered } = await activeIn(world.A1, [world.A2]);
      await quiet();
      const d = deliveryWorld({ jobKick: "deliver" });
      as(world.users.ownerA);
      const output = expectOk(await d.kickingPipeline.run(commands.requestMove, { workspaceId: world.A2, input: { discoveredAssetId: discovered[world.A2] } }));
      if (output.kind !== "requested") throw new Error("not requested");
      expect(Object.keys(output).sort()).toEqual(["kind", "moveId", "reused"]); // the routed row id never reaches the client
      const [release] = await outboxOf(output.moveId);
      expect(d.kicks).toEqual([[release?.id]]);
      await d.wake();
      const rows = await outboxOf(output.moveId);
      expect(rows.map((row) => [row.topic, row.status])).toEqual([[RELEASE, "DISPATCHED"], [ACTIVATE, "DISPATCHED"]]);
      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([world.A2]);
      const destination = (await activeAccounts(name))[0];
      expect((await evaluations(destination?.id ?? "")).map((row) => row.status)).toEqual(["DISPATCHED"]);
      expect((await sweepDispatch(d.deps())).claimed).toBe(0); // nothing left for the sweeper
      expect([...d.runtime.runs.values()].map((run) => run.request.task)).toEqual([RELEASE, ACTIVATE, EVALUATE]);
    });

    it("crash after commit, before the wake-up: the run still succeeds, the row waits, and the dispatch sweeper recovers it once", async () => {
      await quiet();
      const { name, discovered } = await activeIn(world.A1, [world.A2]);
      await quiet();
      const d = deliveryWorld({ jobKick: "lost" });
      as(world.users.ownerA);
      const output = expectOk(await d.kickingPipeline.run(commands.requestMove, { workspaceId: world.A2, input: { discoveredAssetId: discovered[world.A2] } }));
      if (output.kind !== "requested") throw new Error("not requested");
      await d.wake(); // the release runs; its own wake-up is lost
      expect([...d.runtime.runs.values()].map((run) => [run.request.task, run.status])).toEqual([[RELEASE, "COMPLETED"]]);
      expect(logLines.some((line) => line.includes("outbox.nudge.failed"))).toBe(true);
      const activation = (await outboxOf(output.moveId)).find((row) => row.topic === ACTIVATE);
      expect(activation?.status).toBe("PENDING");
      expect((await sweepDispatch(d.deps())).claimed).toBe(0); // too young: the sweeper is recovery, not the normal path
      d.advance(DEFAULT_DELIVERY_CONFIG.dispatchSweepMinAgeSeconds + 5);
      expect((await sweepDispatch(d.deps())).dispatched).toBeGreaterThanOrEqual(1);
      await d.runtime.drain();
      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([world.A2]);
      expect((await audits(output.moveId)).filter((a) => a.action === "connected_account.moved_in")).toHaveLength(1);
    });

    it("duplicate wake-ups are harmless: exactly one dispatch per row and one effect", async () => {
      await quiet();
      const { name, discovered } = await activeIn(world.A1, [world.A2]);
      await quiet();
      const d = deliveryWorld({ jobKick: "deliver" });
      as(world.users.ownerA);
      const output = expectOk(await d.kickingPipeline.run(commands.requestMove, { workspaceId: world.A2, input: { discoveredAssetId: discovered[world.A2] } }));
      if (output.kind !== "requested") throw new Error("not requested");
      // Every wake-up delivered three times (e.g. retried nudges), with concurrent relay passes.
      while (d.kicks.length > 0) {
        d.kicks.shift();
        await Promise.all([relayPass(d.deps()), relayPass(d.deps()), relayPass(d.deps())]);
        await d.runtime.drain();
        await relayPass(d.deps());
        await d.runtime.drain();
      }
      const runs = [...d.runtime.runs.values()];
      expect(runs.filter((run) => run.request.task === RELEASE)).toHaveLength(1);
      expect(runs.filter((run) => run.request.task === ACTIVATE)).toHaveLength(1);
      expect((await activeAccounts(name)).map((row) => row.workspace_id)).toEqual([world.A2]);
      expect((await audits(output.moveId)).map((a) => a.action)).toEqual(["connected_account.move_requested", "connected_account.moved_out", "connected_account.moved_in"]);
    });

    it("a job transaction that rolls back announces nothing", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      const [release] = await outboxOf(moveId);
      if (release === undefined) throw new Error("no release");
      const notices: string[] = [];
      await expect(
        runTenantJob(
          { registry: PRODUCTION_TASKS, worker, logger, outboxCommitted: (n) => Promise.resolve(void notices.push(...n.map((x) => x.id))) },
          RELEASE,
          payloadOf(release),
          { runId: `run_${randomUUID()}`, attempt: 1 },
          async (context) => {
            await runReleaseSource(context);
            throw new Error("crash before commit");
          },
        ),
      ).rejects.toThrow();
      expect(notices).toEqual([]);
      expect((await outboxOf(moveId)).map((row) => row.topic)).toEqual([RELEASE]);
    });
  });

  describe("G6 · no runtime caller can create Move saga outbox rows directly", () => {
    const forge = (tx: DatabaseTransaction, workspace: string, topic: string, initiatorType: string, initiatorUser: string | null, subjects: Record<string, string>) =>
      tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${randomUUID()}, ${topic}, ${orgOf(workspace)}, ${workspace}, ${JSON.stringify(subjects)}::jsonb, 'corr-test-forge-0003', ${initiatorType}, ${initiatorUser}, ${`forged:${randomUUID()}`}, 'PENDING', now())`);

    it.each([RELEASE, ACTIVATE, REJECT])("%s: refused for an Owner of the bound workspace and for its worker (own workspace, valid subjects)", async (topic) => {
      const { sourceAccount, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      const subjects = topic === RELEASE ? { move_id: moveId, connected_account_id: sourceAccount, counterpart_workspace_id: world.A2 } : { move_id: moveId };
      for (const workspace of [world.A1, world.A2]) {
        expect((await sqlState(asWeb(world.users.ownerA, workspace, (tx) => forge(tx, workspace, topic, "user", world.users.ownerA, subjects)))).code).toBe("42501");
        expect((await sqlState(asWorker(workspace, (tx) => forge(tx, workspace, topic, "system", null, subjects)))).code).toBe("42501");
        expect((await sqlState(asWorker(workspace, (tx) => forge(tx, workspace, topic, "user", world.users.ownerA, subjects)))).code).toBe("42501");
      }
      // …and toward another workspace or organization, as before.
      expect((await sqlState(asWeb(world.users.ownerA, world.A2, (tx) => forge(tx, world.A1, topic, "user", world.users.ownerA, subjects)))).code).toBe("42501");
      expect((await sqlState(asWeb(world.users.ownerB, world.B1, (tx) => forge(tx, world.A1, topic, "user", world.users.ownerB, subjects)))).code).toBe("42501");
      expect((await outboxOf(moveId)).map((row) => row.topic)).toEqual([RELEASE]);
    });

    it("the restriction is a RESTRICTIVE policy for web and worker only; other topics and the definer path still work", async () => {
      const restrictive = await oracle<{ roles: string[]; permissive: boolean; command: string }>(
        `select array(select pg_get_userbyid(r)::text from unnest(p.polroles) r order by 1)::text[] as roles, p.polpermissive as permissive, p.polcmd as command
           from pg_policy p where p.polname = 'no_direct_move_routing' and p.polrelid = 'system.outbox'::regclass`);
      expect(restrictive).toEqual([{ roles: ["app_worker", "authenticated"].sort(), permissive: false, command: "a" }]);
      // Any other topic is still appendable by the web user as themselves (generic append_own unchanged)…
      const id = randomUUID();
      await asWeb(world.users.ownerA, world.A2, (tx) => tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${id}, 'testjobs.some_task', ${world.orgA}, ${world.A2}, '{}'::jsonb, 'corr-test-other-0001', 'user', ${world.users.ownerA}, ${`other:${id}`}, 'PENDING', now())`));
      await privileged.query("delete from system.outbox where id = $1", [id]);
      // …never as someone else (no impersonation), and the saga still routes through the definer.
      expect((await sqlState(asWeb(world.users.a12, world.A1, (tx) => tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${randomUUID()}, 'testjobs.some_task', ${world.orgA}, ${world.A1}, '{}'::jsonb, 'corr-test-other-0002', 'user', ${world.users.ownerA}, ${`other:${randomUUID()}`}, 'PENDING', now())`)))).code).toBe("42501");
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      expect((await drive(moveId)).next).toMatchObject({ kind: "completed" });
    });

    it("the definer itself can't be steered: no release without the initiator's live authority, no other workspace's account, no other organization", async () => {
      const { discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "", extra.mover);
      // Another Owner of the destination can't route someone else's request; the source can't route its own release.
      expect((await sqlState(asWeb(extra.destAdmin, world.A2, (tx) => route(tx, moveId, "release_source")))).code).toBe("42501");
      expect((await asWeb(world.users.ownerA, world.A1, (tx) => route(tx, moveId, "release_source"))).rows[0]).toEqual(NOT_ROUTED);
      // Organization B can't route anything for it.
      expect((await asWeb(world.users.ownerB, world.B1, (tx) => route(tx, moveId, "release_source"))).rows[0]).toEqual(NOT_ROUTED);
      expect((await asWorker(world.B1, (tx) => route(tx, moveId, "activate_destination"))).rows[0]).toEqual(NOT_ROUTED);
    });
  });

  describe("G7 · connections.account.list", () => {
    it("workspace-scoped, permission-bound, read-only, identifiers only (no credential material)", async () => {
      const { sourceAccount } = await activeIn(world.A1, [world.A2]);
      const counts = async () => (await oracle<{ audit: number; outbox: number; accounts: number }>(
        `select (select count(*)::int from audit.audit_events where organization_id = $1) as audit,
                (select count(*)::int from system.outbox where organization_id = $1) as outbox,
                (select count(*)::int from connections.connected_accounts where organization_id = $1) as accounts`, [world.orgA]))[0];
      const before = await counts();
      as(world.users.a1); // Manager of A1: read_operational, not connections.manage
      const listed = expectOk(await pipeline.run(commands.list, { workspaceId: world.A1, input: {} }));
      expect(listed.some((account) => account.id === sourceAccount)).toBe(true);
      for (const account of listed) {
        expect(Object.keys(account).sort()).toEqual(["assetClass", "connectionId", "deactivationReason", "id", "platform", "providerAssetId", "status"]);
      }
      as(world.users.ownerA);
      const inA2 = expectOk(await pipeline.run(commands.list, { workspaceId: world.A2, input: {} }));
      expect(inA2.some((account) => account.id === sourceAccount)).toBe(false); // never another workspace's rows
      as(world.users.a1);
      expect(errorCode(await pipeline.run(commands.list, { workspaceId: world.A2, input: {} }))).toBe("NOT_FOUND"); // not a member
      as(world.users.guest);
      expect(errorCode(await pipeline.run(commands.list, { workspaceId: world.A1, input: {} }))).toBe("PERMISSION_DENIED");
      expect(await counts()).toEqual(before); // read-only
      expect(JSON.stringify(listed)).not.toMatch(/envelope|credential|token|secret/i);
    });
  });

  describe("G8 · destination already ACTIVE at activation", () => {
    it("replay of the same activation attempt: idempotent success, no duplicate event, evaluation or audit", async () => {
      const { name, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      await step(moveId, RELEASE);
      const activation = (await outboxOf(moveId)).find((row) => row.topic === ACTIVATE);
      if (activation === undefined) throw new Error("no activation");
      expect(await runRow(activation)).toMatchObject({ kind: "completed", converged: false, evaluationEnqueued: true });
      expect(await runRow(activation)).toEqual({ kind: "skipped", reason: "already_applied" });
      expect(await runRow({ ...activation, id: randomUUID() })).toEqual({ kind: "skipped", reason: "not_pending" });
      const account = (await activeAccounts(name))[0];
      expect((await accountEvents(account?.id ?? "")).map((e) => e.event_type)).toEqual(["MOVED_IN"]);
      expect(await evaluations(account?.id ?? "")).toHaveLength(1);
      expect(await side(moveId, "INCOMING")).toMatchObject({ status: "COMPLETED", connected_account_id: account?.id });
      expect((await audits(moveId)).filter((a) => a.action === "connected_account.moved_in")).toHaveLength(1);
    });

    it("linked independently before activation: converges on that account, saga completion audited exactly once, no fabricated resource event", async () => {
      const { name, discovered } = await activeIn(world.A1, [world.A2]);
      const moveId = await requested(world.A2, discovered[world.A2] ?? "");
      await step(moveId, RELEASE);
      as(world.users.ownerA);
      const linked = expectOk(await link(world.A2, discovered[world.A2] ?? ""));
      if (linked.kind !== "linked") throw new Error("not linked");
      expect(await evaluations(linked.connectedAccountId)).toHaveLength(1); // the normal link evaluation path
      expect(await step(moveId, ACTIVATE)).toEqual({ kind: "completed", connectedAccountId: linked.connectedAccountId, evaluationEnqueued: false, converged: true });
      expect((await activeAccounts(name)).map((row) => row.id)).toEqual([linked.connectedAccountId]); // no duplicate account
      expect((await accountEvents(linked.connectedAccountId)).map((e) => e.event_type)).toEqual(["LINKED"]); // no MOVED_IN fabricated
      expect(await evaluations(linked.connectedAccountId)).toHaveLength(1); // no second evaluation
      expect(await side(moveId, "INCOMING")).toMatchObject({ status: "COMPLETED", connected_account_id: linked.connectedAccountId });
      expect((await audits(moveId)).map((a) => a.action)).toEqual(["connected_account.move_requested", "connected_account.moved_out", "connected_account.moved_in"]);
      expect(await step(moveId, ACTIVATE)).toEqual({ kind: "skipped", reason: "already_applied" });
      expect((await audits(moveId)).filter((a) => a.action === "connected_account.moved_in")).toHaveLength(1);
    });
  });

  it("no log line carries anything but identifiers and closed codes for the saga", () => {
    const joined = logLines.join("\n");
    expect(joined).not.toMatch(/Synthetic asset/);
    expect(joined).not.toMatch(/sim_asset_/);
  });
}
