/**
 * Step H6-E1 — migration 0021 on the real database, through the runtime roles: members (web login → authenticated,
 * verified claims, one bound workspace) and the job runtime (worker login → app_worker). `no_direct_internal_topics`
 * is ONE restrictive policy naming the complete inventory of internal topics (definer- and job-runtime-only), so a
 * member's direct SQL append can never be the authority of `ingestion.confirm_interaction` — or of any other tenant task
 * the web does not append itself — while every legitimate member append and the trusted internal producer keep working.
 * Synthetic tenants only; no job handler runs beyond a recording fake; no provider is called.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RESTRICTIVE_POLICIES, TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { createPostgresReconciliationStore } from "@/modules/ingestion/persistence";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { relayPass, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger } from "@/platform/observability";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

/** The topics the action pipeline appends AS the member (0004 `append_own`): derived from the web producers, pinned by guard. */
export const MEMBER_TOPICS = ["connections.discover_assets", "capability.evaluate_account"] as const;
/** Every other tenant task of the registry: produced only by a reviewed definer (0010, 0019) or the job runtime. */
export const INTERNAL_TOPICS = [
  "connections.move.release_source",
  "connections.move.activate_destination",
  "connections.move.reject_destination",
  "ingestion.reconcile_account",
  "ingestion.reconcile_slice",
  "ingestion.confirm_interaction",
  "interactions.observed",
] as const;
export const INTERNAL_TOPICS_POLICY = "no_direct_internal_topics";
const CONFIRM = "ingestion.confirm_interaction";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

interface World {
  readonly orgA: string;
  readonly A1: string;
  readonly A2: string;
  readonly orgB: string;
  readonly B1: string;
  /** OWNER of A1 and A2. */
  readonly ownerA: string;
  /** OWNER of B1. */
  readonly ownerB: string;
}

interface Row {
  readonly topic: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly subjects: Readonly<Record<string, string>>;
  readonly initiator: { readonly type: "user"; readonly userId: string } | { readonly type: "system" };
}

/** A well-formed IDs-only subject map in the registry's declared shape for `topic` (random UUIDs). */
function subjectsFor(topic: string): Record<string, string> {
  const task = PRODUCTION_TASKS.tenant(topic);
  const names = task?.subjects ?? ["item_id"];
  return Object.fromEntries(names.map((name) => [name, randomUUID()]));
}

export function defineOutboxMemberTopicsSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let world: World;
  const organizations: string[] = [];

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const rows = (workspaceId: string) =>
    oracle<{ id: string; topic: string; initiator_type: string; initiator_user_id: string | null; subject_ids: Record<string, string>; status: string; execution_plane: string | null; dispatch_key: string }>(
      "select id, topic, initiator_type, initiator_user_id, subject_ids, status, execution_plane, dispatch_key from system.outbox where workspace_id = $1 order by created_at, id", [workspaceId]);
  const clear = (workspaceId: string) => privileged.query("delete from system.outbox where workspace_id = $1", [workspaceId]);

  const asMember = <T>(user: string, workspaceId: string, work: (tx: DatabaseTransaction) => Promise<T>) => withUserScope(web, { sub: user, role: "authenticated" }, workspaceId, work);
  const asWorker = <T>(workspaceId: string, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, workspaceId, work);
  /** The raw statement a caller with INSERT on system.outbox can issue: exactly what the policies see. */
  const insert = (tx: DatabaseTransaction, row: Row) =>
    tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
      values (${randomUUID()}, ${row.topic}, ${row.organizationId}, ${row.workspaceId}, ${JSON.stringify(row.subjects)}::jsonb, ${`h6e1-${randomUUID()}`},
              ${row.initiator.type}, ${row.initiator.type === "user" ? row.initiator.userId : null}, ${`h6e1:${randomUUID()}`}, 'PENDING', now())`);
  const memberRow = (topic: string, user = world.ownerA, workspaceId = world.A1, organizationId = world.orgA): Row =>
    ({ topic, organizationId, workspaceId, subjects: subjectsFor(topic), initiator: { type: "user", userId: user } });
  const refused = async (promise: Promise<unknown>, label: string): Promise<void> => {
    expect(await sqlState(promise), label).toMatchObject({ code: "42501" });
  };

  const seed = async (): Promise<World> => {
    const w: World = { orgA: randomUUID(), A1: randomUUID(), A2: randomUUID(), orgB: randomUUID(), B1: randomUUID(), ownerA: randomUUID(), ownerB: randomUUID() };
    organizations.push(w.orgA, w.orgB);
    for (const [org, name] of [[w.orgA, "H6-E1 A"], [w.orgB, "H6-E1 B"]] as const) {
      await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, $2, now())", [org, name]);
    }
    for (const [org, workspace, owner] of [[w.orgA, w.A1, w.ownerA], [w.orgA, w.A2, w.ownerA], [w.orgB, w.B1, w.ownerB]] as const) {
      await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [workspace, org]);
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now()) on conflict do nothing", [org, owner]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [org, workspace, owner]);
    }
    return w;
  };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 2);
    world = await seed();
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });
  // Every case starts from empty outboxes: a refused statement in one case never leaks rows into the next.
  beforeEach(async () => {
    for (const workspace of [world.A1, world.A2, world.B1]) await clear(workspace);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the policy", () => {
    it("exists exactly as 0021 states it: RESTRICTIVE, INSERT, authenticated only, naming exactly the internal inventory", async () => {
      const [policy] = await oracle<{ permissive: boolean; command: string; roles: string[]; with_check: string }>(
        `select p.polpermissive as permissive, p.polcmd as command,
                array(select pg_get_userbyid(r)::text from unnest(p.polroles) r order by 1) as roles,
                pg_get_expr(p.polwithcheck, p.polrelid) as with_check
           from pg_policy p where p.polname = $1 and p.polrelid = 'system.outbox'::regclass`, [INTERNAL_TOPICS_POLICY]);
      expect(policy).toMatchObject({ permissive: false, command: "a", roles: ["authenticated"] });
      const named = [...(policy?.with_check ?? "").matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'::text/g)].map((m) => m[1]).sort();
      expect(named).toEqual([...INTERNAL_TOPICS].sort());
    });

    it("the inventory is closed over the registry: every tenant task that is not a member topic, and nothing else", () => {
      const tenantTasks = PRODUCTION_TASKS.tasks.filter((task) => task.scope === "workspace").map((task) => task.name);
      const internal = tenantTasks.filter((name) => !(MEMBER_TOPICS as readonly string[]).includes(name));
      expect(internal.sort()).toEqual([...INTERNAL_TOPICS].sort());
      expect(INTERNAL_TOPICS).toContain(CONFIRM);
      for (const topic of MEMBER_TOPICS) expect(PRODUCTION_TASKS.tenant(topic), topic).toBeDefined();
    });

    it("the schema manifest pins it, and the earlier restrictive policies (0010, 0019) still exist unchanged beside it", async () => {
      expect(TABLE_CLASSIFICATION["system.outbox"]?.policies).toContain(`${INTERNAL_TOPICS_POLICY} INSERT authenticated`);
      expect(RESTRICTIVE_POLICIES).toContain(`system.outbox ${INTERNAL_TOPICS_POLICY}`);
      const restrictive = await oracle<{ name: string; roles: string[]; with_check: string }>(
        `select p.polname as name, array(select pg_get_userbyid(r)::text from unnest(p.polroles) r order by 1) as roles, pg_get_expr(p.polwithcheck, p.polrelid) as with_check
           from pg_policy p where p.polrelid = 'system.outbox'::regclass and not p.polpermissive and p.polcmd = 'a' order by 1`);
      expect(restrictive.map((p) => [p.name, p.roles])).toEqual([
        ["no_direct_internal_topics", ["authenticated"]],
        ["no_direct_move_routing", ["app_worker", "authenticated"]],
        ["no_direct_reconciliation_routing", ["authenticated"]],
        // 0022 (H6-F2): the reserved webhook-signal topic, for members and workers.
        ["no_direct_signal_routing", ["app_worker", "authenticated"]],
      ]);
      // Union closure on the live catalog: every internal topic is removed from the member by at least one policy.
      const union = new Set(restrictive.flatMap((p) => [...p.with_check.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'::text/g)].map((m) => m[1])));
      for (const topic of INTERNAL_TOPICS) expect(union.has(topic), topic).toBe(true);
      for (const topic of MEMBER_TOPICS) expect(union.has(topic), topic).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("authenticated member", () => {
    it("1. still appends every legitimate member topic into the bound workspace, as themselves (append_own unchanged)", async () => {
      for (const topic of MEMBER_TOPICS) await asMember(world.ownerA, world.A1, (tx) => insert(tx, memberRow(topic)));
      const written = await rows(world.A1);
      expect(written.map((row) => [row.topic, row.initiator_type, row.initiator_user_id, row.status, row.execution_plane])).toEqual(
        MEMBER_TOPICS.map((topic) => [topic, "user", world.ownerA, "PENDING", null]));
      // TL decision (H6-E1): an inventory of internal topics, not an allowlist — a topic outside the registry is still
      // the member's to append (the permanent suites exercise the generic append with synthetic topics; the relay
      // refuses an unregistered topic as unknown_task).
      await asMember(world.ownerA, world.A1, (tx) => insert(tx, memberRow("testjobs.member_probe")));
      expect(await rows(world.A1)).toHaveLength(MEMBER_TOPICS.length + 1);
      await clear(world.A1);
    });

    it("2. cannot append ingestion.confirm_interaction — even in the exact IDs-only shape of the trusted producer", async () => {
      await refused(asMember(world.ownerA, world.A1, (tx) => insert(tx, memberRow(CONFIRM))), CONFIRM);
      // Nor with a system initiator (append_own admits only `user` rows), nor without a workspace.
      await refused(asMember(world.ownerA, world.A1, (tx) => insert(tx, { ...memberRow(CONFIRM), initiator: { type: "system" } })), "system initiator");
      await refused(asMember(world.ownerA, world.A1, (tx) => tx.execute(sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, status, created_at)
        values (${randomUUID()}, ${CONFIRM}, null, null, ${JSON.stringify(subjectsFor(CONFIRM))}::jsonb, ${`h6e1-${randomUUID()}`}, 'user', ${world.ownerA}, ${`h6e1:${randomUUID()}`}, 'PENDING', now())`)), "no workspace");
      expect(await rows(world.A1)).toEqual([]);
    });

    it("3. cannot append any other internal topic either: the refusal is by topic alone (well-formed subjects, own workspace, own identity)", async () => {
      for (const topic of INTERNAL_TOPICS) await refused(asMember(world.ownerA, world.A1, (tx) => insert(tx, memberRow(topic))), topic);
      expect(await rows(world.A1)).toEqual([]);
    });

    it("4. cross-workspace: a member bound to one workspace appends nothing into another, member topic or internal", async () => {
      for (const topic of [...MEMBER_TOPICS, CONFIRM]) {
        await refused(asMember(world.ownerA, world.A1, (tx) => insert(tx, memberRow(topic, world.ownerA, world.A2))), `${topic} → other workspace of the same organization`);
      }
      expect(await rows(world.A2)).toEqual([]);
    });

    it("5. cross-organization and impersonation: another organization's member writes nothing into this tenant", async () => {
      for (const topic of [...MEMBER_TOPICS, CONFIRM]) {
        await refused(asMember(world.ownerB, world.B1, (tx) => insert(tx, memberRow(topic, world.ownerB, world.A1))), `${topic} → other organization's workspace`);
        // Not as someone else either (append_own binds initiator_user_id to the verified claims).
        await refused(asMember(world.ownerB, world.B1, (tx) => insert(tx, memberRow(topic, world.ownerA, world.B1, world.orgB))), `${topic} as another user`);
      }
      expect(await rows(world.A1)).toEqual([]);
      expect(await rows(world.B1)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("trusted internal producer (job runtime)", () => {
    const target = () => ({ organizationId: world.orgA, workspaceId: world.A1, connectedAccountId: randomUUID(), interactionId: randomUUID() });

    it("6, 8. the H6-E producer still appends its IDs-only row: system initiator, exactly two UUID subjects, PENDING and unbound", async () => {
      const t = target();
      const outboxId = randomUUID();
      const noted: string[] = [];
      await asWorker(world.A1, (tx) => createPostgresReconciliationStore(tx, (notice) => { noted.push(notice.id); }).enqueueConfirmation(t, `h6e1-${randomUUID()}`, outboxId, new Date()));
      expect(noted).toEqual([outboxId]);
      const written = await rows(world.A1);
      expect(written).toHaveLength(1);
      const row = written.find((candidate) => candidate.id === outboxId);
      expect(row).toMatchObject({ id: outboxId, topic: CONFIRM, initiator_type: "system", initiator_user_id: null, status: "PENDING", execution_plane: null });
      expect(Object.keys(row?.subject_ids ?? {}).sort()).toEqual(["connected_account_id", "interaction_id"]);
      expect(row?.subject_ids).toEqual({ connected_account_id: t.connectedAccountId, interaction_id: t.interactionId });
      for (const value of Object.values(row?.subject_ids ?? {})) expect(value).toMatch(UUID);
      // The database itself refuses anything but identifiers in the subjects (0004 is_identifier_map), for the worker too.
      expect(await sqlState(asWorker(world.A1, (tx) => insert(tx, { topic: CONFIRM, organizationId: world.orgA, workspaceId: world.A1, subjects: { interaction_id: "fb_c_001" }, initiator: { type: "system" } })))).toMatchObject({ code: "23514" });
      // The worker's own policy is unchanged: bound workspace only, never a human initiator.
      await refused(asWorker(world.A1, (tx) => insert(tx, { topic: CONFIRM, organizationId: world.orgA, workspaceId: world.A2, subjects: subjectsFor(CONFIRM), initiator: { type: "system" } })), "worker → other workspace");
      await refused(asWorker(world.A1, (tx) => insert(tx, { topic: CONFIRM, organizationId: world.orgA, workspaceId: world.A1, subjects: subjectsFor(CONFIRM), initiator: { type: "user", userId: world.ownerA } })), "worker as a user");
      expect(await rows(world.A1)).toHaveLength(1);
    });

    it("7. the existing relay still consumes that row: dispatched once to INTEGRATION with the IDs-only payload", async () => {
      const outboxId = randomUUID();
      await asWorker(world.A1, (tx) => createPostgresReconciliationStore(tx, () => undefined).enqueueConfirmation(target(), `h6e1-${randomUUID()}`, outboxId, new Date()));
      const row = (await rows(world.A1)).find((candidate) => candidate.id === outboxId);
      if (row === undefined) throw new Error("the producer's row is missing");
      const seen: unknown[] = [];
      const handler: FakeHandler = (payload) => {
        seen.push(payload);
        return Promise.resolve(undefined);
      };
      const runtime = new FakeJobRuntime(new Map([[CONFIRM, handler]]), (task) => PRODUCTION_TASKS.get(task)?.retry ?? { maxAttempts: 1, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false });
      const deps: DeliveryDependencies = { system, runtimes: { main: runtime, integration: runtime }, registry: PRODUCTION_TASKS, logger: createLogger({ sink: () => undefined, now: () => new Date() }), clock: () => new Date(), config: CONFIG };
      await relayPass(deps);
      const [after] = await rows(world.A1);
      expect(after).toMatchObject({ id: row.id, status: "DISPATCHED", execution_plane: "integration" });
      expect(await oracle("select 1 from system.outbox_runs where outbox_id = $1", [row.id])).toHaveLength(1);
      const requests = runtime.enqueued.filter((request) => request.dispatchKey === row.dispatch_key);
      expect(requests).toHaveLength(1);
      const payload = requests[0]?.payload as { scope: string; task: string; workspaceId: string; subjectIds: Record<string, string>; initiator: { type: string } };
      expect(payload).toMatchObject({ scope: "workspace", task: CONFIRM, workspaceId: world.A1, initiator: { type: "system" } });
      expect(Object.keys(payload.subjectIds).sort()).toEqual(["connected_account_id", "interaction_id"]);
      expect(JSON.stringify(payload)).not.toMatch(/provider|platform|token|credential|content_id|parent/i);
      await runtime.drain();
      expect(seen).toHaveLength(1);
      await clear(world.A1);
    });
  });
}
