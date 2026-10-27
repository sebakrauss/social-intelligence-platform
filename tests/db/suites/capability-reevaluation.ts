/**
 * Step 7G-H5.5-P2-B1 — explicit capability re-evaluation on the real database. An accepted request is ONE transaction
 * holding exactly one REEVALUATION_REQUESTED event, one NEW capability.evaluate_account request keyed by that event
 * (…:reeval.{event}) and one audit record; a refusal writes nothing. Migration 0014's constraints admit the event only
 * as a user's request, the 0007 policies keep it Owner/Admin-only, and the row lock serializes concurrent requests so
 * at most one new authority exists per cooldown window.
 *
 * Earlier authorities are never touched: the failure-recovery cases deliver them through the REAL relay and run-outcome
 * sweeper (R7) to FAILED, CANCELED, RECOVERY_EXHAUSTED or COMPLETED (skipped / unusable facts / failed persistence),
 * snapshot every column of the old row and its run records, and prove they are byte-identical after the recovery
 * request and after the new authority's own delivery. A crash recovered by R7 reuses its OWN authority and creates no
 * recovery event. Only the job runtime and the provider are test doubles (no network, no credential is ever opened).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUserId, type UserId } from "@/domain/ids";
import { PermanentRejectedError, TransientError, type ProviderCredential, type ProviderReadPort } from "@/integrations/providers/contract";
import { runEvaluateAccountCapabilities } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { ANY, PLATFORM_CATALOG, evaluateAndStore, type CapabilityCatalog, type FactsInput } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import { requestCapabilityReevaluation, type DiscoveryProviders, type ProviderCredentialAccess } from "@/modules/connections";
import { createPostgresConnectionStore } from "@/modules/connections/persistence";
import { withUserScope, withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { runTenantStepJob, type TenantStepJobContext } from "@/platform/jobs";
import { relayPass, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger, type Logger } from "@/platform/observability";
import { createConnectedAccountCommands } from "@/server/commands/connected-accounts";
import { requestCapabilityRecheck, resolveConnectionSettings } from "@/server/connections/settings";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline, type UnitOfWork } from "@/server/pipeline";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { errorCode } from "../../support/harness";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const ROLES = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER"] as const;
type Role = (typeof ROLES)[number];

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly members: Readonly<Record<Role, string>>;
}

const EVALUATE = "capability.evaluate_account";
const AUDIT_ACTION = "connected_account.capability_reevaluation_requested";
const MIN = 60_000;
const COOLDOWN = 30 * MIN;

const CONFIG: DeliveryConfig = {
  batchSize: 200,
  leaseSeconds: 30,
  backoff: { baseSeconds: 5, maxSeconds: 60 },
  dispatchSweepMinAgeSeconds: 60,
  dispatchSloSeconds: 120,
  maxRecoveries: 1,
  outcomeBatchSize: 200,
  unknownObservation: { maxChecks: 4, maxSeconds: 600 },
};

export function defineCapabilityReevaluationSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let logger: Logger;
  const organizations: string[] = [];
  // One server clock for the pipeline, the relay and the sweeper; advanced explicitly (cooldown boundaries are exact).
  let nowMs = Date.now();
  const clock = (): Date => new Date(nowMs);
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  const command = createConnectedAccountCommands().requestCapabilityReevaluation;
  const link = createConnectedAccountCommands().link;

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const countOf = async (query: string, values: readonly unknown[]): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const user = (id: string): UserId => {
    const parsed = parseUserId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const pipelineFor = (id: string, unitOfWork: UnitOfWork = createPostgresUnitOfWork(web)): ActionPipeline =>
    createActionPipeline({ identity: new FakeIdentity(verifiedUser(user(id))), unitOfWork, clock, newId: randomUUID, logger });
  const request = (t: Tenant, as: string, connectedAccountId: unknown, options: { readonly workspaceId?: string; readonly pipeline?: ActionPipeline } = {}) =>
    (options.pipeline ?? pipelineFor(as)).run(command, { workspaceId: options.workspaceId ?? t.workspaceId, input: { connectedAccountId } });

  // ── Synthetic tenants and rows (privileged bootstrap) ────────────────────────────────────────────────────────
  const tenant = async (organizationId?: string): Promise<Tenant> => {
    const members = Object.fromEntries(ROLES.map((role) => [role, randomUUID()])) as Record<Role, string>;
    const t: Tenant = { organizationId: organizationId ?? randomUUID(), workspaceId: randomUUID(), members };
    if (organizationId === undefined) {
      organizations.push(t.organizationId);
      await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Reevaluation', now())", [t.organizationId]);
    }
    // Monitor-only on purpose: the request is configuration, never a platform mutation.
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [t.workspaceId, t.organizationId]);
    for (const role of ROLES) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now()) on conflict do nothing", [t.organizationId, members[role], role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [t.organizationId, t.workspaceId, members[role], role]);
    }
    return t;
  };
  /** A Connection in an exact status, optionally with an (unopenable, never opened) credential envelope. */
  const seedConnection = async (t: Tenant, status: string, options: { readonly provider?: string; readonly credential?: boolean } = {}): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, null, $6, now(), 1, now(), now())`,
      [id, t.organizationId, t.workspaceId, options.provider ?? "meta", status, t.members.OWNER],
    );
    if (options.credential === true) {
      const credential = randomUUID();
      await privileged.query(
        `insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at)
         values ($1, $2, $3, $4, 1, $5, now())`,
        // EnvelopeV1-shaped junk (as Step 5K's stub test): admitted by the table, never opened (the access is fake).
        [credential, t.organizationId, t.workspaceId, id, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])],
      );
      await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, id]);
    }
    return id;
  };
  const seedAsset = async (t: Tenant, connection: string, platform = "facebook"): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'content_bearing', 'Synthetic', now(), now(), now())`,
      [id, t.organizationId, t.workspaceId, connection, platform, `${platform}-${randomUUID().slice(0, 12)}`],
    );
    return id;
  };
  /** An ACTIVE account inserted directly, with no activation event (so no cooldown is running). */
  const seedAccount = async (t: Tenant, options: { readonly connectionStatus?: string; readonly provider?: string; readonly status?: "ACTIVE" | "INACTIVE" } = {}) => {
    const connection = await seedConnection(t, options.connectionStatus ?? "ACTIVE", { provider: options.provider ?? "meta" });
    const asset = await seedAsset(t, connection);
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, deactivated_at, deactivation_reason, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, $3, now(),
              case when $3 = 'INACTIVE' then now() end, case when $3 = 'INACTIVE' then 'UNLINKED' end, now(), now()
         from connections.discovered_assets where id = $2`,
      [id, asset, options.status ?? "ACTIVE"],
    );
    return { id, connection };
  };
  /** A profile written by the REAL evaluator in the worker scope. */
  const writeProfile = (t: Tenant, account: string, catalog: CapabilityCatalog, facts: FactsInput) =>
    withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
      evaluateAndStore(createPostgresCapabilityStore(tx), {
        organizationId: t.organizationId,
        workspaceId: t.workspaceId,
        connectedAccountId: account,
        catalog,
        platform: "facebook",
        assetClass: "content_bearing",
        facts,
        observations: [],
        evaluatedAt: clock(),
      }),
    );
  // Usable facts: the account holds the two permissions platform r3's one entry names (Step 7G-H5.5-P5-C9-C), so a
  // current profile built from them has no NOT_AUTHORIZED row and is genuinely "usable current".
  /** A Facebook Page holding every permission the platform catalog requires (r5: read_content + read_interactions, Step 7G-H5.5-P12-D2b). */
  const AVAILABLE = (): FactsInput => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: ["pages_read_engagement", "pages_read_user_content", "pages_show_list"], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: clock() });
  const UNAVAILABLE = (): FactsInput => ({ kind: "unavailable", observedAt: clock() });

  // ── Oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  interface EventRow {
    readonly id: string;
    readonly event_type: string;
    readonly reason_code: string;
    readonly actor_type: string;
    readonly actor_user_id: string | null;
    readonly move_id: string | null;
    readonly occurred_at: Date;
    readonly tx: string;
  }
  const reevaluationEvents = (workspace: string) =>
    oracle<EventRow>(
      "select id, event_type, reason_code, actor_type, actor_user_id, move_id, occurred_at, xmin::text as tx from connections.connected_account_events where workspace_id = $1 and event_type = 'REEVALUATION_REQUESTED' order by occurred_at, id",
      [workspace],
    );
  interface RequestRow {
    readonly id: string;
    readonly dispatch_key: string;
    readonly status: string;
    readonly subject_ids: Record<string, string>;
    readonly initiator_type: string;
    readonly initiator_user_id: string | null;
    readonly correlation_id: string;
    readonly created_at: Date;
    readonly tx: string;
  }
  const requests = (workspace: string) =>
    oracle<RequestRow>(
      "select id, dispatch_key, status, subject_ids, initiator_type, initiator_user_id, correlation_id, created_at, xmin::text as tx from system.outbox where workspace_id = $1 and topic = $2 order by created_at, dispatch_key",
      [workspace, EVALUATE],
    );
  const reevalRequests = async (workspace: string) => (await requests(workspace)).filter((row) => row.dispatch_key.includes(":reeval."));
  const outboxCount = (workspace: string) => countOf("select count(*)::int as n from system.outbox where workspace_id = $1", [workspace]);
  interface AuditRow {
    readonly actor_type: string;
    readonly actor_user_id: string | null;
    readonly target_type: string;
    readonly target_id: string;
    readonly correlation_id: string;
    readonly occurred_at: Date;
    readonly change: unknown;
    readonly tx: string;
  }
  const audits = (workspace: string) =>
    oracle<AuditRow>(
      "select actor_type, actor_user_id, target_type, target_id, correlation_id, occurred_at, change, xmin::text as tx from audit.audit_events where workspace_id = $1 and action = $2 order by occurred_at",
      [workspace, AUDIT_ACTION],
    );
  const nothingWritten = async (workspace: string): Promise<void> => {
    expect(await reevaluationEvents(workspace)).toEqual([]);
    expect(await reevalRequests(workspace)).toEqual([]);
    expect(await audits(workspace)).toEqual([]);
  };
  /** Every column of an outbox row and of its run records, as text: the authority's complete persisted state. */
  const snapshot = async (outboxId: string): Promise<string> => {
    const row = await oracle<{ row: string }>("select to_jsonb(o)::text as row from system.outbox o where id = $1", [outboxId]);
    const runs = await oracle<{ row: string }>("select to_jsonb(r)::text as row from system.outbox_runs r where outbox_id = $1 order by 1", [outboxId]);
    expect(row).toHaveLength(1);
    return JSON.stringify([row[0]?.row, runs.map((r) => r.row)]);
  };
  const authority = async (outboxId: string) =>
    (await oracle<{ status: string; run_outcome: string | null; recovery_count: number; dispatch_key: string }>(
      "select status, run_outcome, recovery_count, dispatch_key from system.outbox where id = $1",
      [outboxId],
    ))[0];

  // ── Locks ────────────────────────────────────────────────────────────────────────────────────────────────────
  const waitForWaiters = async (n: number): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (((await oracle<{ n: number }>("select count(*)::int as n from pg_locks where not granted"))[0]?.n ?? -1) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`expected ${String(n)} waiting transaction(s)`);
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target, 4);
    web = runtimeDatabase(target, "web", 4);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 2);
    logger = createLogger({ sink: () => undefined, now: clock });
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  describe("migration 0014: the event is admitted only as a user's re-evaluation request", () => {
    it("the widened vocabularies and the new CHECK are validated and match the domain", async () => {
      const rows = await oracle<{ name: string; validated: boolean; definition: string }>(
        `select conname as name, convalidated as validated, pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'connections.connected_account_events'::regclass order by 1`,
      );
      const byName = new Map(rows.map((row) => [row.name, row]));
      const values = (definition: string) => [...definition.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
      expect(byName.get("connected_account_events_event_type_check")?.validated).toBe(true);
      expect(values(byName.get("connected_account_events_event_type_check")?.definition ?? "")).toEqual(
        ["DEACTIVATED", "LINKED", "MOVED_IN", "MOVED_OUT", "REEVALUATION_REQUESTED", "UNLINKED"],
      );
      expect(byName.get("connected_account_events_reason_code_check")?.validated).toBe(true);
      expect(values(byName.get("connected_account_events_reason_code_check")?.definition ?? "")).toEqual(
        ["CONNECTION_DISCONNECTED", "CONNECTION_REMOVED", "MOVE", "USER_LINKED", "USER_REQUESTED_REEVALUATION", "USER_UNLINKED"],
      );
      expect(byName.get("connected_account_events_reevaluation_check")?.validated).toBe(true);
      // The 0007 actor and move checks are still there, unchanged in number.
      expect(rows.filter((row) => row.definition.startsWith("CHECK")).map((row) => row.name).sort()).toEqual([
        "connected_account_events_actor_type_check",
        "connected_account_events_check",
        "connected_account_events_check1",
        "connected_account_events_event_type_check",
        "connected_account_events_reason_code_check",
        "connected_account_events_reevaluation_check",
      ]);
    });

    it("no new table, policy or grant: the 0007 append-only policies and INSERT/SELECT grants are what admits the event", async () => {
      const policies = (await oracle<{ policy: string }>(
        "select policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') as policy from pg_policies where schemaname = 'connections' and tablename = 'connected_account_events' order by 1",
      )).map((row) => row.policy);
      expect(policies).toEqual(["manage_append INSERT authenticated", "member_read SELECT authenticated", "worker_append INSERT app_worker", "worker_read SELECT app_worker"]);
      const grants = (await oracle<{ grant: string }>(
        `select grantee || ' ' || privilege_type as grant from information_schema.role_table_grants
          where table_schema = 'connections' and table_name = 'connected_account_events' and grantee in ('authenticated', 'app_worker', 'app_system', 'anon') order by 1`,
      )).map((row) => row.grant);
      expect(grants).toEqual(["app_worker INSERT", "app_worker SELECT", "authenticated INSERT", "authenticated SELECT"]);
    });

    it("event actor/reason invariant: a user's exact request is admitted; every other shape is refused by RLS or CHECK", async () => {
      const t = await tenant();
      const { id: account } = await seedAccount(t);
      const insert = (as: string, shape: { readonly type?: string; readonly reason?: string; readonly actorType?: string; readonly actorUser?: string | null; readonly move?: string | null }) =>
        withUserScope(web, { sub: as, role: "authenticated" }, t.workspaceId, (tx) =>
          tx.execute(sql`insert into connections.connected_account_events
            (id, organization_id, workspace_id, connected_account_id, event_type, move_id, reason_code, actor_type, actor_user_id, occurred_at)
            values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${account}, ${shape.type ?? "REEVALUATION_REQUESTED"}, ${shape.move ?? null},
                    ${shape.reason ?? "USER_REQUESTED_REEVALUATION"}, ${shape.actorType ?? "user"}, ${shape.actorUser === undefined ? as : shape.actorUser}, now())`),
        );
      const asWorker = (shape: { readonly type: string; readonly reason: string }) =>
        withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
          tx.execute(sql`insert into connections.connected_account_events
            (id, organization_id, workspace_id, connected_account_id, event_type, move_id, reason_code, actor_type, actor_user_id, occurred_at)
            values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${account}, ${shape.type}, null, ${shape.reason}, 'system', null, now())`),
        );

      await insert(t.members.OWNER, {});
      await insert(t.members.ADMIN, {});
      expect(await countOf("select count(*)::int as n from connections.connected_account_events where connected_account_id = $1 and event_type = 'REEVALUATION_REQUESTED'", [account])).toBe(2);

      // CHECK (0014): wrong reason, a move, or the new reason on another event type.
      expect(await sqlState(insert(t.members.OWNER, { reason: "USER_LINKED" }))).toMatchObject({ code: "23514", constraint: "connected_account_events_reevaluation_check" });
      expect(await sqlState(insert(t.members.OWNER, { type: "LINKED" }))).toMatchObject({ code: "23514", constraint: "connected_account_events_reevaluation_check" });
      expect((await sqlState(insert(t.members.OWNER, { move: randomUUID() }))).code).toBe("23514");
      expect(await sqlState(insert(t.members.OWNER, { reason: "NOT_A_REASON" }))).toMatchObject({ code: "23514", constraint: "connected_account_events_reason_code_check" });
      expect(await sqlState(insert(t.members.OWNER, { type: "NOT_A_TYPE", reason: "USER_LINKED" }))).toMatchObject({ code: "23514", constraint: "connected_account_events_event_type_check" });
      // The worker (system actor) can never write it, even though worker_append admits system events.
      expect(await sqlState(asWorker({ type: "REEVALUATION_REQUESTED", reason: "USER_REQUESTED_REEVALUATION" }))).toMatchObject({ code: "23514", constraint: "connected_account_events_reevaluation_check" });
      // RLS (0007 manage_append): Manager / Responder / Analyst-Viewer, a system actor or another user's id from the web.
      for (const role of ["MANAGER", "RESPONDER", "ANALYST_VIEWER"] as const) expect((await sqlState(insert(t.members[role], {}))).code).toBe("42501");
      expect((await sqlState(insert(t.members.OWNER, { actorType: "system", actorUser: null }))).code).toBe("42501");
      expect((await sqlState(insert(t.members.OWNER, { actorUser: t.members.ADMIN }))).code).toBe("42501");
      expect(await countOf("select count(*)::int as n from connections.connected_account_events where connected_account_id = $1", [account])).toBe(2);
    });
  });

  describe("authorization: Owner/Admin only, server side and in RLS", () => {
    it("OWNER accepted; ADMIN accepted (each its own account)", async () => {
      const t = await tenant();
      const owned = await seedAccount(t);
      const administered = await seedAccount(t);
      expect(await request(t, t.members.OWNER, owned.id)).toMatchObject({ status: "ok", value: { requested: true } });
      expect(await request(t, t.members.ADMIN, administered.id)).toMatchObject({ status: "ok", value: { requested: true } });
      const events = await reevaluationEvents(t.workspaceId);
      expect(events.map((event) => event.actor_user_id).sort()).toEqual([t.members.OWNER, t.members.ADMIN].sort());
      expect(await reevalRequests(t.workspaceId)).toHaveLength(2);
      expect(await audits(t.workspaceId)).toHaveLength(2);
    });

    it.each(["MANAGER", "RESPONDER", "ANALYST_VIEWER"] as const)("%s is refused (PERMISSION_DENIED) and nothing is written", async (role) => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const result = await request(t, t.members[role], id);
      expect(result.status).toBe("error");
      expect(errorCode(result)).toBe("PERMISSION_DENIED");
      await nothingWritten(t.workspaceId);
    });

    it("RLS alone stops a Manager past the pipeline: the account can't be locked, so it is NOT_FOUND and nothing is written", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const attempt = withUserScope(web, { sub: t.members.MANAGER, role: "authenticated" }, t.workspaceId, (tx) =>
        requestCapabilityReevaluation(
          { connections: createPostgresConnectionStore(tx), capability: createPostgresCapabilityStore(tx), outbox: { append: () => Promise.reject(new Error("unreachable")) } },
          { scope: { workspaceId: t.workspaceId as never, organizationId: t.organizationId as never, userId: user(t.members.MANAGER) }, connectedAccountId: id, correlationId: "corr-h55-p2-rls", now: clock(), newId: randomUUID },
        ),
      );
      await expect(attempt).rejects.toMatchObject({ code: "NOT_FOUND" });
      await nothingWritten(t.workspaceId);
    });
  });

  describe("workspace isolation", () => {
    it("another workspace's account (other organization, or a sibling workspace the user also owns) is NOT_FOUND; nothing is written anywhere", async () => {
      const a = await tenant();
      const b = await tenant();
      const sibling = await tenant(a.organizationId);
      const accountB = await seedAccount(b);
      const accountA = await seedAccount(a);
      // Routed to A with B's account.
      expect(errorCode(await request(a, a.members.OWNER, accountB.id))).toBe("NOT_FOUND");
      // Routed to B (no membership there) with B's account.
      expect(errorCode(await request(a, a.members.OWNER, accountB.id, { workspaceId: b.workspaceId }))).toBe("NOT_FOUND");
      // The same person owns the sibling workspace too: routing there with A's account is still NOT_FOUND.
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [a.organizationId, sibling.workspaceId, a.members.ADMIN]);
      expect(errorCode(await request(sibling, a.members.ADMIN, accountA.id))).toBe("NOT_FOUND");
      for (const workspace of [a.workspaceId, b.workspaceId, sibling.workspaceId]) await nothingWritten(workspace);
    });

    it("the input is exactly the routed account id: an extra field (e.g. a client idempotency key) is INVALID_INPUT", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const result = await pipelineFor(t.members.OWNER).run(command, { workspaceId: t.workspaceId, input: { connectedAccountId: id, idempotencyKey: randomUUID() } });
      expect(errorCode(result)).toBe("INVALID_INPUT");
      expect(errorCode(await request(t, t.members.OWNER, "not-a-uuid"))).toBe("INVALID_INPUT");
      await nothingWritten(t.workspaceId);
    });
  });

  describe("eligibility on stored profiles and lifecycle (typed refusals write nothing)", () => {
    it("no profile, stale (older revision), current with facts unavailable → accepted; works in a Monitor-only workspace", async () => {
      const t = await tenant();
      expect((await oracle<{ mode: string }>("select mode from tenancy.workspaces where id = $1", [t.workspaceId]))[0]?.mode).toBe("MONITOR_ONLY");
      const none = await seedAccount(t);
      const stale = await seedAccount(t);
      await writeProfile(t, stale.id, { ...PLATFORM_CATALOG, revision: PLATFORM_CATALOG.revision - 1, label: "platform-catalog-older" }, AVAILABLE());
      const unusable = await seedAccount(t, { provider: "tiktok" });
      await writeProfile(t, unusable.id, PLATFORM_CATALOG, UNAVAILABLE());
      for (const account of [none, stale, unusable]) expect(await request(t, t.members.OWNER, account.id)).toMatchObject({ status: "ok", value: { requested: true } });
      expect(await reevalRequests(t.workspaceId)).toHaveLength(3);
    });

    it("usable current profile → PROFILE_CURRENT; newer than this code → PROFILE_NEWER_THAN_CODE", async () => {
      const t = await tenant();
      const current = await seedAccount(t);
      await writeProfile(t, current.id, PLATFORM_CATALOG, AVAILABLE());
      const newer = await seedAccount(t);
      await writeProfile(t, newer.id, { ...PLATFORM_CATALOG, revision: PLATFORM_CATALOG.revision + 1, label: "platform-catalog-future" }, UNAVAILABLE());
      expect(await request(t, t.members.OWNER, current.id)).toMatchObject({ status: "ok", value: { requested: false, reason: "PROFILE_CURRENT" } });
      expect(await request(t, t.members.OWNER, newer.id)).toMatchObject({ status: "ok", value: { requested: false, reason: "PROFILE_NEWER_THAN_CODE" } });
      await nothingWritten(t.workspaceId);
    });

    it("Step 7G-H5.5-P4-C: a current profile with a NOT_AUTHORIZED row (real evaluator, stored) is offered and accepted; all-supported is not", async () => {
      // A hypothetical CURRENT platform catalog (same id and revision as the code's) with one permissioned entry.
      const permissioned: CapabilityCatalog = {
        ...PLATFORM_CATALOG,
        label: "platform-catalog-hypothetical",
        entries: [{ platform: "facebook", assetClass: "content_bearing", capability: "read_content", contentKind: ANY, source: ANY, state: "SUPPORTED", limitation: null,
          requiredPermissions: ["synthetic_read_content"], validation: "validated", evidence: "api-validation:meta.facebook.read_content.20261101-01" }],
      };
      const t = await tenant();
      const missing = await seedAccount(t);
      await writeProfile(t, missing.id, permissioned, AVAILABLE()); // lacks synthetic_read_content → NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING
      const stored = await oracle<{ state: string; reason_codes: string[] }>("select state, reason_codes from capability.profile_entries where connected_account_id = $1 and capability = 'read_content'", [missing.id]);
      expect(stored).toEqual([{ state: "NOT_AUTHORIZED", reason_codes: ["ACCOUNT_PERMISSION_MISSING"] }]);
      const granted = await seedAccount(t);
      await writeProfile(t, granted.id, permissioned, { ...AVAILABLE(), grantedPermissions: ["synthetic_read_content"] } as FactsInput);
      const offer = async (account: string) => {
        const state = await resolveConnectionSettings(pipelineFor(t.members.OWNER), t.workspaceId);
        return state.kind === "ready" ? state.manageableAssets.find((asset) => asset.connectedAccountId === account)?.capabilityReevaluation : state.kind;
      };
      expect(await offer(missing.id)).toEqual({ allowed: true, reason: "ACCOUNT_PERMISSION_MISSING" });
      expect(await offer(granted.id)).toEqual({ allowed: false, reason: "PROFILE_CURRENT" });
      expect(await request(t, t.members.OWNER, granted.id)).toMatchObject({ status: "ok", value: { requested: false, reason: "PROFILE_CURRENT" } });
      expect(await request(t, t.members.ADMIN, missing.id)).toMatchObject({ status: "ok", value: { requested: true } });
      expect(await reevalRequests(t.workspaceId)).toHaveLength(1);
      // The accepted request restarted the cooldown: a second one is refused, nothing more is written.
      expect(await request(t, t.members.OWNER, missing.id)).toMatchObject({ status: "ok", value: { requested: false, reason: "REEVALUATION_TOO_SOON" } });
      expect(await reevalRequests(t.workspaceId)).toHaveLength(1);
    });

    it("INACTIVE account → ACCOUNT_INACTIVE; a non-ACTIVE connection → CONNECTION_NOT_ACTIVE", async () => {
      const t = await tenant();
      const inactive = await seedAccount(t, { status: "INACTIVE" });
      expect(await request(t, t.members.OWNER, inactive.id)).toMatchObject({ status: "ok", value: { requested: false, reason: "ACCOUNT_INACTIVE" } });
      for (const status of ["DEGRADED", "FAILED", "DISCONNECTED", "CONNECTING"]) {
        const account = await seedAccount(t, { connectionStatus: status });
        expect(await request(t, t.members.OWNER, account.id)).toMatchObject({ status: "ok", value: { requested: false, reason: "CONNECTION_NOT_ACTIVE" } });
      }
      await nothingWritten(t.workspaceId);
    });
  });

  describe("one transaction: event + request + audit, or nothing", () => {
    it("an accepted request writes exactly one event, one request keyed by it and one audit record, all in the SAME transaction", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const before = await outboxCount(t.workspaceId);
      const result = await request(t, t.members.ADMIN, id);
      expect(result).toEqual({ status: "ok", value: { requested: true }, correlationId: expect.any(String) as unknown });
      const [event] = await reevaluationEvents(t.workspaceId);
      const [row] = await reevalRequests(t.workspaceId);
      const [audit] = await audits(t.workspaceId);
      if (event === undefined || row === undefined || audit === undefined) throw new Error("missing rows");
      expect(await outboxCount(t.workspaceId)).toBe(before + 1);
      expect(event).toMatchObject({ event_type: "REEVALUATION_REQUESTED", reason_code: "USER_REQUESTED_REEVALUATION", actor_type: "user", actor_user_id: t.members.ADMIN, move_id: null });
      expect(row).toMatchObject({
        dispatch_key: `${EVALUATE}:${id}:reeval.${event.id}`,
        status: "PENDING",
        subject_ids: { connected_account_id: id },
        initiator_type: "user",
        initiator_user_id: t.members.ADMIN,
      });
      expect(audit).toMatchObject({ actor_type: "user", actor_user_id: t.members.ADMIN, target_type: "connected_account", target_id: id, change: null });
      // Same transaction (same xmin), same correlation, same server instant.
      expect(new Set([event.tx, row.tx, audit.tx]).size).toBe(1);
      expect(audit.correlation_id).toBe(row.correlation_id);
      expect(result.correlationId).toBe(row.correlation_id);
      expect(new Set([event.occurred_at.getTime(), row.created_at.getTime(), audit.occurred_at.getTime()])).toEqual(new Set([clock().getTime()]));
    });

    it("a failure after the event and the request (the audit step) rolls everything back", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const base = createPostgresUnitOfWork(web);
      const auditDown: UnitOfWork = { run: (scope, work) => base.run(scope, (tx) => work({ ...tx, audit: { append: () => Promise.reject(new Error("synthetic audit outage")) } })) };
      await expect(request(t, t.members.OWNER, id, { pipeline: pipelineFor(t.members.OWNER, auditDown) })).rejects.toThrow("synthetic audit outage");
      await nothingWritten(t.workspaceId);
      expect(await outboxCount(t.workspaceId)).toBe(0);
    });

    it("a failure appending the request rolls the event back (and no audit is written)", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const base = createPostgresUnitOfWork(web);
      const outboxDown: UnitOfWork = {
        run: (scope, work) => base.run(scope, (tx) => work({ ...tx, outbox: { append: () => Promise.reject(new Error("synthetic outbox outage")), routed: () => undefined } })),
      };
      await expect(request(t, t.members.OWNER, id, { pipeline: pipelineFor(t.members.OWNER, outboxDown) })).rejects.toThrow("synthetic outbox outage");
      await nothingWritten(t.workspaceId);
      // Afterwards the account is still eligible: nothing of the failed attempt counts toward the cooldown.
      expect(await request(t, t.members.OWNER, id)).toMatchObject({ status: "ok", value: { requested: true } });
    });
  });

  describe("cooldown (30 minutes, server clock) and concurrency", () => {
    it("after an activation: 29:59 refused, 30:00 accepted; the accepted request restarts it; each accepted one is a NEW authority", async () => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE");
      const asset = await seedAsset(t, connection);
      const linked = await pipelineFor(t.members.OWNER).run(link, { workspaceId: t.workspaceId, input: { discoveredAssetId: asset } });
      if (linked.status !== "ok" || linked.value.kind !== "linked") throw new Error("link failed");
      const account = linked.value.connectedAccountId;
      const activation = (await requests(t.workspaceId))[0];

      advance(29 * MIN + 59_000);
      expect(await request(t, t.members.OWNER, account)).toMatchObject({ status: "ok", value: { requested: false, reason: "REEVALUATION_TOO_SOON" } });
      await nothingWritten(t.workspaceId);
      advance(1_000); // exactly 30:00 after the LINKED event
      expect(await request(t, t.members.OWNER, account)).toMatchObject({ status: "ok", value: { requested: true } });
      advance(COOLDOWN - 1);
      expect(await request(t, t.members.ADMIN, account)).toMatchObject({ status: "ok", value: { requested: false, reason: "REEVALUATION_TOO_SOON" } });
      advance(1);
      expect(await request(t, t.members.ADMIN, account)).toMatchObject({ status: "ok", value: { requested: true } });

      const events = await reevaluationEvents(t.workspaceId);
      const reeval = await reevalRequests(t.workspaceId);
      expect(events).toHaveLength(2);
      expect(reeval.map((row) => row.dispatch_key)).toEqual(events.map((event) => `${EVALUATE}:${account}:reeval.${event.id}`));
      expect(new Set(reeval.map((row) => row.dispatch_key)).size).toBe(2);
      expect(await audits(t.workspaceId)).toHaveLength(2);
      // The activation's own authority is still exactly as it was written.
      expect((await requests(t.workspaceId)).filter((row) => !row.dispatch_key.includes(":reeval."))).toEqual([activation]);
    });

    it("an HTTP retry inside the cooldown is REEVALUATION_TOO_SOON: no second event id or request", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      expect(await request(t, t.members.OWNER, id)).toMatchObject({ status: "ok", value: { requested: true } });
      for (let i = 0; i < 3; i += 1) expect(await request(t, t.members.OWNER, id)).toMatchObject({ status: "ok", value: { requested: false, reason: "REEVALUATION_TOO_SOON" } });
      expect(await reevaluationEvents(t.workspaceId)).toHaveLength(1);
      expect(await reevalRequests(t.workspaceId)).toHaveLength(1);
      expect(await audits(t.workspaceId)).toHaveLength(1);
    });

    it("two concurrent requests serialize on the row lock: exactly 1 accepted + 1 REEVALUATION_TOO_SOON, exactly 1 new request", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // A third transaction holds the account's row lock until BOTH requests are waiting on it.
      const holder = withUserScope(web, { sub: t.members.OWNER, role: "authenticated" }, t.workspaceId, async (tx) => {
        expect((await createPostgresConnectionStore(tx).connectedAccounts.lock(id))?.id).toBe(id);
        locked();
        await gate;
      });
      await isLocked;
      const racing = Promise.all([request(t, t.members.OWNER, id), request(t, t.members.ADMIN, id)]);
      racing.catch(() => undefined);
      await waitForWaiters(2);
      release();
      await holder;
      const results = await racing;
      const values = results.map((result) => (result.status === "ok" ? result.value : result.status));
      expect(values).toEqual(expect.arrayContaining([{ requested: true }, { requested: false, reason: "REEVALUATION_TOO_SOON" }]));
      expect(values).toHaveLength(2);
      expect(await reevaluationEvents(t.workspaceId)).toHaveLength(1);
      expect(await reevalRequests(t.workspaceId)).toHaveLength(1);
      expect(await outboxCount(t.workspaceId)).toBe(1);
      expect(await audits(t.workspaceId)).toHaveLength(1);
    });

    it("concurrent bursts converge too: N simultaneous requests → exactly one authority", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const results = await Promise.all([t.members.OWNER, t.members.ADMIN, t.members.OWNER, t.members.ADMIN].map((as) => request(t, as, id)));
      expect(results.filter((result) => result.status === "ok" && result.value.requested).length).toBe(1);
      expect(results.filter((result) => result.status === "ok" && !result.value.requested && result.value.reason === "REEVALUATION_TOO_SOON").length).toBe(3);
      expect(await reevalRequests(t.workspaceId)).toHaveLength(1);
    });
  });

  describe("Step 7G-H5.5-P2-B2: the Connections read model's re-check offer and the surface's outcome mapping", () => {
    /** The offer the real settings view gives one account (connections.settings.view through the pipeline). */
    const offerFor = async (t: Tenant, as: string, account: string) => {
      const state = await resolveConnectionSettings(pipelineFor(as), t.workspaceId);
      if (state.kind !== "ready") return state.kind;
      return state.manageableAssets.find((asset) => asset.connectedAccountId === account)?.capabilityReevaluation;
    };

    it("eligible states are offered with availability's reasons; current / newer / unmanaged are not; reading writes nothing", async () => {
      const t = await tenant();
      const none = await seedAccount(t);
      const stale = await seedAccount(t);
      await writeProfile(t, stale.id, { ...PLATFORM_CATALOG, revision: PLATFORM_CATALOG.revision - 1, label: "platform-catalog-older" }, AVAILABLE());
      const unusable = await seedAccount(t);
      await writeProfile(t, unusable.id, PLATFORM_CATALOG, UNAVAILABLE());
      const current = await seedAccount(t);
      await writeProfile(t, current.id, PLATFORM_CATALOG, AVAILABLE());
      const newer = await seedAccount(t);
      await writeProfile(t, newer.id, { ...PLATFORM_CATALOG, revision: PLATFORM_CATALOG.revision + 1, label: "platform-catalog-future" }, UNAVAILABLE());
      const inactive = await seedAccount(t, { status: "INACTIVE" });

      expect(await offerFor(t, t.members.OWNER, none.id)).toEqual({ allowed: true, reason: "PROFILE_NOT_EVALUATED" });
      expect(await offerFor(t, t.members.ADMIN, stale.id)).toEqual({ allowed: true, reason: "PROFILE_STALE" });
      expect(await offerFor(t, t.members.OWNER, unusable.id)).toEqual({ allowed: true, reason: "ACCOUNT_FACTS_UNAVAILABLE" });
      expect(await offerFor(t, t.members.OWNER, current.id)).toEqual({ allowed: false, reason: "PROFILE_CURRENT" });
      expect(await offerFor(t, t.members.OWNER, newer.id)).toEqual({ allowed: false, reason: "PROFILE_NEWER_THAN_CODE" });
      // An INACTIVE account is not managed: the asset carries no account and no offer.
      expect(await offerFor(t, t.members.OWNER, inactive.id)).toBeUndefined();
      await nothingWritten(t.workspaceId);
    });

    it("an actor without connections.manage gets no read model at all (no offer, no action)", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      for (const role of ["MANAGER", "RESPONDER", "ANALYST_VIEWER"] as const) expect(await offerFor(t, t.members[role], id)).toBe("not_allowed");
    });

    it("a non-ACTIVE connection lists no managed accounts, so it offers nothing", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t, { connectionStatus: "DEGRADED" });
      expect(await offerFor(t, t.members.OWNER, id)).toBeUndefined();
    });

    it("request → capability_recheck_requested; the view then shows REEVALUATION_TOO_SOON; a stale tab's second click → capability_recheck_too_soon (one authority)", async () => {
      const t = await tenant();
      const { id } = await seedAccount(t);
      const surface = (as: string, connectedAccountId: unknown) => requestCapabilityRecheck(pipelineFor(as), { workspaceId: t.workspaceId, connectedAccountId });
      expect(await surface(t.members.OWNER, id)).toEqual({ kind: "status", status: "capability_recheck_requested" });
      expect(await offerFor(t, t.members.OWNER, id)).toEqual({ allowed: false, reason: "REEVALUATION_TOO_SOON" });
      expect(await surface(t.members.ADMIN, id)).toEqual({ kind: "status", status: "capability_recheck_too_soon" });
      expect(await reevalRequests(t.workspaceId)).toHaveLength(1);
      advance(COOLDOWN);
      expect(await offerFor(t, t.members.OWNER, id)).toEqual({ allowed: true, reason: "PROFILE_NOT_EVALUATED" });
    });

    it("typed refusals, permission, isolation and malformed ids map to closed statuses; nothing is written", async () => {
      const t = await tenant();
      const other = await tenant();
      const current = await seedAccount(t);
      await writeProfile(t, current.id, PLATFORM_CATALOG, AVAILABLE());
      const newer = await seedAccount(t);
      await writeProfile(t, newer.id, { ...PLATFORM_CATALOG, revision: PLATFORM_CATALOG.revision + 1, label: "platform-catalog-future" }, AVAILABLE());
      const inactive = await seedAccount(t, { status: "INACTIVE" });
      const degraded = await seedAccount(t, { connectionStatus: "DEGRADED" });
      const foreign = await seedAccount(other);
      const surface = (as: string, connectedAccountId: unknown) => requestCapabilityRecheck(pipelineFor(as), { workspaceId: t.workspaceId, connectedAccountId });
      expect(await surface(t.members.OWNER, current.id)).toEqual({ kind: "status", status: "capability_recheck_not_needed" });
      expect(await surface(t.members.OWNER, newer.id)).toEqual({ kind: "status", status: "capability_recheck_newer_version" });
      expect(await surface(t.members.OWNER, inactive.id)).toEqual({ kind: "status", status: "capability_recheck_account_inactive" });
      expect(await surface(t.members.OWNER, degraded.id)).toEqual({ kind: "status", status: "capability_recheck_connection_not_active" });
      expect(await surface(t.members.OWNER, foreign.id)).toEqual({ kind: "status", status: "capability_recheck_not_found" });
      expect(await surface(t.members.OWNER, "not-a-uuid")).toEqual({ kind: "status", status: "capability_recheck_not_found" });
      expect(await surface(t.members.MANAGER, current.id)).toEqual({ kind: "status", status: "not_allowed" });
      await nothingWritten(t.workspaceId);
      await nothingWritten(other.workspaceId);
    });
  });

  describe("failure recovery: earlier authorities stay untouched; recovery is a new authority (real relay + R7 sweeper)", () => {
    type Describe = () => Promise<never>;
    /** The provider behaves per scenario; every call is counted. No credential is ever opened (fake access). */
    let describeAccount: Describe = () => Promise.reject(new TransientError("describeAccount", "network"));
    let persistence: "ok" | "fail" = "ok";
    const providerCalls: string[] = [];
    const access: ProviderCredentialAccess = { withCredential: (_input, use) => use({ kind: "synthetic" } as unknown as ProviderCredential) };
    const providers: DiscoveryProviders = {
      read: () =>
        ({
          describeAccount: () => {
            providerCalls.push("describeAccount");
            return describeAccount();
          },
        }) as unknown as ProviderReadPort,
    };
    /** The REAL capability.evaluate_account handler through the production step wrapper; persistence may be failed on its 2nd step. */
    const handler: FakeHandler = (payload, run) =>
      runTenantStepJob({ registry: PRODUCTION_TASKS, worker, logger }, EVALUATE, payload, run, (context: TenantStepJobContext) => {
        let steps = 0;
        const wrapped: TenantStepJobContext = {
          ...context,
          inScope: (work) => ((steps += 1) === 2 && persistence === "fail" ? Promise.reject(new Error("synthetic profile write failure")) : context.inScope(work)),
        };
        return runEvaluateAccountCapabilities(wrapped, { access, providers });
      });
    let runtime: FakeJobRuntime;
    const deliveryDeps = (): DeliveryDependencies => ({ system, runtimes: { main: runtime, integration: runtime }, registry: PRODUCTION_TASKS, logger, clock, config: CONFIG });
    /** Relay → execute → sweep, until the row has an outcome (bounded). */
    const deliver = async (outboxId: string): Promise<void> => {
      for (let pass = 0; pass < 6; pass += 1) {
        await relayPass(deliveryDeps());
        await runtime.drain();
        await sweepRunOutcomes(deliveryDeps());
        if ((await authority(outboxId))?.run_outcome !== null) return;
        advance(1_000);
      }
      throw new Error("no outcome");
    };
    const runOf = (dispatchKey: string): string => {
      const run = [...runtime.runs.values()].find((candidate) => candidate.request.dispatchKey === dispatchKey);
      if (run === undefined) throw new Error("no run");
      return run.id;
    };
    /** An account activated through the real link command (its activation authority = the old one). */
    const activated = async (options: { readonly credential: boolean }) => {
      const t = await tenant();
      const connection = await seedConnection(t, "ACTIVE", { credential: options.credential });
      const asset = await seedAsset(t, connection);
      const linked = await pipelineFor(t.members.OWNER).run(link, { workspaceId: t.workspaceId, input: { discoveredAssetId: asset } });
      if (linked.status !== "ok" || linked.value.kind !== "linked") throw new Error("link failed");
      const [old] = await requests(t.workspaceId);
      if (old === undefined) throw new Error("no activation request");
      return { t, account: linked.value.connectedAccountId, old };
    };
    /** After the old authority's outcome: refused inside the cooldown, a NEW authority after it; the old one is unchanged. */
    const recoverAfterCooldown = async (t: Tenant, account: string, old: RequestRow, expectedBasisProfile: "none" | "unavailable") => {
      const frozen = await snapshot(old.id);
      expect(await request(t, t.members.OWNER, account)).toMatchObject({ status: "ok", value: { requested: false, reason: "REEVALUATION_TOO_SOON" } });
      advance(COOLDOWN);
      const header = await oracle<{ facts_available: boolean }>("select facts_available from capability.account_profiles where connected_account_id = $1", [account]);
      expect(header.map((row) => row.facts_available)).toEqual(expectedBasisProfile === "none" ? [] : [false]);
      expect(await request(t, t.members.OWNER, account)).toMatchObject({ status: "ok", value: { requested: true } });
      const [event] = await reevaluationEvents(t.workspaceId);
      const fresh = (await reevalRequests(t.workspaceId))[0];
      if (event === undefined || fresh === undefined) throw new Error("no recovery authority");
      expect(fresh.dispatch_key).toBe(`${EVALUATE}:${account}:reeval.${event.id}`);
      expect(fresh.dispatch_key).not.toBe(old.dispatch_key);
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.status).toBe("PENDING");
      expect(await snapshot(old.id)).toBe(frozen);
      // The NEW authority goes through the same, unchanged capability.evaluate_account path; the old one still doesn't move.
      describeAccount = () => Promise.reject(new PermanentRejectedError("describeAccount", "unknown"));
      persistence = "ok";
      await deliver(fresh.id);
      expect(await authority(fresh.id)).toMatchObject({ run_outcome: "COMPLETED", dispatch_key: fresh.dispatch_key });
      expect(await snapshot(old.id)).toBe(frozen);
      return fresh;
    };

    beforeAll(() => {
      runtime = new FakeJobRuntime(new Map([[EVALUATE, handler]]), (task) => PRODUCTION_TASKS.get(task)?.retry ?? { maxAttempts: 1, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false });
    });

    it("previous FAILED authority (the evaluation kept failing) remains untouched", async () => {
      const { t, account, old } = await activated({ credential: true });
      describeAccount = () => Promise.reject(new TransientError("describeAccount", "network"));
      persistence = "ok";
      await deliver(old.id);
      expect(await authority(old.id)).toMatchObject({ status: "DISPATCHED", run_outcome: "FAILED", dispatch_key: old.dispatch_key });
      await recoverAfterCooldown(t, account, old, "none");
    });

    it("previous CANCELED authority remains untouched", async () => {
      const { t, account, old } = await activated({ credential: true });
      await relayPass(deliveryDeps());
      runtime.cancel(runOf(old.dispatch_key));
      await sweepRunOutcomes(deliveryDeps());
      expect(await authority(old.id)).toMatchObject({ run_outcome: "CANCELED" });
      await recoverAfterCooldown(t, account, old, "none");
    });

    it("previous RECOVERY_EXHAUSTED authority (repeated crashes) remains untouched", async () => {
      const { t, account, old } = await activated({ credential: true });
      runtime.fault = (run) => (run.request.dispatchKey === old.dispatch_key ? "crash_before" : undefined);
      try {
        await deliver(old.id);
      } finally {
        runtime.fault = () => undefined;
      }
      expect(await authority(old.id)).toMatchObject({ run_outcome: "RECOVERY_EXHAUSTED", recovery_count: CONFIG.maxRecoveries });
      await recoverAfterCooldown(t, account, old, "none");
    });

    it("a skipped evaluation (no credential) can receive a new recovery authority after the cooldown", async () => {
      const { t, account, old } = await activated({ credential: false });
      const calls = providerCalls.length;
      await deliver(old.id);
      expect(providerCalls.length).toBe(calls); // skipped before any provider call
      expect(await authority(old.id)).toMatchObject({ run_outcome: "COMPLETED" });
      await recoverAfterCooldown(t, account, old, "none");
    });

    it("an unreadable (malformed) provider answer → facts unavailable → the current profile is recovery-eligible", async () => {
      const { t, account, old } = await activated({ credential: true });
      describeAccount = () => Promise.reject(new PermanentRejectedError("describeAccount", "unknown"));
      persistence = "ok";
      await deliver(old.id);
      expect(await authority(old.id)).toMatchObject({ run_outcome: "COMPLETED" });
      await recoverAfterCooldown(t, account, old, "unavailable");
    });

    it("a persistence failure of the old evaluation (profile never written) → the recovery authority is new", async () => {
      const { t, account, old } = await activated({ credential: true });
      describeAccount = () => Promise.reject(new PermanentRejectedError("describeAccount", "unknown"));
      persistence = "fail";
      await deliver(old.id);
      persistence = "ok";
      expect(await authority(old.id)).toMatchObject({ run_outcome: "FAILED" });
      await recoverAfterCooldown(t, account, old, "none");
    });

    it("a crash recovered by R7 reuses its OWN authority (same row, same key) and creates no recovery event or request", async () => {
      const { t, old } = await activated({ credential: true });
      describeAccount = () => Promise.reject(new PermanentRejectedError("describeAccount", "unknown"));
      persistence = "ok";
      let crashed = false;
      runtime.fault = (run) => {
        if (run.request.dispatchKey !== old.dispatch_key || crashed) return undefined;
        crashed = true;
        return "crash_before";
      };
      try {
        await deliver(old.id);
      } finally {
        runtime.fault = () => undefined;
      }
      expect(crashed).toBe(true);
      expect(await authority(old.id)).toMatchObject({ run_outcome: "COMPLETED", recovery_count: 1, dispatch_key: old.dispatch_key });
      expect((await requests(t.workspaceId)).map((row) => row.id)).toEqual([old.id]);
      await nothingWritten(t.workspaceId);
      // Waiting out the cooldown creates nothing by itself either: recovery is only ever an explicit request.
      advance(COOLDOWN);
      await relayPass(deliveryDeps());
      await sweepRunOutcomes(deliveryDeps());
      expect(await outboxCount(t.workspaceId)).toBe(1);
      await nothingWritten(t.workspaceId);
    });
  });
}
