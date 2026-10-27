/**
 * Step H6-C3d — audit provenance after migration 0020, on the real database through the runtime roles. A member's
 * direct append (web login → authenticated, verified claims) is admitted only for the action pipeline's own events,
 * bound to the transaction's tenant context; every event of a reviewed SECURITY DEFINER or of the job runtime is out of
 * reach. The audit ledger stays append-only for every runtime role. Synthetic data only; no job runs, no provider call.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { createPostgresReconciliationStore } from "@/modules/ingestion/persistence";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const ROLES = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;
type Role = (typeof ROLES)[number];

/** The action pipeline's own events (server/commands), per tenant scope — the 0020 allowlist, exactly. */
export const PIPELINE_WORKSPACE_ACTIONS = [
  "workspace.mode_changed",
  "invitation.created",
  "invitation.revoked",
  "workspace_membership.role_changed",
  "workspace_membership.grants_changed",
  "workspace_membership.removed",
  "connection.created",
  "connection.credential_replaced",
  "connection.status_changed",
  "connection.removed",
  "connected_account.linked",
  "connected_account.unlinked",
  "connected_account.move_requested",
  "connected_account.capability_reevaluation_requested",
] as const;
export const PIPELINE_ORGANIZATION_ACTIONS = [
  "workspace.created",
  "invitation.created",
  "invitation.revoked",
  "organization_membership.role_changed",
  "organization_membership.removed",
  "workspace_membership.removed",
] as const;
export const PIPELINE_USER_ACTIONS = ["organization.created", "invitation.accepted"] as const;
/** Emitted only by a reviewed SECURITY DEFINER (0010, 0019) or by the job runtime (actor `system`). */
export const COMMAND_BOUND_ELSEWHERE = [
  "connected_account.reconciliation_requested",
  "connected_account.moved_out",
  "connected_account.moved_in",
  "connected_account.move_failed",
  "connected_account.move_rejected",
  "connection.validated",
] as const;

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly members: Readonly<Record<Role, string>>;
  readonly account: string;
}

interface Row {
  readonly action: string;
  readonly actorType?: string;
  readonly actorUserId: string | null;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly targetType: string;
  readonly targetId: string;
}

export function defineAuditProvenanceSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  const organizations: string[] = [];

  const correlation = (): CorrelationId => {
    const parsed = parseCorrelationId(`h6c3d-${randomUUID()}`);
    if (parsed === undefined) throw new Error("correlation");
    return parsed;
  };
  const auditCount = async (organizationId: string): Promise<number> =>
    (await privileged.query<{ n: number }>("select count(*)::int as n from audit.audit_events where organization_id = $1", [organizationId])).rows[0]?.n ?? -1;

  /** An organization + workspace with one member per role, an ACTIVE Meta connection and one ACTIVE account. */
  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const members = Object.fromEntries(ROLES.map((role) => [role, randomUUID()])) as Record<Role, string>;
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Audit', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    for (const role of ROLES) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, members[role], role === "OWNER" ? "OWNER" : role === "ADMIN" ? "ADMIN" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, members[role], role]);
    }
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, members.OWNER]);
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', 'fb_page_audit', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered]);
    return { organizationId, workspaceId, members, account };
  };

  const insert = (tx: DatabaseTransaction, row: Row) =>
    tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id, target_type, target_id, correlation_id, outcome)
      values (${randomUUID()}, now(), ${row.action}, ${row.actorType ?? "user"}, ${row.actorUserId}::uuid, ${row.organizationId}::uuid, ${row.workspaceId}::uuid, ${row.targetType}, ${row.targetId}, ${correlation()}, 'succeeded')`);
  /** A member's direct append, with `bound` the transaction's sealed workspace (undefined = none, as user/organization commands). */
  const asMember = (user: string, bound: string | undefined, row: Row) => withUserScope(web, { sub: user, role: "authenticated" }, bound, (tx) => insert(tx, row));
  /** The pipeline's workspace-scoped shape for one action. */
  const workspaceRow = (t: Tenant, user: string, action: string): Row => ({
    action,
    actorUserId: user,
    organizationId: t.organizationId,
    workspaceId: t.workspaceId,
    targetType: action.startsWith("connected_account.move") ? "asset_move" : action.startsWith("connected_account.") ? "connected_account" : action.startsWith("connection.") ? "connection" : action.startsWith("invitation.") ? "invitation" : action.startsWith("workspace_membership.") ? "workspace_membership" : "workspace",
    targetId: action.startsWith("workspace_membership.") ? `${t.workspaceId}:${randomUUID()}` : action.startsWith("connected_account.") ? t.account : t.workspaceId,
  });

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
  describe("command-bound actions can't be fabricated by members", () => {
    let t: Tenant;
    beforeAll(async () => {
      t = await tenant();
    });

    it("2–7. connected_account.reconciliation_requested: OWNER, ADMIN, MANAGER, RESPONDER, ANALYST_VIEWER and CLIENT_GUEST are all refused", async () => {
      const before = await auditCount(t.organizationId);
      for (const role of ROLES) {
        const row: Row = { action: "connected_account.reconciliation_requested", actorUserId: t.members[role], organizationId: t.organizationId, workspaceId: t.workspaceId, targetType: "connected_account", targetId: t.account };
        expect(await sqlState(asMember(t.members[role], t.workspaceId, row)), role).toMatchObject({ code: "42501" });
      }
      expect(await auditCount(t.organizationId)).toBe(before);
    });

    it("1. every definer- or worker-owned action is refused to an Owner, bound or not", async () => {
      for (const action of COMMAND_BOUND_ELSEWHERE) {
        const row: Row = { action, actorUserId: t.members.OWNER, organizationId: t.organizationId, workspaceId: t.workspaceId, targetType: action.startsWith("connection.") ? "connection" : action.includes("move") ? "asset_move" : "connected_account", targetId: t.account };
        expect(await sqlState(asMember(t.members.OWNER, t.workspaceId, row)), `${action} bound`).toMatchObject({ code: "42501" });
        expect(await sqlState(asMember(t.members.OWNER, undefined, row)), `${action} unbound`).toMatchObject({ code: "42501" });
      }
    });

    it("8. anon holds no INSERT (refused); anon, app_system and PUBLIC hold no audit privilege at all", async () => {
      const client = await privileged.connect();
      try {
        await client.query("begin");
        await client.query("set local role anon");
        await expect(client.query("insert into audit.audit_events (id, occurred_at, action, actor_type, organization_id, target_type, target_id, correlation_id, outcome) values (gen_random_uuid(), now(), 'organization.created', 'user', $1, 'organization', $1, 'h6c3d-anon-0001', 'succeeded')", [t.organizationId])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("rollback");
        client.release();
      }
      for (const role of ["anon", "app_system", "public"]) {
        expect((await privileged.query<{ ok: boolean }>("select has_table_privilege($1, 'audit.audit_events', 'INSERT') as ok", [role])).rows[0]?.ok, role).toBe(false);
      }
      const grants = (await privileged.query<{ grantee: string; privilege_type: string }>("select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'audit' and table_name = 'audit_events' and grantee <> 'app_owner' order by 1, 2")).rows;
      expect(grants).toEqual([{ grantee: "app_worker", privilege_type: "INSERT" }, { grantee: "authenticated", privilege_type: "INSERT" }]);
    });

    it("9. cross-workspace and cross-organization appends fail: foreign bound workspace, mismatched row, foreign organization", async () => {
      const other = await tenant();
      const before = [await auditCount(t.organizationId), await auditCount(other.organizationId)];
      const owner = t.members.OWNER;
      // t's Owner binds other's workspace (not a member there).
      expect(await sqlState(asMember(owner, other.workspaceId, { ...workspaceRow(other, owner, "workspace.mode_changed") }))).toMatchObject({ code: "42501" });
      // t's Owner, bound to t, writes a row naming other's workspace or organization.
      expect(await sqlState(asMember(owner, t.workspaceId, { ...workspaceRow(t, owner, "workspace.mode_changed"), workspaceId: other.workspaceId }))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(owner, t.workspaceId, { ...workspaceRow(t, owner, "workspace.mode_changed"), organizationId: other.organizationId }))).toMatchObject({ code: "42501" });
      // No organization at all.
      expect(await sqlState(asMember(owner, t.workspaceId, { ...workspaceRow(t, owner, "workspace.mode_changed"), organizationId: null }))).toMatchObject({ code: "42501" });
      // Organization-scoped events for an organization the actor isn't a member of, or naming a foreign workspace.
      expect(await sqlState(asMember(owner, undefined, { action: "organization_membership.role_changed", actorUserId: owner, organizationId: other.organizationId, workspaceId: null, targetType: "organization_membership", targetId: `${other.organizationId}:${other.members.ADMIN}` }))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(owner, undefined, { action: "workspace.created", actorUserId: owner, organizationId: t.organizationId, workspaceId: other.workspaceId, targetType: "workspace", targetId: other.workspaceId }))).toMatchObject({ code: "42501" });
      // User-scoped events for an organization the actor doesn't belong to.
      expect(await sqlState(asMember(owner, undefined, { action: "organization.created", actorUserId: owner, organizationId: other.organizationId, workspaceId: null, targetType: "organization", targetId: other.organizationId }))).toMatchObject({ code: "42501" });
      // A workspace-scoped action written without the bound workspace is refused too.
      expect(await sqlState(asMember(owner, undefined, workspaceRow(t, owner, "connection.removed")))).toMatchObject({ code: "42501" });
      expect([await auditCount(t.organizationId), await auditCount(other.organizationId)]).toEqual(before);
    });

    it("10–11. actor spoofing fails: another user's id, no user, or a non-user actor type", async () => {
      const owner = t.members.OWNER;
      const row = workspaceRow(t, owner, "workspace.mode_changed");
      expect(await sqlState(asMember(owner, t.workspaceId, { ...row, actorUserId: t.members.ADMIN }))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(owner, t.workspaceId, { ...row, actorUserId: null }))).toMatchObject({ code: "42501" });
      for (const actorType of ["system", "policy", "native_platform", "ai_assisted_user"]) {
        expect(await sqlState(asMember(owner, t.workspaceId, { ...row, actorType })), actorType).toMatchObject({ code: "42501" });
      }
    });

    it("21. the closed action vocabulary is unchanged: an unknown action is refused (RLS for members, the CHECK for the job runtime)", async () => {
      expect(await sqlState(asMember(t.members.OWNER, t.workspaceId, workspaceRow(t, t.members.OWNER, "workspace.deleted")))).toMatchObject({ code: "42501" });
      expect(await sqlState(withWorkspaceJobScope(worker, t.workspaceId, (tx) => insert(tx, { action: "workspace.deleted", actorType: "system", actorUserId: null, organizationId: t.organizationId, workspaceId: t.workspaceId, targetType: "workspace", targetId: t.workspaceId })))).toMatchObject({ code: "23514", constraint: "audit_events_action_check" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the pipeline's own events still append (and the documented residual)", () => {
    it("(a) every workspace-scoped pipeline action appends as a member of the sealed workspace", async () => {
      const t = await tenant();
      for (const action of PIPELINE_WORKSPACE_ACTIONS) await asMember(t.members.OWNER, t.workspaceId, workspaceRow(t, t.members.OWNER, action));
      expect(await auditCount(t.organizationId)).toBe(PIPELINE_WORKSPACE_ACTIONS.length);
    });

    it("(a) the actor's own removal from the workspace (no longer a member, still in the organization)", async () => {
      const t = await tenant();
      const leaver = t.members.ADMIN;
      await privileged.query("delete from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [t.workspaceId, leaver]);
      await asMember(leaver, t.workspaceId, { ...workspaceRow(t, leaver, "workspace_membership.removed"), targetId: `${t.workspaceId}:${leaver}` });
      // …but not someone else's removal, nor any other action, once out of the workspace.
      expect(await sqlState(asMember(leaver, t.workspaceId, { ...workspaceRow(t, leaver, "workspace_membership.removed"), targetId: `${t.workspaceId}:${t.members.OWNER}` }))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(leaver, t.workspaceId, workspaceRow(t, leaver, "workspace.mode_changed")))).toMatchObject({ code: "42501" });
    });

    it("(b) organization-scoped pipeline actions append for a member with no workspace bound; a named workspace must be the organization's", async () => {
      const t = await tenant();
      const admin = t.members.ADMIN;
      const org = { actorUserId: admin, organizationId: t.organizationId };
      await asMember(admin, undefined, { ...org, action: "workspace.created", workspaceId: t.workspaceId, targetType: "workspace", targetId: t.workspaceId });
      await asMember(admin, undefined, { ...org, action: "invitation.created", workspaceId: null, targetType: "invitation", targetId: randomUUID() });
      await asMember(admin, undefined, { ...org, action: "invitation.revoked", workspaceId: null, targetType: "invitation", targetId: randomUUID() });
      await asMember(admin, undefined, { ...org, action: "organization_membership.role_changed", workspaceId: null, targetType: "organization_membership", targetId: `${t.organizationId}:${t.members.MANAGER}` });
      await asMember(admin, undefined, { ...org, action: "workspace_membership.removed", workspaceId: t.workspaceId, targetType: "workspace_membership", targetId: `${t.workspaceId}:${t.members.MANAGER}` });
      await asMember(admin, undefined, { ...org, action: "organization_membership.removed", workspaceId: null, targetType: "organization_membership", targetId: `${t.organizationId}:${t.members.MANAGER}` });
      expect(await auditCount(t.organizationId)).toBe(6);
    });

    it("(b) the actor's own removal from the organization (and its workspaces): self-targeted records only", async () => {
      const t = await tenant();
      const leaver = t.members.ADMIN;
      await privileged.query("delete from tenancy.workspace_memberships where organization_id = $1 and user_id = $2", [t.organizationId, leaver]);
      await privileged.query("delete from tenancy.organization_memberships where organization_id = $1 and user_id = $2", [t.organizationId, leaver]);
      const org = { actorUserId: leaver, organizationId: t.organizationId };
      await asMember(leaver, undefined, { ...org, action: "workspace_membership.removed", workspaceId: t.workspaceId, targetType: "workspace_membership", targetId: `${t.workspaceId}:${leaver}` });
      await asMember(leaver, undefined, { ...org, action: "organization_membership.removed", workspaceId: null, targetType: "organization_membership", targetId: `${t.organizationId}:${leaver}` });
      expect(await sqlState(asMember(leaver, undefined, { ...org, action: "organization_membership.removed", workspaceId: null, targetType: "organization_membership", targetId: `${t.organizationId}:${t.members.OWNER}` }))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(leaver, undefined, { ...org, action: "organization_membership.role_changed", workspaceId: null, targetType: "organization_membership", targetId: `${t.organizationId}:${leaver}` }))).toMatchObject({ code: "42501" });
    });

    it("(c) user-scoped pipeline actions append for the actor's own membership", async () => {
      const t = await tenant();
      const owner = t.members.OWNER;
      await asMember(owner, undefined, { action: "organization.created", actorUserId: owner, organizationId: t.organizationId, workspaceId: null, targetType: "organization", targetId: t.organizationId });
      await asMember(t.members.RESPONDER, undefined, { action: "invitation.accepted", actorUserId: t.members.RESPONDER, organizationId: t.organizationId, workspaceId: t.workspaceId, targetType: "invitation", targetId: randomUUID() });
      expect(await auditCount(t.organizationId)).toBe(2);
    });

    it("RESIDUAL (documented): a member can still append a pipeline action in its own workspace; the authoritative emission is a later gate", async () => {
      const t = await tenant();
      // A Manager has no `workspace.mode.change`, yet the database can't tell this INSERT from the pipeline's.
      await asMember(t.members.MANAGER, t.workspaceId, workspaceRow(t, t.members.MANAGER, "workspace.mode_changed"));
      expect(await auditCount(t.organizationId)).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("reviewed producers are unchanged", () => {
    it("12–14. ingestion.request_reconciliation still writes run + audit + outbox atomically, attributed to the requesting human", async () => {
      const t = await tenant();
      const result = await withUserScope(web, { sub: t.members.ADMIN, role: "authenticated" }, t.workspaceId, (tx) =>
        createPostgresReconciliationStore(tx, () => undefined).requestRun({ connectedAccountId: t.account, correlationId: correlation(), requestedAt: null, budget: null }));
      expect(result.outcome).toBe("requested");
      if (result.outcome !== "requested") return;
      const audit = (await privileged.query("select actor_type, actor_user_id, target_type, target_id, outcome from audit.audit_events where organization_id = $1 and action = 'connected_account.reconciliation_requested'", [t.organizationId])).rows;
      expect(audit).toEqual([{ actor_type: "user", actor_user_id: t.members.ADMIN, target_type: "connected_account", target_id: t.account, outcome: "succeeded" }]);
      expect((await privileged.query("select initiator_type, initiator_user_id from ingestion.reconciliation_runs where id = $1", [result.runId])).rows).toEqual([{ initiator_type: "user", initiator_user_id: t.members.ADMIN }]);
      expect((await privileged.query<{ n: number }>("select count(*)::int as n from system.outbox where id = $1 and topic = 'ingestion.reconcile_account'", [result.outboxId])).rows[0]?.n).toBe(1);
      // A refused request (Manager) writes none of the three.
      expect(await sqlState(withUserScope(web, { sub: t.members.MANAGER, role: "authenticated" }, t.workspaceId, (tx) =>
        createPostgresReconciliationStore(tx, () => undefined).requestRun({ connectedAccountId: t.account, correlationId: correlation(), requestedAt: null, budget: null })))).toMatchObject({ code: "42501" });
      expect(await auditCount(t.organizationId)).toBe(1);
    });

    it("15. the job runtime still appends its own system events for its bound workspace — and still never as a user", async () => {
      const t = await tenant();
      await withWorkspaceJobScope(worker, t.workspaceId, (tx) => insert(tx, { action: "connection.validated", actorType: "system", actorUserId: null, organizationId: t.organizationId, workspaceId: t.workspaceId, targetType: "connection", targetId: t.workspaceId }));
      expect(await sqlState(withWorkspaceJobScope(worker, t.workspaceId, (tx) => insert(tx, { action: "connection.validated", actorType: "user", actorUserId: t.members.OWNER, organizationId: t.organizationId, workspaceId: t.workspaceId, targetType: "connection", targetId: t.workspaceId })))).toMatchObject({ code: "42501" });
      expect(await auditCount(t.organizationId)).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the ledger itself", () => {
    it("17–19. append-only: no runtime role reads, updates or deletes audit events", async () => {
      const t = await tenant();
      await asMember(t.members.OWNER, t.workspaceId, workspaceRow(t, t.members.OWNER, "workspace.mode_changed"));
      for (const statement of [sql`select count(*) from audit.audit_events`, sql`update audit.audit_events set outcome = 'failed' where organization_id = ${t.organizationId}`, sql`delete from audit.audit_events where organization_id = ${t.organizationId}`]) {
        expect(await sqlState(withUserScope(web, { sub: t.members.OWNER, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(statement)))).toMatchObject({ code: "42501" });
        expect(await sqlState(withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(statement)))).toMatchObject({ code: "42501" });
      }
      for (const role of ["authenticated", "app_worker", "app_system", "anon"]) {
        for (const privilege of ["SELECT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect((await privileged.query<{ ok: boolean }>("select has_table_privilege($1, 'audit.audit_events', $2) as ok", [role, privilege])).rows[0]?.ok, `${role} ${privilege}`).toBe(false);
        }
      }
      expect(await auditCount(t.organizationId)).toBe(1);
    });

    it("22–23. exactly one authenticated INSERT policy, append_own, whose admitted actions are exactly the pipeline's", async () => {
      const policies = (await privileged.query<{ policyname: string; permissive: string; roles: string; with_check: string }>(
        "select policyname, permissive, roles::text as roles, with_check from pg_policies where schemaname = 'audit' and tablename = 'audit_events' and cmd = 'INSERT' and (roles @> '{authenticated}' or roles @> '{public}')")).rows;
      expect(policies.map((p) => [p.policyname, p.permissive, p.roles])).toEqual([["append_own", "PERMISSIVE", "{authenticated}"]]);
      const admitted = new Set([...(policies[0]?.with_check ?? "").matchAll(/'([a-z_]+\.[a-z_]+)'::text/g)].map((m) => m[1]));
      expect([...admitted].sort()).toEqual([...new Set([...PIPELINE_WORKSPACE_ACTIONS, ...PIPELINE_ORGANIZATION_ACTIONS, ...PIPELINE_USER_ACTIONS])].sort());
      for (const action of COMMAND_BOUND_ELSEWHERE) expect(admitted.has(action), action).toBe(false);
    });

    it("the helper is a definer owned by app_owner with an empty search_path, executable by authenticated only", async () => {
      const [fn] = (await privileged.query<{ owner: string; secdef: boolean; config: string[] | null }>(
        "select pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'audit' and p.proname = 'bound_workspace_organization'")).rows;
      expect(fn).toEqual({ owner: "app_owner", secdef: true, config: ['search_path=""'] });
      for (const [role, expected] of [["authenticated", true], ["app_worker", false], ["app_system", false], ["anon", false], ["public", false]] as const) {
        expect((await privileged.query<{ ok: boolean }>("select has_function_privilege($1, 'audit.bound_workspace_organization()', 'EXECUTE') as ok", [role])).rows[0]?.ok, role).toBe(expected);
      }
    });

    it("the helper answers only to members: a non-member binding a foreign workspace learns nothing", async () => {
      const t = await tenant();
      const other = await tenant();
      const ask = (user: string, bound: string | undefined) => withUserScope(web, { sub: user, role: "authenticated" }, bound, async (tx) => (await tx.execute<{ o: string | null }>(sql`select audit.bound_workspace_organization() as o`)).rows[0]?.o ?? null);
      expect(await ask(t.members.CLIENT_GUEST, t.workspaceId)).toBe(t.organizationId);
      expect(await ask(t.members.OWNER, other.workspaceId)).toBeNull();
      expect(await ask(t.members.OWNER, randomUUID())).toBeNull();
      expect(await ask(t.members.OWNER, undefined)).toBeNull();
    });
  });
}
