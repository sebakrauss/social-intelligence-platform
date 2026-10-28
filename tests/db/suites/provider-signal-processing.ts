/**
 * Step H6-F4 — webhook signals end to end on the real database, simulator only (no Meta, no network):
 *
 *   receipt (provider-signal scope: web login, no claims, no workspace) → REAL router task body (route + due-mark sweep,
 *   system login) → IDs-only `ingestion.process_signals` row → REAL relay → FakeJobRuntime → REAL handlers through the
 *   REAL job wrappers → marks / H6-E confirmation requests → (skew deferral → due-mark sweep) → signal runs through the
 *   0019/0022 request boundary → relist or account planning (MAIN) → content slices (INTEGRATION) → canonical ingestion
 *   → the close hook (satisfaction, follow-up, cap) in the run's closing transaction.
 *
 * Time: the simulator clock is the application clock (marks, runs, satisfaction, cap, expiry). The 0022 due-mark
 * dispatcher compares a mark's revisit time with DATABASE time, so `due()` stands in for the passage of time: it makes
 * exactly the marks whose revisit time the simulated clock has reached due for the real dispatcher.
 * Routing fans out to every ACTIVE account of an asset across the database: each harness first retires the accounts
 * of the earlier ones, so exactly one tenant matches.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import type { ProviderReadPort } from "@/integrations/providers/contract";
import { SimulatorWorld, createSimulatorReadPort } from "@/integrations/providers/simulator";
import { PLATFORM_CATALOG, evaluateAndStore, type FactsInput } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { SIGNAL_RUNTIME, confirmStoredInteraction, processProviderSignal, requestReconciliation, type SignalOutcome, type SignalResult } from "@/modules/ingestion";
import { withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { parseSystemJobPayload, runTenantJob, runTenantStepJob, type SystemJobContext } from "@/platform/jobs";
import { relayPass, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger, type Logger } from "@/platform/observability";
import { reconciliationScope } from "@/server/persistence/ingestion";
import { runConfirmInteraction } from "@/jobs/confirm-interaction";
import { runProcessSignals } from "@/jobs/process-signals";
import { runPurgeProviderEvents, runRouteProviderEvents } from "@/jobs/provider-events";
import { runInteractionsObserved, runReconcileAccount } from "@/jobs/reconciliation";
import { runReconcileSlice } from "@/jobs/reconciliation-slice";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";
import { presentScenario } from "./reconciliation-runtime";

const CONFIG: DeliveryConfig = {
  batchSize: 200,
  leaseSeconds: 30,
  backoff: { baseSeconds: 5, maxSeconds: 60 },
  dispatchSweepMinAgeSeconds: 60,
  dispatchSloSeconds: 120,
  maxRecoveries: 3,
  outcomeBatchSize: 200,
  unknownObservation: { maxChecks: 4, maxSeconds: 600 },
};
const SLICE = "ingestion.reconcile_slice";
const CONFIRM = "ingestion.confirm_interaction";
const PROCESS = "ingestion.process_signals";
const RECORD = "select outcome, receipt_id, new_hint_count from system.record_provider_webhook($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)";
const FB_ASSET = "fb_page_aurora";
const IG_ASSET = "ig_acct_aurora";
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

interface Tenant { readonly organizationId: string; readonly workspaceId: string; readonly owner: string; readonly connection: string; readonly fb: string; readonly ig: string }
interface HintSpec {
  readonly platform: "facebook" | "instagram";
  readonly targetKind?: "content" | "interaction";
  readonly target: string;
  readonly content?: string | null;
  readonly parent?: string | null;
  readonly change?: "created" | "edited" | "removed" | "hidden" | "unhidden" | "updated";
  readonly hintKey?: string;
}

export function defineProviderSignalProcessingSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let logger: Logger;
  const lines: string[] = [];
  const organizations: string[] = [];
  const tenants: Tenant[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const correlation = (): CorrelationId => {
    const parsed = parseCorrelationId(`h6f4-${randomUUID()}`);
    if (parsed === undefined) throw new Error("correlation");
    return parsed;
  };
  const switchChange = async (statement: string): Promise<void> => {
    const client = await privileged.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.operator_id', 'ops.h6f4', true), set_config('app.change_reason', 'test', true)");
      await client.query(statement);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };

  /** A tenant with FB + IG accounts on the scenario's assets (r5 profiles); every earlier tenant's accounts retire. */
  const tenant = async (clock: () => Date): Promise<Tenant> => {
    for (const earlier of tenants) {
      await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED', updated_at = now() where workspace_id = $1 and status = 'ACTIVE'", [earlier.workspaceId]);
    }
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Signals', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [organizationId, owner]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [organizationId, workspaceId, owner]);
    const connection = randomUUID();
    const credential = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, owner]);
    await privileged.query(
      `insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())`,
      [credential, organizationId, workspaceId, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
    await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, connection]);
    const accounts: Record<string, string> = {};
    for (const [asset, platform, grants] of [
      [FB_ASSET, "facebook", ["pages_read_engagement", "pages_read_user_content", "pages_show_list"]],
      [IG_ASSET, "instagram", ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"]],
    ] as const) {
      const discovered = randomUUID();
      await privileged.query(
        `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, platform, asset]);
      const account = randomUUID();
      await privileged.query(
        `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
        [account, discovered]);
      const facts: FactsInput = { kind: "available", assetClass: "content_bearing", grantedPermissions: [...grants], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: clock() };
      await withWorkspaceJobScope(worker, workspaceId, (tx) => evaluateAndStore(createPostgresCapabilityStore(tx), {
        organizationId, workspaceId, connectedAccountId: account, catalog: PLATFORM_CATALOG, platform, assetClass: "content_bearing", facts, observations: [], evaluatedAt: clock(),
      }));
      accounts[asset] = account;
    }
    const t = { organizationId, workspaceId, owner, connection, fb: accounts[FB_ASSET] ?? "", ig: accounts[IG_ASSET] ?? "" };
    tenants.push(t);
    return t;
  };

  /** One isolated world: simulator, counting read port, every real handler (signals included), the delivery loop. */
  const harness = async (options: { readonly onRead?: (operation: string, target: string | undefined) => Promise<void> } = {}) => {
    const world = new SimulatorWorld(presentScenario());
    const clock = (): Date => new Date(world.nowMs());
    const ids = { newId: randomUUID, now: clock };
    const base = createSimulatorReadPort(world, { webhookSigningKey: "synthetic-webhook-signing-key-for-tests" });
    const calls: { readonly operation: string; readonly target: string | undefined; readonly cursor?: string | null }[] = [];
    const port: ProviderReadPort = {
      ...base,
      listContent: (access, window, cursor) => {
        calls.push({ operation: "listContent", target: access.account.id });
        return base.listContent(access, window, cursor);
      },
      listInteractions: async (access, scope, window, cursor) => {
        const target = scope.kind === "content" ? scope.content.id : undefined;
        calls.push({ operation: "listInteractions", target, cursor: cursor === null ? null : String(cursor) });
        await options.onRead?.("listInteractions", target);
        return base.listInteractions(access, scope, window, cursor);
      },
      getInteraction: async (access, target) => {
        calls.push({ operation: "getInteraction", target: target.kind === "stored" ? target.stored.ref.id : undefined });
        await options.onRead?.("getInteraction", target.kind === "stored" ? target.stored.ref.id : undefined);
        return base.getInteraction(access, target);
      },
    };
    const access: ProviderCredentialAccess = { withCredential: (_input, use) => use(world.credential("cred_meta_main")) };
    const providers: DiscoveryProviders = { read: () => port };
    const deps = { registry: PRODUCTION_TASKS, worker, logger };
    const outcomes: SignalOutcome[] = [];
    const handlers = new Map<string, FakeHandler>([
      ["ingestion.reconcile_account", (payload, run) => runTenantJob(deps, "ingestion.reconcile_account", payload, run, (context) => runReconcileAccount(context, ids))],
      [SLICE, (payload, run) => runTenantStepJob(deps, SLICE, payload, run, (context) => runReconcileSlice(context, { access, providers }, { clock: ids }))],
      ["interactions.observed", (payload, run) => runTenantJob(deps, "interactions.observed", payload, run, (context) => runInteractionsObserved(context))],
      [CONFIRM, (payload, run) => runTenantStepJob(deps, CONFIRM, payload, run, (context) => runConfirmInteraction(context, { access, providers }, { clock: ids }))],
      [PROCESS, (payload, run) => runTenantJob(deps, PROCESS, payload, run, async (context): Promise<SignalResult> => {
        const result = await runProcessSignals(context, logger, ids);
        outcomes.push(result.outcome);
        return result;
      })],
    ]);
    const runtime = new FakeJobRuntime(handlers, (task) => PRODUCTION_TASKS.get(task)?.retry ?? { maxAttempts: 1, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false });
    const deliveryDeps = (): DeliveryDependencies => ({ system, runtimes: { main: runtime, integration: runtime }, registry: PRODUCTION_TASKS, logger, clock, config: CONFIG });
    const t = await tenant(clock);
    const step = async (): Promise<void> => {
      await relayPass(deliveryDeps());
      await runtime.drain();
      await sweepRunOutcomes(deliveryDeps());
      world.advanceClock(1);
    };
    const settle = async (): Promise<void> => {
      for (let pass = 0; pass < 200; pass += 1) {
        await step();
        const open = await count(`select count(*)::int as n from system.outbox where workspace_id = $1 and (status = 'PENDING' or (status = 'DISPATCHED' and run_outcome is null))`, [t.workspaceId]);
        if (open === 0) return;
      }
      throw new Error("signal processing did not settle");
    };
    const systemContext = (): SystemJobContext => ({
      payload: parseSystemJobPayload({ v: 1, scope: "system", task: "ingestion.route_provider_events", correlationId: `h6f4-${randomUUID()}`, initiator: { type: "system" } }),
      run: { runId: `run_${randomUUID().slice(0, 8)}`, attempt: 1 },
      system,
    });
    /** The REAL router task body: routes due hints and sweeps due marks. */
    const router = () => runRouteProviderEvents(systemContext(), logger);
    /** A verified receipt holding one hint (identifiers only), as the H6-F3 receiver records it; returns the hint id. */
    const receive = async (spec: HintSpec): Promise<string> => {
      const hintKey = spec.hintKey ?? sha(randomUUID());
      const hint = {
        platform: spec.platform,
        provider_asset_id: spec.platform === "facebook" ? FB_ASSET : IG_ASSET,
        target_kind: spec.targetKind ?? "interaction",
        provider_target_id: spec.target,
        provider_content_id: spec.content ?? null,
        provider_parent_id: spec.parent ?? null,
        change: spec.change ?? "created",
        occurred_at: null,
        hint_key: hintKey,
      };
      const body = sha(`${hintKey}:${randomUUID()}`);
      const client = await web.pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role authenticated");
        await client.query(RECORD, ["meta", spec.platform === "facebook" ? "page" : "instagram", body, null, 128, false, 1, 1, 0, 0, 0, JSON.stringify([hint])]);
        await client.query("commit");
      } finally {
        client.release();
      }
      return (await oracle<{ id: string }>("select id from system.provider_event_hints where hint_key = $1", [hintKey]))[0]?.id ?? "";
    };
    /** Receive + route + deliver: the process_signals outcome of this one signal. */
    const signal = async (spec: HintSpec): Promise<SignalOutcome | undefined> => {
      await receive(spec);
      const before = outcomes.length;
      await router();
      await settle();
      return outcomes[before];
    };
    /**
     * H6-F4d: revisits are DB-anchored (DB now + delay), so simulated time must also pass on the DB clock: every revisit
     * of the workspace moves `seconds` closer (exactly as if the database clock had advanced by that much).
     */
    const passDbTime = async (seconds: number): Promise<void> => {
      await privileged.query("update ingestion.signal_marks set deferred_until = deferred_until - $2 * interval '1 second' where workspace_id = $1 and deferred_until is not null", [t.workspaceId, seconds]);
    };
    /** Makes due, for the real dispatcher, exactly the marks whose revisit time has been reached on the DB clock. */
    const due = async (): Promise<void> => {
      await privileged.query("update ingestion.signal_marks set deferred_until = now() - interval '1 second' where workspace_id = $1 and deferred_until <= now()", [t.workspaceId]);
    };
    /** Lets `seconds` of simulated time pass, then runs the router's due-mark sweep and delivers everything. */
    const elapse = async (seconds: number): Promise<void> => {
      world.advanceClock(seconds);
      await passDbTime(seconds);
      await due();
      await router();
      await settle();
    };
    const request = async (account: string, correlationId = correlation()) => {
      const outcome = await withWorkspaceJobScope(worker, t.workspaceId, (tx) => requestReconciliation(reconciliationScope({ tx, noteOutbox: () => undefined }), ids, { connectedAccountId: account, correlationId }));
      if (outcome.kind !== "requested") throw new Error(`request refused: ${outcome.kind}`);
      return outcome.runId;
    };
    const reconcile = async (account: string): Promise<string> => {
      const id = await request(account);
      await settle();
      return id;
    };
    const redeliver = async (payload: unknown): Promise<void> => {
      const handler = handlers.get(PROCESS);
      if (handler === undefined) throw new Error("handler");
      await handler(payload, { runId: `run_${randomUUID().slice(0, 8)}`, attempt: 1 });
    };
    return { world, clock, ids, calls, runtime, outcomes, t, step, settle, router, receive, signal, due, elapse, request, reconcile, redeliver };
  };
  type Harness = Awaited<ReturnType<typeof harness>>;

  // ── oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  /** Account and relist marks (H6-F4d: confirm marks have their own lifecycle — see confirmMarks). */
  const marks = (t: Tenant, account = t.fb) => oracle<{ id: string; kind: string; content_item_id: string | null; signal_count: number; first_signal_at: Date; last_signal_at: Date; deferred_until: Date | null; requested_run_id: string | null; expires_at: Date; dispatch_generation: number }>(
    "select id, kind, content_item_id, signal_count, first_signal_at, last_signal_at, deferred_until, requested_run_id, expires_at, dispatch_generation from ingestion.signal_marks where workspace_id = $1 and connected_account_id = $2 and kind in ('account', 'relist') order by kind, first_signal_at",
    [t.workspaceId, account]);
  /** A mark's revisit delay as written (DB time: deferred_until − the statement time that wrote it). */
  const revisitDelay = async (markId: string | undefined): Promise<number> =>
    (await oracle<{ ms: number }>("select (extract(epoch from deferred_until - updated_at) * 1000)::float8 as ms from ingestion.signal_marks where id = $1", [markId]))[0]?.ms ?? -1;
  const confirmMarks = (t: Tenant, account = t.fb) => oracle<{ id: string; interaction_id: string; signal_count: number; dispatch_generation: number; deferred_until: Date | null; read_started_at: Date | null; confirmed_through_at: Date | null; last_signal_at: Date }>(
    "select id, interaction_id, signal_count, dispatch_generation, deferred_until, read_started_at, confirmed_through_at, last_signal_at from ingestion.signal_marks where workspace_id = $1 and connected_account_id = $2 and kind = 'confirm' order by last_signal_at",
    [t.workspaceId, account]);
  const runs = (t: Tenant, account = t.fb) => oracle<{ id: string; plan: string; state: string; initiator_type: string; correlation_id: string; max_operations: number; operations_used: number; budget_content_items: number; started_at: Date | null; requested_at: Date }>(
    "select id, plan, state, initiator_type, correlation_id, max_operations, operations_used, budget_content_items, started_at, requested_at from ingestion.reconciliation_runs where workspace_id = $1 and connected_account_id = $2 order by requested_at, id",
    [t.workspaceId, account]);
  const slicesOf = (runId: string) => oracle<{ unit: string; state: string; content_item_id: string | null; window_end: Date }>(
    "select unit, state, content_item_id, window_end from ingestion.reconciliation_slices where reconciliation_run_id = $1 order by created_at, id", [runId]);
  const contentId = async (t: Tenant, providerId: string): Promise<string> =>
    (await oracle<{ id: string }>("select id from content.content_items where workspace_id = $1 and provider_content_id = $2", [t.workspaceId, providerId]))[0]?.id ?? "";
  const interaction = (t: Tenant, providerId: string) => oracle<{ id: string; observed: boolean; parent_interaction_id: string | null; conversation_id: string | null; current_visibility: string | null; current_availability: string | null; current_removal_basis: string | null }>(
    "select id, observed, parent_interaction_id, conversation_id, current_visibility, current_availability, current_removal_basis from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerId]).then((rows) => rows[0]);
  const observationsOf = (t: Tenant, providerId: string) => oracle<{ mechanism: string; removal_basis: string | null }>(
    `select o.mechanism, o.removal_basis from interactions.state_observations o join interactions.interactions i on i.workspace_id = o.workspace_id and i.id = o.interaction_id
      where o.workspace_id = $1 and i.provider_interaction_id = $2 order by o.observed_at, o.created_at`, [t.workspaceId, providerId]);
  const eventsOf = (t: Tenant, providerId: string) => oracle<{ change: string; arrival: string }>(
    `select e.change, e.arrival from ingestion.ingestion_events e join interactions.interactions i on i.workspace_id = e.workspace_id and i.id = e.interaction_id
      where e.workspace_id = $1 and i.provider_interaction_id = $2 order by e.created_at`, [t.workspaceId, providerId]);
  const coverageCount = (t: Tenant) => count("select count(*)::int as n from coverage.coverage_records where workspace_id = $1", [t.workspaceId]);
  const watermarks = (t: Tenant) => oracle<{ content_item_id: string; epoch_at: Date; synced_through: Date | null; latest_created_at: Date | null }>(
    "select content_item_id, epoch_at, synced_through, latest_created_at from ingestion.reconciliation_watermarks where workspace_id = $1 order by content_item_id", [t.workspaceId]);
  const canonicalCounts = async (t: Tenant) => ({
    interactions: await count("select count(*)::int as n from interactions.interactions where workspace_id = $1", [t.workspaceId]),
    conversations: await count("select count(*)::int as n from conversations.conversations where workspace_id = $1", [t.workspaceId]),
    coverage: await coverageCount(t),
    watermarks: (await watermarks(t)).length,
    versions: await count("select count(*)::int as n from interactions.source_text_versions where workspace_id = $1", [t.workspaceId]),
  });

  /** Every settled workspace: nothing open, every row delivered and COMPLETED, no unknown task, IDs-only signal rows. */
  const assertQuiescent = async (h: Harness) => {
    const t = h.t;
    expect(await count("select count(*)::int as n from ingestion.reconciliation_runs where workspace_id = $1 and state in ('REQUESTED', 'RUNNING')", [t.workspaceId]), "no open run").toBe(0);
    expect(await count("select count(*)::int as n from ingestion.reconciliation_slices where workspace_id = $1 and state in ('PENDING', 'RUNNING')", [t.workspaceId]), "no open slice").toBe(0);
    const outbox = await oracle<{ topic: string; status: string; run_outcome: string | null; last_failure_class: string | null; subject_ids: Record<string, string> }>(
      "select topic, status, run_outcome, last_failure_class, subject_ids from system.outbox where workspace_id = $1", [t.workspaceId]);
    expect(outbox.filter((row) => row.status !== "DISPATCHED" || row.run_outcome !== "COMPLETED"), "every row delivered and COMPLETED").toEqual([]);
    expect(outbox.filter((row) => row.last_failure_class === "unknown_task"), "50. zero unknown_task").toEqual([]);
    for (const row of outbox.filter((r) => r.topic === PROCESS)) {
      const keys = Object.keys(row.subject_ids).sort();
      expect([["connected_account_id"], ["connected_account_id", "provider_event_hint_id"]], "49. IDs-only signal subjects").toContainEqual(keys);
    }
    expect(await count("select count(*)::int as n from (select provider_interaction_id from interactions.interactions where workspace_id = $1 group by 1 having count(*) > 1) d", [t.workspaceId]), "no duplicate canonical row").toBe(0);
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 1);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 2);
    logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date() });
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.query("delete from system.provider_event_inbox");
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Facebook: new interactions through targeted relist", () => {
    let h: Harness;
    let organic: string;
    beforeAll(async () => {
      h = await harness();
      await h.reconcile(h.t.fb);
      organic = await contentId(h.t, "fb_post_organic_01");
      h.world.advanceClock(3600);
    });

    it("1, 2, 31, 33, 34, 47. a new comment: a relist mark, scheduled after the skew, then ONE relist run (no listing, 10 ops) imports it as webhook_relist / realtime", async () => {
      const comment = h.world.audienceComment("fb_post_organic_01", "fb_user_02", "Synthetic signalled comment (H6-F4).");
      h.world.advanceClock(5);
      const callsBefore = h.calls.length;
      const before = await canonicalCounts(h.t);
      expect(await h.signal({ platform: "facebook", target: comment, content: "fb_post_organic_01" })).toBe("PLANNED_RELIST");
      // 47–48: the signal itself read nothing and wrote nothing canonical (no provider call from MAIN, no coverage).
      expect(h.calls.length).toBe(callsBefore);
      expect(await canonicalCounts(h.t)).toEqual(before);
      const [mark] = await marks(h.t);
      expect(mark).toMatchObject({ kind: "relist", content_item_id: organic, signal_count: 1, requested_run_id: null });
      // Scheduled for the instant a run could satisfy it: last signal + 120 s (+1 s).
      // H6-F4d: DB-anchored — DB now + (last signal + 121 s − run-clock now).
      expect(Math.abs(await revisitDelay(mark?.id) - (SIGNAL_RUNTIME.skewMs + 1000))).toBeLessThan(1000);
      // H6-F4d: the expiry is DB-anchored too (DB now + 7 days at the upsert).
      expect((await oracle<{ ms: number }>("select (extract(epoch from expires_at - created_at) * 1000)::float8 as ms from ingestion.signal_marks where id = $1", [mark?.id]))[0]?.ms).toBe(SIGNAL_RUNTIME.markTtlMs);
      expect((await runs(h.t)).filter((r) => r.plan === "relist")).toEqual([]);

      await h.elapse(125);
      const relist = (await runs(h.t)).filter((r) => r.plan === "relist");
      expect(relist).toHaveLength(1);
      expect(relist[0]).toMatchObject({ state: "COMPLETED", initiator_type: "system", correlation_id: `sig.${mark?.id ?? ""}`, max_operations: 10, budget_content_items: 10 });
      // 31: no content listing in a relist run; 2: the listing is never consulted, so a post's age doesn't matter.
      const chain = await slicesOf(relist[0]?.id ?? "");
      expect(chain.map((s) => [s.unit, s.state, s.content_item_id])).toEqual([["content_interactions", "COMPLETED", organic]]);
      expect(chain[0]?.window_end.getTime()).toBe(relist[0]?.started_at?.getTime());
      expect(h.calls.slice(callsBefore).map((c) => c.operation)).toEqual(["listInteractions"]);
      // 33–34: imported through the ONE canonical path, provenance webhook_relist, arrival realtime (created after the epoch).
      expect(await interaction(h.t, comment)).toMatchObject({ observed: true, current_availability: "available" });
      expect((await observationsOf(h.t, comment)).map((o) => o.mechanism)).toEqual(["webhook_relist"]);
      expect(await eventsOf(h.t, comment)).toEqual([{ change: "created", arrival: "realtime" }]);
      // 16: satisfied (signal ≤ start − 120 s) and deleted.
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("3, 13 (FB reply). a reply signal relists its content: parent and conversation come from the reread", async () => {
      const comment = h.world.audienceComment("fb_post_organic_01", "fb_user_03", "Synthetic parent (H6-F4).");
      h.world.advanceClock(60);
      const reply = h.world.audienceReply(comment, "fb_user_04", "Synthetic reply (H6-F4).");
      h.world.advanceClock(5);
      expect(await h.signal({ platform: "facebook", target: reply, content: "fb_post_organic_01", parent: comment })).toBe("PLANNED_RELIST");
      await h.elapse(125);
      const [parent, child] = [await interaction(h.t, comment), await interaction(h.t, reply)];
      expect(child?.parent_interaction_id).toBe(parent?.id);
      expect(child?.conversation_id).toBe(parent?.conversation_id);
      expect(parent?.conversation_id).not.toBeNull();
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("6, 25. a duplicate hint is one hint; a redelivered process_signals converges on one mark and at most one run", async () => {
      const comment = h.world.audienceComment("fb_post_boosted_02", "fb_user_02", "Synthetic duplicate (H6-F4).");
      h.world.advanceClock(5);
      const key = sha(randomUUID());
      const hint = await h.receive({ platform: "facebook", target: comment, content: "fb_post_boosted_02", hintKey: key });
      expect(await h.receive({ platform: "facebook", target: comment, content: "fb_post_boosted_02", hintKey: key })).toBe(hint);
      await h.router();
      await h.settle();
      const rows = await oracle<{ subject_ids: Record<string, string>; correlation_id: string; dispatch_key: string; id: string }>(
        "select id, subject_ids, correlation_id, dispatch_key from system.outbox where workspace_id = $1 and topic = $2 and subject_ids ->> 'provider_event_hint_id' = $3", [h.t.workspaceId, PROCESS, hint]);
      expect(rows).toHaveLength(1);
      // Redelivery of the SAME row (a recovered crashed run): same hint, same account, same workspace.
      await h.redeliver({ v: 1, scope: "workspace", task: PROCESS, workspaceId: h.t.workspaceId, outboxId: rows[0]?.id, subjectIds: rows[0]?.subject_ids, correlationId: rows[0]?.correlation_id, initiator: { type: "system" } });
      const pending = await marks(h.t);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.signal_count).toBe(2);
      await h.elapse(125);
      expect((await runs(h.t)).filter((r) => r.plan === "relist")).toHaveLength(3);
      expect(await interaction(h.t, comment)).toMatchObject({ observed: true });
      await assertQuiescent(h);
    });

    it("7. a burst of 30 signals for one content is ONE mark and ONE run", async () => {
      const relistBefore = (await runs(h.t)).filter((r) => r.plan === "relist").length;
      for (let i = 0; i < 30; i += 1) {
        await h.receive({ platform: "facebook", target: `fb_burst_${String(i).padStart(3, "0")}`, content: "fb_post_organic_01" });
      }
      await h.router();
      await h.settle();
      const pending = await marks(h.t);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ kind: "relist", content_item_id: organic, signal_count: 30 });
      await h.elapse(125);
      expect((await runs(h.t)).filter((r) => r.plan === "relist").length - relistBefore).toBe(1);
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("8, 9. edit, hide and unhide of a canonical (old) comment: ONE confirm mark, one immediate H6-E read, later changes coalesce into one trailing read after the cooldown", async () => {
      const target = "fb_c_004";
      const record = await interaction(h.t, target);
      const confirmationRows = () => oracle<{ id: string; dispatch_key: string; subject_ids: Record<string, string> }>(
        "select id, dispatch_key, subject_ids from system.outbox where workspace_id = $1 and topic = $2 order by created_at", [h.t.workspaceId, CONFIRM]);
      const versions = () => count("select count(*)::int as n from interactions.source_text_versions where workspace_id = $1 and interaction_id = $2", [h.t.workspaceId, record?.id]);
      const before = await versions();
      h.world.editInteraction(target, "Synthetic edited text (H6-F4).");
      expect(await h.signal({ platform: "facebook", target, content: "fb_post_organic_01", change: "edited" })).toBe("PLANNED_CONFIRMATION");
      const [mark] = await confirmMarks(h.t);
      expect(mark).toMatchObject({ interaction_id: record?.id, signal_count: 1, dispatch_generation: 1 });
      const [first] = await confirmationRows();
      // H6-F4d: one confirmation per (mark lifetime, claim generation), appended with the claim.
      expect(first?.dispatch_key).toBe(`ingestion.confirm_interaction:${mark?.id ?? ""}:g1`);
      expect(Object.keys(first?.subject_ids ?? {}).sort()).toEqual(["connected_account_id", "interaction_id"]);
      expect(await versions()).toBe(before + 1);
      // The read succeeded: confirmed through its exact DB read start; the mark stays through the cooldown.
      const confirmed = (await confirmMarks(h.t))[0];
      expect(confirmed?.confirmed_through_at?.getTime()).toBe(confirmed?.read_started_at?.getTime());
      // A redelivery of the same routed row requests nothing new.
      const hint = (await oracle<{ id: string }>("select id from system.provider_event_hints where provider_target_id = $1 and change = 'edited' order by received_at desc limit 1", [target]))[0]?.id ?? "";
      const routed = (await oracle<{ id: string; subject_ids: Record<string, string>; correlation_id: string }>(
        "select id, subject_ids, correlation_id from system.outbox where workspace_id = $1 and topic = $2 and subject_ids ->> 'provider_event_hint_id' = $3", [h.t.workspaceId, PROCESS, hint]))[0];
      await h.redeliver({ v: 1, scope: "workspace", task: PROCESS, workspaceId: h.t.workspaceId, outboxId: routed?.id, subjectIds: routed?.subject_ids, correlationId: routed?.correlation_id, initiator: { type: "system" } });
      expect(await confirmationRows()).toHaveLength(1);
      // Later changes seconds apart coalesce into the same mark: no new H6-E request during the cooldown.
      h.world.nativeHide(target);
      expect(await h.signal({ platform: "facebook", target, content: "fb_post_organic_01", change: "hidden" })).toBe("PLANNED_CONFIRMATION");
      expect(await confirmationRows()).toHaveLength(1);
      expect((await interaction(h.t, target))?.current_visibility).toBe("visible");
      // After the cooldown: exactly ONE trailing read (the newer signal is after the last read start).
      await h.elapse(SIGNAL_RUNTIME.confirmationCooldownMs / 1000 + 5);
      expect(await confirmationRows()).toHaveLength(2);
      expect((await interaction(h.t, target))?.current_visibility).toBe("hidden");
      // Caught up after the next cooldown: the mark goes, with no further read.
      await h.elapse(SIGNAL_RUNTIME.confirmationCooldownMs / 1000 + 5);
      expect(await confirmationRows()).toHaveLength(2);
      expect(await confirmMarks(h.t)).toEqual([]);
      // A later change (a new mark lifetime) gets its own immediate read again.
      h.world.nativeUnhide(target);
      expect(await h.signal({ platform: "facebook", target, content: "fb_post_organic_01", change: "unhidden" })).toBe("PLANNED_CONFIRMATION");
      expect((await interaction(h.t, target))?.current_visibility).toBe("visible");
      expect(await confirmationRows()).toHaveLength(3);
      await h.elapse(SIGNAL_RUNTIME.confirmationCooldownMs / 1000 + 5);
      expect(await confirmMarks(h.t)).toEqual([]);
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("10, 11. removal: canonical → confirmation (the signal writes no tombstone; any removal basis is the reread's); non-canonical → nothing", async () => {
      const target = "fb_c_005";
      h.world.removeAtSource(target, { signaled: false });
      const hint = await h.receive({ platform: "facebook", target, content: "fb_post_organic_01", change: "removed" });
      await h.router();
      // Delivered but not yet confirmed: the signal alone changed nothing.
      await h.step();
      expect(hint).not.toBe("");
      expect(await interaction(h.t, target)).toMatchObject({ current_availability: "available", current_removal_basis: null });
      await h.settle();
      expect(h.outcomes.at(-1)).toBe("PLANNED_CONFIRMATION");
      const basis = (await observationsOf(h.t, target)).map((o) => o.removal_basis).filter((b) => b !== null);
      expect(basis.every((b) => b === "direct_fetch_confirmed")).toBe(true);
      expect(await count("select count(*)::int as n from interactions.state_observations where workspace_id = $1 and removal_basis = 'explicit_provider_signal'", [h.t.workspaceId])).toBe(0);
      const rows = (await canonicalCounts(h.t)).interactions;
      expect(await h.signal({ platform: "facebook", target: "fb_never_seen_001", content: "fb_post_organic_01", change: "removed" })).toBe("SKIPPED_NON_CANONICAL_REMOVAL");
      expect((await canonicalCounts(h.t)).interactions).toBe(rows);
      expect(await interaction(h.t, "fb_never_seen_001")).toBeUndefined();
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("12, 13, 32. unknown content → account mark; an account mark wins over relist marks; the account run is unchanged but bounded (10 ops, 9 contents)", async () => {
      expect(await h.signal({ platform: "facebook", target: "fb_c_on_unknown_post", content: "fb_post_not_canonical_77" })).toBe("PLANNED_ACCOUNT");
      expect(lines.some((line) => line.includes("signal.content_not_canonical"))).toBe(true);
      expect(await h.signal({ platform: "facebook", target: "fb_c_more_001", content: "fb_post_boosted_02" })).toBe("PLANNED_ACCOUNT");
      expect((await marks(h.t)).map((m) => m.kind)).toEqual(["account", "relist"]);
      expect(await interaction(h.t, "fb_c_on_unknown_post")).toBeUndefined();
      expect(await count("select count(*)::int as n from content.content_items where workspace_id = $1 and provider_content_id = 'fb_post_not_canonical_77'", [h.t.workspaceId])).toBe(0);
      const before = (await runs(h.t)).length;
      await h.elapse(125);
      const added = (await runs(h.t)).slice(before);
      expect(added.map((r) => [r.plan, r.state, r.max_operations, r.budget_content_items])).toEqual([["account", "COMPLETED", 10, 9]]);
      expect((await slicesOf(added[0]?.id ?? ""))[0]?.unit).toBe("content_listing");
      // The account run traversed the listed content to the end: both marks are satisfied by it.
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("14, 15, 17, 41, 42. an open run absorbs a signal; a signal after its start survives the close hook; exactly one follow-up satisfies it", async () => {
      h.world.advanceClock(SIGNAL_RUNTIME.runWindowMs / 1000);
      const manual = await h.request(h.t.fb);
      const comment = h.world.audienceComment("fb_post_boosted_02", "fb_user_02", "Synthetic during run (H6-F4).");
      expect(await h.signal({ platform: "facebook", target: comment, content: "fb_post_boosted_02" })).toBe("ABSORBED");
      const after = await runs(h.t);
      expect(after.find((r) => r.id === manual)?.state).toBe("COMPLETED");
      // The manual run started before the signal (+ skew): it did not satisfy the mark; the close hook kept it.
      const [mark] = await marks(h.t);
      expect(mark).toMatchObject({ kind: "relist" });
      expect(mark?.deferred_until).not.toBeNull();
      const before = after.length;
      await h.elapse(125);
      const followUps = (await runs(h.t)).slice(before);
      expect(followUps.map((r) => [r.plan, r.state])).toEqual([["relist", "COMPLETED"]]);
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("44. an expired mark is deleted with a metric; coverage, watermarks and canonical rows are untouched", async () => {
      h.world.advanceClock(SIGNAL_RUNTIME.runWindowMs / 1000);
      await h.receive({ platform: "facebook", target: "fb_c_expiring", content: "fb_post_organic_01" });
      await h.router();
      await h.settle();
      const [mark] = await marks(h.t);
      const now = h.clock();
      // H6-F4d: expiry is DB time (DB now + 7 days at upsert); simulate it passing on the DB clock.
      await privileged.query("update ingestion.signal_marks set first_signal_at = $2, last_signal_at = $2, expires_at = now() - interval '1 second', deferred_until = now() - interval '1 second' where id = $1",
        [mark?.id, new Date(now.getTime() - 8 * 86_400_000)]);
      const before = await canonicalCounts(h.t);
      lines.length = 0;
      await h.elapse(1);
      expect(h.outcomes.at(-1)).toBe("EXPIRED");
      expect(lines.some((line) => line.includes("signal.mark_expired"))).toBe(true);
      expect(await marks(h.t)).toEqual([]);
      expect(await canonicalCounts(h.t)).toEqual(before);
      await assertQuiescent(h);
    });

    it("27. a paused provider retains the signal (deferred mark), and the revisit after the pause plans it", async () => {
      // A fresh hour: the earlier cases spent this account's signal-run capacity (the cap is per rolling hour).
      h.world.advanceClock(SIGNAL_RUNTIME.runWindowMs / 1000);
      await switchChange("insert into system.operational_switches (switch_key, qualifier, scope, value) values ('ingestion.provider_pause', 'facebook', 'global', '{\"paused\": true}')");
      try {
        expect(await h.signal({ platform: "facebook", target: "fb_c_paused_001", content: "fb_post_organic_01" })).toBe("SKIPPED_PAUSED");
        const [mark] = await marks(h.t);
        expect(Math.abs(await revisitDelay(mark?.id) - SIGNAL_RUNTIME.revisitMs)).toBeLessThan(1000);
        await h.elapse(SIGNAL_RUNTIME.revisitMs / 1000);
        expect(h.outcomes.at(-1)).toBe("SKIPPED_PAUSED");
        expect(await marks(h.t)).toHaveLength(1);
      } finally {
        await switchChange("delete from system.operational_switches where switch_key = 'ingestion.provider_pause' and qualifier = 'facebook'");
      }
      await h.elapse(SIGNAL_RUNTIME.revisitMs / 1000);
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("39, 40. a crash anywhere in processing rolls back everything (one transaction); redelivery converges", async () => {
      h.world.advanceClock(SIGNAL_RUNTIME.runWindowMs / 1000);
      const hint = await h.receive({ platform: "facebook", target: "fb_c_crash_001", content: "fb_post_boosted_02" });
      // Routed (the IDs-only row is PENDING), not yet delivered: the crash happens inside the consumer's transaction.
      await h.router();
      const failing = withWorkspaceJobScope(worker, h.t.workspaceId, async (tx) => {
        const result = await processProviderSignal(reconciliationScope({ tx, noteOutbox: () => undefined }), h.ids, { connectedAccountId: h.t.fb, providerEventHintId: hint, correlationId: correlation() });
        expect(result.outcome).toBe("PLANNED_RELIST");
        throw new Error("crash after the mark upsert and the review");
      });
      await expect(failing).rejects.toThrow("crash");
      expect(await marks(h.t)).toEqual([]);
      // The routed row is still there to deliver: the outcome is the same, exactly once.
      await h.settle();
      expect(await marks(h.t)).toHaveLength(1);
      await h.elapse(125);
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("26. an account deactivated after routing: SKIPPED_ACCOUNT_INACTIVE, no mark, no work", async () => {
      await h.receive({ platform: "facebook", target: "fb_c_moved_001", content: "fb_post_organic_01" });
      await h.router();
      await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED', updated_at = now() where id = $1", [h.t.fb]);
      const before = (await runs(h.t)).length;
      await h.settle();
      expect(h.outcomes.at(-1)).toBe("SKIPPED_ACCOUNT_INACTIVE");
      expect(await marks(h.t)).toEqual([]);
      expect((await runs(h.t)).length).toBe(before);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Facebook: signal budget, follow-ups and the hourly cap", () => {
    let h: Harness;
    let organic: string;
    beforeAll(async () => {
      h = await harness();
      await h.reconcile(h.t.fb);
      organic = await contentId(h.t, "fb_post_organic_01");
      h.world.advanceClock(3600);
    });

    it("18, 19, 36, 37. ten operations exhaust honestly and PARK the cursor; the follow-up continues it (original window) and completes — no manual Sync", async () => {
      for (let i = 0; i < 32; i += 1) h.world.audienceComment("fb_post_organic_01", "fb_user_02", `Synthetic busy comment ${String(i)} (H6-F4).`);
      const marksBefore = await watermarks(h.t);
      h.world.advanceClock(5);
      expect(await h.signal({ platform: "facebook", target: "fb_c_busy_signal", content: "fb_post_organic_01" })).toBe("PLANNED_RELIST");
      await h.elapse(125);
      const signalRuns = (await runs(h.t)).filter((r) => r.correlation_id.startsWith("sig."));
      // Run 1 exhausts its 10 operations (PARTIAL, cursor parked); run 2 adopts the cursor and reaches the provider's end.
      expect(signalRuns.map((r) => [r.plan, r.state, r.max_operations])).toEqual([["relist", "PARTIAL", 10], ["relist", "COMPLETED", 10]]);
      const [run1, run2] = signalRuns;
      const chain1 = await slicesOf(run1?.id ?? "");
      const [s2] = await slicesOf(run2?.id ?? "");
      // Run 1: two 5-page slices CONTINUED (10 operations), then the next continuation had none left: parked unread.
      expect(chain1.map((slice) => slice.state)).toEqual(["CONTINUED", "CONTINUED", "ABANDONED_BUDGET"]);
      expect(chain1.at(-1)).toMatchObject({ unit: "content_interactions", content_item_id: organic });
      // The continuation keeps the ORIGINAL traversal window (its end is run 1's start, never run 2's).
      expect(s2?.window_end.getTime()).toBe(run1?.started_at?.getTime());
      expect(s2?.window_end.getTime()).toBeLessThan(run2?.started_at?.getTime() ?? 0);
      // Satisfied by the completed traversal (signal + 120 s ≤ its original start); the parked cursor was consumed.
      expect(await marks(h.t)).toEqual([]);
      expect(await count("select count(*)::int as n from ingestion.reconciliation_slices where workspace_id = $1 and cursor is not null", [h.t.workspaceId])).toBe(0);
      // Coverage was incomplete after run 1 and complete after run 2; the watermark moved only at completion.
      const latest = await oracle<{ state: string; reason: string }>(
        "select state, reason from coverage.coverage_records where workspace_id = $1 and content_item_id = $2 order by created_at desc limit 2", [h.t.workspaceId, organic]);
      expect(latest.map((r) => r.state)).toEqual(["COMPLETE", "COMPLETE"]);
      const organicMark = (await watermarks(h.t)).find((w) => w.content_item_id === organic);
      expect(organicMark?.synced_through?.getTime()).toBe(run1?.started_at?.getTime());
      expect(organicMark?.synced_through?.getTime()).toBeGreaterThan(marksBefore.find((w) => w.content_item_id === organic)?.synced_through?.getTime() ?? Infinity);
      await assertQuiescent(h);
    });

    it("22. a manual Sync is not a signal run: it keeps 40 operations and is never counted by the cap", async () => {
      const id = await h.reconcile(h.t.fb);
      const manual = (await runs(h.t)).find((r) => r.id === id);
      expect(manual).toMatchObject({ plan: "account", state: "COMPLETED", max_operations: 40 });
      expect(manual?.correlation_id.startsWith("sig.")).toBe(false);
      const attributed = await count(
        "select count(*)::int as n from ingestion.reconciliation_runs where workspace_id = $1 and connected_account_id = $2 and initiator_type = 'system' and correlation_id like 'sig.%'", [h.t.workspaceId, h.t.fb]);
      expect(attributed).toBe(2);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Facebook: the hourly cap over completed signal runs", () => {
    let h: Harness;
    beforeAll(async () => {
      h = await harness();
      await h.reconcile(h.t.fb);
      h.world.advanceClock(3600);
    });

    it("20, 21, 23, 24. six signal runs an hour are allowed, the seventh defers; after the window ONE run serves both dispatched marks", async () => {
      for (let i = 0; i < 6; i += 1) {
        expect(await h.signal({ platform: "facebook", target: `fb_c_cap_${String(i)}`, content: "fb_post_boosted_02" }), `signal ${String(i)}`).toBe("PLANNED_RELIST");
        await h.elapse(125);
      }
      const six = (await runs(h.t)).filter((r) => r.correlation_id.startsWith("sig."));
      expect(six.map((r) => [r.plan, r.state])).toEqual(Array.from({ length: 6 }, () => ["relist", "COMPLETED"]));
      expect(await h.signal({ platform: "facebook", target: "fb_c_capped_a", content: "fb_post_organic_01" })).toBe("DEFERRED");
      expect(await h.signal({ platform: "facebook", target: "fb_c_capped_b", content: "fb_post_boosted_02" })).toBe("DEFERRED");
      const deferred = await marks(h.t);
      expect(deferred).toHaveLength(2);
      for (const mark of deferred) {
        const delay = await revisitDelay(mark.id);
        expect(delay).toBeGreaterThan(SIGNAL_RUNTIME.runWindowMs - 15 * 60_000);
        expect(delay).toBeLessThanOrEqual(SIGNAL_RUNTIME.runWindowMs + 1000);
      }
      const before = (await runs(h.t)).length;
      const dispatched = h.outcomes.length;
      await h.elapse(SIGNAL_RUNTIME.runWindowMs / 1000 + 120);
      // Two due rows (one per mark, generation + 1), one run: the second is absorbed by the first's open run.
      expect([...h.outcomes.slice(dispatched)].sort()).toEqual(["ABSORBED", "PLANNED_RELIST"]);
      const added = (await runs(h.t)).slice(before);
      expect(added.map((r) => [r.plan, r.state])).toEqual([["relist", "COMPLETED"]]);
      expect((await slicesOf(added[0]?.id ?? "")).map((s) => s.unit)).toEqual(["content_interactions", "content_interactions"]);
      expect(await marks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Instagram: comments relist, replies stay unread; accounts are isolated", () => {
    let h: Harness;
    beforeAll(async () => {
      h = await harness();
      await h.reconcile(h.t.ig);
      h.world.advanceClock(3600);
    });

    it("4, 45. an Instagram comment relists its canonical media; the Facebook account gets nothing", async () => {
      const media = await contentId(h.t, "ig_post_unknown_11");
      const comment = h.world.audienceComment("ig_post_unknown_11", "ig_user_01", "Synthetic Instagram comment (H6-F4).");
      h.world.advanceClock(5);
      expect(await h.signal({ platform: "instagram", target: comment, content: "ig_post_unknown_11" })).toBe("PLANNED_RELIST");
      expect((await marks(h.t, h.t.ig)).map((m) => [m.kind, m.content_item_id])).toEqual([["relist", media]]);
      expect(await marks(h.t, h.t.fb)).toEqual([]);
      await h.elapse(125);
      expect(await interaction(h.t, comment)).toMatchObject({ observed: true });
      expect((await observationsOf(h.t, comment)).map((o) => o.mechanism)).toEqual(["webhook_relist"]);
      expect((await runs(h.t, h.t.ig)).filter((r) => r.plan === "relist")).toHaveLength(1);
      expect(await runs(h.t, h.t.fb)).toEqual([]);
      await assertQuiescent(h);
    });

    it("5, 12 (IG reply). an Instagram reply is SKIPPED_CAPABILITY (REPLIES_NOT_READ): no mark, no run, no reply synthesized", async () => {
      const reply = h.world.audienceReply("ig_c_010", "ig_user_02", "Synthetic Instagram reply (H6-F4).");
      const before = await canonicalCounts(h.t);
      expect(await h.signal({ platform: "instagram", target: reply, content: "ig_post_unknown_11", parent: "ig_c_010" })).toBe("SKIPPED_CAPABILITY");
      expect(await marks(h.t, h.t.ig)).toEqual([]);
      expect(await canonicalCounts(h.t)).toEqual(before);
      expect(await interaction(h.t, reply)).toBeUndefined();
      await assertQuiescent(h);
    });

    it("28. capability lost after routing (a degraded connection): SKIPPED_CAPABILITY — no mark, no run, nothing claimed", async () => {
      const comment = h.world.audienceComment("ig_post_unknown_11", "ig_user_02", "Synthetic comment while degraded (H6-F4).");
      await h.receive({ platform: "instagram", target: comment, content: "ig_post_unknown_11" });
      await h.router();
      await privileged.query("update connections.connections set status = 'DEGRADED', version = version + 1, updated_at = now() where id = $1", [h.t.connection]);
      const before = await canonicalCounts(h.t);
      const runsBefore = (await runs(h.t, h.t.ig)).length;
      try {
        await h.settle();
        expect(h.outcomes.at(-1)).toBe("SKIPPED_CAPABILITY");
        expect(await marks(h.t, h.t.ig)).toEqual([]);
        expect((await runs(h.t, h.t.ig)).length).toBe(runsBefore);
        expect(await canonicalCounts(h.t)).toEqual(before);
      } finally {
        await privileged.query("update connections.connections set status = 'ACTIVE', version = version + 1, updated_at = now() where id = $1", [h.t.connection]);
      }
      await assertQuiescent(h);
    });

    it("46. the worker can never append its own process_signals row (0022 restrictive policy unchanged)", async () => {
      const refused = await sqlState(withWorkspaceJobScope(worker, h.t.workspaceId, (tx) => tx.execute(sql`
        insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${randomUUID()}::uuid, 'ingestion.process_signals', ${h.t.organizationId}::uuid, ${h.t.workspaceId}::uuid,
                jsonb_build_object('connected_account_id', ${h.t.ig}::text), 'h6f4-direct-append', 'system', null, ${`ingestion.process_signals:direct:${randomUUID()}`}, 'PENDING', now())`)));
      expect(refused).toMatchObject({ code: "42501" });
      expect(await oracle("select polname from pg_policy where polrelid = 'system.outbox'::regclass and polname = 'no_direct_signal_routing' and not polpermissive")).toHaveLength(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // Step H6-F4d — 0023 wired into the runtime.
  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
  /** Rewrites a parked cursor's DB parking time as the table owner (test-only: the trigger otherwise keeps it). */
  const ageParkedCursor = async (sliceId: string, minutes: number): Promise<void> => {
    const client = await privileged.connect();
    try {
      await client.query("begin");
      // Only the owner may switch a trigger off; the row itself is rewritten by the privileged login (RLS bypass).
      await client.query("set local role app_owner");
      await client.query("alter table ingestion.reconciliation_slices disable trigger reconciliation_slice_park_cursor");
      await client.query("reset role");
      const updated = await client.query("update ingestion.reconciliation_slices set cursor_parked_at = now() - $2 * interval '1 minute' where id = $1", [sliceId, minutes]);
      if (updated.rowCount !== 1) throw new Error("parked cursor not aged");
      await client.query("set local role app_owner");
      await client.query("alter table ingestion.reconciliation_slices enable trigger reconciliation_slice_park_cursor");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  const parkedSlices = (t: Tenant) => oracle<{ id: string; content_item_id: string; window_start: Date; window_end: Date; reconciliation_run_id: string }>(
    "select id, content_item_id, window_start, window_end, reconciliation_run_id from ingestion.reconciliation_slices where workspace_id = $1 and state = 'ABANDONED_BUDGET' and cursor is not null order by created_at", [t.workspaceId]);
  const comments = (h: Harness, content: string, n: number, tag: string) => {
    for (let i = 0; i < n; i += 1) h.world.audienceComment(content, "fb_user_02", `Synthetic ${tag} comment ${String(i)} (H6-F4d).`);
  };
  const readsOf = (h: Harness, from: number, target: string) => h.calls.slice(from).filter((c) => c.operation === "listInteractions" && c.target === target);

  describe("H6-F4d: cross-run traversal continuation (relist)", () => {
    let h: Harness;
    let boosted: string;
    beforeAll(async () => {
      h = await harness();
      await h.reconcile(h.t.fb);
      boosted = await contentId(h.t, "fb_post_boosted_02");
      h.world.advanceClock(3600);
    });

    it("1–8. a >15-page relist parks, continues monotonically (no page re-read) and completes; coverage and watermark move only at completion", async () => {
      comments(h, "fb_post_boosted_02", 80, "busy");
      const from = h.calls.length;
      h.world.advanceClock(5);
      expect(await h.signal({ platform: "facebook", target: "fb_c_busy_relist", content: "fb_post_boosted_02" })).toBe("PLANNED_RELIST");
      await h.elapse(125);
      const signal = (await runs(h.t)).filter((r) => r.correlation_id.startsWith("sig."));
      expect(signal.map((r) => [r.plan, r.state])).toEqual([["relist", "PARTIAL"], ["relist", "PARTIAL"], ["relist", "COMPLETED"]]);
      // 3. monotonic: one first page only (null cursor), and no cursor ever used twice.
      const reads = readsOf(h, from, "fb_post_boosted_02");
      expect(reads.filter((r) => r.cursor === null)).toHaveLength(1);
      expect(new Set(reads.map((r) => r.cursor)).size).toBe(reads.length);
      expect(reads.length).toBe(signal.reduce((sum, r) => sum + r.operations_used, 0));
      expect(reads.length).toBeGreaterThan(15);
      // Every continuation kept run 1's window (its start is the traversal's authority).
      for (const r of signal.slice(1)) for (const slice of await slicesOf(r.id)) expect(slice.window_end.getTime()).toBe(signal[0]?.started_at?.getTime());
      // 6. satisfied; 7. coverage incomplete until the end, then COMPLETE; 8. the watermark at the ORIGINAL start.
      expect(await marks(h.t)).toEqual([]);
      const history = await oracle<{ state: string; reason: string }>(
        "select state, reason from coverage.coverage_records where workspace_id = $1 and content_item_id = $2 and created_at >= $3 order by created_at, interaction_kind", [h.t.workspaceId, boosted, signal[0]?.requested_at]);
      expect(history.slice(-2).map((r) => r.state)).toEqual(["COMPLETE", "COMPLETE"]);
      // Before the provider's end, nothing was ever claimed complete (in progress or incomplete only).
      expect(history.slice(0, -2).length).toBeGreaterThan(0);
      expect(history.slice(0, -2).every((r) => r.state !== "COMPLETE")).toBe(true);
      expect((await watermarks(h.t)).find((w) => w.content_item_id === boosted)?.synced_through?.getTime()).toBe(signal[0]?.started_at?.getTime());
      expect(await parkedSlices(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("9–10. the cap still binds: a 7th run is deferred, the parked cursor survives the deferral (< 90 min) and the traversal resumes after it", async () => {
      h.world.advanceClock(SIGNAL_RUNTIME.runWindowMs / 1000);
      comments(h, "fb_post_boosted_02", 190, "capped");
      const before = (await runs(h.t)).length;
      h.world.advanceClock(5);
      await h.signal({ platform: "facebook", target: "fb_c_capped_relist", content: "fb_post_boosted_02" });
      await h.elapse(125);
      const window = (await runs(h.t)).slice(before);
      expect(window).toHaveLength(6);
      expect(window.every((r) => r.state === "PARTIAL")).toBe(true);
      const [parked] = await parkedSlices(h.t);
      expect(parked?.content_item_id).toBe(boosted);
      expect((await marks(h.t))[0]?.kind).toBe("relist");
      // After the rolling hour: the continuation resumes from the parked cursor and completes.
      await h.elapse(SIGNAL_RUNTIME.runWindowMs / 1000 + 120);
      const all = (await runs(h.t)).slice(before);
      expect(all.length).toBeGreaterThan(6);
      expect(all.at(-1)?.state).toBe("COMPLETED");
      expect(all.slice(6).every((r) => r.plan === "relist")).toBe(true);
      expect(await marks(h.t)).toEqual([]);
      expect(await parkedSlices(h.t)).toEqual([]);
      await assertQuiescent(h);
    });
  });

  describe("H6-F4d: manual Sync continuation, TTL and invalid cursors", () => {
    let h: Harness;
    let organic: string;
    beforeAll(async () => {
      h = await harness();
      await h.reconcile(h.t.fb);
      organic = await contentId(h.t, "fb_post_organic_01");
      h.world.advanceClock(3600);
    });

    it("14–15. a manual Sync (40 ops) beyond its 15-page content ceiling parks and the NEXT manual Sync continues to completion; never counted by the cap", async () => {
      comments(h, "fb_post_organic_01", 60, "manual");
      h.world.advanceClock(5);
      const from = h.calls.length;
      const first = await h.reconcile(h.t.fb);
      expect((await runs(h.t)).find((r) => r.id === first)).toMatchObject({ plan: "account", state: "PARTIAL", max_operations: 40, initiator_type: "system" });
      const [parked] = await parkedSlices(h.t);
      expect(parked?.content_item_id).toBe(organic);
      const second = await h.reconcile(h.t.fb);
      expect((await runs(h.t)).find((r) => r.id === second)?.state).toBe("COMPLETED");
      const reads = readsOf(h, from, "fb_post_organic_01");
      expect(reads.filter((r) => r.cursor === null)).toHaveLength(1);
      expect(new Set(reads.map((r) => r.cursor)).size).toBe(reads.length);
      expect(reads.length).toBeGreaterThan(15);
      expect((await watermarks(h.t)).find((w) => w.content_item_id === organic)?.synced_through?.getTime()).toBe((await runs(h.t)).find((r) => r.id === first)?.started_at?.getTime());
      expect(await count("select count(*)::int as n from ingestion.reconciliation_runs where workspace_id = $1 and correlation_id like 'sig.%'", [h.t.workspaceId])).toBe(0);
      expect(await parkedSlices(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("11–12. a parked cursor past the 90-minute local TTL is not adopted: it is retired and a fresh traversal starts (new window)", async () => {
      comments(h, "fb_post_organic_01", 60, "stale");
      h.world.advanceClock(5);
      const first = await h.reconcile(h.t.fb);
      const [parked] = await parkedSlices(h.t);
      expect(parked).toBeDefined();
      await ageParkedCursor(parked?.id ?? "", 91);
      const from = h.calls.length;
      const second = await h.reconcile(h.t.fb);
      const chain = (await slicesOf(second)).filter((s) => s.content_item_id === organic);
      expect(chain[0]?.window_end.getTime()).toBe((await runs(h.t)).find((r) => r.id === second)?.started_at?.getTime());
      expect(readsOf(h, from, "fb_post_organic_01")[0]?.cursor).toBeNull();
      expect((await oracle<{ cursor: string | null }>("select cursor from ingestion.reconciliation_slices where id = $1", [parked?.id]))[0]?.cursor).toBeNull();
      expect(first).not.toBe(second);
      // Leave nothing behind for the next case: finish the traversal.
      for (let i = 0; i < 5 && (await parkedSlices(h.t)).length > 0; i += 1) await h.reconcile(h.t.fb);
      await assertQuiescent(h);
    });

    it("13. an adopted cursor the provider refuses restarts the ORIGINAL window once; the traversal still completes; no duplicate rows, no false coverage", async () => {
      h.world.advanceClock(3600);
      comments(h, "fb_post_organic_01", 60, "invalid");
      h.world.advanceClock(5);
      const first = await h.reconcile(h.t.fb);
      const [parked] = await parkedSlices(h.t);
      expect(parked).toBeDefined();
      h.world.injectFaults([{ operation: "listInteractions", target: "fb_post_organic_01", on: 1, fault: { kind: "permanent_rejected", reasonCode: "invalid_cursor" } }]);
      const from = h.calls.length;
      const coverageBefore = await count("select count(*)::int as n from coverage.coverage_records where workspace_id = $1 and content_item_id = $2 and state = 'COMPLETE'", [h.t.workspaceId, organic]);
      const second = await h.reconcile(h.t.fb);
      h.world.clearFaults();
      const reads = readsOf(h, from, "fb_post_organic_01");
      // The refused adopted cursor, then exactly one restart from the window's start (a null cursor), same window.
      expect(reads[0]?.cursor).not.toBeNull();
      expect(reads[1]?.cursor).toBeNull();
      expect(reads.filter((r) => r.cursor === null)).toHaveLength(1);
      const chain = (await slicesOf(second)).filter((s) => s.content_item_id === organic);
      expect(chain[0]?.window_end.getTime()).toBe(parked?.window_end.getTime());
      for (let i = 0; i < 5 && (await parkedSlices(h.t)).length > 0; i += 1) await h.reconcile(h.t.fb);
      expect(await parkedSlices(h.t)).toEqual([]);
      expect(await count("select count(*)::int as n from coverage.coverage_records where workspace_id = $1 and content_item_id = $2 and state = 'COMPLETE'", [h.t.workspaceId, organic])).toBeGreaterThan(coverageBefore);
      expect(first).not.toBe(second);
      await assertQuiescent(h);
    });
  });

  describe("H6-F4d: a newer signal is never satisfied by finishing an older traversal", () => {
    let injected = false;
    let pending: (() => Promise<void>) | undefined;
    let h: Harness;
    let organic: string;
    beforeAll(async () => {
      h = await harness({ onRead: async (operation, target) => {
        if (operation === "listInteractions" && target === "fb_post_organic_01" && pending !== undefined && !injected) {
          injected = true;
          await pending();
        }
      } });
      await h.reconcile(h.t.fb);
      organic = await contentId(h.t, "fb_post_organic_01");
      h.world.advanceClock(3600);
    });

    it("16. a signal arriving after run 1 began keeps the mark through the continuation; a later fresh traversal satisfies it", async () => {
      comments(h, "fb_post_organic_01", 40, "race");
      h.world.advanceClock(5);
      await h.signal({ platform: "facebook", target: "fb_c_race_1", content: "fb_post_organic_01" });
      // The second signal is received while run 1 reads (after its start T0).
      pending = async () => { await h.receive({ platform: "facebook", target: "fb_c_race_2", content: "fb_post_organic_01" }); };
      await h.elapse(125);
      const signal = (await runs(h.t)).filter((r) => r.correlation_id.startsWith("sig."));
      const run1 = signal[0];
      // Run 2 finished the ORIGINAL traversal (window end = run 1's start): the newer signal stayed pending through it.
      const continued = signal.find((r) => r.id !== run1?.id && r.state === "COMPLETED");
      expect(continued).toBeDefined();
      expect((await slicesOf(continued?.id ?? ""))[0]?.window_end.getTime()).toBe(run1?.started_at?.getTime());
      // Eventually a traversal that STARTED after the newer signal completes and satisfies it.
      for (let i = 0; i < 6 && (await marks(h.t)).length > 0; i += 1) await h.elapse(125);
      expect(await marks(h.t)).toEqual([]);
      const last = (await runs(h.t)).filter((r) => r.correlation_id.startsWith("sig.")).at(-1);
      expect((last?.started_at?.getTime() ?? 0)).toBeGreaterThan(run1?.started_at?.getTime() ?? Infinity);
      expect(injected).toBe(true);
      expect(organic).toBeDefined();
      await assertQuiescent(h);
    });
  });

  describe("H6-F4d: confirm marks — immediate + trailing, bounded reads", () => {
    let during: (() => Promise<void>) | undefined;
    let h: Harness;
    beforeAll(async () => {
      h = await harness({ onRead: async (operation) => {
        if (operation === "getInteraction" && during !== undefined) {
          const work = during;
          during = undefined;
          await work();
        }
      } });
      await h.reconcile(h.t.fb);
    });
    const directReads = (from: number, target: string) => h.calls.slice(from).filter((c) => c.operation === "getInteraction" && c.target === target).length;
    const requests = () => count("select count(*)::int as n from system.outbox where workspace_id = $1 and topic = $2", [h.t.workspaceId, CONFIRM]);
    const cooldown = () => h.elapse(SIGNAL_RUNTIME.confirmationCooldownMs / 1000 + 5);
    const burst = async (target: string, n: number, change: HintSpec["change"] = "edited") => {
      for (let i = 0; i < n; i += 1) await h.receive({ platform: "facebook", target, content: "fb_post_organic_01", change });
      await h.router();
      await h.settle();
    };

    it("17–21, 24, 31–32. 100 signals before the first read: ONE mark, ONE generation, ONE read; caught up after the cooldown with no further read; exact microseconds", async () => {
      const from = h.calls.length;
      const before = await requests();
      h.world.editInteraction("fb_c_004", "Synthetic burst edit (H6-F4d).");
      await burst("fb_c_004", 100);
      const [mark] = await confirmMarks(h.t);
      expect(mark).toMatchObject({ signal_count: 100, dispatch_generation: 1 });
      expect((await requests()) - before).toBe(1);
      expect(directReads(from, "fb_c_004")).toBe(1);
      // 31: confirmed through EXACTLY the DB read start, microseconds included.
      const exact = (await oracle<{ same: boolean; fraction: string }>(
        "select confirmed_through_at::text = read_started_at::text as same, to_char(read_started_at, 'US') as fraction from ingestion.signal_marks where id = $1", [mark?.id]))[0];
      expect(exact?.same).toBe(true);
      expect(exact?.fraction).toMatch(/^\d{6}$/);
      // 24: no newer signal than the read start → caught up: no trailing read.
      await cooldown();
      expect(await confirmMarks(h.t)).toEqual([]);
      expect((await requests()) - before).toBe(1);
      expect(directReads(from, "fb_c_004")).toBe(1);
      await assertQuiescent(h);
    });

    it("22, 25. a signal arriving DURING the read requires exactly one trailing read after the cooldown; then caught up", async () => {
      const from = h.calls.length;
      const before = await requests();
      during = async () => { await h.receive({ platform: "facebook", target: "fb_c_004", content: "fb_post_organic_01", change: "edited" }); await h.router(); };
      h.world.editInteraction("fb_c_004", "Synthetic during-read edit (H6-F4d).");
      await burst("fb_c_004", 1);
      const [mark] = await confirmMarks(h.t);
      expect((mark?.last_signal_at.getTime() ?? 0)).toBeGreaterThan(mark?.confirmed_through_at?.getTime() ?? Infinity);
      await cooldown();
      expect((await requests()) - before).toBe(2);
      expect(directReads(from, "fb_c_004")).toBe(2);
      await cooldown();
      expect(await confirmMarks(h.t)).toEqual([]);
      expect(directReads(from, "fb_c_004")).toBe(2);
      await assertQuiescent(h);
    });

    it("26. sustained changes: at most one read per 5-minute cooldown", async () => {
      const from = h.calls.length;
      for (let minute = 0; minute < 12; minute += 1) {
        await burst("fb_c_005", 1);
        await h.elapse(60);
      }
      for (let i = 0; i < 3; i += 1) await cooldown();
      const reads = directReads(from, "fb_c_005");
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(reads).toBeLessThanOrEqual(Math.ceil(12 / 5) + 1);
      expect(await confirmMarks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("27–28. a removal signal uses the same bounded flow; an authoritative not-found keeps H6-E's removal semantics", async () => {
      h.world.removeAtSource("fb_c_003", { signaled: false });
      await burst("fb_c_003", 5, "removed");
      const [mark] = await confirmMarks(h.t);
      expect(mark?.confirmed_through_at).not.toBeNull();
      expect(await interaction(h.t, "fb_c_003")).toMatchObject({ current_availability: "removed_at_source", current_removal_basis: "direct_fetch_confirmed" });
      expect(await count("select count(*)::int as n from interactions.state_observations where workspace_id = $1 and removal_basis = 'explicit_provider_signal'", [h.t.workspaceId])).toBe(0);
      await cooldown();
      expect(await confirmMarks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("29. an ambiguous not-found (Meta 100/33 shape) does NOT confirm: the mark stays, backed off, nothing removed", async () => {
      h.world.injectFaults([{ operation: "getInteraction", target: "fb_c_006", on: "every", fault: { kind: "target_not_found" } }]);
      try {
        await burst("fb_c_006", 1, "removed");
        const [mark] = await confirmMarks(h.t);
        expect(mark).toMatchObject({ confirmed_through_at: null, dispatch_generation: 1 });
        expect(mark?.read_started_at).not.toBeNull();
        expect(await interaction(h.t, "fb_c_006")).toMatchObject({ current_availability: "available", current_removal_basis: null });
        expect(await revisitDelay(mark?.id)).toBeGreaterThanOrEqual(SIGNAL_RUNTIME.confirmationCooldownMs - 1000);
      } finally {
        h.world.clearFaults();
      }
      // Once the provider answers authoritatively, the next claim confirms it.
      await cooldown();
      expect((await confirmMarks(h.t)).find((m) => m.confirmed_through_at !== null)).toBeDefined();
      await cooldown();
      expect(await confirmMarks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("30. a transient failure (retries exhausted) does NOT confirm; the mark stays for the next claim", async () => {
      h.world.injectFaults([{ operation: "getInteraction", target: "fb_c_010", on: "every", fault: { kind: "transient", reason: "server_error" } }]);
      try {
        await burst("fb_c_010", 1);
        const [mark] = await confirmMarks(h.t);
        expect(mark).toMatchObject({ confirmed_through_at: null });
      } finally {
        h.world.clearFaults();
      }
      await cooldown();
      await cooldown();
      expect(await confirmMarks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("crash after the provider answered but before the completion: no false caught-up; the next claim re-reads and confirms", async () => {
      const record = await interaction(h.t, "fb_c_011");
      await h.receive({ platform: "facebook", target: "fb_c_011", content: "fb_post_organic_01", change: "edited" });
      // Deliver the signal but not yet the confirmation: crash the confirmation's settle transaction by hand.
      await h.router();
      await h.step();
      const port = createSimulatorReadPort(h.world, { webhookSigningKey: "synthetic-webhook-signing-key-for-tests" });
      let calls = 0;
      const crashing = (async () => {
        await confirmStoredInteraction({
          inScope: async (work) => {
            calls += 1;
            if (calls === 4) throw new Error("crash before the completion");
            return withWorkspaceJobScope(worker, h.t.workspaceId, (tx) => work(reconciliationScope({ tx, noteOutbox: () => undefined })));
          },
          access: { withCredential: (_input, use) => use(h.world.credential("cred_meta_main")) },
          providers: { read: () => port },
          clock: h.ids,
          finalAttempt: true,
        }, { interactionId: record?.id ?? "", connectedAccountId: h.t.fb, correlationId: correlation() });
      })();
      await expect(crashing).rejects.toThrow("crash");
      const [mark] = await confirmMarks(h.t);
      expect(mark?.confirmed_through_at).toBeNull();
      expect(mark?.read_started_at).not.toBeNull();
      // The queued confirmation (and later claims) still confirm it: nothing was suppressed.
      await h.settle();
      expect((await confirmMarks(h.t))[0]?.confirmed_through_at).not.toBeNull();
      await cooldown();
      expect(await confirmMarks(h.t)).toEqual([]);
      await assertQuiescent(h);
    });

    it("32. concurrent deliveries for one interaction claim ONE generation and request ONE read", async () => {
      const before = await requests();
      for (let i = 0; i < 3; i += 1) await h.receive({ platform: "facebook", target: "fb_c_001", content: "fb_post_organic_01", change: "hidden" });
      await h.router();
      await h.settle();
      const [mark] = await confirmMarks(h.t);
      expect(mark?.dispatch_generation).toBe(1);
      expect((await requests()) - before).toBe(1);
      await cooldown();
      await assertQuiescent(h);
    });

    it("33. an expired confirm mark is purged system-wide by the MAIN purge task (counts only)", async () => {
      await burst("fb_c_002", 1);
      const [mark] = await confirmMarks(h.t);
      await privileged.query("update ingestion.signal_marks set first_signal_at = now() - interval '8 days', expires_at = now() - interval '1 second' where id = $1", [mark?.id]);
      lines.length = 0;
      const context: SystemJobContext = {
        payload: parseSystemJobPayload({ v: 1, scope: "system", task: "ingestion.purge_provider_events", correlationId: `h6f4d-${randomUUID()}`, initiator: { type: "system" } }),
        run: { runId: `run_${randomUUID().slice(0, 8)}`, attempt: 1 },
        system,
      };
      const purged = await runPurgeProviderEvents(context, logger);
      expect(purged.marks.confirmMarks).toBeGreaterThanOrEqual(1);
      expect(await confirmMarks(h.t)).toEqual([]);
      expect(lines.some((line) => line.includes("signal.mark_expired.confirm"))).toBe(true);
      expect(lines.join("\n")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    });
  });
}
