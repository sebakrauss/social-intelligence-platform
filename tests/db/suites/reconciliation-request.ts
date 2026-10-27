/**
 * Step H6-C3b — the reconciliation request boundary of migration 0019 on the real database, through the runtime roles:
 * members (web login → authenticated, verified claims, one bound workspace) and the job runtime (worker login →
 * app_worker). ingestion.request_reconciliation is the ONE creation path of a run: authorization, the one-open check,
 * the REQUESTED run with its budget (max_operations included), its audit event and its planner outbox row, atomically.
 * Synthetic data only; no job runs, no provider is called.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { LIVE_ACCEPTANCE_MAX_OPERATIONS, defaultBudgetSnapshot, planReconciliation, type ReconciliationBudgetSnapshot } from "@/modules/ingestion";
import { createPostgresReconciliationStore } from "@/modules/ingestion/persistence";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { reconciliationScope } from "@/server/persistence/ingestion";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const ROLES = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;
type Role = (typeof ROLES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FUNCTION = "ingestion.request_reconciliation(uuid,text,timestamp with time zone,jsonb)";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly members: Readonly<Record<Role, string>>;
  readonly account: string;
}

export function defineReconciliationRequestSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  const organizations: string[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const correlation = (): CorrelationId => {
    const parsed = parseCorrelationId(`h6c3b-${randomUUID()}`);
    if (parsed === undefined) throw new Error("correlation");
    return parsed;
  };
  const writes = async (t: Tenant) => ({
    runs: await count("select count(*)::int as n from ingestion.reconciliation_runs where workspace_id = $1", [t.workspaceId]),
    audit: await count("select count(*)::int as n from audit.audit_events where workspace_id = $1 and action = 'connected_account.reconciliation_requested'", [t.workspaceId]),
    outbox: await count("select count(*)::int as n from system.outbox where workspace_id = $1 and topic = 'ingestion.reconcile_account'", [t.workspaceId]),
  });

  /** An organization + workspace with one member per role, an ACTIVE Meta connection and one ACTIVE Facebook account. */
  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const members = Object.fromEntries(ROLES.map((role) => [role, randomUUID()])) as Record<Role, string>;
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Request', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    for (const role of ROLES) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, members[role], role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, members[role], role]);
    }
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, members.OWNER]);
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', 'fb_page_aurora', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered]);
    return { organizationId, workspaceId, members, account };
  };

  /** The web path: the member's claims, the bound workspace, no budget and no time (what H6-C4's action will send). */
  const asMember = <T>(t: Tenant, user: string, work: (tx: DatabaseTransaction) => Promise<T>) => withUserScope(web, { sub: user, role: "authenticated" }, t.workspaceId, work);
  const webRequest = (t: Tenant, user: string, account = t.account) =>
    asMember(t, user, (tx) => createPostgresReconciliationStore(tx, () => undefined).requestRun({ connectedAccountId: account, correlationId: correlation(), requestedAt: null, budget: null }));
  /** The internal (operator / LIVE acceptance) path: the job runtime names the time and may narrow the budget. */
  const workerRequest = (t: Tenant, budget: ReconciliationBudgetSnapshot | null = defaultBudgetSnapshot(), account = t.account) =>
    withWorkspaceJobScope(worker, t.workspaceId, (tx) => createPostgresReconciliationStore(tx, () => undefined).requestRun({ connectedAccountId: account, correlationId: correlation(), requestedAt: new Date(), budget }));
  const finishOpen = (t: Tenant) => privileged.query("update ingestion.reconciliation_runs set state = 'SKIPPED_UNAVAILABLE', failure_class = 'test', completed_at = now(), updated_at = now() where workspace_id = $1 and state in ('REQUESTED', 'RUNNING')", [t.workspaceId]);

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("who may request", () => {
    let t: Tenant;
    beforeAll(async () => {
      t = await tenant();
    });

    it("1–2, 10–14, 18. OWNER and ADMIN: one REQUESTED run (their own id, default budget of 40), one audit event, one IDs-only planner row", async () => {
      for (const role of ["OWNER", "ADMIN"] as const) {
        const result = await webRequest(t, t.members[role]);
        expect(result.outcome).toBe("requested");
        if (result.outcome !== "requested") return;
        const [run] = await oracle<{ state: string; initiator_type: string; initiator_user_id: string; max_operations: number; budget_interaction_pages_per_content: number; budget_content_items: number; budget_overlap_seconds: number; operations_used: number }>(
          "select state, initiator_type, initiator_user_id, max_operations, budget_interaction_pages_per_content, budget_content_items, budget_overlap_seconds, operations_used from ingestion.reconciliation_runs where id = $1", [result.runId]);
        expect(run).toEqual({ state: "REQUESTED", initiator_type: "user", initiator_user_id: t.members[role], max_operations: 40, budget_interaction_pages_per_content: 15, budget_content_items: 10, budget_overlap_seconds: 86_400, operations_used: 0 });
        const audit = await oracle<{ actor_type: string; actor_user_id: string; target_type: string; target_id: string; outcome: string }>(
          "select actor_type, actor_user_id, target_type, target_id, outcome from audit.audit_events where workspace_id = $1 and action = 'connected_account.reconciliation_requested' and actor_user_id = $2", [t.workspaceId, t.members[role]]);
        expect(audit).toEqual([{ actor_type: "user", actor_user_id: t.members[role], target_type: "connected_account", target_id: t.account, outcome: "succeeded" }]);
        const outbox = await oracle<{ id: string; topic: string; subject_ids: Record<string, string>; initiator_type: string; initiator_user_id: string; dispatch_key: string; status: string }>(
          "select id, topic, subject_ids, initiator_type, initiator_user_id, dispatch_key, status from system.outbox where workspace_id = $1 and dispatch_key = $2", [t.workspaceId, `ingestion.reconcile_account:${result.runId}`]);
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ id: result.outboxId, topic: "ingestion.reconcile_account", initiator_type: "user", initiator_user_id: t.members[role], status: "PENDING" });
        expect(outbox[0]?.subject_ids).toEqual({ connected_account_id: t.account, reconciliation_run_id: result.runId });
        for (const value of Object.values(outbox[0]?.subject_ids ?? {})) expect(value).toMatch(UUID);
        await finishOpen(t);
      }
      expect(await writes(t)).toEqual({ runs: 2, audit: 2, outbox: 2 });
    });

    it("3–6, 17. MANAGER, RESPONDER, ANALYST_VIEWER and CLIENT_GUEST are refused (42501) and nothing is written", async () => {
      const before = await writes(t);
      for (const role of ["MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
        expect(await sqlState(webRequest(t, t.members[role])), role).toMatchObject({ code: "42501" });
      }
      expect(await writes(t)).toEqual(before);
    });

    it("7. unauthenticated callers can't reach the boundary: anon holds no EXECUTE; a non-member binds nothing", async () => {
      const before = await writes(t);
      const client = await privileged.connect();
      try {
        await client.query("begin");
        await client.query("set local role anon");
        await expect(client.query("select * from ingestion.request_reconciliation($1::uuid, 'h6c3b-anon-0001', null, null)", [t.account])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("rollback");
        client.release();
      }
      expect((await sqlState(webRequest(t, randomUUID()))).code).toMatch(/^(42501|P0001|28000)$/);
      expect(await writes(t)).toEqual(before);
    });

    it("8–9, 23. another workspace's account, a nonexistent one, or binding another workspace: not_found or refused, nothing written anywhere", async () => {
      const other = await tenant();
      const before = [await writes(t), await writes(other)];
      expect(await webRequest(t, t.members.OWNER, other.account)).toEqual({ outcome: "not_found" });
      expect(await webRequest(t, t.members.OWNER, randomUUID())).toEqual({ outcome: "not_found" });
      // t's Owner binding the other workspace (not a member there): refused before anything.
      const escalation = await sqlState(withUserScope(web, { sub: t.members.OWNER, role: "authenticated" }, other.workspaceId, (tx) =>
        createPostgresReconciliationStore(tx, () => undefined).requestRun({ connectedAccountId: other.account, correlationId: correlation(), requestedAt: null, budget: null })));
      expect(escalation.code).toMatch(/^(42501|P0001|28000)$/);
      // The job runtime of t names other's account: not_found (its workspace is the sealed one).
      expect(await workerRequest(t, defaultBudgetSnapshot(), other.account)).toEqual({ outcome: "not_found" });
      expect([await writes(t), await writes(other)]).toEqual(before);
    });

    it("an INACTIVE account of the workspace is not_found too (no request for an account that isn't connected)", async () => {
      const u = await tenant();
      await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED' where id = $1", [u.account]);
      expect(await webRequest(u, u.members.OWNER)).toEqual({ outcome: "not_found" });
      expect(await writes(u)).toEqual({ runs: 0, audit: 0, outbox: 0 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("one open run, atomically", () => {
    it("15. a second request while one is open is already_running with that run, writing nothing", async () => {
      const t = await tenant();
      const first = await webRequest(t, t.members.OWNER);
      if (first.outcome !== "requested") throw new Error("first");
      expect(await webRequest(t, t.members.ADMIN)).toEqual({ outcome: "already_running", runId: first.runId });
      expect(await workerRequest(t)).toEqual({ outcome: "already_running", runId: first.runId });
      expect(await writes(t)).toEqual({ runs: 1, audit: 1, outbox: 1 });
    });

    it("16. concurrent duplicate requests create ONE run, one audit event and one planner row", async () => {
      const t = await tenant();
      const results = await Promise.all([webRequest(t, t.members.OWNER), webRequest(t, t.members.ADMIN)]);
      expect(results.map((r) => r.outcome).sort()).toEqual(["already_running", "requested"]);
      const requested = results.find((r) => r.outcome === "requested");
      const running = results.find((r) => r.outcome === "already_running");
      expect(running && "runId" in running ? running.runId : null).toBe(requested && "runId" in requested ? requested.runId : undefined);
      expect(await writes(t)).toEqual({ runs: 1, audit: 1, outbox: 1 });
    });

    it("a web-requested run is planned by the unchanged MAIN planner (initiator stays attributable on run and audit)", async () => {
      const t = await tenant();
      const result = await webRequest(t, t.members.OWNER);
      if (result.outcome !== "requested") throw new Error("request");
      const outcome = await withWorkspaceJobScope(worker, t.workspaceId, (tx) => planReconciliation(reconciliationScope({ tx, noteOutbox: () => undefined }), { newId: randomUUID, now: () => new Date() }, { runId: result.runId, connectedAccountId: t.account }));
      // No capability profile here: the planner skips truthfully, and the human initiator is still on the run.
      expect(outcome).toMatchObject({ kind: "skipped" });
      expect(await oracle("select state, initiator_type, initiator_user_id from ingestion.reconciliation_runs where id = $1", [result.runId]))
        .toEqual([{ state: "SKIPPED_UNAVAILABLE", initiator_type: "user", initiator_user_id: t.members.OWNER }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the persisted provider-operation budget", () => {
    it("19. the internal path may narrow the budget to the LIVE acceptance's 8; the run is system-initiated and audited", async () => {
      const t = await tenant();
      const result = await workerRequest(t, { ...defaultBudgetSnapshot(), maxOperations: LIVE_ACCEPTANCE_MAX_OPERATIONS });
      if (result.outcome !== "requested") throw new Error("request");
      expect(await oracle("select max_operations, initiator_type, initiator_user_id from ingestion.reconciliation_runs where id = $1", [result.runId]))
        .toEqual([{ max_operations: 8, initiator_type: "system", initiator_user_id: null }]);
      expect(await oracle("select actor_type, actor_user_id from audit.audit_events where workspace_id = $1 and action = 'connected_account.reconciliation_requested'", [t.workspaceId]))
        .toEqual([{ actor_type: "system", actor_user_id: null }]);
      expect(await oracle("select initiator_type from system.outbox where workspace_id = $1 and topic = 'ingestion.reconcile_account'", [t.workspaceId])).toEqual([{ initiator_type: "system" }]);
    });

    it("20. a browser can't choose the budget or the time; the internal path can't exceed the ceiling or pass unknown keys", async () => {
      const t = await tenant();
      const asOwner = (budget: string | null, at: string | null) => asMember(t, t.members.OWNER, (tx) =>
        tx.execute(sql`select * from ingestion.request_reconciliation(${t.account}::uuid, ${correlation()}, ${at}::timestamptz, ${budget}::jsonb)`));
      expect(await sqlState(asOwner('{"max_operations": 40}', null))).toMatchObject({ code: "42501" });
      expect(await sqlState(asOwner('{"max_operations": 1}', null))).toMatchObject({ code: "42501" });
      expect(await sqlState(asOwner(null, new Date().toISOString()))).toMatchObject({ code: "42501" });
      expect(await sqlState(workerRequest(t, { ...defaultBudgetSnapshot(), maxOperations: 41 }))).toMatchObject({ code: "23514" });
      expect(await sqlState(workerRequest(t, { ...defaultBudgetSnapshot(), maxOperations: 0 }))).toMatchObject({ code: "23514" });
      expect(await sqlState(withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
        tx.execute(sql`select * from ingestion.request_reconciliation(${t.account}::uuid, ${correlation()}, now(), ${'{"max_operations": 8, "topic": "x"}'}::jsonb)`)))).toMatchObject({ code: "22023" });
      expect(await writes(t)).toEqual({ runs: 0, audit: 0, outbox: 0 });
    });

    it("21–22, 26. operations_used never exceeds max_operations; max_operations is never updatable; reservation reads the persisted value", async () => {
      const t = await tenant();
      const result = await workerRequest(t, { ...defaultBudgetSnapshot(), maxOperations: 2 });
      if (result.outcome !== "requested") throw new Error("request");
      await privileged.query("update ingestion.reconciliation_runs set state = 'RUNNING', started_at = now(), updated_at = now() where id = $1", [result.runId]);
      const reserve = () => withWorkspaceJobScope(worker, t.workspaceId, (tx) => createPostgresReconciliationStore(tx, () => undefined).reserveRunOperation(result.runId, new Date()));
      expect([await reserve(), await reserve(), await reserve()]).toEqual([true, true, false]);
      expect(await oracle("select operations_used, max_operations from ingestion.reconciliation_runs where id = $1", [result.runId])).toEqual([{ operations_used: 2, max_operations: 2 }]);
      expect(await sqlState(withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set operations_used = 3 where id = ${result.runId}`)))).toMatchObject({ code: "23514" });
      expect(await sqlState(withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set max_operations = 40 where id = ${result.runId}`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(t, t.members.OWNER, (tx) => tx.execute(sql`update ingestion.reconciliation_runs set max_operations = 40 where id = ${result.runId}`)))).toMatchObject({ code: "42501" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the boundary itself", () => {
    it("24–25. a SECURITY DEFINER owned by app_owner, empty search_path, no PUBLIC EXECUTE — only authenticated and app_worker", async () => {
      const [fn] = await oracle<{ owner: string; secdef: boolean; config: string[] | null; acl: string }>(
        `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig as config, p.proacl::text as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ingestion' and p.proname = 'request_reconciliation'`);
      expect(fn).toMatchObject({ owner: "app_owner", secdef: true, config: ['search_path=""'] });
      const grantees = [...(fn?.acl ?? "").matchAll(/(?:^|[{,])([^=,{}]*)=([A-Za-z]*)\//g)].map((m) => [m[1], m[2]]);
      expect(grantees.filter(([grantee]) => grantee === "")).toEqual([]);
      expect(grantees.map(([grantee]) => grantee).sort()).toEqual(["app_owner", "app_worker", "authenticated"]);
      for (const role of ["anon", "app_system", "service_role"]) {
        expect((await oracle<{ ok: boolean }>(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, FUNCTION]).catch(() => [{ ok: false }]))[0]?.ok, role).toBe(false);
      }
    });

    it("the web can't append the reconciliation topics itself (restrictive policy); the worker's own path is unchanged", async () => {
      const t = await tenant();
      for (const topic of ["ingestion.reconcile_account", "ingestion.reconcile_slice", "interactions.observed"]) {
        expect(await sqlState(asMember(t, t.members.OWNER, (tx) => tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
          values (${randomUUID()}, ${topic}, ${t.organizationId}, ${t.workspaceId}, ${JSON.stringify({ connected_account_id: t.account, reconciliation_run_id: randomUUID() })}::jsonb, ${correlation()}, 'user', ${t.members.OWNER}, ${`h6c3b.direct:${randomUUID()}`}, 'PENDING', now())`))), topic).toMatchObject({ code: "42501" });
      }
      // Nor create a run directly (no INSERT grant).
      expect(await sqlState(asMember(t, t.members.OWNER, (tx) => tx.execute(sql`insert into ingestion.reconciliation_runs (id) values (${randomUUID()})`)))).toMatchObject({ code: "42501" });
      // A member's self-attributed audit append is the action pipeline's pre-existing path (0003 append_own, unchanged):
      // it records only that member's own claim and creates no run and no planner row — it is not a request.
      await asMember(t, t.members.OWNER, (tx) => tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id, target_type, target_id, correlation_id, outcome)
        values (${randomUUID()}, now(), 'connected_account.reconciliation_requested', 'user', ${t.members.OWNER}, ${t.organizationId}, ${t.workspaceId}, 'connected_account', ${t.account}, ${correlation()}, 'succeeded')`));
      expect(await writes(t)).toEqual({ runs: 0, audit: 1, outbox: 0 });
    });
  });
}
