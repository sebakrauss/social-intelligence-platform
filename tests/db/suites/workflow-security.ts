/**
 * WORKFLOW-WF-2B — the mandatory SECURITY CHECKPOINT of migration 0034 and the workflow module, on the real database
 * roles (web login → authenticated with transaction-local claims and the sealed workspace; worker login → app_worker;
 * the owner app_owner reached by the migration role), BEFORE any runtime path is connected.
 *
 *   S1  forced RLS, exact grants, no runtime DELETE, no direct member writes
 *   S2  every non-guest read role reads the bound workspace's work items and events; a guest reads none
 *   S3  revoked membership, unbound context, forged binding, claims without membership: nothing visible, nothing writable
 *   S4  cross-workspace reads (other binding, explicit foreign predicate, foreign ids) and writes (definer, worker)
 *   S5  NOT_FOUND without existence oracle: another workspace's id and a random id fail identically
 *   S6  app_worker: creates only OPEN v1 items, appends only its two event shapes, may only REOPEN (trigger guard)
 *   S7  app_owner (reached only by the definer): bound workspace only, no insert, no delete
 *   S8  workflow.change_state: web callers with a workflow role only; attribution = the verified caller; version
 *       compare-and-set; change + event + audit atomic (same id); closed vocabulary; Monitor-only allowed
 *   S9  composite foreign keys: a foreign conversation or interaction fails exactly like a missing one
 *   S10 audit: members cannot append the workflow action themselves; the owner policy admits only the definer's event
 *   S11 R4a: every new function pins pg_catalog, pg_temp; a web session that arms pg_temp runs nothing as app_owner
 *       through workflow.change_state (the full T-26 sweep covers every function too)
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, parseRequestId, type CorrelationId } from "@/domain/correlation";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import { createPostgresInteractionStore } from "@/modules/interactions/persistence";
import { projectMembersJoined } from "@/modules/workflow";
import { createPostgresWorkflowProjectionStore, createPostgresWorkflowReadStore, createPostgresWorkflowStateChanger } from "@/modules/workflow/persistence";
import { parseDatabaseUrl, postgresError, withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { isAppError } from "@/domain/errors";
import { probeRuntimeSession } from "../support/name-resolution-probe";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { WORKSPACE_ROLES, seedConversation, workflowTenant, type TenantRole, type WorkflowTenant } from "../support/workflow-world";
import { count, sqlState } from "./helpers";

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};
const correlation = (): CorrelationId => must(parseCorrelationId(`wf2b-${randomUUID()}`), "correlation");
const requestId = () => must(parseRequestId(`req-${randomUUID()}`), "request");
const ws = (id: string): WorkspaceId => must(parseWorkspaceId(id), "workspace");
const READERS = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER"] as const;
const CHANGERS = ["OWNER", "ADMIN", "MANAGER", "RESPONDER"] as const;

export function defineWorkflowSecuritySuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let A: WorkflowTenant;
  let B: WorkflowTenant;
  let M: WorkflowTenant; // Monitor-only
  const items: Record<string, { conversationId: string; anchorId: string }[]> = {};
  const organizations: string[] = [];
  const clock = { newId: randomUUID, now: () => new Date() };

  const asUser = <T>(t: WorkflowTenant, role: TenantRole, bound: string | undefined, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> =>
    withUserScope(web, { sub: t.users[role], role: "authenticated" }, bound, work);
  const asWorker = <T>(workspaceId: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => withWorkspaceJobScope(worker, workspaceId, work);
  /** The module's own worker path: create (OPEN, v1, created event) and project. */
  const project = (t: WorkflowTenant, conversationId: string, joined: { interactionId: string; authorRole: string | null; observed: boolean }[]) =>
    asWorker(t.workspaceId, (tx) => projectMembersJoined(createPostgresWorkflowProjectionStore(tx, createPostgresAuditLog(tx)), { latestActivity: (id) => createPostgresInteractionStore(tx).latestConversationActivity(id) }, clock, {
      conversationId, organizationId: t.organizationId, workspaceId: t.workspaceId, joined, correlationId: correlation() }));
  const change = (t: WorkflowTenant, role: TenantRole, bound: string, workItemId: string, to: "DONE" | "OPEN", expectedVersion: number, resolution: string | null = null) =>
    asUser(t, role, bound, (tx) => createPostgresWorkflowStateChanger(tx).changeState({
      workItemId, change: to === "DONE" ? { to, resolution: resolution as never } : { to }, expectedVersion, correlationId: correlation(), requestId: requestId() }));
  const rawChange = (tx: DatabaseTransaction, id: string, to: string, resolution: string | null, version: number) =>
    tx.execute(sql`select * from workflow.change_state(${id}::uuid, ${to}, ${resolution}, ${version}::integer, ${"wf2b-raw-call"}, null)`);
  const versionOf = async (id: string): Promise<number> => (await privileged.query<{ version: number }>("select version from workflow.work_items where id = $1", [id])).rows[0]?.version ?? -1;
  const errorCode = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (isAppError(error)) return error.code;
      const pgError = postgresError(error);
      if (pgError === undefined) throw error;
      return pgError.code;
    }
    return "resolved";
  };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web");
    worker = runtimeDatabase(target, "worker");
    A = await workflowTenant(privileged);
    B = await workflowTenant(privileged);
    M = await workflowTenant(privileged, "MONITOR_ONLY");
    organizations.push(A.organizationId, B.organizationId, M.organizationId);
    for (const t of [A, B, M]) {
      items[t.workspaceId] = [];
      for (let n = 0; n < 3; n += 1) {
        const conversation = await seedConversation(privileged, t, new Date(Date.UTC(2026, 9, 1 + n)));
        items[t.workspaceId]?.push(conversation);
        await project(t, conversation.conversationId, [{ interactionId: conversation.anchorId, authorRole: "user", observed: true }]);
      }
    }
  });

  afterAll(async () => {
    await cleanupWorld(privileged, organizations);
    await web.end();
    await worker.end();
    await privileged.end();
  });

  const itemOf = (t: WorkflowTenant, n = 0) => must(items[t.workspaceId]?.[n], "item");

  describe("S1 · structure, grants and the absence of write paths", () => {
    it("RLS is enabled AND forced on both tables; no policy admits DELETE; the members' grant is SELECT only", async () => {
      const rows = (await privileged.query<{ relname: string; rls: boolean; forced: boolean }>(
        "select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'workflow' and c.relkind = 'r' order by 1")).rows;
      expect(rows).toEqual([{ relname: "work_items", rls: true, forced: true }, { relname: "workflow_events", rls: true, forced: true }]);
      const deletes = (await privileged.query("select polname from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'workflow' and p.polcmd in ('d', '*')")).rowCount;
      expect(deletes).toBe(0);
      const grants = (await privileged.query<{ grantee: string; table_name: string; privilege_type: string }>(
        "select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'workflow' and grantee not in ('app_owner') order by 1, 2, 3")).rows;
      expect(grants).toEqual([
        { grantee: "app_worker", table_name: "work_items", privilege_type: "INSERT" },
        { grantee: "app_worker", table_name: "work_items", privilege_type: "SELECT" },
        { grantee: "app_worker", table_name: "workflow_events", privilege_type: "INSERT" },
        { grantee: "app_worker", table_name: "workflow_events", privilege_type: "SELECT" },
        { grantee: "authenticated", table_name: "work_items", privilege_type: "SELECT" },
        { grantee: "authenticated", table_name: "workflow_events", privilege_type: "SELECT" },
      ]);
      const anon = (await privileged.query("select 1 from information_schema.role_table_grants where table_schema = 'workflow' and grantee in ('anon', 'service_role', 'PUBLIC', 'web_login', 'worker_login', 'system_login')")).rowCount;
      expect(anon).toBe(0);
    });

    it("a member cannot INSERT, UPDATE or DELETE either table directly (no grant), even with every workflow role", async () => {
      const { conversationId } = itemOf(A);
      for (const statement of [
        sql`update workflow.work_items set state = 'DONE' where id = ${conversationId}::uuid`,
        sql`delete from workflow.work_items where id = ${conversationId}::uuid`,
        sql`insert into workflow.workflow_events (id, organization_id, workspace_id, work_item_id, kind, from_state, to_state, initiator_kind, initiator_user_id, version_after, correlation_id, occurred_at)
            values (gen_random_uuid(), ${A.organizationId}::uuid, ${A.workspaceId}::uuid, ${conversationId}::uuid, 'state_changed', 'OPEN', 'DONE', 'user', ${A.users.OWNER}::uuid, 2, 'wf2b-forged-event', now())`,
        sql`delete from workflow.workflow_events where work_item_id = ${conversationId}::uuid`,
      ]) {
        expect((await sqlState(asUser(A, "OWNER", A.workspaceId, (tx) => tx.execute(statement)))).code).toBe("42501");
      }
    });

    it("the job runtime cannot DELETE either table (no grant)", async () => {
      const { conversationId } = itemOf(A);
      expect((await sqlState(asWorker(A.workspaceId, (tx) => tx.execute(sql`delete from workflow.work_items where id = ${conversationId}::uuid`)))).code).toBe("42501");
      expect((await sqlState(asWorker(A.workspaceId, (tx) => tx.execute(sql`delete from workflow.workflow_events where work_item_id = ${conversationId}::uuid`)))).code).toBe("42501");
    });
  });

  describe("S2 · authenticated read roles and guest denial", () => {
    it("OWNER, ADMIN, MANAGER, RESPONDER and ANALYST_VIEWER read every work item and event of the bound workspace through the queue", async () => {
      for (const role of READERS) {
        const seen = await asUser(A, role, A.workspaceId, async (tx) => ({
          queue: (await createPostgresWorkflowReadStore(tx).queue({ workspaceId: ws(A.workspaceId), view: "all", before: null, limit: 25 })).map((row) => row.id).sort(),
          items: await count(tx, "workflow.work_items"),
          events: await count(tx, "workflow.workflow_events"),
        }));
        expect(seen.queue, role).toEqual((items[A.workspaceId] ?? []).map((item) => item.conversationId).sort());
        expect(seen.items, role).toBe(3);
        expect(seen.events, role).toBe(3);
      }
    });

    it("a CLIENT_GUEST reads nothing (work items, events, queue) and cannot change a state", async () => {
      const seen = await asUser(A, "CLIENT_GUEST", A.workspaceId, async (tx) => ({
        queue: (await createPostgresWorkflowReadStore(tx).queue({ workspaceId: ws(A.workspaceId), view: "all", before: null, limit: 25 })).length,
        items: await count(tx, "workflow.work_items"),
        events: await count(tx, "workflow.workflow_events"),
      }));
      expect(seen).toEqual({ queue: 0, items: 0, events: 0 });
      expect(await errorCode(change(A, "CLIENT_GUEST", A.workspaceId, itemOf(A).conversationId, "DONE", 1))).toBe("PERMISSION_DENIED");
    });

    it("an ANALYST_VIEWER reads but cannot change a state (no workflow.internal role)", async () => {
      expect(await errorCode(change(A, "ANALYST_VIEWER", A.workspaceId, itemOf(A).conversationId, "DONE", 1))).toBe("PERMISSION_DENIED");
      expect(await versionOf(itemOf(A).conversationId)).toBe(1);
    });
  });

  describe("S3 · revoked membership, unbound and forged context", () => {
    it("a revoked membership reads nothing and changes nothing in the very next transaction", async () => {
      const before = await asUser(A, "REVOKED", A.workspaceId, (tx) => count(tx, "workflow.work_items"));
      expect(before).toBe(3);
      await privileged.query("delete from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [A.workspaceId, A.users.REVOKED]);
      const after = await asUser(A, "REVOKED", A.workspaceId, async (tx) => ({ items: await count(tx, "workflow.work_items"), events: await count(tx, "workflow.workflow_events") }));
      expect(after).toEqual({ items: 0, events: 0 });
      expect(await errorCode(change(A, "REVOKED", A.workspaceId, itemOf(A).conversationId, "DONE", 1))).toBe("PERMISSION_DENIED");
    });

    it("no bound workspace, a forged binding, a seal of another workspace, or no claims: nothing visible and the definer refuses", async () => {
      const claims = (tx: DatabaseTransaction, user: string) => tx.execute(sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated" })}, true), set_config('request.jwt.claim.sub', ${user}, true)`);
      const raw = async (setup: (tx: DatabaseTransaction) => Promise<unknown>) =>
        web.db.transaction(async (tx) => {
          await tx.execute(sql`set local role authenticated`);
          await setup(tx);
          return { items: await count(tx, "workflow.work_items"), events: await count(tx, "workflow.workflow_events") };
        });
      expect(await raw((tx) => claims(tx, A.users.OWNER))).toEqual({ items: 0, events: 0 });
      expect(await raw(async (tx) => { await claims(tx, A.users.OWNER); await tx.execute(sql`select set_config('app.workspace_id', ${A.workspaceId}, true)`); })).toEqual({ items: 0, events: 0 });
      expect(await raw(async (tx) => {
        await claims(tx, A.users.OWNER);
        await tx.execute(sql`select app.bind_workspace(${B.workspaceId}::uuid)`);
        await tx.execute(sql`select set_config('app.workspace_id', ${A.workspaceId}, true)`);
      })).toEqual({ items: 0, events: 0 });
      expect(await raw((tx) => tx.execute(sql`select app.bind_workspace(${A.workspaceId}::uuid)`))).toEqual({ items: 0, events: 0 });
      // The definer under the same four contexts.
      const id = itemOf(A).conversationId;
      const refused = (setup: (tx: DatabaseTransaction) => Promise<unknown>) => sqlState(web.db.transaction(async (tx) => { await tx.execute(sql`set local role authenticated`); await setup(tx); await rawChange(tx, id, "DONE", null, 1); }));
      expect((await refused((tx) => claims(tx, A.users.OWNER))).code).toBe("42501");
      expect((await refused(async (tx) => { await claims(tx, A.users.OWNER); await tx.execute(sql`select set_config('app.workspace_id', ${A.workspaceId}, true)`); })).code).toBe("42501");
      expect((await refused((tx) => tx.execute(sql`select app.bind_workspace(${A.workspaceId}::uuid)`))).code).toBe("42501");
      expect(await versionOf(id)).toBe(1);
    });
  });

  describe("S4 · cross-workspace reads and writes", () => {
    it("a member binding another workspace reads nothing; an explicit predicate or ids of another workspace read nothing", async () => {
      expect(await asUser(A, "OWNER", B.workspaceId, (tx) => count(tx, "workflow.work_items"))).toBe(0);
      const foreign = await asUser(A, "OWNER", A.workspaceId, async (tx) => {
        const store = createPostgresWorkflowReadStore(tx);
        return {
          queue: (await store.queue({ workspaceId: ws(B.workspaceId), view: "all", before: null, limit: 25 })).length,
          ids: (await store.findMany({ workspaceId: ws(A.workspaceId), ids: (items[B.workspaceId] ?? []).map((item) => item.conversationId) })).length,
          idsWithForeignPredicate: (await store.findMany({ workspaceId: ws(B.workspaceId), ids: (items[B.workspaceId] ?? []).map((item) => item.conversationId) })).length,
          events: await count(tx, "workflow.workflow_events", sql`workspace_id = ${B.workspaceId}::uuid`),
        };
      });
      expect(foreign).toEqual({ queue: 0, ids: 0, idsWithForeignPredicate: 0, events: 0 });
    });

    it("the job runtime bound to A reads none of B's rows and changes none of them", async () => {
      const id = itemOf(B).conversationId;
      const result = await asWorker(A.workspaceId, async (tx) => ({
        read: await count(tx, "workflow.work_items", sql`workspace_id = ${B.workspaceId}::uuid`),
        updated: (await tx.execute(sql`update workflow.work_items set updated_at = now() where id = ${id}::uuid`)).rowCount,
      }));
      expect(result).toEqual({ read: 0, updated: 0 });
      // An insert for B while bound to A fails the policy (fail closed).
      const insertForeign = await sqlState(asWorker(A.workspaceId, (tx) => tx.execute(sql`
        insert into workflow.work_items (id, organization_id, workspace_id, subject_kind, conversation_id, state, state_changed_at, state_changed_by_kind, version, latest_activity_at, created_at, updated_at)
        values (${itemOf(B, 1).conversationId}::uuid, ${B.organizationId}::uuid, ${B.workspaceId}::uuid, 'comment_conversation', ${itemOf(B, 1).conversationId}::uuid, 'OPEN', now(), 'system_ingestion', 1, date_trunc('milliseconds', now()), now(), now())`)));
      expect(insertForeign.code).toBe("42501");
    });
  });

  describe("S5 · NOT_FOUND without an existence oracle", () => {
    it("another workspace's work item and a random id are refused identically (same code, same message), whoever asks", async () => {
      const detail = async (id: string) => {
        try {
          await asUser(A, "OWNER", A.workspaceId, (tx) => rawChange(tx, id, "DONE", null, 1));
        } catch (error) {
          let current: unknown = error;
          while (typeof current === "object" && current !== null && typeof (current as { code?: unknown }).code !== "string") current = (current as { cause?: unknown }).cause;
          const found = current as { code?: string; message?: string } | null;
          return { code: found?.code, message: found?.message };
        }
        return { code: "resolved", message: "" };
      };
      const foreign = await detail(itemOf(B).conversationId);
      const missing = await detail(randomUUID());
      expect(foreign).toEqual({ code: "P0002", message: "workflow: not found" });
      expect(missing).toEqual(foreign);
      expect(await errorCode(change(A, "OWNER", A.workspaceId, itemOf(B).conversationId, "DONE", 1))).toBe("NOT_FOUND");
      expect(await versionOf(itemOf(B).conversationId)).toBe(1);
    });
  });

  describe("S6 · app_worker: OPEN creation, its two event shapes, and only the objective reopen", () => {
    const bump = (id: string, set: ReturnType<typeof sql>) => asWorker(A.workspaceId, (tx) => tx.execute(sql`update workflow.work_items set ${set} where id = ${id}::uuid`));

    it("creation is OPEN / version 1 / system_ingestion only", async () => {
      const conversation = await seedConversation(privileged, A, new Date(Date.UTC(2026, 9, 20)));
      const insert = (state: string, version: number, by: string) => asWorker(A.workspaceId, (tx) => tx.execute(sql`
        insert into workflow.work_items (id, organization_id, workspace_id, subject_kind, conversation_id, state, state_changed_at, state_changed_by_kind, version, latest_activity_at, created_at, updated_at)
        values (${conversation.conversationId}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, 'comment_conversation', ${conversation.conversationId}::uuid, ${state}, now(), ${by}, ${version}, date_trunc('milliseconds', now()), now(), now())`));
      expect((await sqlState(insert("DONE", 1, "system_ingestion"))).code).toBe("42501");
      expect((await sqlState(insert("OPEN", 2, "system_ingestion"))).code).toBe("42501");
      expect((await sqlState(insert("OPEN", 1, "user"))).code).toBe("42501");
      await insert("OPEN", 1, "system_ingestion");
      items[A.workspaceId]?.push(conversation);
      await privileged.query("insert into workflow.workflow_events (id, organization_id, workspace_id, work_item_id, kind, to_state, initiator_kind, version_after, correlation_id, occurred_at) values (gen_random_uuid(), $1, $2, $3, 'created', 'OPEN', 'system_ingestion', 1, 'wf2b-test-created', now())",
        [A.organizationId, A.workspaceId, conversation.conversationId]);
    });

    it("the trigger guard refuses an automatic Done, a resolution, a version jump and an attribution rewrite", async () => {
      const id = itemOf(A, 1).conversationId;
      expect((await sqlState(bump(id, sql`state = 'DONE', version = version + 1, state_changed_at = now(), state_changed_by_kind = 'system_auto_reopen'`))).code).toBe("42501");
      expect((await sqlState(bump(id, sql`state = 'DONE', version = version + 1, state_changed_at = now(), state_changed_by_kind = 'user', state_changed_by_user = ${A.users.OWNER}::uuid`))).code).toBe("42501");
      expect((await sqlState(bump(id, sql`version = version + 2`))).code).toBe("42501");
      expect((await sqlState(bump(id, sql`version = version - 1`))).code).toBe("42501");
      expect((await sqlState(bump(id, sql`state_changed_by_kind = 'system_auto_reopen', state_changed_at = now()`))).code).toBe("42501");
      expect(await versionOf(id)).toBe(1);
    });

    it("the only worker transition is Done → Open (system_auto_reopen, no resolution, version + 1)", async () => {
      const id = itemOf(A, 2).conversationId;
      const done = await change(A, "MANAGER", A.workspaceId, id, "DONE", 1, "no_reply_needed");
      expect(done).toMatchObject({ outcome: "changed", state: "DONE", version: 2 });
      expect((await sqlState(bump(id, sql`state = 'OPEN', resolution = 'reviewed', version = version + 1, state_changed_at = now(), state_changed_by_kind = 'system_auto_reopen'`))).code).toBe("42501");
      expect((await sqlState(bump(id, sql`state = 'OPEN', resolution = null, version = version + 1, state_changed_at = now(), state_changed_by_kind = 'user', state_changed_by_user = ${A.users.OWNER}::uuid`))).code).toBe("42501");
      await bump(id, sql`state = 'OPEN', resolution = null, version = version + 1, state_changed_at = now(), state_changed_by_kind = 'system_auto_reopen', state_changed_by_user = null`);
      expect(await versionOf(id)).toBe(3);
    });

    it("the worker appends only `created` (system_ingestion) and `state_changed` Done → Open (system_auto_reopen) events", async () => {
      const { conversationId, anchorId } = itemOf(A);
      const event = (kind: string, from: string | null, to: string, by: string, user: string | null, cause: string | null) => asWorker(A.workspaceId, (tx) => tx.execute(sql`
        insert into workflow.workflow_events (id, organization_id, workspace_id, work_item_id, kind, from_state, to_state, initiator_kind, initiator_user_id, cause_interaction_id, version_after, correlation_id, occurred_at)
        values (gen_random_uuid(), ${A.organizationId}::uuid, ${A.workspaceId}::uuid, ${conversationId}::uuid, ${kind}, ${from}, ${to}, ${by}, ${user}::uuid, ${cause}::uuid, 5, 'wf2b-worker-event', now())`));
      expect((await sqlState(event("state_changed", "OPEN", "DONE", "system_auto_reopen", null, anchorId))).code).toBe("42501");
      expect((await sqlState(event("state_changed", "DONE", "OPEN", "user", A.users.OWNER, null))).code).toBe("42501");
      expect((await sqlState(event("created", null, "OPEN", "migration", null, null))).code).toBe("42501");
      await event("state_changed", "DONE", "OPEN", "system_auto_reopen", null, anchorId);
    });
  });

  describe("S7 · app_owner, reached only through the definer", () => {
    const asOwner = <T>(bound: string | null, work: (client: pg.PoolClient) => Promise<T>) => (async () => {
      const client = await privileged.connect();
      try {
        await client.query("begin");
        await client.query("set local role app_owner");
        if (bound !== null) await client.query("select app.bind_workspace($1::uuid)", [bound]);
        return await work(client);
      } finally {
        await client.query("rollback");
        client.release();
      }
    })();
    it("under FORCED RLS the owner reads only the bound workspace, inserts no work item and deletes nothing", async () => {
      expect(await asOwner(null, async (c) => (await c.query<{ n: number }>("select count(*)::int as n from workflow.work_items")).rows[0])).toEqual({ n: 0 });
      expect(await asOwner(A.workspaceId, async (c) => (await c.query<{ n: number }>("select count(*)::int as n from workflow.work_items where workspace_id <> $1", [A.workspaceId])).rows[0])).toEqual({ n: 0 });
      expect(await asOwner(A.workspaceId, async (c) => (await c.query("delete from workflow.work_items")).rowCount)).toBe(0);
      expect(await asOwner(A.workspaceId, async (c) => (await c.query("delete from workflow.workflow_events")).rowCount)).toBe(0);
      const forced = await sqlState(asOwner(A.workspaceId, (c) => c.query(
        "insert into workflow.work_items (id, organization_id, workspace_id, subject_kind, conversation_id, state, state_changed_at, state_changed_by_kind, version, latest_activity_at, created_at, updated_at) values ($1, $2, $3, 'comment_conversation', $1, 'OPEN', now(), 'system_ingestion', 1, date_trunc('milliseconds', now()), now(), now())",
        [randomUUID(), A.organizationId, A.workspaceId])));
      expect(forced.code).toBe("42501");
    });
  });

  describe("S8 · workflow.change_state (the web's only write path)", () => {
    it("every workflow role marks Done and reopens; the change, its event and its audit event share one id and name the verified caller", async () => {
      for (const role of CHANGERS) {
        const conversation = await seedConversation(privileged, A, new Date());
        await project(A, conversation.conversationId, [{ interactionId: conversation.anchorId, authorRole: "user", observed: true }]);
        const done = await change(A, role, A.workspaceId, conversation.conversationId, "DONE", 1, "replied_on_platform");
        expect(done, role).toEqual({ outcome: "changed", state: "DONE", resolution: "replied_on_platform", version: 2 });
        const reopened = await change(A, role, A.workspaceId, conversation.conversationId, "OPEN", 2);
        expect(reopened, role).toEqual({ outcome: "changed", state: "OPEN", resolution: null, version: 3 });
        const trail = (await privileged.query<{ kind: string; from_state: string | null; to_state: string; initiator_kind: string; initiator_user_id: string | null; actor: string | null; action: string | null; change: unknown }>(
          `select e.kind, e.from_state, e.to_state, e.initiator_kind, e.initiator_user_id, a.actor_user_id as actor, a.action, a.change
             from workflow.workflow_events e left join audit.audit_events a on a.id = e.id
            where e.work_item_id = $1 order by e.version_after`, [conversation.conversationId])).rows;
        expect(trail, role).toEqual([
          { kind: "created", from_state: null, to_state: "OPEN", initiator_kind: "system_ingestion", initiator_user_id: null, actor: null, action: null, change: null },
          { kind: "state_changed", from_state: "OPEN", to_state: "DONE", initiator_kind: "user", initiator_user_id: A.users[role], actor: A.users[role], action: "work_item.state_changed",
            change: { kind: "workflow_state", previous: { state: "OPEN", resolution: null }, current: { state: "DONE", resolution: "replied_on_platform" } } },
          { kind: "state_changed", from_state: "DONE", to_state: "OPEN", initiator_kind: "user", initiator_user_id: A.users[role], actor: A.users[role], action: "work_item.state_changed",
            change: { kind: "workflow_state", previous: { state: "DONE", resolution: "replied_on_platform" }, current: { state: "OPEN", resolution: null } } },
        ]);
      }
    });

    it("a stale version is refused with nothing written; the same state is 'unchanged' with nothing written", async () => {
      const id = itemOf(A).conversationId;
      const events = async () => Number((await privileged.query<{ n: string }>("select count(*) as n from workflow.workflow_events where work_item_id = $1", [id])).rows[0]?.n);
      const before = await events();
      expect(await change(A, "MANAGER", A.workspaceId, id, "DONE", 99)).toEqual({ outcome: "stale", state: "OPEN", resolution: null, version: 1 });
      expect(await change(A, "MANAGER", A.workspaceId, id, "OPEN", 1)).toEqual({ outcome: "unchanged", state: "OPEN", resolution: null, version: 1 });
      expect(await events()).toBe(before);
      expect(await versionOf(id)).toBe(1);
    });

    it("input outside the closed vocabulary is INVALID_INPUT (a resolution only with Done)", async () => {
      const id = itemOf(A).conversationId;
      expect((await sqlState(asUser(A, "MANAGER", A.workspaceId, (tx) => rawChange(tx, id, "OPEN", "no_reply_needed", 1)))).code).toBe("22023");
      expect((await sqlState(asUser(A, "MANAGER", A.workspaceId, (tx) => rawChange(tx, id, "DONE", "thanks!", 1)))).code).toBe("22023");
      expect((await sqlState(asUser(A, "MANAGER", A.workspaceId, (tx) => rawChange(tx, id, "SNOOZED", null, 1)))).code).toBe("22023");
    });

    it("a worker login is refused even when bound (the definer is web-only, EXECUTE is authenticated-only)", async () => {
      const refused = await sqlState(asWorker(A.workspaceId, (tx) => rawChange(tx, itemOf(A).conversationId, "DONE", null, 1)));
      expect(refused.code).toBe("42501");
    });

    it("Monitor-only workspaces keep internal workflow: Mark Done and Reopen work there (PD UC-18, D-49)", async () => {
      const id = itemOf(M).conversationId;
      expect(await change(M, "RESPONDER", M.workspaceId, id, "DONE", 1, "reviewed")).toMatchObject({ outcome: "changed", state: "DONE", version: 2 });
      expect(await change(M, "RESPONDER", M.workspaceId, id, "OPEN", 2)).toMatchObject({ outcome: "changed", state: "OPEN", version: 3 });
    });

    it("concurrent Mark Done with the same version: exactly one changes, the other is stale", async () => {
      const id = itemOf(A, 1).conversationId;
      const version = await versionOf(id);
      const results = await Promise.all([change(A, "OWNER", A.workspaceId, id, "DONE", version), change(A, "MANAGER", A.workspaceId, id, "DONE", version)]);
      expect(results.map((result) => result.outcome).sort()).toEqual(["changed", "stale"]);
      expect(await versionOf(id)).toBe(version + 1);
      await change(A, "OWNER", A.workspaceId, id, "OPEN", version + 1);
    });
  });

  describe("S9 · composite foreign keys (R5)", () => {
    it("a work item naming another workspace's conversation, or an event naming another workspace's interaction, fails exactly like a missing one", async () => {
      const insertItem = (conversationId: string) => asWorker(A.workspaceId, (tx) => tx.execute(sql`
        insert into workflow.work_items (id, organization_id, workspace_id, subject_kind, conversation_id, state, state_changed_at, state_changed_by_kind, version, latest_activity_at, created_at, updated_at)
        values (${conversationId}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, 'comment_conversation', ${conversationId}::uuid, 'OPEN', now(), 'system_ingestion', 1, date_trunc('milliseconds', now()), now(), now())`));
      const foreign = await sqlState(insertItem(itemOf(B, 2).conversationId));
      const missing = await sqlState(insertItem(randomUUID()));
      expect(foreign).toEqual({ code: "23503", constraint: "work_items_workspace_id_conversation_id_fkey" });
      expect(missing).toEqual(foreign);
      const event = (cause: string) => asWorker(A.workspaceId, (tx) => tx.execute(sql`
        insert into workflow.workflow_events (id, organization_id, workspace_id, work_item_id, kind, from_state, to_state, initiator_kind, cause_interaction_id, version_after, correlation_id, occurred_at)
        values (gen_random_uuid(), ${A.organizationId}::uuid, ${A.workspaceId}::uuid, ${itemOf(A).conversationId}::uuid, 'state_changed', 'DONE', 'OPEN', 'system_auto_reopen', ${cause}::uuid, 9, 'wf2b-fk-probe', now())`));
      const foreignCause = await sqlState(event(itemOf(B).anchorId));
      expect(foreignCause.code).toBe("23503");
      expect(await sqlState(event(randomUUID()))).toEqual(foreignCause);
    });
  });

  describe("S10 · audit", () => {
    it("a member cannot append the workflow action through the pipeline's own policy (append_own is unchanged)", async () => {
      const appended = await sqlState(asUser(A, "OWNER", A.workspaceId, (tx) => tx.execute(sql`
        insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id, target_type, target_id, correlation_id, outcome, change)
        values (gen_random_uuid(), now(), 'work_item.state_changed', 'user', ${A.users.OWNER}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, 'work_item', ${itemOf(A).conversationId}, 'wf2b-forged-audit', 'succeeded', null)`)));
      expect(appended.code).toBe("42501");
    });

    it("the audit CHECK accepts a workflow change summary only in its closed shape", async () => {
      const check = async (change: unknown) => (await privileged.query<{ ok: boolean }>("select audit.is_valid_change($1::jsonb) as ok", [JSON.stringify(change)])).rows[0]?.ok;
      expect(await check({ kind: "workflow_state", previous: { state: "OPEN", resolution: null }, current: { state: "DONE", resolution: "no_reply_needed" } })).toBe(true);
      expect(await check({ kind: "workflow_state", previous: { state: "OPEN", resolution: null }, current: { state: "OPEN", resolution: null } })).toBe(false);
      expect(await check({ kind: "workflow_state", previous: { state: "OPEN", resolution: "no_reply_needed" }, current: { state: "DONE", resolution: null } })).toBe(false);
      expect(await check({ kind: "workflow_state", previous: { state: "OPEN", resolution: null }, current: { state: "DONE", resolution: "free text" } })).toBe(false);
      expect(await check({ kind: "workflow_state", previous: { state: "OPEN" }, current: { state: "DONE", resolution: null } })).toBe(false);
      // Every earlier kind still validates exactly as before.
      expect(await check({ kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" })).toBe(true);
      expect(await check({ kind: "connection_status", previous: "ACTIVE", current: "DEGRADED" })).toBe(true);
    });
  });

  describe("S11 · R4a privileged name resolution", () => {
    it("every workflow function and the new audit validator pin exactly pg_catalog, pg_temp", async () => {
      const rows = (await privileged.query<{ name: string; config: string[] | null; definer: boolean }>(
        `select n.nspname || '.' || p.proname as name, p.proconfig as config, p.prosecdef as definer
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'workflow' or (n.nspname = 'audit' and p.proname in ('is_workflow_state', 'is_valid_change')) order by 1`)).rows;
      expect(rows).toEqual([
        { name: "audit.is_valid_change", config: ["search_path=pg_catalog, pg_temp"], definer: false },
        { name: "audit.is_workflow_state", config: ["search_path=pg_catalog, pg_temp"], definer: false },
        { name: "workflow.change_state", config: ["search_path=pg_catalog, pg_temp"], definer: true },
        { name: "workflow.work_item_guard", config: ["search_path=pg_catalog, pg_temp"], definer: false },
      ]);
    });

    it("a web session that arms its temporary schema runs nothing as app_owner through workflow.change_state", async () => {
      const parsed = parseDatabaseUrl(getTarget().runtimeUrls.web, "web URL");
      const client = new pg.Client({ host: parsed.host, port: parsed.port, database: parsed.database, user: parsed.user, password: parsed.password });
      client.on("error", () => undefined);
      await client.connect();
      try {
        const claims = `select pg_catalog.set_config('request.jwt.claims', '${JSON.stringify({ sub: A.users.OWNER, role: "authenticated" })}', true), pg_catalog.set_config('request.jwt.claim.sub', '${A.users.OWNER}', true)`;
        const result = await probeRuntimeSession(client, { setup: ["set local role authenticated", claims, `select app.bind_workspace('${A.workspaceId}'::uuid)`], uuid: itemOf(A).conversationId });
        expect(result.armed).toBe(true);
        // Signatures are rendered while pg_temp shadows the builtin types, so match the function, not its type spelling.
        expect(result.exercised.filter((signature) => /^(workflow\.change_state|audit\.is_workflow_state|audit\.is_valid_change)\(/.test(signature))).toHaveLength(3);
        expect(result.escalated).toEqual({});
      } finally {
        await client.end();
      }
    });
  });

  it("covers every workspace role", () => {
    expect([...READERS, "CLIENT_GUEST"].sort()).toEqual([...WORKSPACE_ROLES].sort());
  });
}
