/**
 * Step H7-B1b-0 — the shared-dev acceptance fixture tool on the local disposable cluster (never dev-v2): plan is
 * read-only; apply creates the exact hierarchy and the canonical chain through ingestInteractionFact; a second apply
 * writes nothing; an identity conflict or the protected workspace stops before any write; a failure between the two
 * transactions resumes; no credential and no classification row is ever written by the tool. Then, locally only, the
 * REAL relay delivers the fixture's genuine outbox row to the REAL `interactions.observed` consumer (FakeJobRuntime) and
 * the deterministic runtime records exactly one request and one link_present signal.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runInteractionsObserved } from "@/jobs/reconciliation";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { DETERMINISTIC_PIPELINE_VERSION } from "@/modules/classification";
import type { RuntimeDatabase } from "@/platform/db";
import { runTenantJob } from "@/platform/jobs";
import { relayPass, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger } from "@/platform/observability";
import { PROTECTED_WORKSPACE_IDS } from "@/tools/db/dev-fixture-guard";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import {
  H7_CLASSIFICATION_ACCEPTANCE_FIXTURE as FIXTURE,
  applyAcceptanceFixture,
  loadAcceptanceScenario,
  planAcceptanceFixture,
  type FixtureReport,
} from "../dev-fixtures/classification-acceptance";
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
const PROTECTED_ORG = "5eed2e00-0000-4000-8000-0000000000ff";
const [PROTECTED_WS = ""] = PROTECTED_WORKSPACE_IDS;
const CANONICAL = ["content.content_items", "interactions.authors", "interactions.interactions", "interactions.source_text_versions", "interactions.state_observations",
  "conversations.conversations", "ingestion.ingestion_events", "system.outbox"] as const;

export function defineDevFixtureClassificationAcceptanceSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date() });

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const ws = FIXTURE.workspace.id;
  /** Row counts of everything the fixture could write (hierarchy, canonical, outbox, credentials, classification). */
  const census = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {
      "tenancy.organizations": await count("select count(*)::int as n from tenancy.organizations where id = $1", [FIXTURE.organization.id]),
      "tenancy.workspaces": await count("select count(*)::int as n from tenancy.workspaces where id = $1", [ws]),
    };
    for (const table of ["connections.connections", "connections.discovered_assets", "connections.connected_accounts", "credentials.provider_credentials", ...CANONICAL,
      "classification.understanding_requests", "classification.signals", "classification.assessments", "audit.audit_events"]) {
      out[table] = await count(`select count(*)::int as n from ${table} where workspace_id = $1`, [ws]);
    }
    return out;
  };
  /** A digest of every fixture row (full rows), to prove "nothing changed". */
  const digest = async (workspaceId: string, options: { readonly outbox?: boolean } = {}): Promise<string> => {
    const parts: string[] = [];
    const tables = ["tenancy.workspaces", "connections.connections", "connections.discovered_assets", "connections.connected_accounts", ...CANONICAL];
    for (const table of tables.filter((name) => options.outbox !== false || name !== "system.outbox")) {
      const column = table === "tenancy.workspaces" ? "id" : "workspace_id";
      const rows = await oracle<{ d: string | null }>(`select md5(string_agg(t::text, '|' order by t::text)) as d from ${table} t where ${column} = $1`, [workspaceId]);
      parts.push(`${table}:${rows[0]?.d ?? "-"}`);
    }
    return parts.join(";");
  };
  const apply = (extra: Partial<Parameters<typeof applyAcceptanceFixture>[0]> = {}): Promise<FixtureReport> => applyAcceptanceFixture({ privileged, worker, ...extra });

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target, 3);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 1);
    // A stand-in for the protected shared-dev workspace (same id): the tool must never touch it.
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Protected stand-in', now())", [PROTECTED_ORG]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'Protected', 'MONITOR_ONLY', now())", [PROTECTED_WS, PROTECTED_ORG]);
  });
  afterAll(async () => {
    await cleanupWorld(privileged, [FIXTURE.organization.id, PROTECTED_ORG]);
    await system.end();
    await worker.end();
    await privileged.end();
  });

  describe("plan, refusals and identity", () => {
    it("5. an absent fixture plans CREATE_ALL and the plan writes nothing", async () => {
      const before = await census();
      const plan = await planAcceptanceFixture(privileged);
      expect(plan).toMatchObject({ status: "CREATE_ALL", workspaceId: ws, ids: null, expectedSignals: ["link_present"], arrival: "backfill", conflicts: [] });
      expect(await census()).toEqual(before);
      expect(Object.values(before).every((n) => n === 0)).toBe(true);
    });

    it("8. a different row at a fixture id is FIXTURE_IDENTITY_CONFLICT — plan and apply write nothing, nothing is adopted", async () => {
      await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Somebody else', now())", [FIXTURE.organization.id]);
      try {
        expect((await planAcceptanceFixture(privileged)).status).toBe("FIXTURE_IDENTITY_CONFLICT");
        const before = await census();
        const result = await apply();
        expect(result.status).toBe("FIXTURE_IDENTITY_CONFLICT");
        expect(result.conflicts).toContain("organization differs from the fixture");
        expect(await census()).toEqual(before);
        expect(await oracle("select name from tenancy.organizations where id = $1", [FIXTURE.organization.id])).toEqual([{ name: "Somebody else" }]);
      } finally {
        await cleanupWorld(privileged, [FIXTURE.organization.id]);
      }
    });

    it("4/20. the protected workspace is refused by id (and by its id range) before any read or write", async () => {
      const protectedBefore = await digest(PROTECTED_WS);
      for (const id of [PROTECTED_WS, "5eed2e00-0000-4000-8000-000000000099"]) {
        const descriptor = { ...FIXTURE, workspace: { ...FIXTURE.workspace, id } };
        expect((await planAcceptanceFixture(privileged, descriptor)).status).toBe("REFUSED_PROTECTED_WORKSPACE");
        expect((await applyAcceptanceFixture({ privileged, worker }, descriptor)).status).toBe("REFUSED_PROTECTED_WORKSPACE");
      }
      expect(await digest(PROTECTED_WS)).toBe(protectedBefore);
      expect(await count("select count(*)::int as n from connections.connections where workspace_id = $1", [PROTECTED_WS])).toBe(0);
    });
  });

  describe("apply", () => {
    it("partial failure: a failure after the hierarchy commits leaves RESUME_CANONICAL; the next apply completes (RESUMED)", async () => {
      await expect(apply({ beforeCanonical: () => Promise.reject(new Error("injected")) })).rejects.toThrow("injected");
      const partial = await census();
      expect(partial).toMatchObject({ "tenancy.organizations": 1, "tenancy.workspaces": 1, "connections.connections": 1, "connections.discovered_assets": 1, "connections.connected_accounts": 1 });
      for (const table of CANONICAL) expect(partial[table], table).toBe(0);
      expect((await planAcceptanceFixture(privileged)).status).toBe("RESUME_CANONICAL");
      expect((await apply()).status).toBe("RESUMED");
      expect((await planAcceptanceFixture(privileged)).status).toBe("ALREADY_PRESENT_MATCH");
      await cleanupWorld(privileged, [FIXTURE.organization.id]);
    });

    it("6/9–16. apply creates exactly the hierarchy and ONE canonical chain through ingestion; no credential, no classification row", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await apply();
      expect(result).toMatchObject({ status: "CREATED", workspaceId: ws, outboxStatus: "PENDING", outboxNotices: 1, expectedSignals: ["link_present"], conflicts: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
      const ids = result.ids;
      if (ids === null) throw new Error("ids");
      expect(await census()).toEqual({
        "tenancy.organizations": 1, "tenancy.workspaces": 1, "connections.connections": 1, "connections.discovered_assets": 1, "connections.connected_accounts": 1,
        "credentials.provider_credentials": 0, "content.content_items": 1, "interactions.authors": 1, "interactions.interactions": 1, "interactions.source_text_versions": 1,
        "interactions.state_observations": 1, "conversations.conversations": 1, "ingestion.ingestion_events": 1, "system.outbox": 1,
        "classification.understanding_requests": 0, "classification.signals": 0, "classification.assessments": 0, "audit.audit_events": 0,
      });
      // Hierarchy: inert simulator connection with NO credential, MONITOR_ONLY workspace without members.
      expect(await oracle("select provider, status, active_credential_id from connections.connections where workspace_id = $1", [ws])).toEqual([{ provider: "simulator", status: "ACTIVE", active_credential_id: null }]);
      expect(await oracle("select mode from tenancy.workspaces where id = $1", [ws])).toEqual([{ mode: "MONITOR_ONLY" }]);
      expect(await count("select count(*)::int as n from tenancy.workspace_memberships where workspace_id = $1", [ws])).toBe(0);
      // Canonical: the interaction, its ONE immutable version (the current pointer), the created event naming exactly it.
      const { text } = loadAcceptanceScenario();
      expect(await oracle(
        `select i.observed, i.kind, i.author_role, i.provider_interaction_id, v.source_text = $2 as same_text, i.current_source_text_version_id::text = v.id::text as current
           from interactions.interactions i join interactions.source_text_versions v on v.workspace_id = i.workspace_id and v.interaction_id = i.id where i.id = $1`, [ids.interactionId, text]))
        .toEqual([{ observed: true, kind: "comment", author_role: "user", provider_interaction_id: FIXTURE.providerInteractionId, same_text: true, current: true }]);
      expect(await oracle("select change, arrival, source_text_version_id::text as version, initiator from ingestion.ingestion_events where id = $1", [ids.ingestionEventId]))
        .toEqual([{ change: "created", arrival: "backfill", version: ids.sourceTextVersionId, initiator: "system" }]);
      // The genuine outbox row of the canonical emitter: IDs-only subjects, dispatch key = the event, system initiator.
      const [outbox] = await oracle<{ id: string; topic: string; subject_ids: Record<string, string>; dispatch_key: string; initiator_type: string; status: string }>(
        "select id::text, topic, subject_ids, dispatch_key, initiator_type, status from system.outbox where workspace_id = $1", [ws]);
      expect(outbox).toMatchObject({ id: ids.outboxId, topic: "interactions.observed", initiator_type: "system", status: "PENDING" });
      expect(outbox?.subject_ids).toEqual({ ingestion_event_id: ids.ingestionEventId, interaction_id: ids.interactionId, conversation_id: ids.conversationId, source_text_version_id: ids.sourceTextVersionId });
      expect(outbox?.dispatch_key).toContain(ids.ingestionEventId);
      expect(JSON.stringify(outbox)).not.toContain("example.com");
    });

    it("7. a second apply is ALREADY_PRESENT_MATCH and writes nothing (not even an observation time)", async () => {
      const before = await digest(ws);
      const result = await apply();
      expect(result).toMatchObject({ status: "ALREADY_PRESENT_MATCH", outboxNotices: 0 });
      expect(await digest(ws)).toBe(before);
    });

    it("8. a changed fixture row afterwards is a conflict, not a repair", async () => {
      await privileged.query("update tenancy.workspaces set name = 'Renamed' where id = $1", [ws]);
      try {
        const before = await digest(ws);
        expect((await apply()).status).toBe("FIXTURE_IDENTITY_CONFLICT");
        expect(await digest(ws)).toBe(before);
      } finally {
        await privileged.query("update tenancy.workspaces set name = $2 where id = $1", [ws, FIXTURE.workspace.name]);
      }
      expect((await planAcceptanceFixture(privileged)).status).toBe("ALREADY_PRESENT_MATCH");
    });
  });

  describe("local end-to-end (disposable cluster only)", () => {
    it("the real relay delivers the genuine row to the real consumer: one request, one link_present, no assessment, canonical unchanged", async () => {
      const ids = (await planAcceptanceFixture(privileged)).ids;
      if (ids === null) throw new Error("ids");
      // Delivery moves the outbox row to DISPATCHED (the relay's own state); every canonical and hierarchy row stays.
      const canonicalBefore = await digest(ws, { outbox: false });
      const deps = { registry: PRODUCTION_TASKS, worker, logger };
      const handlers = new Map<string, FakeHandler>([["interactions.observed", (payload, run) => runTenantJob(deps, "interactions.observed", payload, run, (context) => runInteractionsObserved(context))]]);
      const runtime = new FakeJobRuntime(handlers, (task) => PRODUCTION_TASKS.get(task)?.retry ?? { maxAttempts: 1, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false });
      const delivery = (): DeliveryDependencies => ({ system, runtimes: { main: runtime, integration: runtime }, registry: PRODUCTION_TASKS, logger, clock: () => new Date(), config: CONFIG });
      for (let pass = 0; pass < 5; pass += 1) {
        await relayPass(delivery());
        await runtime.drain();
        await sweepRunOutcomes(delivery());
        if ((await count("select count(*)::int as n from classification.understanding_requests where workspace_id = $1", [ws])) > 0) break;
      }
      const ran = runtime.enqueued.flatMap((request) => (request.task === "interactions.observed" && request.payload.scope === "workspace" && request.payload.workspaceId === ws ? [request.payload] : []));
      expect(ran).toHaveLength(1);
      expect(ran[0]?.outboxId).toBe(ids.outboxId);
      expect(await oracle("select status from system.outbox where id = $1", [ids.outboxId])).toEqual([{ status: "DISPATCHED" }]);
      expect(await oracle("select state, pipeline_version, arrival, source_text_version_id::text as version from classification.understanding_requests where workspace_id = $1", [ws]))
        .toEqual([{ state: "DETERMINISTIC_DONE", pipeline_version: DETERMINISTIC_PIPELINE_VERSION, arrival: "backfill", version: ids.sourceTextVersionId }]);
      const signals = await oracle<{ kind: string; starts: number[]; ends: number[] }>(
        "select kind, span_starts as starts, span_ends as ends from classification.signals where workspace_id = $1", [ws]);
      expect(signals.map((signal) => signal.kind)).toEqual(["link_present"]);
      const { text } = loadAcceptanceScenario();
      expect(text.slice(signals[0]?.starts[0], signals[0]?.ends[0])).toBe("example.com/h7-b1b");
      expect(await count("select count(*)::int as n from classification.assessments where workspace_id = $1", [ws])).toBe(0);
      expect(await digest(ws, { outbox: false })).toBe(canonicalBefore);
      expect(lines.join("\n")).not.toMatch(/example\.com|synthetic acceptance comment/i);
      // The fixture's identity is unaffected by delivery and classification: still a match, still writes nothing.
      expect((await apply()).status).toBe("ALREADY_PRESENT_MATCH");
    });
  });
}
