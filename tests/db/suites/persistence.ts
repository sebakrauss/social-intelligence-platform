/**
 * Step 1 behavior on the real database: the unchanged action pipeline and tenancy commands, wired to the
 * PostgreSQL unit of work (web login → authenticated → claims → sealed workspace) instead of in-memory
 * adapters. Proves persistence of organizations, workspaces, memberships, grants, mode and recipient-bound
 * invitations (digest only), audit in the same transaction, outbox atomicity, and that RLS accepts exactly
 * the writes the application performs — and nothing it doesn't.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@/domain/access";
import { AppError } from "@/domain/errors";
import { parseUserId, type OrganizationId, type UserId, type WorkspaceId } from "@/domain/ids";
import { opaqueTokens } from "@/platform/crypto";
import { withUserScope, type RuntimeDatabase } from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { createLogger } from "@/platform/observability";
import { createTenancyCommands } from "@/server/commands/tenancy";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type UserCommand, type WorkspaceCommand } from "@/server/pipeline";
import { object } from "@/domain/validation";
import { CapturingDelivery, FakeIdentity, verifiedUser } from "../../support/in-memory";
import { errorCode, expectOk } from "../../support/harness";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const newUser = (): UserId => {
  const id = parseUserId(randomUUID());
  if (id === undefined) throw new Error("uuid");
  return id;
};
const emailFor = (user: UserId): string => `user-${user.slice(0, 8)}@example.test`;

export function definePersistenceSuite(getTarget: () => DbTarget): void {
  let target: DbTarget;
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let system: RuntimeDatabase<"system">;
  const organizations: string[] = [];
  const identity = new FakeIdentity();
  const delivery = new CapturingDelivery();
  const logLines: string[] = [];
  const commands = createTenancyCommands({ tokens: opaqueTokens, delivery });
  let pipeline: ReturnType<typeof createActionPipeline>;

  const as = (user: UserId, email: string = emailFor(user)): void => {
    identity.user = verifiedUser(user, email);
  };
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> =>
    (await privileged.query<T>(query, [...values])).rows;

  beforeAll(() => {
    target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 2);
    system = runtimeDatabase(target, "system", 1);
    pipeline = createActionPipeline({
      identity,
      unitOfWork: createPostgresUnitOfWork(web),
      clock: () => new Date(),
      newId: randomUUID,
      logger: createLogger({ sink: (line) => logLines.push(line), now: () => new Date() }),
    });
  });

  afterAll(async () => {
    await Promise.all([web.end(), system.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  async function createOrganization(owner: UserId): Promise<OrganizationId> {
    as(owner);
    const { organizationId } = expectOk(await pipeline.run(commands.createOrganization, { input: { name: "Organization" } }));
    organizations.push(organizationId);
    return organizationId;
  }

  async function createWorkspace(creator: UserId, organizationId: OrganizationId): Promise<WorkspaceId> {
    as(creator);
    return expectOk(await pipeline.run(commands.createWorkspace, { organizationId, input: { name: "Workspace" } })).workspaceId;
  }

  async function addMember(inviter: UserId, workspaceId: WorkspaceId, user: UserId, role: WorkspaceRole, grants?: readonly string[]): Promise<void> {
    as(inviter);
    expectOk(await pipeline.run(commands.inviteToWorkspace, {
      workspaceId,
      input: grants === undefined ? { recipientEmail: emailFor(user), role } : { recipientEmail: emailFor(user), role, grants },
    }));
    as(user);
    expectOk(await pipeline.run(commands.acceptInvitation, { input: { token: delivery.delivered.at(-1)?.rawToken } }));
  }

  describe("tenancy persistence through the action pipeline", () => {
    it("creates an organization and its first Owner, a workspace and its first Owner, with audit rows in the same transactions", async () => {
      const owner = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      expect(await oracle("select role from tenancy.organization_memberships where organization_id = $1", [organizationId])).toEqual([{ role: "OWNER" }]);
      expect(await oracle("select role, grants from tenancy.workspace_memberships where workspace_id = $1", [workspaceId])).toEqual([{ role: "OWNER", grants: [] }]);
      expect(await oracle("select mode from tenancy.workspaces where id = $1", [workspaceId])).toEqual([{ mode: "STANDARD" }]);
      const audit = await oracle<{ action: string; actor_user_id: string }>("select action, actor_user_id from audit.audit_events where organization_id = $1 order by occurred_at, action", [organizationId]);
      expect(audit.map((row) => row.action).sort()).toEqual(["organization.created", "workspace.created"]);
      expect(audit.every((row) => row.actor_user_id === owner)).toBe(true);
    });

    it("an organization Admin who creates a workspace becomes its only Owner, without organization authority", async () => {
      const owner = newUser();
      const admin = newUser();
      const organizationId = await createOrganization(owner);
      as(owner);
      expectOk(await pipeline.run(commands.inviteToOrganization, { organizationId, input: { recipientEmail: emailFor(admin), role: "ADMIN" } }));
      as(admin);
      expectOk(await pipeline.run(commands.acceptInvitation, { input: { token: delivery.delivered.at(-1)?.rawToken } }));
      const workspaceId = await createWorkspace(admin, organizationId);
      expect(await oracle("select user_id::text, role from tenancy.workspace_memberships where workspace_id = $1", [workspaceId])).toEqual([{ user_id: admin, role: "OWNER" }]);
      as(admin);
      expect(errorCode(await pipeline.run(commands.changeOrganizationMemberRole, { organizationId, input: { userId: admin, role: "OWNER" } }))).toBe("PERMISSION_DENIED");
      expect(await oracle("select role from tenancy.organization_memberships where organization_id = $1 and user_id = $2", [organizationId, admin])).toEqual([{ role: "ADMIN" }]);
    });

    it("persists mode changes, roles and grants with closed-vocabulary before/after audit summaries", async () => {
      const owner = newUser();
      const responder = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      await addMember(owner, workspaceId, responder, "RESPONDER");
      as(owner);
      expectOk(await pipeline.run(commands.changeWorkspaceMode, { workspaceId, input: { mode: "MONITOR_ONLY" } }));
      expectOk(await pipeline.run(commands.setMemberGrants, { workspaceId, input: { userId: responder, grants: ["moderate.delete"] } }));
      expectOk(await pipeline.run(commands.changeMemberRole, { workspaceId, input: { userId: responder, role: "MANAGER" } }));
      expect(await oracle("select mode from tenancy.workspaces where id = $1", [workspaceId])).toEqual([{ mode: "MONITOR_ONLY" }]);
      expect(await oracle("select role, grants from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [workspaceId, responder]))
        .toEqual([{ role: "MANAGER", grants: [] }]);
      const changes = await oracle<{ action: string; change: unknown }>(
        "select action, change from audit.audit_events where workspace_id = $1 and change is not null order by recorded_at, action", [workspaceId]);
      expect(changes).toEqual([
        { action: "workspace.mode_changed", change: { kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" } },
        { action: "workspace_membership.grants_changed", change: { kind: "workspace_membership", previous: { role: "RESPONDER", grants: [] }, current: { role: "RESPONDER", grants: ["moderate.delete"] } } },
        { action: "workspace_membership.role_changed", change: { kind: "workspace_membership", previous: { role: "RESPONDER", grants: ["moderate.delete"] }, current: { role: "MANAGER", grants: [] } } },
      ]);
    });

    it("stores only the invitation digest, binds acceptance to the recipient, and consumes the invitation once", async () => {
      const owner = newUser();
      const invitee = newUser();
      const stranger = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      as(owner);
      const { invitationId } = expectOk(await pipeline.run(commands.inviteToWorkspace, {
        workspaceId,
        input: { recipientEmail: emailFor(invitee), role: "RESPONDER", grants: ["moderate.delete"] },
      }));
      const raw = delivery.delivered.at(-1)?.rawToken ?? "";
      const stored = await oracle<Record<string, unknown>>("select * from tenancy.invitations where id = $1", [invitationId]);
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(raw);
      expect(stored[0]?.["token_digest"]).toBe(opaqueTokens.digest(raw));
      // Nothing anywhere in the audit or outbox mentions the email or the raw token.
      const ledgers = JSON.stringify(await oracle("select * from audit.audit_events where organization_id = $1", [organizationId]));
      expect(ledgers).not.toContain(raw);
      expect(ledgers).not.toContain("@");

      // A forwarded invitation (someone else's verified email) is NOT_FOUND and stays pending.
      as(stranger);
      expect(errorCode(await pipeline.run(commands.acceptInvitation, { input: { token: raw } }))).toBe("NOT_FOUND");
      expect(await oracle("select status from tenancy.invitations where id = $1", [invitationId])).toEqual([{ status: "PENDING" }]);
      expect(await oracle("select 1 from tenancy.organization_memberships where organization_id = $1 and user_id = $2", [organizationId, stranger])).toEqual([]);

      as(invitee);
      expect(expectOk(await pipeline.run(commands.acceptInvitation, { input: { token: raw } })).outcome).toBe("joined");
      expect(await oracle("select role, grants from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [workspaceId, invitee]))
        .toEqual([{ role: "RESPONDER", grants: ["moderate.delete"] }]);
      expect(await oracle("select status, accepted_by::text from tenancy.invitations where id = $1", [invitationId])).toEqual([{ status: "ACCEPTED", accepted_by: invitee }]);
      expect(errorCode(await pipeline.run(commands.acceptInvitation, { input: { token: raw } }))).toBe("NOT_FOUND");
    });

    it("refuses to join without presenting a pending invitation, even by raw SQL under the runtime role", async () => {
      const owner = newUser();
      const intruder = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      const joinOrg = withUserScope(web, { sub: intruder }, undefined, (tx) =>
        tx.execute(sql`insert into tenancy.organization_memberships values (${organizationId}, ${intruder}, 'MEMBER', now())`));
      expect((await sqlState(joinOrg)).code).toBe("42501");
      const claimOwner = withUserScope(web, { sub: intruder }, undefined, (tx) =>
        tx.execute(sql`insert into tenancy.organization_memberships values (${organizationId}, ${intruder}, 'OWNER', now())`));
      expect((await sqlState(claimOwner)).code).toBe("42501");
      const joinWorkspace = withUserScope(web, { sub: intruder }, workspaceId, (tx) =>
        tx.execute(sql`insert into tenancy.workspace_memberships values (${organizationId}, ${workspaceId}, ${intruder}, 'MANAGER', '{}', now())`));
      expect((await sqlState(joinWorkspace)).code).toBe("42501");
    });

    it("removes an organization member and each workspace membership, auditing every removal", async () => {
      const owner = newUser();
      const member = newUser();
      const organizationId = await createOrganization(owner);
      const workspaces = [await createWorkspace(owner, organizationId), await createWorkspace(owner, organizationId), await createWorkspace(owner, organizationId)];
      for (const workspaceId of workspaces) await addMember(owner, workspaceId, member, "ANALYST_VIEWER");
      as(owner);
      expectOk(await pipeline.run(commands.removeOrganizationMember, { organizationId, input: { userId: member } }));
      expect(await oracle("select 1 from tenancy.workspace_memberships where user_id = $1", [member])).toEqual([]);
      expect(await oracle("select 1 from tenancy.organization_memberships where user_id = $1", [member])).toEqual([]);
      const removals = await oracle<{ action: string; workspace_id: string | null }>(
        "select action, workspace_id::text from audit.audit_events where target_id like '%' || $1 and action like '%.removed'", [member]);
      expect(removals.filter((row) => row.action === "organization_membership.removed")).toHaveLength(1);
      expect(removals.filter((row) => row.action === "workspace_membership.removed").map((row) => row.workspace_id).sort()).toEqual([...workspaces].sort());
    });

    it("maps the database last-Owner refusal to CONFLICT and leaves everything unchanged", async () => {
      const owner = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      as(owner);
      expect(errorCode(await pipeline.run(commands.changeMemberRole, { workspaceId, input: { userId: owner, role: "ADMIN" } }))).toBe("CONFLICT");
      expect(errorCode(await pipeline.run(commands.removeOrganizationMember, { organizationId, input: { userId: owner } }))).toBe("CONFLICT");
      // The database enforces it even if the application check were bypassed.
      const direct = withUserScope(web, { sub: owner }, workspaceId, (tx) =>
        tx.execute(sql`update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = ${workspaceId} and user_id = ${owner}`));
      expect(await sqlState(direct)).toEqual({ code: "23514", constraint: "workspace_keeps_an_owner" });
      expect(await oracle("select role from tenancy.workspace_memberships where workspace_id = $1", [workspaceId])).toEqual([{ role: "OWNER" }]);
    });

    it("never reveals another tenant: foreign workspace commands are NOT_FOUND", async () => {
      const ownerA = newUser();
      const ownerB = newUser();
      await createOrganization(ownerA);
      const orgB = await createOrganization(ownerB);
      const workspaceB = await createWorkspace(ownerB, orgB);
      as(ownerA);
      expect(errorCode(await pipeline.run(commands.changeWorkspaceMode, { workspaceId: workspaceB, input: { mode: "MONITOR_ONLY" } }))).toBe("NOT_FOUND");
      expect(errorCode(await pipeline.run(commands.inviteToOrganization, { organizationId: orgB, input: { recipientEmail: emailFor(ownerA), role: "ADMIN" } }))).toBe("NOT_FOUND");
      expect(await oracle("select mode from tenancy.workspaces where id = $1", [workspaceB])).toEqual([{ mode: "STANDARD" }]);
    });
  });

  describe("one transaction: state + audit + outbox", () => {
    const probe = (fail: boolean): WorkspaceCommand<object, { readonly workspaceId: WorkspaceId; readonly userId: UserId }, string> => ({
      scope: "workspace",
      name: "test.outbox_probe",
      permission: "workspace.mode.change",
      requiresStandardMode: false,
      validate: object({}),
      async execute(context, _input, tx, env) {
        await tx.tenancy.workspaces.update({ ...context.workspace, mode: "MONITOR_ONLY" });
        await tx.outbox.append({
          id: randomUUID(),
          topic: "test.outbox_probe",
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
          subjectIds: { workspace_id: context.workspaceId },
          correlationId: env.correlationId,
          initiator: { type: "user", userId: context.userId },
          dispatchKey: `probe:${randomUUID()}`,
          createdAt: env.now,
        });
        if (fail) throw new AppError("CONFLICT", {});
        return { workspaceId: context.workspaceId, userId: context.userId };
      },
      audit: ({ workspaceId }) => ({
        action: "workspace.mode_changed",
        targetType: "workspace",
        targetId: workspaceId,
        change: { kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY" },
      }),
      respond: () => "ok",
    });

    it("commits the state change, its audit event and its outbox row together", async () => {
      const owner = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      as(owner);
      expectOk(await pipeline.run(probe(false), { workspaceId, input: {} }));
      expect(await oracle("select mode from tenancy.workspaces where id = $1", [workspaceId])).toEqual([{ mode: "MONITOR_ONLY" }]);
      expect(await oracle("select topic, status, subject_ids from system.outbox where workspace_id = $1", [workspaceId]))
        .toEqual([{ topic: "test.outbox_probe", status: "PENDING", subject_ids: { workspace_id: workspaceId } }]);
      expect(await oracle("select 1 from audit.audit_events where workspace_id = $1 and action = 'workspace.mode_changed'", [workspaceId])).toHaveLength(1);
    });

    it("rolls back the state change, audit and outbox together when the command fails", async () => {
      const owner = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      as(owner);
      expect(errorCode(await pipeline.run(probe(true), { workspaceId, input: {} }))).toBe("CONFLICT");
      expect(await oracle("select mode from tenancy.workspaces where id = $1", [workspaceId])).toEqual([{ mode: "STANDARD" }]);
      expect(await oracle("select 1 from system.outbox where workspace_id = $1", [workspaceId])).toEqual([]);
      expect(await oracle("select 1 from audit.audit_events where workspace_id = $1 and action = 'workspace.mode_changed'", [workspaceId])).toEqual([]);
    });

    it("web users can append but never read the outbox; the system role reads delivery metadata only", async () => {
      const owner = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      as(owner);
      expectOk(await pipeline.run(probe(false), { workspaceId, input: {} }));
      const read = withUserScope(web, { sub: owner }, workspaceId, (tx) => tx.execute(sql`select * from system.outbox`));
      expect((await sqlState(read)).code).toBe("42501");
      const seen = await withSystemScope(system, (tx) =>
        tx.execute<{ topic: string }>(sql`select topic from system.outbox where workspace_id = ${workspaceId}`));
      expect(seen.rows).toEqual([{ topic: "test.outbox_probe" }]);
      // Non-identifier subject values are refused by the database too (IDs only, by construction).
      const leaky = withUserScope(web, { sub: owner }, workspaceId, (tx) =>
        tx.execute(sql`insert into system.outbox (id, topic, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, created_at)
          values (${randomUUID()}, 'test.outbox_probe', ${workspaceId}, ${JSON.stringify({ email: "person@example.test" })}::jsonb, 'corr-leaky-outbox', 'user', ${owner}, ${`probe:${randomUUID()}`}, now())`));
      expect((await sqlState(leaky)).code).toBe("23514");
    });

    it("the database refuses free-form or personal data in audit change summaries", async () => {
      const owner = newUser();
      const organizationId = await createOrganization(owner);
      const workspaceId = await createWorkspace(owner, organizationId);
      const leaky = withUserScope(web, { sub: owner }, workspaceId, (tx) =>
        tx.execute(sql`insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, workspace_id, target_type, target_id, correlation_id, outcome, change)
          values (${randomUUID()}, now(), 'workspace.mode_changed', 'user', ${owner}, ${workspaceId}, 'workspace', ${workspaceId}, 'corr-leaky-audit', 'succeeded',
                  ${JSON.stringify({ kind: "workspace_mode", previous: "STANDARD", current: "MONITOR_ONLY", note: "person@example.test" })}::jsonb)`));
      expect((await sqlState(leaky)).code).toBe("23514");
    });
  });

  describe("user-scoped commands without a pipeline-registered workspace", () => {
    it("a user command never binds a workspace", async () => {
      const owner = newUser();
      const organizationId = await createOrganization(owner);
      const probe: UserCommand<object, string | null, string | null> = {
        scope: "user",
        name: "test.no_binding",
        validate: object({}),
        execute: async (_context, _input, tx) => {
          const organization = await tx.tenancy.organizations.get(organizationId);
          return organization?.id ?? null;
        },
        audit: () => undefined,
        respond: (value) => value,
      };
      as(owner);
      expect(expectOk(await pipeline.run(probe, { input: {}, workspaceId: randomUUID() }))).toBe(organizationId);
    });
  });
}
