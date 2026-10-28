/**
 * Step H6-E — stored-interaction confirmation acceptance on the real database, simulator only (no Meta, no network):
 *
 *   reconciliation (real H6-C3 pipeline) makes canonical rows → requestInteractionConfirmation (worker scope) → the
 *   IDs-only `ingestion.confirm_interaction` row → REAL relay → FakeJobRuntime → the REAL INTEGRATION handler through
 *   runTenantStepJob → ONE getInteraction(stored) → the ONE canonical ingestion path → interactions.observed.
 *
 * The simulator's world is the provider's truth: a vanished interaction answers an AUTHORITATIVE not-found (H6-E), an
 * injected `target_not_found` fault answers an UNCONFIRMED one (as Meta's 100/33 does). Capability is the real resolver
 * over real r5 profiles. Every case asserts what changed — and, as importantly, what did not.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import type { InteractionTarget, ProviderReadPort } from "@/integrations/providers/contract";
import { SimulatorWorld, createSimulatorReadPort, parseScenario, type FaultRule } from "@/integrations/providers/simulator";
import { PLATFORM_CATALOG, evaluateAndStore, type FactsInput } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { requestInteractionConfirmation, requestReconciliation, type ConfirmationResult } from "@/modules/ingestion";
import { withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { runTenantJob, runTenantStepJob } from "@/platform/jobs";
import { relayPass, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger, type Logger } from "@/platform/observability";
import { reconciliationScope } from "@/server/persistence/ingestion";
import { runConfirmInteraction } from "@/jobs/confirm-interaction";
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFIRM = "ingestion.confirm_interaction";
const SLICE = "ingestion.reconcile_slice";

/** The baseline scenario moved to the present, with the validated content scope (as the H6-C3 acceptance does). */
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
  readonly connection: string;
  readonly fb: string;
  readonly ig: string;
}

export function defineInteractionConfirmationSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let logger: Logger;
  const organizations: string[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const correlation = (): CorrelationId => {
    const parsed = parseCorrelationId(`h6e-${randomUUID()}`);
    if (parsed === undefined) throw new Error("correlation");
    return parsed;
  };

  const tenant = async (clock: () => Date): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Confirmation', now())", [organizationId]);
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
    return { organizationId, workspaceId, connection, fb: accounts["fb_page_aurora"] ?? "", ig: accounts["ig_acct_aurora"] ?? "" };
  };

  /** One world, with FB and IG already reconciled into canonical rows by the REAL H6-C3 pipeline. */
  const harness = async () => {
    const world = new SimulatorWorld(presentScenario());
    const clock = (): Date => new Date(world.nowMs());
    const ids = { newId: randomUUID, now: clock };
    const base = createSimulatorReadPort(world, { webhookSigningKey: "synthetic-webhook-signing-key-for-tests" });
    const reads: { readonly operation: string; readonly target?: InteractionTarget }[] = [];
    const port: ProviderReadPort = {
      ...base,
      listContent: (access, window, cursor) => {
        reads.push({ operation: "listContent" });
        return base.listContent(access, window, cursor);
      },
      listInteractions: (access, scope, window, cursor) => {
        reads.push({ operation: "listInteractions" });
        return base.listInteractions(access, scope, window, cursor);
      },
      getInteraction: (access, target) => {
        reads.push({ operation: "getInteraction", target });
        return base.getInteraction(access, target);
      },
    };
    const access: ProviderCredentialAccess = { withCredential: (_input, use) => use(world.credential("cred_meta_main")) };
    const providers: DiscoveryProviders = { read: () => port };
    const results: ConfirmationResult[] = [];
    const deps = { registry: PRODUCTION_TASKS, worker, logger };
    const handlers = new Map<string, FakeHandler>([
      ["ingestion.reconcile_account", (payload, run) => runTenantJob(deps, "ingestion.reconcile_account", payload, run, (context) => runReconcileAccount(context, ids))],
      [SLICE, (payload, run) => runTenantStepJob(deps, SLICE, payload, run, (context) => runReconcileSlice(context, { access, providers }, { clock: ids }))],
      ["interactions.observed", (payload, run) => runTenantJob(deps, "interactions.observed", payload, run, (context) => runInteractionsObserved(context))],
      [CONFIRM, (payload, run) => runTenantStepJob(deps, CONFIRM, payload, run, async (context) => {
        const result = await runConfirmInteraction(context, { access, providers }, { clock: ids });
        results.push(result);
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
      for (let pass = 0; pass < 80; pass += 1) {
        await step();
        const open = await count("select count(*)::int as n from system.outbox where workspace_id = $1 and (status = 'PENDING' or (status = 'DISPATCHED' and run_outcome is null))", [t.workspaceId]);
        if (open === 0) return;
      }
      throw new Error("work did not settle");
    };
    const reconcile = async (account: string): Promise<void> => {
      const requested = await withWorkspaceJobScope(worker, t.workspaceId, (tx) => requestReconciliation(reconciliationScope({ tx, noteOutbox: () => undefined }), ids, { connectedAccountId: account, correlationId: correlation() }));
      if (requested.kind !== "requested") throw new Error(`reconciliation refused: ${requested.kind}`);
      await settle();
    };
    await reconcile(t.fb);
    await reconcile(t.ig);
    reads.length = 0;
    /** Request ONE confirmation of a canonical interaction (by provider id, resolved to its UUID here) and settle it. */
    const confirm = async (providerId: string): Promise<ConfirmationResult | undefined> => {
      const canonical = (await oracle<{ id: string }>("select id from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerId]))[0];
      if (canonical === undefined) throw new Error(`not canonical: ${providerId}`);
      const before = results.length;
      const requested = await withWorkspaceJobScope(worker, t.workspaceId, (tx) => requestInteractionConfirmation(reconciliationScope({ tx, noteOutbox: () => undefined }), ids, { interactionId: canonical.id, correlationId: correlation() }));
      if (requested.kind !== "requested") throw new Error(`confirmation refused: ${requested.kind}`);
      world.advanceClock(5);
      await settle();
      return results.slice(before).at(-1);
    };
    return { world, clock, ids, reads, results, runtime, t, step, settle, reconcile, confirm };
  };
  type Harness = Awaited<ReturnType<typeof harness>>;

  // ── oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  const row = (t: Tenant, providerId: string) => oracle<{ id: string; kind: string | null; parent_interaction_id: string | null; conversation_id: string | null; current_visibility: string | null; current_availability: string | null; current_removal_basis: string | null; current_source_text_version_id: string | null }>(
    "select id, kind, parent_interaction_id, conversation_id, current_visibility, current_availability, current_removal_basis, current_source_text_version_id from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerId]).then((rows) => rows[0]);
  const eventsOf = (t: Tenant, providerId: string) => oracle<{ change: string; arrival: string }>(
    `select e.change, e.arrival from ingestion.ingestion_events e join interactions.interactions i on i.workspace_id = e.workspace_id and i.id = e.interaction_id
      where e.workspace_id = $1 and i.provider_interaction_id = $2 order by e.created_at`, [t.workspaceId, providerId]);
  const observationsOf = (t: Tenant, providerId: string) => oracle<{ availability: string; removal_basis: string | null; mechanism: string; operation: string; provenance: string }>(
    `select s.availability, s.removal_basis, s.mechanism, s.operation, s.provenance from interactions.state_observations s join interactions.interactions i on i.workspace_id = s.workspace_id and i.id = s.interaction_id
      where s.workspace_id = $1 and i.provider_interaction_id = $2 order by s.created_at`, [t.workspaceId, providerId]);
  const textVersionsOf = (t: Tenant, providerId: string) => count(
    "select count(*)::int as n from interactions.source_text_versions v join interactions.interactions i on i.workspace_id = v.workspace_id and i.id = v.interaction_id where v.workspace_id = $1 and i.provider_interaction_id = $2", [t.workspaceId, providerId]);
  const traversalDigest = async (t: Tenant) => JSON.stringify({
    coverage: await oracle("select to_jsonb(r)::text as r from coverage.coverage_records r where workspace_id = $1 order by id", [t.workspaceId]),
    watermarks: await oracle("select to_jsonb(w)::text as w from ingestion.reconciliation_watermarks w where workspace_id = $1 order by content_item_id", [t.workspaceId]),
  });
  const getInteractionReads = (h: Harness) => h.reads.filter((r) => r.operation === "getInteraction");
  const switchChange = async (statement: string): Promise<void> => {
    const client = await privileged.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.operator_id', 'ops.h6e', true), set_config('app.change_reason', 'test', true)");
      await client.query(statement);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  /** 24–26: every confirmation row IDs-only and COMPLETED; every event consumed; no unknown task. */
  const assertQuiescent = async (h: Harness) => {
    const outbox = await oracle<{ topic: string; status: string; run_outcome: string | null; last_failure_class: string | null; subject_ids: Record<string, string> }>(
      "select topic, status, run_outcome, last_failure_class, subject_ids from system.outbox where workspace_id = $1", [h.t.workspaceId]);
    expect(outbox.filter((r) => r.status !== "DISPATCHED" || r.run_outcome !== "COMPLETED"), "every row delivered and COMPLETED").toEqual([]);
    expect(outbox.filter((r) => r.last_failure_class === "unknown_task"), "no unknown task").toEqual([]);
    for (const r of outbox.filter((x) => x.topic === CONFIRM)) {
      expect(Object.keys(r.subject_ids).sort()).toEqual(["connected_account_id", "interaction_id"]);
      for (const value of Object.values(r.subject_ids)) expect(value).toMatch(UUID);
    }
    expect(outbox.filter((r) => r.topic === "interactions.observed").length).toBe(await count("select count(*)::int as n from ingestion.ingestion_events where workspace_id = $1", [h.t.workspaceId]));
    expect(await count("select count(*)::int as n from (select provider_interaction_id from interactions.interactions where workspace_id = $1 group by 1 having count(*) > 1) d", [h.t.workspaceId]), "no duplicate canonical row").toBe(0);
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
  describe("FOUND: an existing interaction is re-read and nothing changes", () => {
    it("1–3, 21. FB comment, FB reply and IG comment FOUND: unchanged, no event; the target is the STORED provenance of the canonical row", async () => {
      const h = await harness();
      for (const id of ["fb_c_004", "fb_c_002", "ig_c_010"]) {
        const before = { events: (await eventsOf(h.t, id)).length, observations: (await observationsOf(h.t, id)).length, row: await row(h.t, id) };
        expect(await h.confirm(id), id).toEqual({ kind: "confirmed", outcome: "FOUND", changed: false });
        expect((await eventsOf(h.t, id)).length, id).toBe(before.events);
        expect((await observationsOf(h.t, id)).length, id).toBe(before.observations);
        expect(await row(h.t, id)).toEqual(before.row);
      }
      // 21. Each re-read named a STORED target whose provider ids are the canonical row's — no caller supplied any.
      const targets = getInteractionReads(h).map((r) => r.target);
      expect(targets.map((target) => target?.kind)).toEqual(["stored", "stored", "stored"]);
      const stored = targets.map((target) => (target?.kind === "stored" ? target.stored : undefined));
      expect(stored.map((s) => [s?.ref.id, s?.content.id, s?.parent?.id ?? null, s?.interactionKind, s?.account.id])).toEqual([
        ["fb_c_004", "fb_post_organic_01", null, "comment", "fb_page_aurora"],
        ["fb_c_002", "fb_post_organic_01", "fb_c_001", "reply", "fb_page_aurora"],
        ["ig_c_010", "ig_post_unknown_11", null, "comment", "ig_acct_aurora"],
      ]);
      expect(h.reads.filter((r) => r.operation !== "getInteraction"), "a confirmation reads nothing else").toEqual([]);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("AUTHORITATIVE_NOT_FOUND: the only removal authority", () => {
    it("4–6, 20. FB comment, FB reply and IG comment vanish → removed_at_source (direct_fetch_confirmed); rows, text history and coverage stay", async () => {
      const h = await harness();
      const traversal = await traversalDigest(h.t);
      for (const id of ["fb_c_005", "fb_c_003", "ig_c_010"]) {
        const before = await row(h.t, id);
        const versions = await textVersionsOf(h.t, id);
        h.world.removeAtSource(id, { signaled: false });
        expect(await h.confirm(id), id).toEqual({ kind: "confirmed", outcome: "AUTHORITATIVE_NOT_FOUND", changed: true });
        const after = await row(h.t, id);
        expect(after, id).toEqual({ ...before, current_availability: "removed_at_source", current_removal_basis: "direct_fetch_confirmed" });
        expect(await textVersionsOf(h.t, id), "text history preserved").toBe(versions);
        expect((await eventsOf(h.t, id)).map((e) => e.change).at(-1)).toBe("removed_at_source");
        expect((await observationsOf(h.t, id)).at(-1)).toEqual({ availability: "removed_at_source", removal_basis: "direct_fetch_confirmed", mechanism: "stored_reread", operation: "getInteraction", provenance: "stored" });
      }
      // 20. Object-level authority never touches traversal coverage or watermarks.
      expect(await traversalDigest(h.t)).toBe(traversal);
      await assertQuiescent(h);
    });

    it("16. a second not-found of an already removed interaction adds no event and no observation", async () => {
      const h = await harness();
      h.world.removeAtSource("fb_c_004", { signaled: false });
      await h.confirm("fb_c_004");
      const before = { events: (await eventsOf(h.t, "fb_c_004")).length, observations: (await observationsOf(h.t, "fb_c_004")).length };
      expect(await h.confirm("fb_c_004")).toEqual({ kind: "confirmed", outcome: "AUTHORITATIVE_NOT_FOUND", changed: false });
      expect({ events: (await eventsOf(h.t, "fb_c_004")).length, observations: (await observationsOf(h.t, "fb_c_004")).length }).toEqual(before);
      await assertQuiescent(h);
    });

    it("17. a removed interaction that reappears is the same canonical row, available again (state_changed), no new conversation", async () => {
      const h = await harness();
      h.world.removeAtSource("fb_c_004", { signaled: false });
      await h.confirm("fb_c_004");
      const removed = await row(h.t, "fb_c_004");
      const conversations = await count("select count(*)::int as n from conversations.conversations where workspace_id = $1", [h.t.workspaceId]);
      h.world.restoreAtSource("fb_c_004");
      expect(await h.confirm("fb_c_004")).toEqual({ kind: "confirmed", outcome: "FOUND", changed: true });
      const restored = await row(h.t, "fb_c_004");
      expect(restored?.id).toBe(removed?.id);
      expect([restored?.current_availability, restored?.current_removal_basis, restored?.conversation_id]).toEqual(["available", null, removed?.conversation_id]);
      expect((await eventsOf(h.t, "fb_c_004")).map((e) => e.change).slice(-2)).toEqual(["removed_at_source", "state_changed"]);
      expect(await count("select count(*)::int as n from conversations.conversations where workspace_id = $1", [h.t.workspaceId])).toBe(conversations);
      await assertQuiescent(h);
    });

    it("18–19. removing the conversation's anchor keeps the conversation, its anchor and every reply's linkage — nothing is re-anchored", async () => {
      const h = await harness();
      const anchor = await row(h.t, "fb_c_001");
      const conversation = (await oracle<{ id: string; anchor_interaction_id: string; workflow_state: string }>("select id, anchor_interaction_id, workflow_state from conversations.conversations where workspace_id = $1 and id = $2", [h.t.workspaceId, anchor?.conversation_id]))[0];
      const replies = [await row(h.t, "fb_c_002"), await row(h.t, "fb_c_003")];
      h.world.removeAtSource("fb_c_001", { signaled: false });
      expect(await h.confirm("fb_c_001")).toEqual({ kind: "confirmed", outcome: "AUTHORITATIVE_NOT_FOUND", changed: true });
      expect((await oracle("select id, anchor_interaction_id, workflow_state from conversations.conversations where workspace_id = $1 and id = $2", [h.t.workspaceId, anchor?.conversation_id]))[0]).toEqual(conversation);
      expect([await row(h.t, "fb_c_002"), await row(h.t, "fb_c_003")]).toEqual(replies);
      // 19. A removed reply keeps its parent and conversation.
      h.world.removeAtSource("fb_c_002", { signaled: false });
      await h.confirm("fb_c_002");
      const reply = await row(h.t, "fb_c_002");
      expect([reply?.parent_interaction_id, reply?.conversation_id, reply?.current_availability]).toEqual([anchor?.id, anchor?.conversation_id, "removed_at_source"]);
      expect((await row(h.t, "fb_c_003"))?.parent_interaction_id).toBe(reply?.id);
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("nothing else removes", () => {
    it("7. absence from a listing alone: a vanished interaction stays available through any number of reconciliations", async () => {
      const h = await harness();
      h.world.removeAtSource("fb_c_011", { signaled: false });
      await h.reconcile(h.t.fb);
      await h.reconcile(h.t.fb);
      expect(await row(h.t, "fb_c_011")).toMatchObject({ current_availability: "available", current_removal_basis: null });
      expect((await eventsOf(h.t, "fb_c_011")).map((e) => e.change)).toEqual(["created"]);
      expect(getInteractionReads(h)).toEqual([]);
      await assertQuiescent(h);
    });

    it.each([
      ["8. transient failure", { kind: "transient", reason: "network" }, "TEMPORARY_FAILURE"],
      ["9. rate limit", { kind: "rate_limited", retryAfterSeconds: 30 }, "TEMPORARY_FAILURE"],
      ["10. permission failure", { kind: "permission_missing", capability: "read_interactions" }, "AUTHORIZATION_FAILURE"],
      ["11. credential failure", { kind: "credential_invalid", reason: "revoked" }, "AUTHORIZATION_FAILURE"],
      ["15. ambiguous not-found (unconfirmed, as Meta's 100/33)", { kind: "target_not_found" }, "PROVIDER_CONTRACT_AMBIGUOUS"],
      ["15. a refused request", { kind: "permanent_rejected", reasonCode: "unknown" }, "PROVIDER_CONTRACT_AMBIGUOUS"],
    ] as const)("%s → no removal, no event; retries stay bounded by the task policy", async (_label, fault, outcome) => {
      const h = await harness();
      h.world.removeAtSource("fb_c_005", { signaled: false });
      h.world.injectFaults([{ operation: "getInteraction", on: "every", fault } satisfies FaultRule]);
      const before = await row(h.t, "fb_c_005");
      expect(await h.confirm("fb_c_005")).toEqual({ kind: "confirmed", outcome, changed: false });
      expect(await row(h.t, "fb_c_005")).toEqual(before);
      expect((await eventsOf(h.t, "fb_c_005")).map((e) => e.change)).toEqual(["created"]);
      const maxAttempts = PRODUCTION_TASKS.get(CONFIRM)?.retry.maxAttempts ?? 1;
      expect(getInteractionReads(h).length).toBe(outcome === "TEMPORARY_FAILURE" ? maxAttempts : 1);
      await assertQuiescent(h);
    });

    it("12–14. stale profile, removed connection, provider pause and an unvalidated scope: refused BEFORE any provider read", async () => {
      const h = await harness();
      for (const id of ["fb_c_005", "ig_c_010"]) h.world.removeAtSource(id, { signaled: false });
      // 12. Profile stale.
      await privileged.query("update capability.account_profiles set catalog_revision = catalog_revision - 1 where connected_account_id = $1", [h.t.fb]);
      expect(await h.confirm("fb_c_005")).toEqual({ kind: "confirmed", outcome: "CAPABILITY_UNAVAILABLE", changed: false });
      await privileged.query("update capability.account_profiles set catalog_revision = catalog_revision + 1 where connected_account_id = $1", [h.t.fb]);
      // Provider pause (kill switch).
      await switchChange(`insert into system.operational_switches (id, switch_key, qualifier, scope, organization_id, workspace_id, value, updated_at) values ('${randomUUID()}', 'ingestion.provider_pause', 'facebook', 'global', null, null, '{"paused": true}', now())`);
      expect(await h.confirm("fb_c_005")).toEqual({ kind: "confirmed", outcome: "CAPABILITY_UNAVAILABLE", changed: false });
      await switchChange("delete from system.operational_switches where switch_key = 'ingestion.provider_pause'");
      // 14. An unvalidated scope (the IG profile entry no longer validated for post/unknown).
      await privileged.query("update capability.profile_entries set state = 'UNKNOWN_NOT_VALIDATED', reason_codes = '{CATALOG_NOT_VALIDATED}', limitation_code = null where connected_account_id = $1 and capability = 'read_interactions' and content_kind = 'post'", [h.t.ig]);
      expect(await h.confirm("ig_c_010")).toEqual({ kind: "confirmed", outcome: "CAPABILITY_UNAVAILABLE", changed: false });
      // 13. Connection removed.
      await privileged.query("update connections.connections set status = 'REMOVED', active_credential_id = null where id = $1", [h.t.connection]);
      expect(await h.confirm("fb_c_005")).toEqual({ kind: "confirmed", outcome: "CAPABILITY_UNAVAILABLE", changed: false });
      expect(getInteractionReads(h), "no provider read at all").toEqual([]);
      for (const id of ["fb_c_005", "ig_c_010"]) expect((await row(h.t, id))?.current_availability, id).toBe("available");
      await assertQuiescent(h);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("scope and payload", () => {
    it("22. another workspace's interaction: the request refuses it, and a forged task row reads nothing and changes nothing", async () => {
      const h = await harness();
      const other = await harness();
      const foreign = await row(other.t, "fb_c_004");
      const refused = await withWorkspaceJobScope(worker, h.t.workspaceId, (tx) => requestInteractionConfirmation(reconciliationScope({ tx, noteOutbox: () => undefined }), h.ids, { interactionId: foreign?.id ?? "", correlationId: correlation() }));
      expect(refused).toEqual({ kind: "not_found" });
      // A forged row in h's workspace naming other's interaction (and h's own account): resolved under h's RLS → not found.
      await privileged.query(
        `insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, status, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, 'system', $7, 'PENDING', now() - interval '10 minutes')`,
        [randomUUID(), CONFIRM, h.t.organizationId, h.t.workspaceId, JSON.stringify({ connected_account_id: h.t.fb, interaction_id: foreign?.id }), correlation(), `${CONFIRM}:${randomUUID()}`]);
      await h.settle();
      expect(h.results.at(-1)).toEqual({ kind: "confirmed", outcome: "INTERACTION_NOT_FOUND", changed: false });
      expect(getInteractionReads(h)).toEqual([]);
      expect(await row(other.t, "fb_c_004")).toEqual(foreign);
      await assertQuiescent(h);
    });

    it("23–26. the confirmation task is INTEGRATION-only, IDs-only, and every event it causes is consumed terminally", () => {
      expect(PRODUCTION_TASKS.get(CONFIRM)?.executionPlane).toBe("integration");
      expect(PRODUCTION_TASKS.tenant(CONFIRM)?.subjects).toEqual(["connected_account_id", "interaction_id"]);
      expect(PRODUCTION_TASKS.get("interactions.observed")?.executionPlane).toBe("main");
    });
  });
}
