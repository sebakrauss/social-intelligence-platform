/**
 * Step H6-C3 — end-to-end reconciliation runtime acceptance on the real database, simulator only (no Meta, no network):
 *
 *   request (worker scope) → outbox → REAL relay → FakeJobRuntime → REAL handlers through the REAL job wrappers
 *   (runTenantJob / runTenantStepJob, the production registry) → planner (MAIN) → content_listing slice → serial
 *   content_interactions slices (INTEGRATION) → canonical ingestion → coverage → watermarks → interactions.observed →
 *   the MAIN terminal consumer; the REAL outcome sweeper recovers crashed runs.
 *
 * Capability is the REAL resolver over REAL platform-catalog (r5) profiles of Meta accounts — Facebook read_interactions
 * post·unknown SUPPORTED (comment + reply), Instagram AVAILABLE_WITH_LIMITATION / REPLIES_NOT_READ — with the
 * simulator read port injected where the Meta port would be. The simulator's baseline scenario is shifted to the
 * present and its posts report `unknown` source (the validated scope); an organic post and an ad creative stay outside
 * it. Only tenants, connections, accounts, credentials (unopenable synthetic envelopes) and profiles are bootstrapped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { parseInstant } from "@/domain/instant";
import { parseWorkspaceId } from "@/domain/ids";
import type { InteractionDto, Page, ProviderReadPort } from "@/integrations/providers/contract";
import { SimulatorWorld, createSimulatorReadPort, parseScenario, type FaultRule } from "@/integrations/providers/simulator";
import { PLATFORM_CATALOG, evaluateAndStore, type FactsInput } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { ingestInteractionFact, interactionSourceFactFromDto, requestReconciliation, type RequestReconciliationOutcome } from "@/modules/ingestion";
import { parseInteractionSourceFact } from "@/modules/interactions";
import { withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { runTenantJob, runTenantStepJob } from "@/platform/jobs";
import { relayPass, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger, type Logger } from "@/platform/observability";
import { ingestionStores, reconciliationScope } from "@/server/persistence/ingestion";
import { runInteractionsObserved, runReconcileAccount } from "@/jobs/reconciliation";
import { runReconcileSlice } from "@/jobs/reconciliation-slice";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { rawScenario } from "../../providers/support/fixtures";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";

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
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SLICE = "ingestion.reconcile_slice";

/** The baseline scenario moved to the present (its clock starts 10 min ahead), with the validated content scope. */
function presentScenario() {
  const raw = rawScenario("baseline");
  const delta = Date.now() + 10 * 60_000 - Date.parse(String(raw["clockStart"]));
  const shift = (value: unknown): unknown => {
    if (typeof value === "string" && ISO.test(value)) return new Date(Date.parse(value) + delta).toISOString();
    if (Array.isArray(value)) return value.map(shift);
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shift(inner)]));
    return value;
  };
  const shifted = shift(raw) as { contents: { id: string; kind: string; reportedSource: string }[] } & Record<string, unknown>;
  for (const content of shifted.contents) {
    if (content.id === "fb_post_organic_01" || content.id === "fb_post_boosted_02") content.reportedSource = "unknown";
    if (content.id === "ig_post_unknown_11") content.kind = "post";
  }
  return parseScenario(shifted);
}

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly connection: string;
  readonly fb: string;
  readonly ig: string;
}

export function defineReconciliationRuntimeSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let logger: Logger;
  const organizations: string[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const correlation = (): CorrelationId => {
    const parsed = parseCorrelationId(`h6c3-${randomUUID()}`);
    if (parsed === undefined) throw new Error("correlation");
    return parsed;
  };

  /** Organization, workspace, owner, an ACTIVE Meta connection with a credential, FB + IG accounts, r5 profiles. */
  const tenant = async (clock: () => Date): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Reconciliation', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [organizationId, owner]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [organizationId, workspaceId, owner]);
    const connection = randomUUID();
    const credential = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, owner]);
    // An EnvelopeV1-shaped synthetic envelope: admitted by the table, never opened (the access below is a test double).
    await privileged.query(
      `insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())`,
      [credential, organizationId, workspaceId, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
    await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, connection]);
    const accounts: Record<string, string> = {};
    for (const [asset, platform, grants] of [
      ["fb_page_aurora", "facebook", ["pages_read_engagement", "pages_read_user_content", "pages_show_list"]],
      ["ig_acct_aurora", "instagram", ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"]],
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
    return { organizationId, workspaceId, owner, connection, fb: accounts["fb_page_aurora"] ?? "", ig: accounts["ig_acct_aurora"] ?? "" };
  };

  /** One isolated world: simulator, counting read port, runtime with the REAL handlers, and the delivery loop. */
  const harness = async (options: { readonly operationsPerRun?: number; readonly beforeRead?: (operation: string, target: string | undefined) => Promise<void> } = {}) => {
    const world = new SimulatorWorld(presentScenario());
    const clock = (): Date => new Date(world.nowMs());
    const ids = { newId: randomUUID, now: clock };
    const base = createSimulatorReadPort(world, { webhookSigningKey: "synthetic-webhook-signing-key-for-tests" });
    const calls: { readonly operation: string; readonly target: string | undefined }[] = [];
    const port: ProviderReadPort = {
      ...base,
      listContent: async (access, window, cursor) => {
        calls.push({ operation: "listContent", target: access.account.id });
        await options.beforeRead?.("listContent", access.account.id);
        return base.listContent(access, window, cursor);
      },
      listInteractions: async (access, scope, window, cursor) => {
        const target = scope.kind === "content" ? scope.content.id : undefined;
        calls.push({ operation: "listInteractions", target });
        await options.beforeRead?.("listInteractions", target);
        return base.listInteractions(access, scope, window, cursor);
      },
    };
    const access: ProviderCredentialAccess = { withCredential: (_input, use) => use(world.credential("cred_meta_main")) };
    const providers: DiscoveryProviders = { read: () => port };
    const deps = { registry: PRODUCTION_TASKS, worker, logger };
    const handlers = new Map<string, FakeHandler>([
      ["ingestion.reconcile_account", (payload, run) => runTenantJob(deps, "ingestion.reconcile_account", payload, run, (context) => runReconcileAccount(context, ids))],
      [SLICE, (payload, run) => runTenantStepJob(deps, SLICE, payload, run, (context) => runReconcileSlice(context, { access, providers }, { operationsPerRun: options.operationsPerRun ?? 40, clock: ids }))],
      ["interactions.observed", (payload, run) => runTenantJob(deps, "interactions.observed", payload, run, (context) => runInteractionsObserved(context))],
    ]);
    const runtime = new FakeJobRuntime(handlers, (task) => PRODUCTION_TASKS.get(task)?.retry ?? { maxAttempts: 1, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false });
    const deliveryDeps = (): DeliveryDependencies => ({ system, runtimes: { main: runtime, integration: runtime }, registry: PRODUCTION_TASKS, logger, clock, config: CONFIG });
    const t = await tenant(clock);
    /** One relay → execute → outcome-sweep pass. */
    const step = async (): Promise<void> => {
      await relayPass(deliveryDeps());
      await runtime.drain();
      await sweepRunOutcomes(deliveryDeps());
      world.advanceClock(1);
    };
    /** Passes until the workspace has no undelivered or unfinished work (bounded). */
    const settle = async (): Promise<void> => {
      for (let pass = 0; pass < 80; pass += 1) {
        await step();
        const open = await count(
          `select count(*)::int as n from system.outbox where workspace_id = $1 and (status = 'PENDING' or (status = 'DISPATCHED' and run_outcome is null))`, [t.workspaceId]);
        if (open === 0) return;
      }
      throw new Error("reconciliation did not settle");
    };
    const request = (account: string, budget?: Parameters<typeof requestReconciliation>[2]["budget"]): Promise<RequestReconciliationOutcome> =>
      withWorkspaceJobScope(worker, t.workspaceId, (tx) => requestReconciliation(reconciliationScope({ tx, noteOutbox: () => undefined }), ids, {
        connectedAccountId: account, initiator: { type: "user", userId: t.owner }, correlationId: correlation(), ...(budget === undefined ? {} : { budget }),
      }));
    const reconcile = async (account: string, budget?: Parameters<typeof requestReconciliation>[2]["budget"]) => {
      const requested = await request(account, budget);
      if (requested.kind !== "requested") throw new Error(`request refused: ${requested.kind}`);
      await settle();
      return requested.runId;
    };
    return { world, clock, ids, calls, runtime, t, step, settle, request, reconcile, deliveryDeps };
  };
  type Harness = Awaited<ReturnType<typeof harness>>;

  // ── oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  const run = (id: string) => oracle<{ state: string; failure_class: string | null; operations_used: number; pages_used: number; content_items_used: number; started_at: Date | null; budget_interaction_pages_per_content: number }>(
    "select state, failure_class, operations_used, pages_used, content_items_used, started_at, budget_interaction_pages_per_content from ingestion.reconciliation_runs where id = $1", [id]).then((rows) => rows[0]);
  const slices = (runId: string) => oracle<{ id: string; unit: string; sequence: number; state: string; attempt: number; cursor: string | null; failure_class: string | null; pages_read: number; operations_used: number; conflict_count: number; retry_not_before: Date | null; content_item_id: string | null }>(
    "select id, unit, sequence, state, attempt, cursor, failure_class, pages_read, operations_used, conflict_count, retry_not_before, content_item_id from ingestion.reconciliation_slices where reconciliation_run_id = $1 order by created_at, id", [runId]);
  const interaction = (t: Tenant, providerId: string) => oracle<{ id: string; observed: boolean; kind: string | null; parent_interaction_id: string | null; conversation_id: string | null; current_visibility: string | null; current_availability: string | null; author_role: string | null }>(
    "select id, observed, kind, parent_interaction_id, conversation_id, current_visibility, current_availability, author_role from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerId]).then((rows) => rows[0]);
  const coverage = (t: Tenant, contentProviderId: string) => oracle<{ interaction_kind: string; state: string; reason: string; slice_outcome: string; limitation_code: string | null; interval_start: Date; interval_end: Date }>(
    `select r.interaction_kind, r.state, r.reason, r.slice_outcome, r.limitation_code, r.interval_start, r.interval_end from coverage.coverage_records r
       join content.content_items c on c.workspace_id = r.workspace_id and c.id = r.content_item_id where r.workspace_id = $1 and c.provider_content_id = $2 order by r.created_at, r.interaction_kind`,
    [t.workspaceId, contentProviderId]);
  const events = (t: Tenant) => oracle<{ change: string; arrival: string; interaction: string }>(
    `select e.change, e.arrival, i.provider_interaction_id as interaction from ingestion.ingestion_events e join interactions.interactions i on i.workspace_id = e.workspace_id and i.id = e.interaction_id
      where e.workspace_id = $1 order by e.created_at, i.provider_interaction_id`, [t.workspaceId]);

  /** A switch row is changed only by an attributed operator, in one transaction (0005; T-27 precedent). */
  const switchChange = async (statement: string): Promise<void> => {
    const client = await privileged.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.operator_id', 'ops.h6c3', true), set_config('app.change_reason', 'test', true)");
      await client.query(statement);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };

  /** The invariants every settled workspace must satisfy (Phase S). */
  const assertQuiescent = async (h: Harness) => {
    const t = h.t;
    expect(await count("select count(*)::int as n from ingestion.reconciliation_slices where workspace_id = $1 and state in ('PENDING', 'RUNNING')", [t.workspaceId]), "no open slice").toBe(0);
    expect(await count("select count(*)::int as n from ingestion.reconciliation_slices where workspace_id = $1 and cursor is not null", [t.workspaceId]), "no retained cursor").toBe(0);
    expect(await count("select count(*)::int as n from ingestion.reconciliation_runs where workspace_id = $1 and state in ('REQUESTED', 'RUNNING')", [t.workspaceId]), "no open run").toBe(0);
    const outbox = await oracle<{ topic: string; status: string; run_outcome: string | null; last_failure_class: string | null }>(
      "select topic, status, run_outcome, last_failure_class from system.outbox where workspace_id = $1", [t.workspaceId]);
    expect(outbox.filter((row) => row.status !== "DISPATCHED" || row.run_outcome !== "COMPLETED"), "every outbox row delivered and COMPLETED").toEqual([]);
    expect(outbox.filter((row) => row.last_failure_class === "unknown_task"), "no unknown task").toEqual([]);
    // One canonical row per provider id; one event per (interaction, change, observed time) at most once.
    expect(await count("select count(*)::int as n from (select provider_interaction_id from interactions.interactions where workspace_id = $1 group by 1 having count(*) > 1) d", [t.workspaceId])).toBe(0);
    expect(await count("select count(*)::int as n from conversations.conversations c join interactions.interactions i on i.workspace_id = c.workspace_id and i.id = c.anchor_interaction_id where c.workspace_id = $1 and (not i.observed or i.parent_interaction_id is not null or i.author_role = 'account_identity')", [t.workspaceId]), "no provisional or brand-anchored conversation").toBe(0);
    // Every interactions.observed row was consumed by the terminal consumer.
    const observed = outbox.filter((row) => row.topic === "interactions.observed");
    expect(observed.length).toBe(await count("select count(*)::int as n from ingestion.ingestion_events where workspace_id = $1", [t.workspaceId]));
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 2);
    logger = createLogger({ sink: () => undefined, now: () => new Date() });
  });
  afterAll(async () => {
    await Promise.all([worker.end(), system.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Facebook: the full pipeline, then incremental runs", () => {
    let h: Harness;
    let first: string;
    beforeAll(async () => {
      h = await harness();
      first = await h.reconcile(h.t.fb);
    });

    it("1–3. reads the validated content only, and ingests comments, the brand reply and the nested reply as backfill", async () => {
      expect(await run(first)).toMatchObject({ state: "COMPLETED", failure_class: null, content_items_used: 2 });
      const chain = await slices(first);
      expect(chain.map((s) => [s.unit, s.state])).toEqual([["content_listing", "COMPLETED"], ["content_interactions", "COMPLETED"], ["content_interactions", "COMPLETED"]]);
      // Listing order is the provider's (newest first): the organic post (outside post·unknown) is neither stored nor read.
      expect(await oracle("select provider_content_id, content_kind, reported_source from content.content_items where workspace_id = $1 order by provider_content_id", [h.t.workspaceId]))
        .toEqual([{ provider_content_id: "fb_post_boosted_02", content_kind: "post", reported_source: "unknown" }, { provider_content_id: "fb_post_organic_01", content_kind: "post", reported_source: "unknown" }]);
      expect(h.calls.filter((c) => c.operation === "listInteractions").map((c) => c.target).sort()).toEqual(["fb_post_boosted_02", "fb_post_organic_01", "fb_post_organic_01"]);
      expect(await count("select count(*)::int as n from interactions.interactions where workspace_id = $1 and observed", [h.t.workspaceId])).toBe(8);
      const [c1, c2, c3] = [await interaction(h.t, "fb_c_001"), await interaction(h.t, "fb_c_002"), await interaction(h.t, "fb_c_003")];
      expect(c1?.conversation_id).not.toBeNull();
      expect([c2?.parent_interaction_id, c2?.author_role, c2?.conversation_id]).toEqual([c1?.id, "account_identity", c1?.conversation_id]);
      expect([c3?.parent_interaction_id, c3?.conversation_id]).toEqual([c2?.id, c1?.conversation_id]);
      expect((await interaction(h.t, "fb_c_006"))?.current_visibility).toBe("hidden");
      expect(new Set((await events(h.t)).map((e) => `${e.change}/${e.arrival}`))).toEqual(new Set(["created/backfill"]));
      // Operations: 1 listing + organic 2 pages + boosted 1 page.
      expect((await run(first))?.operations_used).toBe(4);
      await assertQuiescent(h);
    });

    it("the first traversal claims nothing before its epoch; the watermark starts there", async () => {
      const started = (await run(first))?.started_at;
      const history = await coverage(h.t, "fb_post_organic_01");
      expect(history.map((r) => [r.interaction_kind, r.state, r.reason, r.slice_outcome, r.limitation_code, r.interval_end.getTime()])).toEqual([
        ["comment", "UNAVAILABLE", "HISTORY_DEPTH_NOT_VALIDATED", "NOT_VALIDATED", null, started?.getTime()],
        ["reply", "UNAVAILABLE", "HISTORY_DEPTH_NOT_VALIDATED", "NOT_VALIDATED", null, started?.getTime()],
      ]);
      for (const record of history) expect(record.interval_start < record.interval_end).toBe(true);
      expect(await oracle("select epoch_at, synced_through, consecutive_failures from ingestion.reconciliation_watermarks where workspace_id = $1 order by content_item_id", [h.t.workspaceId]))
        .toEqual([{ epoch_at: started, synced_through: started, consecutive_failures: 0 }, { epoch_at: started, synced_through: started, consecutive_failures: 0 }]);
    });

    it("26–28. every interactions.observed was accepted by the terminal consumer; nothing else ran", () => {
      const tasks = [...h.runtime.runs.values()].map((r) => r.request.task);
      expect(new Set(tasks)).toEqual(new Set(["ingestion.reconcile_account", SLICE, "interactions.observed"]));
      expect(tasks.filter((task) => task === "interactions.observed")).toHaveLength(8);
      expect([...h.runtime.runs.values()].every((r) => r.status === "COMPLETED")).toBe(true);
    });

    it("24. a second request while a run is open is already_running", async () => {
      const opened = await h.request(h.t.fb);
      expect(opened.kind).toBe("requested");
      expect(await h.request(h.t.fb)).toEqual({ kind: "already_running", runId: opened.kind === "requested" ? opened.runId : "" });
      await h.settle();
    });

    it("10–13. later runs read only the overlap window: new interactions are reconciliation, edits and hides apply, duplicates add nothing, absence is no deletion", async () => {
      h.world.advanceClock(3600);
      const comment = h.world.audienceComment("fb_post_organic_01", "fb_user_02", "Synthetic new comment (H6-C3).");
      h.world.advanceClock(60);
      const reply = h.world.audienceReply(comment, "fb_user_03", "Synthetic new reply (H6-C3).");
      // A run reads [window start, its own start): an interaction created at that very instant belongs to the next run.
      h.world.advanceClock(60);
      const before = (await events(h.t)).length;
      const second = await h.reconcile(h.t.fb);
      expect(await run(second)).toMatchObject({ state: "COMPLETED" });
      const added = (await events(h.t)).slice(before);
      expect(added.map((e) => `${e.interaction}:${e.change}/${e.arrival}`).sort()).toEqual([`${comment}:created/reconciliation`, `${reply}:created/reconciliation`].sort());
      expect((await interaction(h.t, reply))?.conversation_id).toBe((await interaction(h.t, comment))?.conversation_id);
      // COMPLETE only for what this traversal proved: [previous synced-through, this run's start).
      const secondStart = (await run(second))?.started_at;
      const cov = (await coverage(h.t, "fb_post_organic_01")).filter((r) => r.state === "COMPLETE" && r.interval_end.getTime() === secondStart?.getTime());
      expect(cov.map((r) => [r.interaction_kind, r.reason])).toEqual([["comment", "VALIDATED_SCOPE_READ"], ["reply", "VALIDATED_SCOPE_READ"]]);
      // Its start is the previous synced-through (contiguous with the run before; never earlier than the epoch).
      const epoch = (await run(first))?.started_at;
      for (const record of cov) expect(record.interval_start.getTime()).toBeGreaterThanOrEqual(epoch?.getTime() ?? Number.POSITIVE_INFINITY);
      // Edit and hide, then reconcile: one text_changed and one state_changed; nothing else.
      h.world.advanceClock(60);
      h.world.editInteraction(comment, "Synthetic edited comment (H6-C3).");
      h.world.nativeHide(reply);
      h.world.advanceClock(60);
      const mark = (await events(h.t)).length;
      await h.reconcile(h.t.fb);
      expect((await events(h.t)).slice(mark).map((e) => `${e.interaction}:${e.change}`).sort()).toEqual([`${comment}:text_changed`, `${reply}:state_changed`].sort());
      expect((await interaction(h.t, reply))?.current_visibility).toBe("hidden");
      // And back: a native unhide is one more state_changed.
      h.world.nativeUnhide(reply);
      h.world.advanceClock(60);
      const hiddenMark = (await events(h.t)).length;
      await h.reconcile(h.t.fb);
      expect((await events(h.t)).slice(hiddenMark).map((e) => `${e.interaction}:${e.change}`)).toEqual([`${reply}:state_changed`]);
      expect((await interaction(h.t, reply))?.current_visibility).toBe("visible");
      // Duplicate reconciliation: no row, no event.
      const rows = await count("select count(*)::int as n from interactions.interactions where workspace_id = $1", [h.t.workspaceId]);
      const unchanged = (await events(h.t)).length;
      await h.reconcile(h.t.fb);
      expect(await count("select count(*)::int as n from interactions.interactions where workspace_id = $1", [h.t.workspaceId])).toBe(rows);
      expect((await events(h.t)).length).toBe(unchanged);
      // A signaled removal is not listed: absence alone never becomes removed_at_source (listing reconciliation).
      h.world.removeAtSource(reply, { signaled: true });
      await h.reconcile(h.t.fb);
      expect((await interaction(h.t, reply))?.current_availability).toBe("available");
      expect((await events(h.t)).length).toBe(unchanged);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Instagram under REPLIES_NOT_READ", () => {
    it("8–9. ingests top-level comments, never a reply, and covers replies as UNAVAILABLE (never zero)", async () => {
      const h = await harness();
      const reply = h.world.audienceReply("ig_c_010", "ig_user_01", "Synthetic Instagram reply (H6-C3).");
      const first = await h.reconcile(h.t.ig);
      expect(await run(first)).toMatchObject({ state: "COMPLETED", content_items_used: 1 });
      expect((await interaction(h.t, "ig_c_010"))).toMatchObject({ observed: true, kind: "comment" });
      expect(await interaction(h.t, reply)).toBeUndefined();
      expect(await count("select count(*)::int as n from interactions.interactions where workspace_id = $1 and (kind = 'reply' or not observed)", [h.t.workspaceId])).toBe(0);
      h.world.advanceClock(3600);
      const second = await h.reconcile(h.t.ig);
      const started = (await run(second))?.started_at;
      const latest = (await coverage(h.t, "ig_post_unknown_11")).filter((r) => r.interval_end.getTime() === started?.getTime());
      expect(latest.map((r) => [r.interaction_kind, r.state, r.reason, r.limitation_code])).toEqual([
        ["comment", "COMPLETE", "VALIDATED_SCOPE_READ", "REPLIES_NOT_READ"],
        ["reply", "UNAVAILABLE", "CAPABILITY_LIMITATION", "REPLIES_NOT_READ"],
      ]);
      expect(await oracle("select provider_content_id from content.content_items where workspace_id = $1", [h.t.workspaceId])).toEqual([{ provider_content_id: "ig_post_unknown_11" }]);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("threads split across slices, continuation and budget", () => {
    it("4–7, 14, 16. replies before their root across continuations attach late; a brand root stays without; the budget ends as TRAVERSAL_INCOMPLETE", async () => {
      const h = await harness();
      // Newest first, three per page: brandReply, brandRoot, replyA2 | replyA1, filler2, filler1 | rootA, 006, 005 | ...
      const rootA = h.world.audienceComment("fb_post_organic_01", "fb_user_01", "Synthetic root A.");
      h.world.advanceClock(60);
      h.world.audienceComment("fb_post_organic_01", "fb_user_02", "Synthetic filler 1.");
      h.world.advanceClock(60);
      h.world.audienceComment("fb_post_organic_01", "fb_user_03", "Synthetic filler 2.");
      h.world.advanceClock(60);
      const replyA1 = h.world.audienceReply(rootA, "fb_user_02", "Synthetic reply A1.");
      h.world.advanceClock(60);
      const replyA2 = h.world.audienceReply(replyA1, "fb_user_03", "Synthetic reply A2.");
      h.world.advanceClock(60);
      const brandRoot = h.world.audienceComment("fb_post_organic_01", "fb_author_aurora", "Synthetic brand comment.");
      h.world.advanceClock(60);
      const brandReply = h.world.audienceReply(brandRoot, "fb_user_01", "Synthetic reply to the brand.");
      h.world.advanceClock(600);
      const id = await h.reconcile(h.t.fb, { listingPagesPerSlice: 1, interactionPagesPerSlice: 1, continuationsPerContent: 2, interactionPagesPerContent: 3, contentItems: 10, overlapSeconds: 86_400 });
      const organic = (await slices(id)).filter((s) => s.unit === "content_interactions" && s.content_item_id !== null);
      const organicContent = (await oracle<{ id: string }>("select id from content.content_items where workspace_id = $1 and provider_content_id = 'fb_post_organic_01'", [h.t.workspaceId]))[0]?.id;
      const chain = organic.filter((s) => s.content_item_id === organicContent);
      expect(chain.map((s) => [s.sequence, s.state])).toEqual([[0, "CONTINUED"], [1, "CONTINUED"], [2, "ABANDONED_BUDGET"]]);
      expect(await run(id)).toMatchObject({ state: "PARTIAL" });
      // replyA2 (slice 0) and replyA1 (slice 1) waited without a conversation; rootA (slice 2) created it and attached both.
      const a = await interaction(h.t, rootA);
      expect(a?.conversation_id).not.toBeNull();
      for (const reply of [replyA1, replyA2]) expect((await interaction(h.t, reply))?.conversation_id).toBe(a?.conversation_id);
      expect((await interaction(h.t, replyA1))?.parent_interaction_id).toBe(a?.id);
      // The brand-rooted thread has no conversation.
      for (const node of [brandRoot, brandReply]) expect((await interaction(h.t, node))?.conversation_id).toBeNull();
      // 004 … 001 were never reached: not ingested, and the content's coverage is TRAVERSAL_INCOMPLETE, never COMPLETE.
      expect(await interaction(h.t, "fb_c_001")).toBeUndefined();
      const cov = await coverage(h.t, "fb_post_organic_01");
      expect(cov.filter((r) => r.state === "COMPLETE")).toEqual([]);
      expect(cov.filter((r) => r.reason === "TRAVERSAL_INCOMPLETE").map((r) => [r.interaction_kind, r.state, r.slice_outcome])).toEqual([["comment", "UNKNOWN", "TEMPORARILY_FAILED"], ["reply", "UNKNOWN", "TEMPORARILY_FAILED"]]);
      expect(await count("select count(*)::int as n from ingestion.reconciliation_watermarks w join content.content_items c on c.workspace_id = w.workspace_id and c.id = w.content_item_id where w.workspace_id = $1 and c.provider_content_id = 'fb_post_organic_01'", [h.t.workspaceId])).toBe(0);
      await assertQuiescent(h);
    });

    it("15. an expired cursor is dropped at claim: the window restarts ONCE, bounded, without duplicates", async () => {
      const h = await harness();
      const requested = await h.request(h.t.fb, { listingPagesPerSlice: 1, interactionPagesPerSlice: 1, continuationsPerContent: 2, interactionPagesPerContent: 3, contentItems: 10, overlapSeconds: 86_400 });
      if (requested.kind !== "requested") throw new Error("request");
      const organicChain = async () => {
        const content = (await oracle<{ id: string }>("select id from content.content_items where workspace_id = $1 and provider_content_id = 'fb_post_organic_01'", [h.t.workspaceId]))[0]?.id;
        return (await slices(requested.runId)).filter((s) => s.content_item_id !== null && s.content_item_id === content);
      };
      // Deliver until the organic post's first slice CONTINUED and its continuation waits with a cursor …
      for (let pass = 0; pass < 12 && !(await organicChain()).some((s) => s.sequence === 1 && s.state === "PENDING"); pass += 1) await h.step();
      const waiting = (await organicChain()).find((s) => s.sequence === 1);
      expect(waiting).toMatchObject({ state: "PENDING" });
      expect(waiting?.cursor).not.toBeNull();
      // … and the cursor outlives its 15 minutes before the continuation runs.
      h.world.advanceClock(16 * 60);
      await h.settle();
      // The continuation re-read page 1 from scratch (one restart), continued again with a FRESH cursor, then finished.
      expect((await organicChain()).map((s) => [s.sequence, s.state, s.pages_read])).toEqual([[0, "CONTINUED", 1], [1, "CONTINUED", 1], [2, "COMPLETED", 1]]);
      expect(h.calls.filter((c) => c.target === "fb_post_organic_01")).toHaveLength(3);
      expect(await count("select count(*)::int as n from (select interaction_id, change from ingestion.ingestion_events where workspace_id = $1 group by 1, 2 having count(*) > 1) d", [h.t.workspaceId])).toBe(0);
      expect(await count("select count(*)::int as n from interactions.interactions i join content.content_items c on c.workspace_id = i.workspace_id and c.id = i.content_item_id where i.workspace_id = $1 and c.provider_content_id = 'fb_post_organic_01' and i.observed", [h.t.workspaceId])).toBe(6);
      await assertQuiescent(h);
    });

    it("the run operation budget is reserved before every read: exhausted mid-slice → no further provider call, PARTIAL, TRAVERSAL_INCOMPLETE", async () => {
      // 3 operations: the listing, the boosted post's single page, then the organic post's FIRST page only.
      const h = await harness({ operationsPerRun: 3 });
      const id = await h.reconcile(h.t.fb);
      expect(await run(id)).toMatchObject({ state: "PARTIAL", operations_used: 3 });
      expect(h.calls).toHaveLength(3);
      const chain = (await slices(id)).filter((s) => s.unit === "content_interactions");
      expect(chain.map((s) => s.state)).toEqual(["COMPLETED", "ABANDONED_BUDGET"]);
      // The organic page read before the budget ran out is ingested (facts are facts) …
      expect(await count("select count(*)::int as n from interactions.interactions i join content.content_items c on c.workspace_id = i.workspace_id and c.id = i.content_item_id where i.workspace_id = $1 and c.provider_content_id = 'fb_post_organic_01' and i.observed", [h.t.workspaceId])).toBe(3);
      // … but nothing is claimed complete for it: TRAVERSAL_INCOMPLETE, and no watermark.
      expect((await coverage(h.t, "fb_post_organic_01")).map((r) => [r.state, r.reason])).toEqual([["UNKNOWN", "TRAVERSAL_INCOMPLETE"], ["UNKNOWN", "TRAVERSAL_INCOMPLETE"]]);
      expect((await coverage(h.t, "fb_post_boosted_02")).map((r) => r.reason)).toEqual(["HISTORY_DEPTH_NOT_VALIDATED", "HISTORY_DEPTH_NOT_VALIDATED"]);
      expect(await count("select count(*)::int as n from ingestion.reconciliation_watermarks where workspace_id = $1", [h.t.workspaceId])).toBe(1);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("failures, retries and recovery", () => {
    it("17. RateLimited: FAILED_RATE_LIMITED with Retry-After, the rest of the run stops, the next request backs off", async () => {
      const h = await harness();
      h.world.injectFaults([{ operation: "listInteractions", on: 1, fault: { kind: "rate_limited", retryAfterSeconds: 120 } } satisfies FaultRule]);
      const id = await h.reconcile(h.t.fb);
      const chain = (await slices(id)).filter((s) => s.unit === "content_interactions");
      expect(chain.map((s) => [s.state, s.failure_class])).toEqual([["FAILED_RATE_LIMITED", "rate_limited"], ["FAILED_RATE_LIMITED", "rate_limited_backoff"]]);
      expect(chain.every((s) => s.retry_not_before !== null)).toBe(true);
      expect(await run(id)).toMatchObject({ state: "PARTIAL" });
      expect(h.calls.filter((c) => c.operation === "listInteractions")).toHaveLength(1);
      const blocked = await h.reconcile(h.t.fb);
      expect(await run(blocked)).toMatchObject({ state: "SKIPPED_UNAVAILABLE", failure_class: "rate_limited_backoff" });
      h.world.advanceClock(180);
      h.world.clearFaults();
      expect(await run(await h.reconcile(h.t.fb))).toMatchObject({ state: "COMPLETED" });
      await assertQuiescent(h);
    });

    it("18. a transient provider failure is retried by the runtime: the slice re-claims (attempt 2) and completes", async () => {
      const h = await harness();
      h.world.injectFaults([{ operation: "listInteractions", on: 1, fault: { kind: "transient", reason: "network" } } satisfies FaultRule]);
      const id = await h.reconcile(h.t.fb);
      expect(await run(id)).toMatchObject({ state: "COMPLETED" });
      const first = (await slices(id)).find((s) => s.unit === "content_interactions");
      expect(first).toMatchObject({ state: "COMPLETED", attempt: 2 });
      // The failed read was reserved and counted too.
      expect((await run(id))?.operations_used).toBe(5);
      await assertQuiescent(h);
    });

    it("19. a crash after the slice committed: the re-dispatched run finds it finished and does nothing again", async () => {
      const h = await harness();
      let crashed = false;
      h.runtime.fault = (fake, attempt) => {
        if (crashed || fake.request.task !== SLICE || attempt !== 1) return undefined;
        crashed = true;
        return "crash_after";
      };
      const id = await h.reconcile(h.t.fb);
      expect(crashed).toBe(true);
      expect(await run(id)).toMatchObject({ state: "COMPLETED" });
      expect([...h.runtime.runs.values()].some((r) => r.status === "CRASHED")).toBe(true);
      // The listing slice ran its provider read exactly once.
      expect(h.calls.filter((c) => c.operation === "listContent")).toHaveLength(1);
      expect(await count("select count(*)::int as n from interactions.interactions where workspace_id = $1", [h.t.workspaceId])).toBe(8);
      await assertQuiescent(h);
    });

    it("20. a worker failure before the commit: the retry re-claims and re-reads (bounded), without duplicates", async () => {
      let failed = false;
      const h = await harness({
        beforeRead: (operation) => {
          if (operation !== "listInteractions" || failed) return Promise.resolve();
          failed = true;
          return Promise.reject(new Error("synthetic worker failure before commit"));
        },
      });
      const id = await h.reconcile(h.t.fb);
      expect(failed).toBe(true);
      expect(await run(id)).toMatchObject({ state: "COMPLETED" });
      expect((await slices(id)).find((s) => s.unit === "content_interactions")).toMatchObject({ state: "COMPLETED", attempt: 2 });
      expect(await count("select count(*)::int as n from interactions.interactions where workspace_id = $1", [h.t.workspaceId])).toBe(8);
      await assertQuiescent(h);
    });

    it("21. a profile that becomes stale mid-run stops the run truthfully (TEMPORARILY_FAILED, no read)", async () => {
      const h = await harness();
      const requested = await h.request(h.t.fb);
      if (requested.kind !== "requested") throw new Error("request");
      for (let pass = 0; pass < 6 && !(await slices(requested.runId)).some((s) => s.unit === "content_listing" && s.state === "COMPLETED"); pass += 1) await h.step();
      await privileged.query("update capability.account_profiles set catalog_revision = catalog_revision - 1 where connected_account_id = $1", [h.t.fb]);
      const reads = h.calls.length;
      await h.settle();
      expect(h.calls.length).toBe(reads);
      expect(await run(requested.runId)).toMatchObject({ state: "PARTIAL" });
      expect((await slices(requested.runId)).filter((s) => s.unit === "content_interactions").map((s) => [s.state, s.failure_class])).toEqual([["FAILED_TRANSIENT", "profile_stale"], ["FAILED_TRANSIENT", "profile_stale"]]);
      expect((await coverage(h.t, "fb_post_organic_01")).map((r) => [r.state, r.reason, r.slice_outcome])).toEqual([["FAILED", "PROFILE_STALE", "TEMPORARILY_FAILED"], ["FAILED", "PROFILE_STALE", "TEMPORARILY_FAILED"]]);
      await assertQuiescent(h);
    });

    it("22. a connection removed while the provider answers: the answer is discarded, nothing is ingested", async () => {
      const ref: { tenant?: Tenant } = {};
      const h = await harness({
        beforeRead: async (operation) => {
          if (operation === "listInteractions" && ref.tenant !== undefined) {
            await privileged.query("update connections.connections set status = 'REMOVED', active_credential_id = null where id = $1", [ref.tenant.connection]);
          }
        },
      });
      ref.tenant = h.t;
      const id = await h.reconcile(h.t.fb);
      expect(await count("select count(*)::int as n from interactions.interactions where workspace_id = $1", [h.t.workspaceId])).toBe(0);
      expect(await run(id)).toMatchObject({ state: "PARTIAL" });
      expect((await slices(id)).filter((s) => s.unit === "content_interactions").map((s) => s.failure_class)).toEqual(["connection_removed", "connection_removed"]);
      await assertQuiescent(h);
    });

    it("23. the ingestion.provider_pause kill switch skips the run before any read", async () => {
      const h = await harness();
      await switchChange("insert into system.operational_switches (switch_key, qualifier, scope, value) values ('ingestion.provider_pause', 'facebook', 'global', '{\"paused\": true}')");
      try {
        const id = await h.reconcile(h.t.fb);
        expect(await run(id)).toMatchObject({ state: "SKIPPED_UNAVAILABLE", failure_class: "provider_paused" });
        expect(h.calls).toHaveLength(0);
      } finally {
        await switchChange("delete from system.operational_switches where switch_key = 'ingestion.provider_pause' and qualifier = 'facebook'");
      }
      await assertQuiescent(h);
    });

    it("25. an authority conflict is recorded for its fact alone; every other fact is ingested", async () => {
      const h = await harness();
      // fb_c_004 already exists canonically under ANOTHER post (written through the H6-B service, not by hand).
      const sim = createSimulatorReadPort(h.world, { webhookSigningKey: "synthetic-webhook-signing-key-for-tests" });
      const access = { credential: h.world.credential("cred_meta_main"), account: h.world.assetRef("fb_page_aurora") };
      const window = { from: new Date(Date.now() - 365 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() } as unknown as Parameters<ProviderReadPort["listInteractions"]>[2];
      let dto: InteractionDto | undefined;
      let cursor: Parameters<ProviderReadPort["listInteractions"]>[3] = null;
      for (let page = 0; page < 5 && dto === undefined; page += 1) {
        const listed: Page<InteractionDto> = (await sim.listInteractions(access, { kind: "account" }, window, cursor)).data;
        dto = listed.items.find((item) => item.ref.id === "fb_c_004");
        if (listed.next.kind === "end") break;
        cursor = listed.next.cursor;
      }
      if (dto === undefined) throw new Error("fb_c_004 not listed");
      const workspaceId = parseWorkspaceId(h.t.workspaceId);
      const observedAt = parseInstant(h.clock().toISOString());
      if (workspaceId === undefined || observedAt === undefined) throw new Error("ids");
      const fact = interactionSourceFactFromDto(dto, { workspaceId, connectedAccountId: h.t.fb, providerAssetId: "fb_page_aurora", mechanism: "reconciliation", operation: "listInteractions", provenance: "listed", observedAt, catalogRevision: 5, profileRevision: 1 });
      const moved = parseInteractionSourceFact({ ...fact, identity: { ...fact.identity, contentId: "fb_post_boosted_02" } });
      if (!moved.ok) throw new Error("fact");
      await withWorkspaceJobScope(worker, h.t.workspaceId, (tx) => ingestInteractionFact(ingestionStores({ tx, noteOutbox: () => undefined }), h.ids, {
        fact: moved.fact, content: { contentKind: "post", reportedSource: "unknown" }, availability: { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null }, arrival: "reconciliation", correlationId: correlation(),
      }));
      const id = await h.reconcile(h.t.fb);
      const conflicts = await oracle<{ conflict_class: string; interaction_id: string | null }>("select conflict_class, interaction_id from ingestion.authority_conflicts where reconciliation_run_id = $1", [id]);
      expect(conflicts.map((c) => c.conflict_class)).toContain("CONTENT_CHANGED");
      expect(new Set(conflicts.map((c) => c.interaction_id))).toEqual(new Set([(await interaction(h.t, "fb_c_004"))?.id]));
      const organic = (await slices(id)).find((s) => s.unit === "content_interactions" && s.conflict_count > 0);
      expect(organic?.state).toBe("COMPLETED");
      // The other organic facts (001–003, 005, 006) are canonical; fb_c_004 stayed where it was.
      for (const other of ["fb_c_001", "fb_c_002", "fb_c_003", "fb_c_005", "fb_c_006"]) expect((await interaction(h.t, other))?.observed).toBe(true);
      await assertQuiescent(h);
    });
  });
}
