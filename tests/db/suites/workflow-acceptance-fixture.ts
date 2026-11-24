/**
 * W12-PREP-01 — the shared-dev Workflow acceptance tooling on the LOCAL disposable cluster (never dev-v2).
 *
 *   identity    invalid descriptor / workspace mode, protected ids, plan writes nothing, collisions are conflicts (never
 *               adopted), a changed fixture row is a conflict (never repaired)
 *   apply       exact permanent footprint; partial failures resume; a second apply writes nothing; no provider call
 *   downstream  the REAL relay delivers the fixture's genuine outbox rows to the REAL `interactions.observed` consumer
 *               with the DEPLOYED route policy: deterministic classification only, no AI request or AI outbox row
 *   members     unknown / unconfirmed / foreign users refused; approved memberships only; extra members are conflicts
 *   access      through the REAL action pipeline (web runtime, forced RLS): U1 never reaches B, U2 never reaches M
 *   A-10        audience reply reopens a DONE C2 (version + 1, one system_auto_reopen event, one audit row); the account
 *               reply changes nothing; preconditions refuse an OPEN C2
 *   A-03        U2 RESPONDER → ANALYST_VIEWER → CLIENT_GUEST, one audited compare-and-set step at a time; nothing else
 *   existing    a separate tenant's Workflow rows (the "existing DEV data") are byte-identical throughout
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseUserId } from "@/domain/ids";
import { runInteractionsObserved } from "@/jobs/reconciliation";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import type { RuntimeDatabase } from "@/platform/db";
import { runTenantJob } from "@/platform/jobs";
import { relayPass, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger } from "@/platform/observability";
import { markDoneCommand } from "@/server/commands/workflow";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type PipelineResult } from "@/server/pipeline";
import { inboxConversationCommand, inboxListCommand } from "@/server/queries/inbox";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import {
  W12_WORKFLOW_ACCEPTANCE_FIXTURE as FIXTURE,
  applyWorkflowAcceptanceFixture,
  applyWorkflowAcceptanceReply,
  expectedFixtureFootprint,
  fixtureCensus,
  fixtureContainment,
  CONSUMER_TABLES,
  outsideDigest,
  planWorkflowAcceptanceFixture,
  planWorkflowAcceptanceReply,
  workspaceIds,
  workspaceOf,
  type ApplyDependencies,
  type WorkflowAcceptanceDescriptor,
} from "../dev-fixtures/workflow-acceptance";
import { applyMembers as applyMembersWith, applyRole, planMembers as planMembersWith, planRole, verifyAcceptance as verifyWith, type UserDirectory } from "../dev-fixtures/workflow-acceptance-members";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { ingestAs, ingestTenant, organicTemplate, sighting, type IngestTenant } from "../support/workflow-ingest";
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
const A = workspaceOf(FIXTURE, "A");
const B = workspaceOf(FIXTURE, "B");
const M = workspaceOf(FIXTURE, "M");

export function defineWorkflowAcceptanceFixtureSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let worker: RuntimeDatabase<"worker">;
  let web: RuntimeDatabase<"web">;
  let system: RuntimeDatabase<"system">;
  let existing!: IngestTenant;
  const U1 = randomUUID();
  const U2 = randomUUID();
  const UNCONFIRMED = randomUUID();
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line), now: () => new Date() });
  // A plain counter, not a vi.fn(): vitest clears mock call history between tests, which would make "never called"
  // vacuous across tests. Checked in every test that ingests and once more after the whole file.
  let fetchCalls = 0;
  const fetchSpy = { calls: (): number => fetchCalls };
  // auth.users is Supabase Auth's table; the local emulation has none (and the migration role may not create one there).
  // The production directory reads it (pinned by the architecture guard); locally, an in-memory stand-in.
  const authUsers = new Map<string, boolean>();
  const directory: UserDirectory = (_db, userId) => Promise.resolve({ exists: authUsers.has(userId), confirmed: authUsers.get(userId) === true });
  const planMembers = (u: Readonly<Record<"U1" | "U2", string>>) => planMembersWith(privileged, u, FIXTURE, directory);
  const applyMembers = (u: Readonly<Record<"U1" | "U2", string>>) => applyMembersWith(privileged, u, FIXTURE, directory);
  const verifyAcceptance = (u: Readonly<Record<"U1" | "U2", string>>) => verifyWith(privileged, u, FIXTURE, directory);

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  /** Every row count of every base table in the application schemas (proves "nothing written"). */
  const globalCensus = async (): Promise<Record<string, number>> => {
    const tables = await oracle<{ name: string }>(`select table_schema || '.' || table_name as name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema in ('tenancy','connections','content','interactions','conversations','ingestion','system','workflow','audit','classification','mutations','credentials','capability','coverage','idempotency') order by 1`);
    const out: Record<string, number> = {};
    for (const { name } of tables) out[name] = await count(`select count(*)::int as n from ${name}`);
    return out;
  };
  const existingDigest = async (): Promise<string> =>
    (await oracle<{ d: string }>(`select md5(coalesce((select string_agg(t::text, '|' order by t::text) from workflow.work_items t where workspace_id = $1), '')
      || coalesce((select string_agg(t::text, '|' order by t::text) from workflow.workflow_events t where workspace_id = $1), '')
      || coalesce((select string_agg(t::text, '|' order by t::text) from conversations.conversations t where workspace_id = $1), '')) as d`, [existing.workspaceId]))[0]?.d ?? "-";
  const deps = (extra: Partial<ApplyDependencies> = {}): ApplyDependencies => ({ privileged, worker, ...extra });
  const pipelineAs = (user: string) => createActionPipeline({
    identity: new FakeIdentity(verifiedUser(parseUserId(user) ?? (() => { throw new Error("user"); })())),
    unitOfWork: createPostgresUnitOfWork(web),
    clock: () => new Date(),
    newId: randomUUID,
    logger: createLogger({ sink: () => undefined }),
  });
  const codeOf = (result: PipelineResult<unknown>): string => (result.status === "error" ? result.error.code : result.status);
  const listCount = async (user: string, workspaceId: string): Promise<number | string> => {
    const result = await pipelineAs(user).run(inboxListCommand, { workspaceId, input: {} });
    return result.status === "ok" ? result.value.items.length : codeOf(result);
  };
  const c2 = async (): Promise<{ id: string; state: string; version: number }> => {
    const [row] = await oracle<{ id: string; state: string; version: number }>(
      `select w.id::text, w.state, w.version from workflow.work_items w join interactions.interactions i on i.conversation_id = w.id and i.workspace_id = w.workspace_id
        where w.workspace_id = $1 and i.provider_interaction_id = $2`, [A.id, FIXTURE.c2.root]);
    if (row === undefined) throw new Error("c2");
    return row;
  };
  const markDone = async (user: string, workspaceId: string, conversationId: string, version: number): Promise<string> =>
    codeOf(await pipelineAs(user).run(markDoneCommand, { workspaceId, input: { conversationId, expectedVersion: version } }));
  const reset = async (): Promise<void> => cleanupWorld(privileged, [FIXTURE.organization.id]);

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target, 3);
    worker = runtimeDatabase(target, "worker", 2);
    web = runtimeDatabase(target, "web", 2);
    system = runtimeDatabase(target, "system", 1);
    vi.stubGlobal("fetch", () => {
      fetchCalls += 1;
      return Promise.reject(new Error("network is forbidden in the W12 fixture suite"));
    });
    authUsers.set(U1, true).set(U2, true).set(UNCONFIRMED, false);
    // The "existing DEV data": a real tenant with one conversation and its work item, through the production ingestion path.
    existing = await ingestTenant(privileged);
    const { content, base } = await organicTemplate(existing);
    await ingestAs(worker, existing, content, sighting(base, { id: "fb_existing_root", parent: null, author: "user", createdAt: "2026-11-10T10:00:00.000Z", observedAt: "2026-11-10T10:05:00.000Z" }));
  });
  afterAll(async () => {
    expect(fetchSpy.calls()).toBe(0);
    await reset();
    if ((existing as IngestTenant | undefined) !== undefined) await cleanupWorld(privileged, [existing.organizationId]);
    vi.unstubAllGlobals();
    await system.end();
    await web.end();
    await worker.end();
    await privileged.end();
  });

  describe("identity, refusals and plan", () => {
    it("an invalid descriptor (a workspace mode outside the enum, the wrong mode, an unlabelled name) is refused before any read or write", async () => {
      const before = await globalCensus();
      const variants: WorkflowAcceptanceDescriptor[] = [
        { ...FIXTURE, workspaces: [A, B, { ...M, mode: "MONITOR" as never }] },
        { ...FIXTURE, workspaces: [A, B, { ...M, mode: "STANDARD" }] },
        { ...FIXTURE, workspaces: [{ ...A, mode: "MONITOR_ONLY" }, B, M] },
        { ...FIXTURE, workspaces: [{ ...A, name: "Acceptance A" }, B, M] },
        { ...FIXTURE, workspaces: [A, B] },
      ];
      for (const d of variants) {
        expect((await planWorkflowAcceptanceFixture(privileged, d)).status).toBe("REFUSED_INVALID_DESCRIPTOR");
        expect((await applyWorkflowAcceptanceFixture(deps(), d)).status).toBe("REFUSED_INVALID_DESCRIPTOR");
      }
      expect(await globalCensus()).toEqual(before);
    });

    it("protected ids (the P2-E range) are refused for the organization and every workspace", async () => {
      const before = await globalCensus();
      for (const d of [
        { ...FIXTURE, organization: { ...FIXTURE.organization, id: "5eed2e00-0000-4000-8000-0000000000aa" } },
        { ...FIXTURE, workspaces: [A, { ...B, id: "5eed2e00-0000-4000-8000-000000000001" }, M] },
      ]) {
        expect((await planWorkflowAcceptanceFixture(privileged, d)).status).toBe("REFUSED_PROTECTED_WORKSPACE");
        expect((await applyWorkflowAcceptanceFixture(deps(), d)).status).toBe("REFUSED_PROTECTED_WORKSPACE");
      }
      expect(await globalCensus()).toEqual(before);
    });

    it("an absent fixture plans CREATE_ALL, enumerates the permanent footprint, and the plan writes nothing", async () => {
      const before = await globalCensus();
      const plan = await planWorkflowAcceptanceFixture(privileged);
      expect(plan.status).toBe("CREATE_ALL");
      expect(plan.hierarchyToCreate).toHaveLength(13);
      expect(plan.conversationsToIngest).toEqual([...A.roots, ...B.roots, ...M.roots]);
      expect(plan.expectedFootprintFromEmpty).toMatchObject({ "tenancy.workspaces": 3, "workflow.work_items": 7, "workflow.workflow_events": 7, "audit.audit_events": 0 });
      expect(await globalCensus()).toEqual(before);
    });

    it("collisions are FIXTURE_IDENTITY_CONFLICT — a different row at a fixture id, a squatter in the id namespace, a foreign use of a fixture asset — and nothing is adopted or written", async () => {
      const squatOrg = "12acce00-0000-4000-8000-0000000000ff";
      const cases: { readonly setup: () => Promise<void>; readonly teardown: () => Promise<void>; readonly conflict: string }[] = [
        { setup: async () => { await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Somebody else', now())", [FIXTURE.organization.id]); },
          teardown: () => cleanupWorld(privileged, [FIXTURE.organization.id]), conflict: "a hierarchy row differs from the fixture" },
        { setup: async () => { await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Squatter', now())", [squatOrg]); },
          teardown: () => cleanupWorld(privileged, [squatOrg]), conflict: "another organization or workspace uses the fixture id namespace" },
        { setup: async () => {
          await privileged.query(`insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
            select $1, organization_id, workspace_id, connection_id, platform, $2, asset_class, 'Foreign', now(), now(), now() from connections.discovered_assets where workspace_id = $3 limit 1`,
          [randomUUID(), A.providerAssetId, existing.workspaceId]);
        }, teardown: async () => { await privileged.query("delete from connections.discovered_assets where provider_asset_id = $1 and workspace_id = $2", [A.providerAssetId, existing.workspaceId]); },
        conflict: "a fixture asset id is used outside the fixture" },
      ];
      for (const c of cases) {
        await c.setup();
        try {
          const before = await globalCensus();
          const plan = await planWorkflowAcceptanceFixture(privileged);
          expect(plan.status).toBe("FIXTURE_IDENTITY_CONFLICT");
          expect(plan.conflicts).toContain(c.conflict);
          expect((await applyWorkflowAcceptanceFixture(deps())).status).toBe("FIXTURE_IDENTITY_CONFLICT");
          expect(await globalCensus()).toEqual(before);
        } finally {
          await c.teardown();
        }
      }
      expect((await planWorkflowAcceptanceFixture(privileged)).status).toBe("CREATE_ALL");
    });
  });

  describe("apply", () => {
    it("partial failures resume: after the hierarchy, and after the third conversation", async () => {
      await expect(applyWorkflowAcceptanceFixture(deps({ beforeConversations: () => Promise.reject(new Error("injected-1")) }))).rejects.toThrow("injected-1");
      const afterHierarchy = await planWorkflowAcceptanceFixture(privileged);
      expect(afterHierarchy).toMatchObject({ status: "RESUME_CONVERSATIONS", hierarchyToCreate: [] });
      expect(afterHierarchy.conversationsToIngest).toHaveLength(7);
      let seen = 0;
      await expect(applyWorkflowAcceptanceFixture(deps({ afterInteraction: () => (++seen === 3 ? Promise.reject(new Error("injected-2")) : Promise.resolve()) }))).rejects.toThrow("injected-2");
      expect((await planWorkflowAcceptanceFixture(privileged)).conversationsToIngest).toHaveLength(4);
      const resumed = await applyWorkflowAcceptanceFixture(deps());
      expect(resumed.status).toBe("RESUMED");
      expect(resumed.containment?.ok).toBe(true);
      expect((await planWorkflowAcceptanceFixture(privileged)).status).toBe("ALREADY_PRESENT_MATCH");
      await reset();
    });

    it("CREATED: exactly the approved permanent footprint, through ingestion; seven OPEN v1 work items; no membership, audit, credential or provider call; existing data untouched", async () => {
      const existingBefore = await existingDigest();
      const outsideBefore = await outsideDigest(privileged);
      const result = await applyWorkflowAcceptanceFixture(deps());
      expect(result.status).toBe("CREATED");
      expect(fetchSpy.calls()).toBe(0);
      const expected = Object.fromEntries(Object.entries(expectedFixtureFootprint()).filter(([, n]) => n !== 0));
      expect(result.measuredDelta).toEqual(expected);
      expect(result.containment).toEqual({ ok: true, unexpectedTables: [], outboxTopics: ["interactions.observed"], aiRequests: 0, hierarchyCountProblems: [] });
      expect(result.outsideDigestAfter).toBe(result.outsideDigestBefore);
      expect(result.outboxNotices).toBe(7);
      expect(result.workItems).toHaveLength(7);
      expect(result.workItems.every((w) => w.state === "OPEN" && w.version === 1)).toBe(true);
      expect(await oracle("select id::text, mode from tenancy.workspaces where id = any($1::uuid[]) order by id", [workspaceIds(FIXTURE)]))
        .toEqual([{ id: A.id, mode: "STANDARD" }, { id: B.id, mode: "STANDARD" }, { id: M.id, mode: "MONITOR_ONLY" }]);
      expect(await oracle("select provider, status, active_credential_id from connections.connections where workspace_id = any($1::uuid[]) order by workspace_id", [workspaceIds(FIXTURE)]))
        .toEqual([1, 2, 3].map(() => ({ provider: "simulator", status: "ACTIVE", active_credential_id: null })));
      expect(await count("select count(*)::int as n from workflow.workflow_events where workspace_id = any($1::uuid[]) and kind = 'created' and initiator_kind = 'system_ingestion' and correlation_id = $2",
        [workspaceIds(FIXTURE), result.correlationId])).toBe(7);
      expect(await oracle("select workspace_id::text as ws, count(*)::int as n from conversations.conversations where workspace_id = any($1::uuid[]) group by 1 order by 1", [workspaceIds(FIXTURE)]))
        .toEqual([{ ws: A.id, n: 5 }, { ws: B.id, n: 1 }, { ws: M.id, n: 1 }]);
      expect(await existingDigest()).toBe(existingBefore);
      expect(await outsideDigest(privileged)).toBe(outsideBefore);
    });

    it("the migration role sees every row through forced RLS (otherwise every negative check would fail open)", async () => {
      expect(await oracle("select (rolsuper or rolbypassrls) as sees_all from pg_catalog.pg_roles where rolname = current_user")).toEqual([{ sees_all: true }]);
    });

    it("a second connection in A (e.g. a connect flow started by U1) is a CONTAINMENT_VIOLATION, not an allowed row", async () => {
      const extra = randomUUID();
      await privileged.query(
        `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
         values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [extra, FIXTURE.organization.id, A.id, FIXTURE.connectionAuthorizedBy]);
      try {
        const containment = await fixtureContainment(privileged);
        expect(containment.ok).toBe(false);
        expect(containment.hierarchyCountProblems).toEqual(["A: connections.connections holds 2 rows"]);
      } finally {
        await privileged.query("delete from connections.connections where id = $1", [extra]);
      }
      expect((await fixtureContainment(privileged)).ok).toBe(true);
    });

    it("a second apply is ALREADY_PRESENT_MATCH and writes nothing; a changed fixture row is a conflict, never a repair", async () => {
      const before = await globalCensus();
      expect((await applyWorkflowAcceptanceFixture(deps())).status).toBe("ALREADY_PRESENT_MATCH");
      expect(await globalCensus()).toEqual(before);
      await privileged.query("update tenancy.workspaces set name = 'Renamed' where id = $1", [B.id]);
      try {
        expect((await applyWorkflowAcceptanceFixture(deps())).status).toBe("FIXTURE_IDENTITY_CONFLICT");
        expect(await oracle("select name from tenancy.workspaces where id = $1", [B.id])).toEqual([{ name: "Renamed" }]);
      } finally {
        await privileged.query("update tenancy.workspaces set name = $2 where id = $1", [B.id, B.name]);
      }
      expect((await planWorkflowAcceptanceFixture(privileged)).status).toBe("ALREADY_PRESENT_MATCH");
    });
  });

  describe("downstream effects (local relay → real consumer, deployed route policy)", () => {
    it("the genuine outbox rows reach the real interactions.observed consumer: deterministic classification only, no AI request, no AI outbox row, no other side table", async () => {
      const before = await fixtureCensus(privileged);
      const handlers = new Map<string, FakeHandler>([["interactions.observed", (payload, run) => runTenantJob({ registry: PRODUCTION_TASKS, worker, logger }, "interactions.observed", payload, run, (context) => runInteractionsObserved(context))]]);
      const runtime = new FakeJobRuntime(handlers, (task) => PRODUCTION_TASKS.get(task)?.retry ?? { maxAttempts: 1, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false });
      const delivery = (): DeliveryDependencies => ({ system, runtimes: { main: runtime, integration: runtime, intelligence: runtime }, registry: PRODUCTION_TASKS, logger, clock: () => new Date(), config: CONFIG });
      for (let pass = 0; pass < 6; pass += 1) {
        await relayPass(delivery());
        await runtime.drain();
        await sweepRunOutcomes(delivery());
      }
      const ran = runtime.enqueued.filter((r) => r.payload.scope === "workspace" && workspaceIds(FIXTURE).includes(r.payload.workspaceId));
      expect(ran.map((r) => r.task).sort()).toEqual(Array.from({ length: 7 }, () => "interactions.observed"));
      const after = await fixtureCensus(privileged);
      const changed = Object.keys(after).filter((table) => after[table] !== before[table]);
      expect(changed.every((table) => CONSUMER_TABLES.includes(table)), changed.join(",")).toBe(true);
      expect(await count("select count(*)::int as n from classification.understanding_requests where workspace_id = any($1::uuid[])", [workspaceIds(FIXTURE)])).toBe(7);
      expect(await count("select count(*)::int as n from classification.understanding_requests where workspace_id = any($1::uuid[]) and state like 'AI%'", [workspaceIds(FIXTURE)])).toBe(0);
      expect(await count("select count(*)::int as n from system.outbox where workspace_id = any($1::uuid[]) and topic <> 'interactions.observed'", [workspaceIds(FIXTURE)])).toBe(0);
      for (const table of ["classification.ai_call_intents", "classification.ai_attempts", "classification.ai_results", "classification.ai_budget_reservations", "classification.assessments"]) {
        expect(await count(`select count(*)::int as n from ${table} where workspace_id = any($1::uuid[])`, [workspaceIds(FIXTURE)]), table).toBe(0);
      }
      expect((await fixtureContainment(privileged)).ok).toBe(true);
      expect(fetchSpy.calls()).toBe(0);
      expect(lines.join("\n")).not.toMatch(/Synthetic W12 acceptance comment/);
      expect((await planWorkflowAcceptanceFixture(privileged)).status).toBe("ALREADY_PRESENT_MATCH");
    });
  });

  describe("members", () => {
    it("refuses unknown, unconfirmed and foreign users, plans the six approved rows without writing, attaches them once", async () => {
      const foreignUser = existing.users.OWNER;
      authUsers.set(foreignUser, true);
      try {
        const before = await globalCensus();
        expect((await planMembers({ U1: randomUUID(), U2 })).status).toBe("REFUSED_UNKNOWN_USER");
        expect((await planMembers({ U1: UNCONFIRMED, U2 })).status).toBe("REFUSED_UNKNOWN_USER");
        expect((await applyMembers({ U1: foreignUser, U2 })).status).toBe("REFUSED_FOREIGN_MEMBERSHIP");
        expect((await planMembers({ U1, U2: U1 })).status).toBe("REFUSED_UNKNOWN_USER");
        const plan = await planMembers({ U1, U2 });
        expect(plan.status).toBe("CREATE_ALL");
        expect(plan.toCreate).toEqual(["organization:U1:MEMBER", "organization:U2:MEMBER", "A:U1:OWNER", "M:U1:OWNER", "A:U2:RESPONDER", "B:U2:MANAGER"]);
        expect(await globalCensus()).toEqual(before);
      } finally {
        authUsers.delete(foreignUser);
      }
      const outsideBefore = await outsideDigest(privileged);
      expect((await applyMembers({ U1, U2 })).status).toBe("CREATED");
      expect(await oracle("select workspace_id::text as ws, user_id::text as u, role, grants from tenancy.workspace_memberships where workspace_id = any($1::uuid[]) order by 1, 3",
        [workspaceIds(FIXTURE)])).toEqual([
        { ws: A.id, u: U1, role: "OWNER", grants: [] }, { ws: A.id, u: U2, role: "RESPONDER", grants: [] },
        { ws: B.id, u: U2, role: "MANAGER", grants: [] }, { ws: M.id, u: U1, role: "OWNER", grants: [] },
      ]);
      expect(await oracle("select role from tenancy.organization_memberships where organization_id = $1 order by user_id", [FIXTURE.organization.id])).toEqual([{ role: "MEMBER" }, { role: "MEMBER" }]);
      expect(await count("select count(*)::int as n from audit.audit_events where organization_id = $1", [FIXTURE.organization.id])).toBe(0);
      expect(await outsideDigest(privileged)).toBe(outsideBefore);
      expect((await applyMembers({ U1, U2 })).status).toBe("ALREADY_PRESENT_MATCH");
    });

    it("any other member of a fixture workspace — U1 in B, a stranger in A — is a MEMBERSHIP_CONFLICT", async () => {
      for (const [workspaceId, user, role] of [[B.id, U1, "RESPONDER"], [A.id, UNCONFIRMED, "ANALYST_VIEWER"]] as const) {
        await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'MEMBER', now()) on conflict do nothing", [FIXTURE.organization.id, user]);
        await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [FIXTURE.organization.id, workspaceId, user, role]);
        try {
          expect((await planMembers({ U1, U2 })).status).toBe("MEMBERSHIP_CONFLICT");
          expect((await verifyAcceptance({ U1, U2 })).ok).toBe(false);
        } finally {
          await privileged.query("delete from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [workspaceId, user]);
          if (user === UNCONFIRMED) await privileged.query("delete from tenancy.organization_memberships where organization_id = $1 and user_id = $2", [FIXTURE.organization.id, user]);
        }
      }
      expect((await verifyAcceptance({ U1, U2 })).ok).toBe(true);
    });

    it("access through the REAL pipeline and RLS: U1 reaches A (5) and M (1), never B; U2 reaches A (5) and B (1), never M", async () => {
      expect(await listCount(U1, A.id)).toBe(5);
      expect(await listCount(U1, M.id)).toBe(1);
      expect(await listCount(U1, B.id)).toBe("NOT_FOUND");
      expect(await listCount(U2, B.id)).toBe(1);
      expect(await listCount(U2, A.id)).toBe(5);
      expect(await listCount(U2, M.id)).toBe("NOT_FOUND");
      expect(await listCount(U1, existing.workspaceId)).toBe("NOT_FOUND");
    });

    it("A-02 (U2): acting as MANAGER of B while a legitimate RESPONDER of A, B lists only B and an A conversation under B's address is NOT_FOUND", async () => {
      expect(await oracle("select role from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [A.id, U2])).toEqual([{ role: "RESPONDER" }]);
      const [aConversation] = await oracle<{ id: string }>("select id::text from conversations.conversations where workspace_id = $1 limit 1", [A.id]);
      const [bConversation] = await oracle<{ id: string }>("select id::text from conversations.conversations where workspace_id = $1", [B.id]);
      if (aConversation === undefined || bConversation === undefined) throw new Error("conversations");
      const list = await pipelineAs(U2).run(inboxListCommand, { workspaceId: B.id, input: {} });
      expect(list.status === "ok" ? list.value.items.map((item) => item.conversationId) : codeOf(list)).toEqual([bConversation.id]);
      expect(codeOf(await pipelineAs(U2).run(inboxConversationCommand, { workspaceId: B.id, input: { conversationId: aConversation.id } }))).toBe("NOT_FOUND");
      // The same conversation in its own workspace is legitimately readable by U2 (a member of A): not an authorization failure.
      expect(codeOf(await pipelineAs(U2).run(inboxConversationCommand, { workspaceId: A.id, input: { conversationId: aConversation.id } }))).toBe("ok");
    });
  });

  describe("A-10 replies", () => {
    it("refuses while C2 is OPEN and the account reply before the audience reply; nothing written", async () => {
      const before = await globalCensus();
      expect((await planWorkflowAcceptanceReply(privileged, "audience")).status).toBe("REFUSED_PRECONDITION");
      expect((await applyWorkflowAcceptanceReply(deps(), "audience")).status).toBe("REFUSED_PRECONDITION");
      expect((await applyWorkflowAcceptanceReply(deps(), "account")).status).toBe("REFUSED_PRECONDITION");
      expect(await globalCensus()).toEqual(before);
    });

    it("audience reply on a DONE C2: auto-reopen, version + 1, one system_auto_reopen event naming the reply, one system audit row; existing data untouched", async () => {
      const existingBefore = await existingDigest();
      const item = await c2();
      expect(await markDone(U1, A.id, item.id, item.version)).toBe("ok");
      const done = await c2();
      expect(done.state).toBe("DONE");
      expect((await planWorkflowAcceptanceReply(privileged, "audience")).status).toBe("READY");
      const result = await applyWorkflowAcceptanceReply(deps(), "audience");
      expect(result.status).toBe("INGESTED");
      expect(result.c2Before).toEqual({ state: "DONE", version: done.version });
      expect(result.c2After).toEqual({ state: "OPEN", version: done.version + 1 });
      expect(result.measuredDelta).toMatchObject({ "interactions.interactions": 1, "workflow.workflow_events": 1, "audit.audit_events": 1, "system.outbox": 1 });
      expect(await oracle("select actor_type, action from audit.audit_events where workspace_id = $1 and correlation_id = $2", [A.id, result.correlationId]))
        .toEqual([{ actor_type: "system", action: "work_item.state_changed" }]);
      expect(await existingDigest()).toBe(existingBefore);
      expect((await applyWorkflowAcceptanceReply(deps(), "audience")).status).toBe("ALREADY_PRESENT_MATCH");
    });

    it("account reply: refused while C2 is OPEN; on a DONE C2 it changes neither state nor version", async () => {
      expect((await planWorkflowAcceptanceReply(privileged, "account")).status).toBe("REFUSED_PRECONDITION");
      const item = await c2();
      expect(await markDone(U1, A.id, item.id, item.version)).toBe("ok");
      const done = await c2();
      const result = await applyWorkflowAcceptanceReply(deps(), "account");
      expect(result.status).toBe("INGESTED");
      expect(result.c2After).toEqual({ state: "DONE", version: done.version });
      expect(result.measuredDelta?.["workflow.workflow_events"]).toBeUndefined();
      expect((await applyWorkflowAcceptanceReply(deps(), "account")).status).toBe("ALREADY_PRESENT_MATCH");
      expect(fetchSpy.calls()).toBe(0);
    });

    it("M (MONITOR_ONLY) keeps internal Workflow: U1 marks its conversation done (A-12 precondition)", async () => {
      const [row] = await oracle<{ id: string; version: number }>("select id::text, version from workflow.work_items where workspace_id = $1", [M.id]);
      if (row === undefined) throw new Error("m");
      expect(await markDone(U1, M.id, row.id, row.version)).toBe("ok");
      expect(await count("select count(*)::int as n from mutations.mutation_intents where workspace_id = $1", [M.id])).toBe(0);
    });
  });

  describe("A-03 role sequence", () => {
    it("only the next step, only from the expected current role, only for the attached U2", async () => {
      const before = await globalCensus();
      expect((await planRole(privileged, U2, "RESPONDER", "CLIENT_GUEST")).status).toBe("REFUSED_TRANSITION");
      expect((await planRole(privileged, U2, "ANALYST_VIEWER", "CLIENT_GUEST")).status).toBe("REFUSED_PRECONDITION");
      expect((await applyRole(privileged, U1, "RESPONDER", "ANALYST_VIEWER")).status).toBe("REFUSED_PRECONDITION");
      expect((await applyRole(privileged, randomUUID(), "RESPONDER", "ANALYST_VIEWER")).status).toBe("REFUSED_PRECONDITION");
      expect(await globalCensus()).toEqual(before);
    });

    it("RESPONDER → ANALYST_VIEWER → CLIENT_GUEST: each one compare-and-set change with its audit event; the pipeline then denies the change and the read", async () => {
      const item = await c2();
      const first = await applyRole(privileged, U2, "RESPONDER", "ANALYST_VIEWER");
      expect(first.status).toBe("CHANGED");
      expect(await oracle("select action, actor_type, actor_user_id, target_type, target_id, outcome, change from audit.audit_events where id = $1", [first.auditEventId])).toEqual([{
        action: "workspace_membership.role_changed", actor_type: "system", actor_user_id: null, target_type: "workspace_membership", target_id: `${A.id}:${U2}`, outcome: "succeeded",
        change: { kind: "workspace_membership", previous: { role: "RESPONDER", grants: [] }, current: { role: "ANALYST_VIEWER", grants: [] } },
      }]);
      expect(await listCount(U2, A.id)).toBe(5);
      expect(await markDone(U2, A.id, item.id, item.version)).toBe("PERMISSION_DENIED");
      expect((await applyRole(privileged, U2, "RESPONDER", "ANALYST_VIEWER")).status).toBe("REFUSED_PRECONDITION");
      expect((await applyRole(privileged, U2, "ANALYST_VIEWER", "CLIENT_GUEST")).status).toBe("CHANGED");
      expect(await listCount(U2, A.id)).toBe("PERMISSION_DENIED");
      expect(await listCount(U2, B.id)).toBe(1);
      const verify = await verifyAcceptance({ U1, U2 });
      expect(verify.ok).toBe(true);
      expect(verify.roleAuditEvents).toBe(2);
      expect(fetchSpy.calls()).toBe(0);
    });
  });
}
