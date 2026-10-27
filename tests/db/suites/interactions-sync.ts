/**
 * Step H6-C4 — "Sync interactions" end to end on the real database: the settings surface's outcome mapping, the action
 * pipeline (session identity, live tenant resolution, connections.manage), the web unit of work (web login →
 * authenticated, verified claims, sealed workspace) and 0019's boundary, which writes the REQUESTED run, its audit
 * event and its planner row. Proves the pipeline adds no second audit event, the browser can choose nothing but the
 * account, and every refusal writes nothing. Synthetic data only; no job runs, no provider is called.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUserId, type UserId } from "@/domain/ids";
import { createLogger, type Logger } from "@/platform/observability";
import type { OutboxNotice } from "@/platform/outbox";
import { requestInteractionsSyncCommand } from "@/server/commands/reconciliation";
import { requestInteractionsSync } from "@/server/connections/settings";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import type { RuntimeDatabase } from "@/platform/db";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";

const ROLES = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;
type Role = (typeof ROLES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly members: Readonly<Record<Role, string>>;
  readonly account: string;
}

export function defineInteractionsSyncSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let logger: Logger;
  const organizations: string[] = [];
  const committed: OutboxNotice[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const count = async (query: string, values: readonly unknown[] = []): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const writes = async (t: Tenant) => ({
    runs: await count("select count(*)::int as n from ingestion.reconciliation_runs where workspace_id = $1", [t.workspaceId]),
    audit: await count("select count(*)::int as n from audit.audit_events where organization_id = $1", [t.organizationId]),
    outbox: await count("select count(*)::int as n from system.outbox where workspace_id = $1", [t.workspaceId]),
  });
  const user = (id: string): UserId => {
    const parsed = parseUserId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const pipelineFor = (id: string | undefined): ActionPipeline =>
    createActionPipeline({
      identity: new FakeIdentity(id === undefined ? undefined : verifiedUser(user(id))),
      unitOfWork: createPostgresUnitOfWork(web),
      clock: () => new Date(),
      newId: randomUUID,
      logger,
      outboxCommitted: (notices) => {
        committed.push(...notices);
        return Promise.resolve();
      },
    });
  /** What the server action does: the settings surface's mapping over the registered command. */
  const sync = (t: Tenant, as: string | undefined, connectedAccountId: unknown = t.account, workspaceId: unknown = t.workspaceId) =>
    requestInteractionsSync(pipelineFor(as), { workspaceId, connectedAccountId });

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const members = Object.fromEntries(ROLES.map((role) => [role, randomUUID()])) as Record<Role, string>;
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Sync', now())", [organizationId]);
    // Monitor-only on purpose: a sync request reads, it never mutates the platform.
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
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, `fb-${randomUUID().slice(0, 12)}`]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered]);
    return { organizationId, workspaceId, members, account };
  };
  const finishOpen = (t: Tenant) =>
    privileged.query("update ingestion.reconciliation_runs set state = 'SKIPPED_UNAVAILABLE', failure_class = 'test', completed_at = now(), updated_at = now() where workspace_id = $1 and state in ('REQUESTED', 'RUNNING')", [t.workspaceId]);

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 3);
    logger = createLogger({ sink: () => undefined });
  });
  afterAll(async () => {
    await web.end();
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("who may start a sync", () => {
    it("OWNER and ADMIN: sync_started — one REQUESTED run (their own id, 40 operations), ONE audit event (the boundary's), one IDs-only planner row", async () => {
      const t = await tenant();
      for (const role of ["OWNER", "ADMIN"] as const) {
        committed.length = 0;
        expect(await sync(t, t.members[role])).toEqual({ kind: "status", status: "sync_started" });
        const runs = await oracle<{ id: string; state: string; initiator_type: string; initiator_user_id: string; max_operations: number; operations_used: number }>(
          "select id, state, initiator_type, initiator_user_id, max_operations, operations_used from ingestion.reconciliation_runs where workspace_id = $1 and state = 'REQUESTED'", [t.workspaceId]);
        expect(runs).toHaveLength(1);
        const run = runs[0];
        expect(run).toMatchObject({ state: "REQUESTED", initiator_type: "user", initiator_user_id: t.members[role], max_operations: 40, operations_used: 0 });
        // Exactly one audit event for this request — the boundary's — and none from the pipeline.
        const audit = await oracle<{ action: string; actor_type: string; actor_user_id: string; target_id: string; workspace_id: string }>(
          "select action, actor_type, actor_user_id, target_id, workspace_id from audit.audit_events where organization_id = $1 and actor_user_id = $2", [t.organizationId, t.members[role]]);
        expect(audit).toEqual([{ action: "connected_account.reconciliation_requested", actor_type: "user", actor_user_id: t.members[role], target_id: t.account, workspace_id: t.workspaceId }]);
        const outbox = await oracle<{ id: string; topic: string; subject_ids: Record<string, string>; initiator_user_id: string; status: string }>(
          "select id, topic, subject_ids, initiator_user_id, status from system.outbox where workspace_id = $1 and dispatch_key = $2", [t.workspaceId, `ingestion.reconcile_account:${run?.id ?? ""}`]);
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ topic: "ingestion.reconcile_account", initiator_user_id: t.members[role], status: "PENDING" });
        expect(outbox[0]?.subject_ids).toEqual({ connected_account_id: t.account, reconciliation_run_id: run?.id });
        for (const value of Object.values(outbox[0]?.subject_ids ?? {})) expect(value).toMatch(UUID);
        // The pipeline's post-commit wake-up names the boundary's row (ids only).
        expect(committed.map((notice) => notice.id)).toEqual([outbox[0]?.id]);
        await finishOpen(t);
      }
      expect(await writes(t)).toEqual({ runs: 2, audit: 2, outbox: 2 });
    });

    it("MANAGER, RESPONDER, ANALYST_VIEWER and CLIENT_GUEST: not_allowed, and nothing is written", async () => {
      const t = await tenant();
      for (const role of ["MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
        expect(await sync(t, t.members[role]), role).toEqual({ kind: "status", status: "not_allowed" });
      }
      expect(await writes(t)).toEqual({ runs: 0, audit: 0, outbox: 0 });
    });

    it("unauthenticated: signed_out, nothing written; a non-member: workspace not found (sync_not_found), nothing written", async () => {
      const t = await tenant();
      expect(await sync(t, undefined)).toEqual({ kind: "signed_out" });
      expect(await sync(t, randomUUID())).toEqual({ kind: "status", status: "sync_not_found" });
      expect(await writes(t)).toEqual({ runs: 0, audit: 0, outbox: 0 });
    });

    it("another workspace's account, a nonexistent one, an inactive one or a malformed id: the same sync_not_found, nothing written anywhere", async () => {
      const t = await tenant();
      const other = await tenant();
      expect(await sync(t, t.members.OWNER, other.account)).toEqual({ kind: "status", status: "sync_not_found" });
      expect(await sync(t, t.members.OWNER, randomUUID())).toEqual({ kind: "status", status: "sync_not_found" });
      for (const malformed of ["", "not-a-uuid", t.account.toUpperCase(), null, 42]) expect(await sync(t, t.members.OWNER, malformed)).toEqual({ kind: "status", status: "sync_not_found" });
      await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED' where id = $1", [t.account]);
      expect(await sync(t, t.members.OWNER)).toEqual({ kind: "status", status: "sync_not_found" });
      // t's Owner routing other's workspace (not a member there).
      expect(await sync(t, t.members.OWNER, other.account, other.workspaceId)).toEqual({ kind: "status", status: "sync_not_found" });
      expect([await writes(t), await writes(other)]).toEqual([{ runs: 0, audit: 0, outbox: 0 }, { runs: 0, audit: 0, outbox: 0 }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("one open run", () => {
    it("a second request while one is open: sync_already_running (a product state), nothing new written", async () => {
      const t = await tenant();
      expect(await sync(t, t.members.OWNER)).toEqual({ kind: "status", status: "sync_started" });
      expect(await sync(t, t.members.ADMIN)).toEqual({ kind: "status", status: "sync_already_running" });
      expect(await sync(t, t.members.OWNER)).toEqual({ kind: "status", status: "sync_already_running" });
      expect(await writes(t)).toEqual({ runs: 1, audit: 1, outbox: 1 });
    });

    it("concurrent requests (double submit, two admins): one run, one audit event, one planner row", async () => {
      const t = await tenant();
      const results = await Promise.all([sync(t, t.members.OWNER), sync(t, t.members.ADMIN), sync(t, t.members.OWNER)]);
      expect(results.map((r) => (r.kind === "status" ? r.status : r.kind)).sort()).toEqual(["sync_already_running", "sync_already_running", "sync_started"]);
      expect(await writes(t)).toEqual({ runs: 1, audit: 1, outbox: 1 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the browser chooses nothing but the account", () => {
    it("budget, time, workspace, organization, user, role, topic or subjects in the input: INVALID_INPUT, nothing written", async () => {
      const t = await tenant();
      const extras: Record<string, unknown>[] = [
        { maxOperations: 8 },
        { max_operations: 1 },
        { budget: { maxOperations: 40 } },
        { requestedAt: new Date().toISOString() },
        { workspaceId: t.workspaceId },
        { organizationId: t.organizationId },
        { userId: t.members.OWNER },
        { role: "OWNER" },
        { topic: "ingestion.reconcile_slice" },
        { subjectIds: { connected_account_id: t.account } },
        { state: "RUNNING" },
      ];
      for (const extra of extras) {
        const result = await pipelineFor(t.members.OWNER).run(requestInteractionsSyncCommand, { workspaceId: t.workspaceId, input: { connectedAccountId: t.account, ...extra } });
        expect(result.status === "error" ? result.error.code : result.status, JSON.stringify(Object.keys(extra))).toBe("INVALID_INPUT");
      }
      expect(await writes(t)).toEqual({ runs: 0, audit: 0, outbox: 0 });
      // The ordinary request: 40 operations, the approved defaults, statement time.
      expect(await sync(t, t.members.OWNER)).toEqual({ kind: "status", status: "sync_started" });
      expect(await oracle("select max_operations, budget_listing_pages_per_slice, budget_interaction_pages_per_slice, budget_continuations_per_content, budget_content_items, budget_overlap_seconds from ingestion.reconciliation_runs where workspace_id = $1", [t.workspaceId]))
        .toEqual([{ max_operations: 40, budget_listing_pages_per_slice: 1, budget_interaction_pages_per_slice: 5, budget_continuations_per_content: 2, budget_content_items: 10, budget_overlap_seconds: 86_400 }]);
    });
  });
}
