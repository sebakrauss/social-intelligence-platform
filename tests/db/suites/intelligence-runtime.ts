/**
 * Step H7-D1d — the intelligence runtime on the real database (schema 0025), SIMULATOR ONLY: no provider SDK, no
 * network, no credential. MAIN is driven through the real `interactions.observed` consumer (runTenantJob) and the real
 * relay (relayPass, fake job runtimes per plane); INTELLIGENCE through the real task wrapper (runTenantStepJob →
 * runUnderstandAi) with a composition whose only provider is the deterministic simulator. Proves the source defaults,
 * the atomic MAIN dispatch, the canonical reload and pre-model checks, the budget authority, the ledger / result /
 * SHADOW assessment writers, the A1 composition, the five failure classes, the generation-aware state machine, the R6/R7
 * recovery, ten concurrency cases and tenant isolation. All rows are synthetic and local (disposable cluster).
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLedgeredAiGateway, createModelRegistry, type ModelProvider, type ProviderCall, type ProviderRequest, type ProviderResponse } from "@/ai/gateway";
import { QUALIFIED_UNDERSTANDING_DESCRIPTOR } from "@/ai/providers/anthropic/qualified";
import { createSimulatorProvider, simulatorModel, type SimulatedResponse } from "@/ai/providers/simulator";
import { PRODUCTION_INTELLIGENCE, QUALIFIED_UNDERSTANDING_BINDING, runUnderstandAi, type IntelligenceComposition } from "@/jobs/intelligence";
import { INTELLIGENCE_ROUTE_POLICY } from "@/jobs/intelligence-policy";
import { runInteractionsObserved, type InteractionsObservedResult } from "@/jobs/reconciliation";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import {
  DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
  DETERMINISTIC_PIPELINE_VERSION,
  INTELLIGENCE_PIPELINE_VERSION,
  MAX_TRANSPORT_GENERATIONS,
  STALE_IN_FLIGHT_MS,
  UNDERSTAND_AI_TOPIC,
  dispatchUnderstanding,
  recoverStaleUnderstanding,
  understandAiDispatchKey,
  type UnderstandAiRoutePolicy,
} from "@/modules/classification";
import { runUnderstanding, understandAiRouteTable, type IntelligenceRunScope, type UnderstandingRunOutcome } from "@/modules/classification/intelligence-runtime";
import { createPostgresIntelligenceStore } from "@/modules/classification/persistence";
import { claimEffect, withUserScope, withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { runTenantJob, runTenantStepJob, type TenantJobPayload } from "@/platform/jobs";
import { createLogger, type Logger } from "@/platform/observability";
import { relayPass, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { intelligenceScope } from "@/server/persistence/classification";
import { CALL_ACCOUNTING_SQL, type CallAccountingRow } from "@/tools/db/ai-call-accounting";
import { CORPUS_FILE, parseEvalCorpus } from "../../eval/classification/corpus";
import { goldenOutput } from "../../eval/classification/golden";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { readFileSync } from "node:fs";
import path from "node:path";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly account: string;
  readonly asset: string;
  readonly content: string;
}

interface Comment {
  readonly interaction: string;
  readonly version: string;
}

const CORPUS = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, CORPUS_FILE), "utf8")));
const caseOf = (id: string) => CORPUS.cases.find((c) => c.id === id) ?? (() => { throw new Error(id); })();
const PRAISE = caseOf("es-cl-praise-01");
const COMPLAINT = caseOf("es-ar-complaint-01");
/** The synthetic corpus texts (committed evaluation data, never customer text). */
const textOf = (c: typeof PRAISE): string => {
  const text = c.input["text"];
  if (typeof text !== "string") throw new TypeError("corpus text");
  return text;
};
const PRAISE_TEXT = textOf(PRAISE);
const COMPLAINT_TEXT = textOf(COMPLAINT);
const SIM_REF = { providerKey: "simulator", modelKey: "sim" } as const;
const SIM_BINDING = { model: SIM_REF, modelRequested: "sim", transportSchemaVersion: "simulator-script.v1", routeFingerprint: createHash("sha256").update("h7-d1d-simulator-route").digest("hex") };
const CONFIG: DeliveryConfig = {
  batchSize: 50, leaseSeconds: 30, backoff: { baseSeconds: 5, maxSeconds: 60 }, dispatchSweepMinAgeSeconds: 60, dispatchSloSeconds: 120, maxRecoveries: 3, outcomeBatchSize: 50,
  unknownObservation: { maxChecks: 4, maxSeconds: 600 },
};

/** A scripted simulator behind a counting provider: every request reuses ONE script entry ("case"), whatever its reference. */
function scriptedProvider(responses: readonly SimulatedResponse[], options: { readonly usage?: boolean; readonly gate?: () => Promise<void> } = {}) {
  const simulator = createSimulatorProvider(new Map([["case", responses]]));
  const calls: ProviderCall[] = [];
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = {
    providerKey: simulator.providerKey,
    async complete(request, call): Promise<ProviderResponse> {
      calls.push(call);
      requests.push(request);
      await options.gate?.();
      const response = await simulator.complete(request, { reference: "case", attempt: call.attempt });
      return response.kind === "completed" && options.usage === true ? { ...response, usage: { inputTokens: 1234, outputTokens: 210, cachedInputTokens: 0 } } : response;
    },
  };
  return { provider, calls, requests };
}

/** A gate the test opens: the provider call blocks until `open()` (to hold a run in flight). */
function gate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  return { wait: async () => { entered(); await opened; }, open: () => { release(); }, reached };
}

export function defineIntelligenceRuntimeSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let worker: RuntimeDatabase<"worker">;
  let web: RuntimeDatabase<"web">;
  let system: RuntimeDatabase<"system">;
  const organizations: string[] = [];
  const lines: string[] = [];
  let logger: Logger;
  let A: Tenant;
  let B: Tenant;
  let now = new Date("2026-10-31T12:00:00.000Z");
  const clock = { newId: () => randomUUID(), now: () => now };
  const advance = (ms: number): void => { now = new Date(now.getTime() + ms); };

  /** An audited operational-switch change (0005: operator id and reason are required), committed. */
  const switchChange = async (statement: string): Promise<void> => {
    const client = await privileged.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.operator_id', 'ops.h7d1d', true), set_config('app.change_reason', 'test', true)");
      await client.query(statement);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;

  /** The simulator policy: complete route, synthetic fixture workspaces (never real data). */
  const policyFor = (overrides: Partial<UnderstandAiRoutePolicy> = {}): UnderstandAiRoutePolicy => ({
    ...DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
    enabled: true,
    samplingPercentage: 100,
    killSwitch: "inactive",
    model: SIM_REF,
    timeoutMs: 30_000,
    budget: { kind: "caps", maxCallsPerDay: 1_000, maxInputCharsPerDay: 50_000_000 },
    fixtureWorkspaceIds: [A.workspaceId, B.workspaceId],
    ...overrides,
  });
  const composition = (provider: ModelProvider, overrides: Partial<IntelligenceComposition> = {}): IntelligenceComposition => ({
    policy: policyFor(),
    models: [simulatorModel("sim")],
    providers: () => [provider],
    binding: SIM_BINDING,
    clock,
    ...overrides,
  });

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const owner = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'H7D1D', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [organizationId, owner]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [organizationId, workspaceId, owner]);
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, owner]);
    const asset = `h7d1d_${randomUUID().slice(0, 8)}`;
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, asset]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
    const content = randomUUID();
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
                                          source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, 'post', 'organic', 'available', now(), now(), now(), now())`, [content, organizationId, workspaceId, account, asset, `${asset}_p`]);
    return { organizationId, workspaceId, owner, account, asset, content };
  };

  const versionOf = async (t: Tenant, interaction: string, text: string): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into interactions.source_text_versions (id, organization_id, workspace_id, interaction_id, text_hash, source_text, provider_edited_at, observed_at, created_at)
       values ($1, $2, $3, $4, $5, $6, null, now(), now())`, [id, t.organizationId, t.workspaceId, interaction, createHash("sha256").update(text, "utf8").digest("hex"), text]);
    await privileged.query("update interactions.interactions set current_source_text_version_id = $1, text_observed_at = now() where id = $2", [id, interaction]);
    return id;
  };

  /** An OBSERVED canonical comment (or reply to `parent`) whose CURRENT text is `text`, as ingestion commits it. */
  const comment = async (t: Tenant, text: string, options: { readonly role?: "account_identity" | "user" | "unknown"; readonly parent?: Comment } = {}): Promise<Comment> => {
    const interaction = randomUUID();
    const author = randomUUID();
    const role = options.role ?? "user";
    await privileged.query("insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at) values ($1, $2, $3, 'facebook', $4, $5, null, now(), now())",
      [author, t.organizationId, t.workspaceId, `a_${author.slice(0, 8)}`, role]);
    await privileged.query(
      `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
         provider_content_id, observed, kind, parent_interaction_id, author_id, author_role, current_visibility, current_availability, provider_created_at, state_observed_at,
         first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, $7, $8, true, $9, $10, $11, $12, 'visible', 'available', now(), now(), now(), now(), now(), now())`,
      [interaction, t.organizationId, t.workspaceId, `${t.asset}_c_${interaction.slice(0, 8)}`, t.account, t.asset, t.content, `${t.asset}_p`, options.parent === undefined ? "comment" : "reply",
        options.parent?.interaction ?? null, author, role]);
    return { interaction, version: await versionOf(t, interaction, text) };
  };

  const observed = async (t: Tenant, c: Comment) => {
    const event = randomUUID();
    await privileged.query(
      `insert into ingestion.ingestion_events (id, organization_id, workspace_id, interaction_id, conversation_id, source_text_version_id, change, arrival, observed_at, correlation_id, initiator, created_at)
       values ($1, $2, $3, $4, null, $5, 'created', 'realtime', now(), $6, 'system', now())`, [event, t.organizationId, t.workspaceId, c.interaction, c.version, `h7d1d-${randomUUID()}`]);
    return { v: 1, scope: "workspace", task: "interactions.observed", workspaceId: t.workspaceId, outboxId: randomUUID(), subjectIds: { ingestion_event_id: event, interaction_id: c.interaction, source_text_version_id: c.version }, correlationId: `h7d1d-${randomUUID()}`, initiator: { type: "system" } };
  };
  const deliverObserved = (payload: unknown, policy: UnderstandAiRoutePolicy): Promise<InteractionsObservedResult> =>
    runTenantJob({ registry: PRODUCTION_TASKS, worker, logger }, "interactions.observed", payload, { runId: `run_${randomUUID().slice(0, 8)}`, attempt: 1 }, (context) => runInteractionsObserved(context, clock, logger, policy));

  /** The IDs-only outbox rows of the intelligence topic for one text version (oldest first). */
  const dispatches = (c: Comment) => oracle<{ id: string; dispatch_key: string; subject_ids: Record<string, string>; correlation_id: string; workspace_id: string; status: string; execution_plane: string | null; initiator_type: string }>(
    `select id, dispatch_key, subject_ids, correlation_id, workspace_id, status, execution_plane, initiator_type from system.outbox
      where topic = $1 and subject_ids ->> 'source_text_version' = $2 order by created_at, dispatch_key`, [UNDERSTAND_AI_TOPIC, c.version]);
  /** The tenant envelope the relay builds from an outbox row (platform/outbox/delivery payloadFor). */
  const envelopeOf = (row: { id: string; workspace_id: string; subject_ids: Record<string, string>; correlation_id: string }): TenantJobPayload =>
    ({ v: 1, scope: "workspace", task: UNDERSTAND_AI_TOPIC, workspaceId: row.workspace_id, outboxId: row.id, subjectIds: row.subject_ids, correlationId: row.correlation_id, initiator: { type: "system" } });
  const runAi = (payload: unknown, comp: IntelligenceComposition): Promise<UnderstandingRunOutcome> =>
    runTenantStepJob({ registry: PRODUCTION_TASKS, worker, logger }, UNDERSTAND_AI_TOPIC, payload, { runId: `run_${randomUUID().slice(0, 8)}`, attempt: 1 }, (context) => runUnderstandAi(context, comp, logger));
  /** The latest dispatch of a version, run once. */
  const runLatest = async (c: Comment, comp: IntelligenceComposition): Promise<UnderstandingRunOutcome> => {
    const rows = await dispatches(c);
    const last = rows.at(-1);
    if (last === undefined) throw new Error("no dispatch");
    return runAi(envelopeOf(last), comp);
  };

  const request = (c: Comment) => oracle<{ id: string; state: string; ai_generation: number | null; ai_failure_class: string | null; completed: boolean }>(
    "select id, state, ai_generation, ai_failure_class, completed_at is not null as completed from classification.understanding_requests where source_text_version_id = $1 and pipeline_version = $2",
    [c.version, INTELLIGENCE_PIPELINE_VERSION]).then((rows) => rows[0]);
  const attempts = (c: Comment) => oracle<{ id: string; dispatch_generation: number; attempt_number: number; outcome: string; failure_class: string | null; issue_codes: string[]; input_chars: number;
    input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null; cost_estimate_usd: string | null; pricing_table_version: string | null; provider: string; model_requested: string; transport_schema_version: string }>(
    `select id, dispatch_generation, attempt_number, outcome, failure_class, issue_codes, input_chars, input_tokens, output_tokens, cached_input_tokens, cost_estimate_usd, pricing_table_version,
            provider, model_requested, transport_schema_version
       from classification.ai_attempts where source_text_version_id = $1 order by dispatch_generation, attempt_number`, [c.version]);
  const results = (c: Comment) => oracle<{ id: string; attempt_id: string; acceptance_mode: string; dispatch_generation: number; summary: string | null; evidence_starts: number[] | null; route_fingerprint: string }>(
    "select id, attempt_id, acceptance_mode, dispatch_generation, summary, evidence_starts, route_fingerprint from classification.ai_results where source_text_version_id = $1", [c.version]);
  const aiAssessments = (c: Comment) => oracle<{ dimension: string; origin: string; acceptance_mode: string; ai_result_id: string; pipeline_version: string; language_policy_version: string; value_keys: string[] | null }>(
    "select dimension, origin, acceptance_mode, ai_result_id, pipeline_version, language_policy_version, value_keys from classification.assessments where source_text_version_id = $1 order by dimension", [c.version]);

  /** One complete happy dispatch: an observed event whose request is AI_PENDING generation 1 with its outbox row. */
  const dispatched = async (t: Tenant, text: string, policy = policyFor()): Promise<Comment> => {
    const c = await comment(t, text);
    const result = await deliverObserved(await observed(t, c), policy);
    expect(result.intelligence).toMatchObject({ kind: "dispatched", generation: 1 });
    return c;
  };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target, 4);
    worker = runtimeDatabase(target, "worker", 8);
    web = runtimeDatabase(target, "web", 2);
    system = runtimeDatabase(target, "system", 2);
    logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date() });
    A = await tenant();
    B = await tenant();
  });
  afterAll(async () => {
    await worker.end();
    await web.end();
    await system.end();
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  describe("26 · source defaults: nothing runs", () => {
    it("the production policy IS the deny-by-default policy; an observed comment gets its deterministic request only", async () => {
      expect(INTELLIGENCE_ROUTE_POLICY).toBe(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY);
      expect(PRODUCTION_INTELLIGENCE.policy).toBe(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY);
      expect(DEFAULT_UNDERSTAND_AI_ROUTE_POLICY).toMatchObject({ enabled: false, samplingPercentage: 0, killSwitch: "active", realDataEligible: false, budget: { kind: "deny_all" }, model: null, timeoutMs: null });
      const c = await comment(A, PRAISE_TEXT);
      const result = await deliverObserved(await observed(A, c), INTELLIGENCE_ROUTE_POLICY);
      expect(result.classification).toMatchObject({ kind: "recorded", state: "DETERMINISTIC_DONE" });
      expect(result.intelligence).toEqual({ kind: "skipped", reason: "route_disabled" });
      expect(await request(c)).toBeUndefined();
      expect(await dispatches(c)).toEqual([]);
      expect(await count("select count(*)::int as n from classification.ai_budget_reservations where workspace_id = $1", [A.workspaceId])).toBe(0);
    });

    it("the qualified descriptor is disabled: even a complete route and a provider make no call (AI_UNAVAILABLE)", async () => {
      const qualifiedRef = { providerKey: "anthropic", modelKey: "claude-sonnet-5-5" };
      const c = await dispatched(A, PRAISE_TEXT, policyFor({ model: qualifiedRef }));
      const counting = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      const anthropicShaped: ModelProvider = { providerKey: "anthropic", complete: (r, call) => counting.provider.complete(r, call) };
      const outcome = await runLatest(c, composition(anthropicShaped, { policy: policyFor({ model: qualifiedRef }), models: [QUALIFIED_UNDERSTANDING_DESCRIPTOR], binding: QUALIFIED_UNDERSTANDING_BINDING }));
      expect(outcome).toMatchObject({ kind: "failed", failureClass: "AI_UNAVAILABLE", cause: "model_unavailable", redispatched: false, attempts: 0 });
      expect(counting.calls).toHaveLength(0);
      expect(await request(c)).toMatchObject({ state: "AI_FAILED", ai_failure_class: "AI_UNAVAILABLE" });
    });
  });

  describe("17–19 · MAIN dispatch and the relay", () => {
    it("the request becomes AI_PENDING generation 1 with exactly one IDs-only outbox row, in the consumer's transaction", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const req = await request(c);
      expect(req).toMatchObject({ state: "AI_PENDING", ai_generation: 1, ai_failure_class: null, completed: false });
      const rows = await dispatches(c);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dispatch_key: understandAiDispatchKey(req?.id ?? "", 1), status: "PENDING", execution_plane: null, initiator_type: "system", workspace_id: A.workspaceId });
      expect(rows[0]?.subject_ids).toEqual({ interaction: c.interaction, source_text_version: c.version, understanding_request: req?.id });
      // The deterministic request of the same version is untouched (a different pipeline, a different request).
      expect(await oracle("select state from classification.understanding_requests where source_text_version_id = $1 and pipeline_version = $2", [c.version, DETERMINISTIC_PIPELINE_VERSION])).toEqual([{ state: "DETERMINISTIC_DONE" }]);
      // A replayed delivery converges: no second request, no second row.
      const replay = await deliverObserved(await observed(A, c), policyFor());
      expect(replay.intelligence).toMatchObject({ kind: "existing", state: "AI_PENDING" });
      expect(await dispatches(c)).toHaveLength(1);
    });

    it("atomicity: a consumer transaction that fails after the dispatch leaves neither the AI_PENDING request nor its outbox row", async () => {
      const c = await comment(A, PRAISE_TEXT);
      await expect(withWorkspaceJobScope(worker, A.workspaceId, async (tx) => {
        const outcome = await dispatchUnderstanding(intelligenceScope({ tx, noteOutbox: () => undefined }), clock, policyFor(), { workspaceId: A.workspaceId, interactionId: c.interaction, sourceTextVersionId: c.version, arrival: "realtime", correlationId: "h7d1d-atomic-0001" });
        expect(outcome.kind).toBe("dispatched");
        throw new Error("rolled back after dispatch");
      })).rejects.toThrow("rolled back after dispatch");
      expect(await request(c)).toBeUndefined();
      expect(await dispatches(c)).toEqual([]);
    });

    it("the relay binds the row to the INTELLIGENCE plane and enqueues it only on the intelligence runtime, which completes it", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      const deps = { registry: PRODUCTION_TASKS, worker, logger };
      const handler: FakeHandler = (payload, run) => runTenantStepJob(deps, UNDERSTAND_AI_TOPIC, payload, run, (context) => runUnderstandAi(context, composition(sim.provider), logger));
      const intelligence = new FakeJobRuntime(new Map([[UNDERSTAND_AI_TOPIC, handler]]), () => PRODUCTION_TASKS.get(UNDERSTAND_AI_TOPIC)?.retry ?? { maxAttempts: 1, factor: 1, minDelayMs: 1, maxDelayMs: 1, randomize: false });
      const elsewhere = new FakeJobRuntime(new Map(), () => ({ maxAttempts: 1, factor: 1, minDelayMs: 1, maxDelayMs: 1, randomize: false }));
      const delivery: DeliveryDependencies = { system, runtimes: { main: elsewhere, integration: elsewhere, intelligence }, registry: PRODUCTION_TASKS, logger, clock: () => new Date(), config: CONFIG };
      await relayPass(delivery);
      const [row] = await dispatches(c);
      expect(row).toMatchObject({ status: "DISPATCHED", execution_plane: "intelligence" });
      expect(intelligence.enqueued.map((e) => e.task)).toContain(UNDERSTAND_AI_TOPIC);
      expect(elsewhere.enqueued.filter((e) => e.task === UNDERSTAND_AI_TOPIC)).toEqual([]);
      await intelligence.drain();
      expect(await request(c)).toMatchObject({ state: "COMPLETED", ai_generation: 1, completed: true });
      // The pass also delivered the other pending intelligence rows of the cluster; THIS request was called once.
      expect(await attempts(c)).toHaveLength(1);
      // Minimal wake-up: the run reports nothing back by payload; no `classification.understood` row exists.
      expect(await count("select count(*)::int as n from system.outbox where topic like 'classification.understood%'")).toBe(0);
    });
  });

  describe("22 · simulator flows: success", () => {
    it("ledger → shadow result → A1 composition → SHADOW assessments; COMPLETED; usage recorded, cost null; no text copied", async () => {
      const c = await dispatched(A, COMPLAINT_TEXT);
      const body = { ...goldenOutput(COMPLAINT), summary: "Pedido demorado sin respuesta.", evidence: [{ quote: "nadie responde" }] };
      const sim = scriptedProvider([{ kind: "output", body }], { usage: true });
      const outcome = await runLatest(c, composition(sim.provider));
      expect(outcome).toMatchObject({ kind: "completed", generation: 1, attempts: 1 });
      if (outcome.kind !== "completed") throw new Error("not completed");
      // Protection / Needs review are DERIVED by the canonical A1 functions (a complaint is protected meaning).
      expect(outcome.protection.result).toBe("protected");
      expect(outcome.needsReview.policyVersion).toMatch(/^needs-review/);
      const [attempt] = await attempts(c);
      expect(attempt).toMatchObject({ dispatch_generation: 1, attempt_number: 1, outcome: "accepted", failure_class: null, issue_codes: [], input_tokens: 1234, output_tokens: 210, cached_input_tokens: 0,
        cost_estimate_usd: null, pricing_table_version: null, provider: "simulator", model_requested: "sim", transport_schema_version: "simulator-script.v1" });
      expect(attempt?.input_chars).toBeGreaterThan(COMPLAINT_TEXT.length);
      const [result] = await results(c);
      expect(result).toMatchObject({ attempt_id: attempt?.id, acceptance_mode: "shadow", dispatch_generation: 1, summary: "Pedido demorado sin respuesta.", route_fingerprint: SIM_BINDING.routeFingerprint });
      expect(result?.evidence_starts).toEqual([COMPLAINT_TEXT.indexOf("nadie responde")]);
      const assessed = await aiAssessments(c);
      expect(assessed.length).toBe(outcome.assessments);
      expect(assessed.length).toBeGreaterThan(0);
      for (const a of assessed) expect(a).toMatchObject({ origin: "ai", acceptance_mode: "shadow", ai_result_id: result?.id, pipeline_version: INTELLIGENCE_PIPELINE_VERSION, language_policy_version: "language-policy.v1" });
      expect(await request(c)).toMatchObject({ state: "COMPLETED", ai_generation: 1, completed: true });
      // No raw text, prompt or response anywhere in the new rows.
      const dump = (await oracle<{ d: string }>(
        `select coalesce((select string_agg(row_to_json(x)::text, '|') from classification.ai_attempts x where source_text_version_id = $1), '') ||
                coalesce((select string_agg(row_to_json(y)::text, '|') from classification.ai_results y where source_text_version_id = $1), '') as d`, [c.version]))[0]?.d ?? "";
      expect(dump).not.toContain("Hace dos semanas");
      expect(dump).not.toContain("nadie responde");
      expect(dump).not.toMatch(/WRENKIND_UNTRUSTED_DATA|schemaVersion|dimensions/);
      // Members never read the shadow rows (0025 no_shadow_member_reads); the worker does.
      const memberRows = await withUserScope(web, { sub: A.owner, role: "authenticated" }, A.workspaceId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from classification.assessments where acceptance_mode = 'shadow'`));
      expect(memberRows.rows[0]?.n).toBe(0);
    });

    it("an invalid first output gets ONE re-ask; the valid re-ask is the accepted attempt", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "raw", text: "not json" }, { kind: "output", body: goldenOutput(PRAISE) }]);
      const outcome = await runLatest(c, composition(sim.provider));
      expect(outcome).toMatchObject({ kind: "completed", attempts: 2 });
      const rows = await attempts(c);
      expect(rows.map((r) => [r.attempt_number, r.outcome, r.issue_codes])).toEqual([[1, "invalid_output", ["MALFORMED_JSON"]], [2, "accepted", []]]);
      expect((await results(c))[0]?.attempt_id).toBe(rows[1]?.id);
      // The re-ask carries only the closed issue codes, never the rejected output.
      expect(sim.requests[1]?.system).toMatch(/Issue codes: MALFORMED_JSON\./);
      expect(sim.requests[1]?.system).not.toContain("not json");
    });
  });

  describe("15 · simulator flows: the five failure classes", () => {
    it("AI_INVALID_OUTPUT after the one re-ask: two attempts, no result, no assessment", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "raw", text: "{" }, { kind: "output", body: { ...goldenOutput(PRAISE), protection: "not_protected" } }]);
      const outcome = await runLatest(c, composition(sim.provider));
      expect(outcome).toMatchObject({ kind: "failed", failureClass: "AI_INVALID_OUTPUT", redispatched: false, attempts: 2 });
      if (outcome.kind === "failed") expect(outcome.protection.result).toBe("uncertain");
      expect((await attempts(c)).map((r) => [r.outcome, r.failure_class])).toEqual([["invalid_output", "AI_INVALID_OUTPUT"], ["invalid_output", "AI_INVALID_OUTPUT"]]);
      expect((await attempts(c))[1]?.issue_codes).toContain("UNEXPECTED_KEY");
      expect(await results(c)).toEqual([]);
      expect(await aiAssessments(c)).toEqual([]);
      expect(await request(c)).toMatchObject({ state: "AI_FAILED", ai_failure_class: "AI_INVALID_OUTPUT", completed: true });
    });

    it("AI_UNAVAILABLE (transient): each failure dispatches the next generation, bounded by MAX_TRANSPORT_GENERATIONS, then AI_FAILED", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "unavailable" }]);
      for (let generation = 1; generation <= MAX_TRANSPORT_GENERATIONS; generation += 1) {
        const outcome = await runLatest(c, composition(sim.provider));
        expect(outcome).toMatchObject({ kind: "failed", failureClass: "AI_UNAVAILABLE", generation, redispatched: generation < MAX_TRANSPORT_GENERATIONS });
      }
      expect(sim.calls).toHaveLength(MAX_TRANSPORT_GENERATIONS);
      expect((await dispatches(c)).map((r) => r.dispatch_key.slice(-3))).toEqual([":a1", ":a2", ":a3"]);
      expect(await request(c)).toMatchObject({ state: "AI_FAILED", ai_generation: MAX_TRANSPORT_GENERATIONS, ai_failure_class: "AI_UNAVAILABLE" });
      expect((await attempts(c)).map((r) => r.dispatch_generation)).toEqual([1, 2, 3]);
    });

    it("AI_REFUSED: one attempt, no retry, no result", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "refusal" }]);
      expect(await runLatest(c, composition(sim.provider))).toMatchObject({ kind: "failed", failureClass: "AI_REFUSED", redispatched: false, attempts: 1 });
      expect(await request(c)).toMatchObject({ state: "AI_FAILED", ai_failure_class: "AI_REFUSED" });
      expect(await results(c)).toEqual([]);
    });

    it("AI_BUDGET: a denied reservation (reserve_ai_budget) makes ZERO provider calls; caps are atomic per workspace × day", async () => {
      const tight = policyFor({ budget: { kind: "caps", maxCallsPerDay: 2, maxInputCharsPerDay: 50_000_000 } });
      const first = await dispatched(B, PRAISE_TEXT, tight);
      const second = await dispatched(B, COMPLAINT_TEXT, tight);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      expect(await runLatest(first, composition(sim.provider, { policy: tight }))).toMatchObject({ kind: "completed" });
      const denied = await runLatest(second, composition(sim.provider, { policy: tight }));
      expect(denied).toMatchObject({ kind: "failed", failureClass: "AI_BUDGET", cause: "budget_exhausted", attempts: 0, redispatched: false });
      expect(sim.calls).toHaveLength(1);
      expect(await attempts(second)).toEqual([]);
      expect(await oracle("select reserved_calls, task_id from classification.ai_budget_reservations where workspace_id = $1", [B.workspaceId])).toEqual([{ reserved_calls: 2, task_id: "classification.understanding" }]);
    });

    it("AI_INPUT_TOO_LARGE: beyond the model's input bound the gateway refuses (no call, no result); the A1 bound equals the canonical one", async () => {
      // The canonical source text is itself bounded at the A1 analyzed-text bound (0017: 32 768), so the dispatch-time
      // AI_INPUT_TOO_LARGE branch is defense in depth (unit-tested); the model bound is the reachable one.
      await expect(comment(A, "a".repeat(32_769))).rejects.toThrow(/source_text_versions_source_text_check/);
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      const outcome = await runLatest(c, composition(sim.provider, { models: [simulatorModel("sim", { maxInputChars: 100 })] }));
      expect(outcome).toMatchObject({ kind: "failed", failureClass: "AI_INPUT_TOO_LARGE", attempts: 0 });
      expect(sim.calls).toHaveLength(0);
      expect(await results(c)).toEqual([]);
    });
  });

  describe("22 · safety", () => {
    it("an action field or a model-supplied Protection is rejected as output (never applied); no mutation, alert or canonical change", async () => {
      const c = await dispatched(A, COMPLAINT_TEXT);
      const canonicalBefore = await oracle("select md5(string_agg(row_to_json(i)::text, '|' order by i.id)) as d from interactions.interactions i where workspace_id = $1", [A.workspaceId]);
      const sim = scriptedProvider([{ kind: "output", body: { ...goldenOutput(COMPLAINT), action: "hide" } }, { kind: "output", body: { ...goldenOutput(COMPLAINT), needsReview: false } }]);
      expect(await runLatest(c, composition(sim.provider))).toMatchObject({ kind: "failed", failureClass: "AI_INVALID_OUTPUT" });
      expect((await attempts(c)).every((r) => r.issue_codes.includes("UNEXPECTED_KEY"))).toBe(true);
      expect(await oracle("select md5(string_agg(row_to_json(i)::text, '|' order by i.id)) as d from interactions.interactions i where workspace_id = $1", [A.workspaceId])).toEqual(canonicalBefore);
      // The only outbox rows any intelligence code writes are its own dispatches.
      expect(await count("select count(*)::int as n from system.outbox where workspace_id = $1 and topic not in ('classification.understand_ai')", [A.workspaceId])).toBe(0);
    });

    it("never dispatched: own-brand, empty and emoji-only text, real data, the global ai.task_kill switch", async () => {
      const own = await comment(A, "Gracias por escribirnos", { role: "account_identity" });
      expect((await deliverObserved(await observed(A, own), policyFor())).intelligence).toBeNull();
      const empty = await comment(A, "   ");
      expect((await deliverObserved(await observed(A, empty), policyFor())).intelligence).toEqual({ kind: "skipped", reason: "text_empty" });
      const emoji = await comment(A, "🔥🔥👍🏽");
      expect((await deliverObserved(await observed(A, emoji), policyFor())).intelligence).toEqual({ kind: "skipped", reason: "text_emoji_only" });
      const real = await comment(A, PRAISE_TEXT);
      expect((await deliverObserved(await observed(A, real), policyFor({ fixtureWorkspaceIds: [] }))).intelligence).toEqual({ kind: "skipped", reason: "real_data_not_eligible" });
      const killed = await comment(A, PRAISE_TEXT);
      await switchChange("insert into system.operational_switches (switch_key, qualifier, scope, value) values ('ai.task_kill', 'classification_understanding', 'global', '{\"active\": true}')");
      try {
        expect((await deliverObserved(await observed(A, killed), policyFor())).intelligence).toEqual({ kind: "skipped", reason: "kill_switch" });
      } finally {
        await switchChange("delete from system.operational_switches where switch_key = 'ai.task_kill'");
      }
      for (const c of [own, empty, emoji, real, killed]) expect(await request(c)).toBeUndefined();
    });

    it("the kill switch at EXECUTION: a dispatched request is refused without a provider call", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      await switchChange("insert into system.operational_switches (switch_key, qualifier, scope, value) values ('ai.task_kill', '*', 'global', '{\"active\": true}')");
      try {
        expect(await runLatest(c, composition(sim.provider))).toEqual({ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "kill_switch" });
      } finally {
        await switchChange("delete from system.operational_switches where switch_key = 'ai.task_kill'");
      }
      expect(sim.calls).toHaveLength(0);
      // The policy's own kill switch too (the gateway's), and a route disabled since dispatch.
      const d = await dispatched(A, PRAISE_TEXT);
      expect(await runLatest(d, composition(sim.provider, { policy: policyFor({ killSwitch: "active" }) }))).toEqual({ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "kill_switch" });
      expect(sim.calls).toHaveLength(0);
    });

    it("a classification.deterministic.v1 request is never continued; a reply's parent text reaches the model only as the bounded excerpt", async () => {
      const c = await comment(A, PRAISE_TEXT);
      await deliverObserved(await observed(A, c), INTELLIGENCE_ROUTE_POLICY);
      const [deterministic] = await oracle<{ id: string }>("select id from classification.understanding_requests where source_text_version_id = $1", [c.version]);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      const forged = { v: 1, scope: "workspace", task: UNDERSTAND_AI_TOPIC, workspaceId: A.workspaceId, outboxId: randomUUID(), subjectIds: { interaction: c.interaction, source_text_version: c.version, understanding_request: deterministic?.id ?? "" }, correlationId: "h7d1d-forged-0001", initiator: { type: "system" } };
      expect(await runAi(forged, composition(sim.provider))).toEqual({ kind: "skipped", reason: "pipeline_not_intelligence" });
      const parent = await comment(A, "Hola, ¿cómo están?");
      const reply = await comment(A, COMPLAINT_TEXT, { parent });
      const result = await deliverObserved(await observed(A, reply), policyFor());
      expect(result.intelligence).toMatchObject({ kind: "dispatched" });
      await runLatest(reply, composition(sim.provider));
      const data = sim.requests.at(-1)?.data ?? "";
      expect(data).toContain('"interactionKind":"reply"');
      expect(data).toContain('"parentExcerpt":"Hola, ¿cómo están?"');
      expect(data).not.toMatch(/workspaceId|interactionId|author|handle/);
      expect(sim.calls).toHaveLength(1);
    });
  });

  describe("23 · concurrency and idempotency", () => {
    it("1+5 · duplicate deliveries racing the same request: one provider call, one result", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const hold = gate();
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }], { gate: hold.wait });
      const [row] = await dispatches(c);
      if (row === undefined) throw new Error("no dispatch");
      const first = runAi(envelopeOf(row), composition(sim.provider));
      await hold.reached;
      const duplicates = await Promise.all([runAi(envelopeOf(row), composition(sim.provider)), runAi(envelopeOf(row), composition(sim.provider))]);
      hold.open();
      expect(await first).toMatchObject({ kind: "completed" });
      for (const d of duplicates) expect(d).toEqual({ kind: "skipped", reason: "already_running" });
      expect(sim.calls).toHaveLength(1);
      expect(await results(c)).toHaveLength(1);
    });

    it("2 · duplicate outbox delivery after completion and a duplicate dispatch key: no new row, no new call", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      await runLatest(c, composition(sim.provider));
      expect(await runLatest(c, composition(sim.provider))).toEqual({ kind: "skipped", reason: "already_terminal" });
      const req = await request(c);
      const appended = await withWorkspaceJobScope(worker, A.workspaceId, async (tx) => {
        const store = createPostgresIntelligenceStore(tx, () => undefined);
        const locked = await store.lockRequest(req?.id ?? "");
        if (locked === undefined) throw new Error("request");
        return store.appendDispatch({ request: locked, generation: 1, correlationId: "h7d1d-dup-key-0001", outboxId: randomUUID(), now });
      });
      expect(appended).toBe("exists");
      expect(sim.calls).toHaveLength(1);
      expect(await dispatches(c)).toHaveLength(1);
    });

    it("3 · a stale generation's delivery runs the CURRENT generation once; the current delivery is then a duplicate", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      await runLatest(c, composition(scriptedProvider([{ kind: "timeout" }]).provider));
      const [old, current] = await dispatches(c);
      if (old === undefined || current === undefined) throw new Error("two dispatches expected");
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      expect(await runAi(envelopeOf(old), composition(sim.provider))).toMatchObject({ kind: "completed", generation: 2 });
      expect(await runAi(envelopeOf(current), composition(sim.provider))).toEqual({ kind: "skipped", reason: "already_terminal" });
      expect(sim.calls).toHaveLength(1);
      expect((await attempts(c)).map((r) => [r.dispatch_generation, r.outcome])).toEqual([[1, "unavailable"], [2, "accepted"]]);
    });

    it("4 · a version superseded after dispatch is refused at execution (no provider call)", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      await versionOf(A, c.interaction, "texto editado después");
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      expect(await runLatest(c, composition(sim.provider))).toEqual({ kind: "refused", failureClass: "AI_UNAVAILABLE", reason: "version_superseded" });
      expect(sim.calls).toHaveLength(0);
      expect(await request(c)).toMatchObject({ state: "AI_FAILED", ai_failure_class: "AI_UNAVAILABLE" });
    });

    it("6 · a duplicate racing a re-ask: still two attempts and one result", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const hold = gate();
      const sim = scriptedProvider([{ kind: "raw", text: "nope" }, { kind: "output", body: goldenOutput(PRAISE) }], { gate: hold.wait });
      const [row] = await dispatches(c);
      if (row === undefined) throw new Error("no dispatch");
      const first = runAi(envelopeOf(row), composition(sim.provider));
      await hold.reached;
      const duplicate = await runAi(envelopeOf(row), composition(sim.provider));
      hold.open();
      expect(await first).toMatchObject({ kind: "completed", attempts: 2 });
      expect(duplicate).toEqual({ kind: "skipped", reason: "already_running" });
      expect(await attempts(c)).toHaveLength(2);
      expect(await results(c)).toHaveLength(1);
    });

    it("7 · repeated completion of a completed request changes nothing", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      await runLatest(c, composition(sim.provider));
      const before = await aiAssessments(c);
      for (let i = 0; i < 3; i += 1) expect(await runLatest(c, composition(sim.provider))).toEqual({ kind: "skipped", reason: "already_terminal" });
      expect(await aiAssessments(c)).toEqual(before);
      expect(await attempts(c)).toHaveLength(1);
    });

    it("8 · recovery during an active run: not stale ⇒ untouched; stale ⇒ next generation, and the late run accepts NOTHING", async () => {
      const t = await tenant();
      const own = policyFor({ fixtureWorkspaceIds: [t.workspaceId] });
      const c = await dispatched(t, PRAISE_TEXT, own);
      const hold = gate();
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }], { gate: hold.wait });
      const late = runLatest(c, composition(sim.provider, { policy: own }));
      await hold.reached;
      const recover = () => withWorkspaceJobScope(worker, t.workspaceId, (tx) => recoverStaleUnderstanding(intelligenceScope({ tx, noteOutbox: () => undefined }), clock, own, { correlationId: "h7d1d-recovery-0001" }));
      expect(await recover()).toEqual({ redispatched: 0, failed: 0 });
      advance(STALE_IN_FLIGHT_MS + 60_000);
      expect(await recover()).toEqual({ redispatched: 1, failed: 0 });
      expect(await request(c)).toMatchObject({ state: "AI_PENDING", ai_generation: 2 });
      hold.open();
      expect(await late).toMatchObject({ kind: "generation_superseded", generation: 1, attempts: 1 });
      expect(await results(c)).toEqual([]);
      const next = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      expect(await runLatest(c, composition(next.provider, { policy: own }))).toMatchObject({ kind: "completed", generation: 2 });
      // At-least-once window: two provider calls happened (the late one is in the ledger), ONE result was accepted.
      expect((await attempts(c)).map((r) => r.dispatch_generation)).toEqual([1, 2]);
      expect(await results(c)).toHaveLength(1);
    });

    it("9 · two requests racing one budget: exactly one reservation succeeds, the other is AI_BUDGET with zero calls", async () => {
      const t = await tenant();
      const tight = policyFor({ budget: { kind: "caps", maxCallsPerDay: 2, maxInputCharsPerDay: 50_000_000 }, fixtureWorkspaceIds: [t.workspaceId] });
      const one = await dispatched(t, PRAISE_TEXT, tight);
      const two = await dispatched(t, PRAISE_TEXT, tight);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      const outcomes = await Promise.all([runLatest(one, composition(sim.provider, { policy: tight })), runLatest(two, composition(sim.provider, { policy: tight }))]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["completed", "failed"]);
      expect(outcomes.find((o) => o.kind === "failed")).toMatchObject({ failureClass: "AI_BUDGET", attempts: 0 });
      expect(sim.calls).toHaveLength(1);
    });

    it("10 · a second result for the same request is refused by ai_results_once (the runtime's backstop)", async () => {
      const c = await dispatched(A, PRAISE_TEXT);
      await runLatest(c, composition(scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]).provider));
      const [existing] = await oracle<Record<string, unknown>>("select * from classification.ai_results where source_text_version_id = $1", [c.version]);
      if (existing === undefined) throw new Error("result");
      const written = await withWorkspaceJobScope(worker, A.workspaceId, (tx) => createPostgresIntelligenceStore(tx, () => undefined).recordResult({
        id: randomUUID(), organizationId: A.organizationId, workspaceId: A.workspaceId, understandingRequestId: existing["understanding_request_id"] as string, interactionId: c.interaction,
        sourceTextVersionId: c.version, pipelineVersion: INTELLIGENCE_PIPELINE_VERSION, dispatchGeneration: 1, attemptId: existing["attempt_id"] as string, acceptanceMode: "shadow", provider: "simulator",
        modelRequested: "sim", modelReported: null, routeFingerprint: SIM_BINDING.routeFingerprint, taskId: "classification.understanding", taskVersion: "understanding-task.v2",
        promptVersion: existing["prompt_version"] as string, promptHash: existing["prompt_hash"] as string, outputSchemaVersion: "understanding-output.v1", transportSchemaVersion: "simulator-script.v1",
        taxonomyVersion: "taxonomy.v1", confidencePolicyVersion: existing["confidence_policy_version"] as string, languagePolicyVersion: "language-policy.v1", inputContractVersion: "understanding-input.v1",
        summary: null, evidence: [], correlationId: "h7d1d-second-result-01", triggerRunId: "run_second", createdAt: now,
      }));
      expect(written).toBe("exists");
      expect(await results(c)).toHaveLength(1);
    });
  });

  describe("20 · R6/R7 recovery", () => {
    it("a lost dispatch (stale AI_PENDING) gets the next generation; at the bound, or with the route disabled, it ends AI_FAILED", async () => {
      const t = await tenant();
      const policy = policyFor({ fixtureWorkspaceIds: [t.workspaceId] });
      const lost = await dispatched(t, PRAISE_TEXT, policy);
      const disabled = await dispatched(t, COMPLAINT_TEXT, policy);
      advance(STALE_IN_FLIGHT_MS + 60_000);
      const recover = (p: UnderstandAiRoutePolicy) => withWorkspaceJobScope(worker, t.workspaceId, (tx) => recoverStaleUnderstanding(intelligenceScope({ tx, noteOutbox: () => undefined }), clock, p, { correlationId: "h7d1d-recovery-0002" }));
      // A route disabled since dispatch: recovery never bypasses routing — both stale requests end AI_FAILED.
      expect(await recover(INTELLIGENCE_ROUTE_POLICY)).toEqual({ redispatched: 0, failed: 2 });
      expect(await request(lost)).toMatchObject({ state: "AI_FAILED", ai_failure_class: "AI_UNAVAILABLE" });
      expect(await request(disabled)).toMatchObject({ state: "AI_FAILED" });
      const again = await dispatched(t, PRAISE_TEXT, policy);
      for (let generation = 1; generation < MAX_TRANSPORT_GENERATIONS; generation += 1) {
        advance(STALE_IN_FLIGHT_MS + 60_000);
        expect(await recover(policy)).toEqual({ redispatched: 1, failed: 0 });
      }
      advance(STALE_IN_FLIGHT_MS + 60_000);
      expect(await recover(policy)).toEqual({ redispatched: 0, failed: 1 });
      expect(await request(again)).toMatchObject({ state: "AI_FAILED", ai_generation: MAX_TRANSPORT_GENERATIONS, ai_failure_class: "AI_UNAVAILABLE" });
      expect((await dispatches(again)).map((r) => r.dispatch_key.slice(-3))).toEqual([":a1", ":a2", ":a3"]);
      // The MAIN consumer runs the same bounded pass on every delivery.
      expect((await deliverObserved(await observed(t, await comment(t, "🔥")), policy)).recovery).toEqual({ redispatched: 0, failed: 0 });
    });
  });

  describe("24 · tenant isolation", () => {
    it("another workspace's request reads as absent; a mismatched identity is skipped; dispatch and recovery see only the bound workspace", async () => {
      const b = await dispatched(B, PRAISE_TEXT);
      const [row] = await dispatches(b);
      if (row === undefined) throw new Error("dispatch");
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      expect(await runAi({ ...envelopeOf(row), workspaceId: A.workspaceId }, composition(sim.provider))).toEqual({ kind: "skipped", reason: "request_not_found" });
      const other = await comment(B, "otro comentario");
      expect(await runAi({ ...envelopeOf(row), subjectIds: { ...row.subject_ids, interaction: other.interaction } }, composition(sim.provider))).toEqual({ kind: "skipped", reason: "request_identity_mismatch" });
      expect(sim.calls).toHaveLength(0);
      expect(await request(b)).toMatchObject({ state: "AI_PENDING", ai_generation: 1 });
      // A's scope can neither dispatch B's version nor recover B's stale request.
      const crossed = await withWorkspaceJobScope(worker, A.workspaceId, (tx) => dispatchUnderstanding(intelligenceScope({ tx, noteOutbox: () => undefined }), clock, policyFor(), {
        workspaceId: A.workspaceId, interactionId: b.interaction, sourceTextVersionId: b.version, arrival: "realtime", correlationId: "h7d1d-cross-000001" }));
      expect(crossed).toEqual({ kind: "skipped", reason: "target_not_found" });
      advance(STALE_IN_FLIGHT_MS + 60_000);
      await withWorkspaceJobScope(worker, A.workspaceId, (tx) => recoverStaleUnderstanding(intelligenceScope({ tx, noteOutbox: () => undefined }), clock, policyFor(), { correlationId: "h7d1d-cross-000002" }));
      expect(await request(b)).toMatchObject({ state: "AI_PENDING", ai_generation: 1 });
      // The writers are bound too: a ledger row naming B's request from A's scope fails like a missing reference (composite FK).
      const crossAttempt = withWorkspaceJobScope(worker, A.workspaceId, (tx) => createPostgresIntelligenceStore(tx, () => undefined).recordAttempts([{
        id: randomUUID(), organizationId: A.organizationId, workspaceId: A.workspaceId, understandingRequestId: row.subject_ids["understanding_request"] ?? "", interactionId: b.interaction,
        sourceTextVersionId: b.version, pipelineVersion: INTELLIGENCE_PIPELINE_VERSION, dispatchGeneration: 1, attemptNumber: 1, attemptKind: "initial", taskId: "classification.understanding",
        taskVersion: "understanding-task.v2", promptVersion: "understanding-prompt.v2", promptHash: "c177c6f36c77337645d2cc9f45628f80bd2fbeddd8f5ac2a418ac97ae2c9b7bf", outputSchemaVersion: "understanding-output.v1",
        transportSchemaVersion: "simulator-script.v1", taxonomyVersion: "taxonomy.v1", confidencePolicyVersion: "confidence.v1", languagePolicyVersion: "language-policy.v1", inputContractVersion: "understanding-input.v1",
        provider: "simulator", modelRequested: "sim", modelReported: null, startedAt: now, completedAt: now, latencyMs: 0, inputChars: 1, inputTokens: null, outputTokens: null, cachedInputTokens: null,
        costEstimateUsd: null, pricingTableVersion: null, outcome: "refused", failureClass: "AI_REFUSED", issueCodes: [], correlationId: "h7d1d-cross-000003", triggerRunId: "run_cross", createdAt: now,
      }]));
      await expect(crossAttempt).rejects.toThrow();
      // A's budget reservation names only A (the bound workspace, never a parameter).
      expect(await count("select count(*)::int as n from classification.ai_budget_reservations where workspace_id = $1", [B.workspaceId])).toBe(1);
    });

    it("logs carry ids, enums and counts only — never the text", async () => {
      lines.length = 0;
      const c = await dispatched(A, "Texto privadísimo de prueba sin enlaces");
      await runLatest(c, composition(scriptedProvider([{ kind: "refusal" }]).provider));
      const joined = lines.join("\n");
      expect(joined).toMatch(/classification\.intelligence\.dispatch/);
      expect(joined).toMatch(/classification\.intelligence\.run/);
      expect(joined).not.toMatch(/privad|prueba sin enlaces/);
    });
  });

  describe("H7-D1e2b · durable provider-call intents: every egress has an identity committed BEFORE the call", () => {
    type Faults = { readonly atGateway?: () => void; readonly scope?: (scope: IntelligenceRunScope) => IntelligenceRunScope };
    /**
     * The INTELLIGENCE run, driven through runUnderstanding with the REAL stores and the ledgered gateway, so faults can
     * be injected at exact points. `events` records each step only once its transaction COMMITTED (or, for the provider,
     * when it is called): budget_reserved → call_intent_committed:n → provider_called:n → attempt_recorded:n.
     */
    const runDirect = async (t: Tenant, c: Comment, provider: ModelProvider, events: string[] = [], faults: Faults = {}, policy = policyFor({ fixtureWorkspaceIds: [t.workspaceId] })) => {
      const [row] = (await dispatches(c)).slice(-1);
      if (row === undefined) throw new Error("no dispatch");
      const runId = `run_${randomUUID().slice(0, 8)}`;
      const inScope = async <T,>(work: (scope: IntelligenceRunScope) => Promise<T>): Promise<T> => {
        const pending: string[] = [];
        const result = await withWorkspaceJobScope(worker, t.workspaceId, (tx) => {
          const base = intelligenceScope({ tx, noteOutbox: () => undefined });
          const store = base.intelligence;
          const observed: IntelligenceRunScope = {
            ...base,
            claimEffect: (effectKey) => claimEffect(tx, { workspaceId: t.workspaceId, effectKey, task: UNDERSTAND_AI_TOPIC, outboxId: row.id, runId }),
            intelligence: {
              ...store,
              reserveBudget: async (r) => { const ok = await store.reserveBudget(r); if (ok) pending.push("budget_reserved"); return ok; },
              recordCallIntent: async (i) => { const w = await store.recordCallIntent(i); if (w === "inserted") pending.push(`call_intent_committed:${String(i.attemptNumber)}`); return w; },
              recordAttempts: async (rows) => { const n = await store.recordAttempts(rows); for (const r of rows) pending.push(`attempt_recorded:${String(r.attemptNumber)}`); return n; },
            },
          };
          return work(faults.scope === undefined ? observed : faults.scope(observed));
        });
        events.push(...pending);
        return result;
      };
      const logging: ModelProvider = { providerKey: provider.providerKey, complete: (request, call) => { events.push(`provider_called:${String(call.attempt)}`); return provider.complete(request, call); } };
      return runUnderstanding({
        inScope,
        policy,
        binding: SIM_BINDING,
        clock,
        gatewayFor: (budget, egress) => {
          faults.atGateway?.();
          return createLedgeredAiGateway({ registry: createModelRegistry([simulatorModel("sim")]), routes: understandAiRouteTable(policy), providers: [logging], budget, egress, killed: () => false, now: clock.now });
        },
      }, { workspaceId: t.workspaceId, interactionId: c.interaction, sourceTextVersionId: c.version, understandingRequestId: row.subject_ids["understanding_request"] ?? "", correlationId: row.correlation_id }, { runId });
    };
    const intents = (c: Comment) => oracle<{ dispatch_generation: number; attempt_number: number; attempt_kind: string; route_fingerprint: string; model_requested: string }>(
      "select dispatch_generation, attempt_number, attempt_kind, route_fingerprint, model_requested from classification.ai_call_intents where source_text_version_id = $1 order by dispatch_generation, attempt_number", [c.version]);
    /** The derived accounting of a version's intents (the reconciliation tool's own SQL), as [generation, attempt, state]. */
    const accounting = async (c: Comment, staleMinutes = 15) => (await oracle<CallAccountingRow>(CALL_ACCOUNTING_SQL, [new Date(now.getTime() - staleMinutes * 60_000)]))
      .filter((r) => r.understanding_request_id === (/* the request of this version */ requestIds.get(c.version)))
      .map((r) => [r.dispatch_generation, r.attempt_number, r.accounting_state]);
    const requestIds = new Map<string, string>();
    const own = async () => {
      const t = await tenant();
      return { t, policy: policyFor({ fixtureWorkspaceIds: [t.workspaceId] }) };
    };
    const dispatchedOwn = async (t: Tenant, policy: UnderstandAiRoutePolicy, text = PRAISE_TEXT) => {
      const c = await dispatched(t, text, policy);
      requestIds.set(c.version, (await request(c))?.id ?? "");
      return c;
    };
    const recoverIn = (t: Tenant, policy: UnderstandAiRoutePolicy) =>
      withWorkspaceJobScope(worker, t.workspaceId, (tx) => recoverStaleUnderstanding(intelligenceScope({ tx, noteOutbox: () => undefined }), clock, policy, { correlationId: "h7d1e2b-recovery-01" }));

    it("22 · ordering: budget_reserved → call_intent_committed → provider_called → attempt_recorded, for the initial call AND the re-ask; every egress names the route", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const events: string[] = [];
      const sim = scriptedProvider([{ kind: "raw", text: "not json" }, { kind: "output", body: goldenOutput(PRAISE) }]);
      expect(await runDirect(t, c, sim.provider, events, {}, policy)).toMatchObject({ kind: "completed", attempts: 2 });
      // tx2 re-asserts the two attempt rows idempotently at the end (same ids): they were ALREADY durable per call.
      expect(events).toEqual(["budget_reserved", "call_intent_committed:1", "provider_called:1", "attempt_recorded:1", "call_intent_committed:2", "provider_called:2", "attempt_recorded:2", "attempt_recorded:1", "attempt_recorded:2"]);
      expect(await intents(c)).toEqual([
        { dispatch_generation: 1, attempt_number: 1, attempt_kind: "initial", route_fingerprint: SIM_BINDING.routeFingerprint, model_requested: "sim" },
        { dispatch_generation: 1, attempt_number: 2, attempt_kind: "reask", route_fingerprint: SIM_BINDING.routeFingerprint, model_requested: "sim" },
      ]);
      expect(await attempts(c)).toHaveLength(2);
      expect(await accounting(c)).toEqual([[1, 1, "RECORDED"], [1, 2, "RECORDED"]]);
      expect(await results(c)).toHaveLength(1);
    });

    it("A · crash after the claim, before the budget: no reservation, no intent, no call", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      await expect(runDirect(t, c, sim.provider, [], { atGateway: () => { throw new Error("crash"); } }, policy)).rejects.toThrow("crash");
      expect(sim.calls).toHaveLength(0);
      expect(await intents(c)).toEqual([]);
      expect(await count("select count(*)::int as n from classification.ai_budget_reservations where workspace_id = $1", [t.workspaceId])).toBe(0);
      expect(await request(c)).toMatchObject({ state: "AI_RUNNING", ai_generation: 1 });
    });

    it("B · budget reserved, the intent can't be committed: NO provider call, the reservation stays spent, AI_UNAVAILABLE(egress_unrecorded)", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      const broken = (scope: IntelligenceRunScope): IntelligenceRunScope => ({ ...scope, intelligence: { ...scope.intelligence, recordCallIntent: () => Promise.reject(new Error("crash")) } });
      expect(await runDirect(t, c, sim.provider, [], { scope: broken }, policy)).toMatchObject({ kind: "failed", failureClass: "AI_UNAVAILABLE", cause: "egress_unrecorded", attempts: 0, redispatched: false });
      expect(sim.calls).toHaveLength(0);
      expect(await intents(c)).toEqual([]);
      expect(await oracle("select reserved_calls from classification.ai_budget_reservations where workspace_id = $1", [t.workspaceId])).toEqual([{ reserved_calls: 2 }]);
    });

    it("C · intent committed, the provider call dies: the intent stays (no fake attempt); IN_FLIGHT, then UNKNOWN_PROVIDER_OUTCOME — also after recovery", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const dying: ModelProvider = { providerKey: "simulator", complete: () => Promise.reject(new Error("crash")) };
      await expect(runDirect(t, c, dying, [], {}, policy)).rejects.toThrow("crash");
      expect(await intents(c)).toMatchObject([{ dispatch_generation: 1, attempt_number: 1 }]);
      expect(await attempts(c)).toEqual([]);
      expect(await accounting(c)).toEqual([[1, 1, "IN_FLIGHT"]]);
      advance(STALE_IN_FLIGHT_MS + 60_000);
      expect(await accounting(c)).toEqual([[1, 1, "UNKNOWN_PROVIDER_OUTCOME"]]);
      expect(await recoverIn(t, policy)).toEqual({ redispatched: 1, failed: 0 });
      // The unknown call does not disappear when the generation advances; the new generation is a NEW identity.
      expect(await accounting(c)).toEqual([[1, 1, "UNKNOWN_PROVIDER_OUTCOME"]]);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      expect(await runDirect(t, c, sim.provider, [], {}, policy)).toMatchObject({ kind: "completed", generation: 2 });
      expect(await accounting(c)).toEqual([[1, 1, "UNKNOWN_PROVIDER_OUTCOME"], [2, 1, "RECORDED"]]);
      expect(await results(c)).toHaveLength(1);
      // Budget: both generations reserved (2 calls each); nothing is ever refunded for the unknown call.
      expect(await oracle("select reserved_calls from classification.ai_budget_reservations where workspace_id = $1", [t.workspaceId])).toEqual([{ reserved_calls: 4 }]);
    });

    it("C′ · attempt 1 completed, re-ask intent committed, the re-ask dies: attempt 1 and intent 2 are durable — no accounting loss", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const sim = scriptedProvider([{ kind: "raw", text: "not json" }]);
      const halfDying: ModelProvider = { providerKey: "simulator", complete: (request, call) => (call.attempt === 2 ? Promise.reject(new Error("crash")) : sim.provider.complete(request, call)) };
      await expect(runDirect(t, c, halfDying, [], {}, policy)).rejects.toThrow("crash");
      expect((await intents(c)).map((i) => [i.attempt_number, i.attempt_kind])).toEqual([[1, "initial"], [2, "reask"]]);
      expect((await attempts(c)).map((a) => [a.attempt_number, a.outcome])).toEqual([[1, "invalid_output"]]);
      expect(await accounting(c)).toEqual([[1, 1, "RECORDED"], [1, 2, "IN_FLIGHT"]]);
    });

    it.each([
      ["D · the result write", "recordResult"],
      ["E · the shadow-assessment write", "recordShadowAssessments"],
      ["F/G · the terminal transition", "transition"],
    ] as const)("%s fails inside the final transaction: the completed call is ALREADY durable; recovery continues, fully accounted", async (_label, method) => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      let finalTx = false;
      const failing = (scope: IntelligenceRunScope): IntelligenceRunScope => {
        const store = scope.intelligence;
        return {
          ...scope,
          intelligence: {
            ...store,
            // Only the final transaction's write fails (the claim's own transition in tx1 must succeed).
            lockRequest: async (id) => { const r = await store.lockRequest(id); if (r?.state === "AI_RUNNING") finalTx = true; return r; },
            recordResult: (r) => (method === "recordResult" ? Promise.reject(new Error("crash")) : store.recordResult(r)),
            recordShadowAssessments: (rows) => (method === "recordShadowAssessments" ? Promise.reject(new Error("crash")) : store.recordShadowAssessments(rows)),
            transition: (tr) => (method === "transition" && finalTx && tr.to === "COMPLETED" ? Promise.reject(new Error("crash")) : store.transition(tr)),
          },
        };
      };
      await expect(runDirect(t, c, sim.provider, [], { scope: failing }, policy)).rejects.toThrow("crash");
      expect((await attempts(c)).map((a) => [a.dispatch_generation, a.outcome])).toEqual([[1, "accepted"]]);
      expect(await results(c)).toEqual([]);
      expect(await aiAssessments(c)).toEqual([]);
      expect(await accounting(c)).toEqual([[1, 1, "RECORDED"]]);
      advance(STALE_IN_FLIGHT_MS + 60_000);
      expect((await recoverIn(t, policy)).redispatched).toBe(1);
      expect(await runDirect(t, c, scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]).provider, [], {}, policy)).toMatchObject({ kind: "completed", generation: 2 });
      expect(await accounting(c)).toEqual([[1, 1, "RECORDED"], [2, 1, "RECORDED"]]);
      expect(await results(c)).toHaveLength(1);
    });

    it("21 · H · the re-ask FENCE: recovery supersedes the generation between the initial call and the re-ask — the old run's re-ask intent is refused, re-ask calls 0", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const sim = scriptedProvider([{ kind: "raw", text: "not json" }, { kind: "output", body: goldenOutput(PRAISE) }]);
      const superseding: ModelProvider = {
        providerKey: "simulator",
        complete: async (request, call) => {
          const response = await sim.provider.complete(request, call);
          if (call.attempt === 1) {
            advance(STALE_IN_FLIGHT_MS + 60_000);
            expect(await recoverIn(t, policy)).toEqual({ redispatched: 1, failed: 0 });
          }
          return response;
        },
      };
      expect(await runDirect(t, c, superseding, [], {}, policy)).toMatchObject({ kind: "generation_superseded", generation: 1, attempts: 1 });
      expect(sim.calls.map((call) => call.attempt)).toEqual([1]);
      expect((await intents(c)).map((i) => [i.dispatch_generation, i.attempt_number])).toEqual([[1, 1]]);
      expect(await accounting(c)).toEqual([[1, 1, "RECORDED"]]);
      expect(await request(c)).toMatchObject({ state: "AI_PENDING", ai_generation: 2 });
    });

    it("H · a late run of a superseded generation can't even make its initial call", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const sim = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]);
      const late = async () => {
        advance(STALE_IN_FLIGHT_MS + 60_000);
        await recoverIn(t, policy);
      };
      // After tx1 (the claim) and before the egress fence takes its row lock, recovery supersedes generation 1.
      let armed = false;
      const outcome = await runDirect(t, c, sim.provider, [], {
        atGateway: () => { armed = true; },
        scope: (scope) => ({ ...scope, intelligence: { ...scope.intelligence, lockRequest: async (id) => { if (armed) { armed = false; await late(); } return scope.intelligence.lockRequest(id); } } }),
      }, policy);
      // The fence saw the moved generation under its lock: no intent was written for generation 1 and no call was made.
      expect(sim.calls).toHaveLength(0);
      expect(outcome).toMatchObject({ kind: "generation_superseded", generation: 1, attempts: 0 });
      expect(await intents(c)).toEqual([]);
    });

    it("16 · duplicate calls (a late run AND its recovered successor) are fully accounted: distinct identities, one accepted result", async () => {
      const { t, policy } = await own();
      const c = await dispatchedOwn(t, policy);
      const hold = gate();
      const slow = scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }], { gate: hold.wait });
      const late = runDirect(t, c, slow.provider, [], {}, policy);
      await hold.reached;
      advance(STALE_IN_FLIGHT_MS + 60_000);
      expect((await recoverIn(t, policy)).redispatched).toBe(1);
      expect(await runDirect(t, c, scriptedProvider([{ kind: "output", body: goldenOutput(PRAISE) }]).provider, [], {}, policy)).toMatchObject({ kind: "completed", generation: 2 });
      hold.open();
      expect(await late).toMatchObject({ kind: "generation_superseded", generation: 1 });
      expect(await accounting(c)).toEqual([[1, 1, "RECORDED"], [2, 1, "RECORDED"]]);
      expect(await results(c)).toHaveLength(1);
    });
  });
}
