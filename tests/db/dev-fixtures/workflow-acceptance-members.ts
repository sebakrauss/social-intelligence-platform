/**
 * W12-PREP-01 — membership provisioning and the audited U2 role sequence of the shared-dev Workflow acceptance fixture
 * (DEV-PREFLIGHT-01 §8: U1 OWNER of A and M; U2 MANAGER of B and RESPONDER → ANALYST_VIEWER → CLIENT_GUEST in A).
 *
 * Why a provisioning tool: the tenancy commands that would do this (invitations, tenancy.membership.change_role) are
 * composed in NO runtime (W12-UNBLOCK-01 F8). This module never impersonates a user, never forges claims and grants no
 * permission beyond the matrix: it writes membership rows with the migration role (like the fixture hierarchy and every
 * managed test bootstrap), and each ROLE CHANGE is written in ONE transaction with its audit event — the same action,
 * target and change shape the pipeline's `tenancy.membership.change_role` records — attributed to `system` (the
 * operator), never to a user.
 *
 * Safety:
 *   - both users must already exist in auth.users with a confirmed email (created by the PO through the app's own
 *     sign-up); the tool never creates, updates or deletes an auth user;
 *   - a user with ANY membership outside the synthetic organization is refused (the PO's real account can never be
 *     attached by mistake), and the fixture workspaces must hold no other member;
 *   - organization role MEMBER for both: no organization-level power (no workspace creation, no invitations);
 *   - grants are always empty (the role's defaults only);
 *   - every change states the role it expects to find (compare-and-set); only one step of the U2 sequence at a time;
 *   - no delete, reset or downgrade-to-previous path exists.
 */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { isAllowedU2Transition, U2_ROLE_SEQUENCE, type U2Role } from "@/tools/db/workflow-acceptance-guard";
import {
  descriptorProblems,
  fixtureContainment,
  fixtureStatus,
  inspectWorkflowAcceptanceFixture,
  isProtectedDescriptor,
  outsideDigest,
  W12_WORKFLOW_ACCEPTANCE_FIXTURE,
  workspaceIds,
  workspaceOf,
  type Containment,
  type Queryable,
  type WorkflowAcceptanceDescriptor,
  type WorkspaceKey,
} from "./workflow-acceptance";

export type MembersStatus =
  | "CREATE_ALL" | "RESUME_MEMBERS" | "ALREADY_PRESENT_MATCH" | "CREATED" | "RESUMED"
  | "REFUSED_PRECONDITION" | "REFUSED_UNKNOWN_USER" | "REFUSED_FOREIGN_MEMBERSHIP" | "MEMBERSHIP_CONFLICT" | "REFUSED_INVALID_DESCRIPTOR" | "REFUSED_PROTECTED_WORKSPACE";
export type RoleStatus = "READY" | "CHANGED" | "REFUSED_TRANSITION" | "REFUSED_PRECONDITION" | "REFUSED_INVALID_DESCRIPTOR" | "REFUSED_PROTECTED_WORKSPACE" | "POSTCONDITION_FAILED";

type Presence = "absent" | "match" | "mismatch";
const mask = (userId: string): string => `${userId.slice(0, 8)}…`;
const rowsOf = async <T extends pg.QueryResultRow>(db: Queryable, sql: string, values: unknown[]): Promise<readonly T[]> => (await db.query<T>(sql, values)).rows;
const countOf = async (db: Queryable, sql: string, values: unknown[]): Promise<number> => (await db.query<{ n: number }>(sql, values)).rows[0]?.n ?? -1;

interface ExpectedWorkspaceMembership { readonly key: WorkspaceKey; readonly user: "U1" | "U2"; readonly roles: readonly string[]; readonly initial: string }

/** The approved memberships. U2's role in A may be any step of its sequence (the A-03 changes happen in between). */
export const EXPECTED_WORKSPACE_MEMBERSHIPS: readonly ExpectedWorkspaceMembership[] = Object.freeze([
  { key: "A", user: "U1", roles: ["OWNER"], initial: "OWNER" },
  { key: "M", user: "U1", roles: ["OWNER"], initial: "OWNER" },
  { key: "A", user: "U2", roles: [...U2_ROLE_SEQUENCE], initial: "RESPONDER" },
  { key: "B", user: "U2", roles: ["MANAGER"], initial: "MANAGER" },
]);
export const ORGANIZATION_ROLE = "MEMBER";

export interface MembersInspection {
  readonly users: Readonly<Record<"U1" | "U2", { readonly exists: boolean; readonly confirmed: boolean; readonly foreignMemberships: number }>>;
  readonly organization: Readonly<Record<"U1" | "U2", Presence>>;
  readonly workspaces: readonly { readonly key: WorkspaceKey; readonly user: "U1" | "U2"; readonly presence: Presence; readonly role: string | null }[];
  readonly unexpectedMembers: number;
  readonly fixtureReady: boolean;
}

/** Where an auth user's existence and confirmation are read. */
export type UserDirectory = (db: Queryable, userId: string) => Promise<{ readonly exists: boolean; readonly confirmed: boolean }>;

/** auth.users (Supabase Auth) — read only: does the id exist, and is its email confirmed (it can sign in)? */
export const AUTH_USERS_DIRECTORY: UserDirectory = async (db, userId) => {
  const [row] = await rowsOf<{ confirmed: boolean }>(db, "select email_confirmed_at is not null as confirmed from auth.users where id = $1", [userId]);
  return row === undefined ? { exists: false, confirmed: false } : { exists: true, confirmed: row.confirmed };
};

export async function inspectMembers(db: Queryable, d: WorkflowAcceptanceDescriptor, u: Readonly<Record<"U1" | "U2", string>>, directory: UserDirectory = AUTH_USERS_DIRECTORY): Promise<MembersInspection> {
  const ids = workspaceIds(d);
  const fixtureReady = fixtureStatus(await inspectWorkflowAcceptanceFixture(db, d)) === "ALREADY_PRESENT_MATCH";
  const users = {} as Record<"U1" | "U2", { exists: boolean; confirmed: boolean; foreignMemberships: number }>;
  const organization = {} as Record<"U1" | "U2", Presence>;
  for (const key of ["U1", "U2"] as const) {
    const foreignMemberships = await countOf(db,
      `select ((select count(*) from tenancy.organization_memberships where user_id = $1 and organization_id <> $2)
             + (select count(*) from tenancy.workspace_memberships where user_id = $1 and not (workspace_id = any($3::uuid[]))))::int as n`, [u[key], d.organization.id, ids]);
    users[key] = { ...(await directory(db, u[key])), foreignMemberships };
    const org = await rowsOf<{ role: string }>(db, "select role from tenancy.organization_memberships where organization_id = $1 and user_id = $2", [d.organization.id, u[key]]);
    organization[key] = org.length === 0 ? "absent" : org.length === 1 && org[0]?.role === ORGANIZATION_ROLE ? "match" : "mismatch";
  }
  const workspaces: { key: WorkspaceKey; user: "U1" | "U2"; presence: Presence; role: string | null }[] = [];
  for (const expected of EXPECTED_WORKSPACE_MEMBERSHIPS) {
    const rows = await rowsOf<{ role: string; grants: string[] }>(db, "select role, grants from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2",
      [workspaceOf(d, expected.key).id, u[expected.user]]);
    const [row] = rows;
    const presence: Presence = row === undefined ? "absent" : rows.length === 1 && expected.roles.includes(row.role) && row.grants.length === 0 ? "match" : "mismatch";
    workspaces.push({ key: expected.key, user: expected.user, presence, role: row?.role ?? null });
  }
  // Anyone else in a fixture workspace or the organization (including U1 in B and U2 in M) is a conflict.
  const allowedPairs = EXPECTED_WORKSPACE_MEMBERSHIPS.map((e) => `${workspaceOf(d, e.key).id}:${u[e.user]}`);
  const unexpectedMembers = await countOf(db,
    `select ((select count(*) from tenancy.workspace_memberships where workspace_id = any($1::uuid[]) and not ((workspace_id::text || ':' || user_id::text) = any($2::text[])))
           + (select count(*) from tenancy.organization_memberships where organization_id = $3 and not (user_id = any($4::uuid[]))))::int as n`,
    [ids, allowedPairs, d.organization.id, [u.U1, u.U2]]);
  return { users, organization, workspaces, unexpectedMembers, fixtureReady };
}

export function membersStatus(i: MembersInspection): MembersStatus {
  if (!i.fixtureReady) return "REFUSED_PRECONDITION";
  if (!i.users.U1.exists || !i.users.U2.exists || !i.users.U1.confirmed || !i.users.U2.confirmed) return "REFUSED_UNKNOWN_USER";
  if (i.users.U1.foreignMemberships !== 0 || i.users.U2.foreignMemberships !== 0) return "REFUSED_FOREIGN_MEMBERSHIP";
  const states = [...Object.values(i.organization), ...i.workspaces.map((w) => w.presence)];
  if (i.unexpectedMembers !== 0 || states.includes("mismatch")) return "MEMBERSHIP_CONFLICT";
  if (states.every((s) => s === "absent")) return "CREATE_ALL";
  return states.every((s) => s === "match") ? "ALREADY_PRESENT_MATCH" : "RESUME_MEMBERS";
}

export interface MembersReport {
  readonly status: MembersStatus;
  readonly u1: string;
  readonly u2: string;
  readonly toCreate: readonly string[];
  readonly memberships: readonly { readonly workspace: WorkspaceKey; readonly user: "U1" | "U2"; readonly role: string | null; readonly presence: Presence }[];
  readonly users: MembersInspection["users"] | null;
  readonly unexpectedMembers: number;
  readonly outsideDigestBefore: string | null;
  readonly outsideDigestAfter: string | null;
}

const membersReport = (status: MembersStatus, u: Readonly<Record<"U1" | "U2", string>>, i: MembersInspection | null, outside: { before?: string; after?: string } = {}): MembersReport => ({
  status,
  u1: mask(u.U1),
  u2: mask(u.U2),
  toCreate: i === null ? [] : [
    ...(["U1", "U2"] as const).filter((k) => i.organization[k] === "absent").map((k) => `organization:${k}:${ORGANIZATION_ROLE}`),
    ...i.workspaces.filter((w) => w.presence === "absent").map((w) => `${w.key}:${w.user}:${EXPECTED_WORKSPACE_MEMBERSHIPS.find((e) => e.key === w.key && e.user === w.user)?.initial ?? "?"}`),
  ],
  memberships: i === null ? [] : i.workspaces.map((w) => ({ workspace: w.key, user: w.user, role: w.role, presence: w.presence })),
  users: i?.users ?? null,
  unexpectedMembers: i?.unexpectedMembers ?? 0,
  outsideDigestBefore: outside.before ?? null,
  outsideDigestAfter: outside.after ?? null,
});

async function inTransaction<T>(privileged: pg.Pool, isolation: "repeatable read, read only" | "serializable", work: (client: pg.PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  const client = await privileged.connect();
  try {
    await client.query(`begin isolation level ${isolation}`);
    const result = await work(client);
    await client.query(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const refusal = (d: WorkflowAcceptanceDescriptor): "REFUSED_INVALID_DESCRIPTOR" | "REFUSED_PROTECTED_WORKSPACE" | null =>
  descriptorProblems(d).length > 0 ? "REFUSED_INVALID_DESCRIPTOR" : isProtectedDescriptor(d) ? "REFUSED_PROTECTED_WORKSPACE" : null;

export async function planMembers(privileged: pg.Pool, u: Readonly<Record<"U1" | "U2", string>>, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE,
  directory: UserDirectory = AUTH_USERS_DIRECTORY): Promise<MembersReport> {
  const refused = refusal(d);
  if (refused !== null) return membersReport(refused, u, null);
  if (u.U1 === u.U2) return membersReport("REFUSED_UNKNOWN_USER", u, null);
  return inTransaction(privileged, "repeatable read, read only", async (c) => {
    const i = await inspectMembers(c, d, u, directory);
    return membersReport(membersStatus(i), u, i, { before: await outsideDigest(c, d) });
  }, false);
}

/** Inserts only the absent approved memberships, in ONE SERIALIZABLE transaction that re-inspects first and after. */
export async function applyMembers(privileged: pg.Pool, u: Readonly<Record<"U1" | "U2", string>>, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE,
  directory: UserDirectory = AUTH_USERS_DIRECTORY): Promise<MembersReport> {
  const plan = await planMembers(privileged, u, d, directory);
  if (plan.status !== "CREATE_ALL" && plan.status !== "RESUME_MEMBERS") return plan;
  return inTransaction(privileged, "serializable", async (c) => {
    const before = await inspectMembers(c, d, u, directory);
    const status = membersStatus(before);
    if (status !== "CREATE_ALL" && status !== "RESUME_MEMBERS") return membersReport(status, u, before);
    const outsideBefore = await outsideDigest(c, d);
    for (const key of ["U1", "U2"] as const) {
      if (before.organization[key] === "absent") {
        await c.query("insert into tenancy.organization_memberships (organization_id, user_id, role, created_at) values ($1, $2, $3, now())", [d.organization.id, u[key], ORGANIZATION_ROLE]);
      }
    }
    for (const w of before.workspaces.filter((m) => m.presence === "absent")) {
      const expected = EXPECTED_WORKSPACE_MEMBERSHIPS.find((e) => e.key === w.key && e.user === w.user);
      if (expected === undefined) throw new Error("membership_not_expected");
      await c.query("insert into tenancy.workspace_memberships (organization_id, workspace_id, user_id, role, grants, created_at) values ($1, $2, $3, $4, '{}', now())",
        [d.organization.id, workspaceOf(d, w.key).id, u[w.user], expected.initial]);
    }
    const after = await inspectMembers(c, d, u, directory);
    if (membersStatus(after) !== "ALREADY_PRESENT_MATCH") throw new Error("members_not_established");
    const outsideAfter = await outsideDigest(c, d);
    if (outsideAfter !== outsideBefore) throw new Error("outside_data_changed");
    return membersReport(status === "CREATE_ALL" ? "CREATED" : "RESUMED", u, after, { before: outsideBefore, after: outsideAfter });
  }, true);
}

export interface RoleReport {
  readonly status: RoleStatus;
  readonly u2: string;
  readonly from: U2Role;
  readonly to: U2Role;
  readonly reason: string | null;
  readonly currentRole: string | null;
  readonly auditEventId: string | null;
  readonly correlationId: string | null;
}

const roleReport = (status: RoleStatus, u2: string, from: U2Role, to: U2Role, reason: string | null, extra: Partial<Pick<RoleReport, "currentRole" | "auditEventId" | "correlationId">> = {}): RoleReport => ({
  status, u2: mask(u2), from, to, reason, currentRole: extra.currentRole ?? null, auditEventId: extra.auditEventId ?? null, correlationId: extra.correlationId ?? null,
});

async function roleDecision(db: Queryable, d: WorkflowAcceptanceDescriptor, u2: string, from: U2Role, to: U2Role): Promise<RoleReport> {
  if (!isAllowedU2Transition(from, to)) return roleReport("REFUSED_TRANSITION", u2, from, to, `only ${U2_ROLE_SEQUENCE.join(" → ")}, one step at a time`);
  const a = workspaceOf(d, "A");
  const rows = await rowsOf<{ role: string; grants: string[] }>(db, "select role, grants from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [a.id, u2]);
  const [row] = rows;
  if (row === undefined) return roleReport("REFUSED_PRECONDITION", u2, from, to, "U2 is not a member of A");
  if (row.role !== from || row.grants.length !== 0) return roleReport("REFUSED_PRECONDITION", u2, from, to, "U2's current role in A is not the expected one", { currentRole: row.role });
  // U2 must be the attached acceptance user: MANAGER of B, nothing outside the synthetic organization.
  const b = await rowsOf<{ role: string }>(db, "select role from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [workspaceOf(d, "B").id, u2]);
  const foreign = await countOf(db,
    `select ((select count(*) from tenancy.organization_memberships where user_id = $1 and organization_id <> $2)
           + (select count(*) from tenancy.workspace_memberships where user_id = $1 and not (workspace_id = any($3::uuid[]))))::int as n`, [u2, d.organization.id, workspaceIds(d)]);
  if (b[0]?.role !== "MANAGER" || foreign !== 0) return roleReport("REFUSED_PRECONDITION", u2, from, to, "the user is not the attached acceptance U2", { currentRole: row.role });
  return roleReport("READY", u2, from, to, null, { currentRole: row.role });
}

export async function planRole(privileged: pg.Pool, u2: string, from: U2Role, to: U2Role, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<RoleReport> {
  const refused = refusal(d);
  if (refused !== null) return roleReport(refused, u2, from, to, null);
  return inTransaction(privileged, "repeatable read, read only", (c) => roleDecision(c, d, u2, from, to), false);
}

/** One compare-and-set role change of U2 in A and its audit event, in ONE SERIALIZABLE transaction. */
export async function applyRole(privileged: pg.Pool, u2: string, from: U2Role, to: U2Role, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<RoleReport> {
  const plan = await planRole(privileged, u2, from, to, d);
  if (plan.status !== "READY") return plan;
  const a = workspaceOf(d, "A");
  const auditEventId = randomUUID();
  const correlationId = `w12-acceptance.role.${randomUUID()}`;
  return inTransaction(privileged, "serializable", async (c) => {
    const decision = await roleDecision(c, d, u2, from, to);
    if (decision.status !== "READY") return decision;
    const updated = await c.query("update tenancy.workspace_memberships set role = $4 where workspace_id = $1 and user_id = $2 and role = $3 and grants = '{}'", [a.id, u2, from, to]);
    if (updated.rowCount !== 1) throw new Error("role_compare_and_set_failed");
    // The pipeline's own record of tenancy.membership.change_role (server/commands/tenancy.ts), attributed to `system`.
    await c.query(
      `insert into audit.audit_events (id, occurred_at, action, actor_type, actor_user_id, organization_id, workspace_id, target_type, target_id, correlation_id, request_id, outcome, change)
       values ($1, now(), 'workspace_membership.role_changed', 'system', null, $2, $3, 'workspace_membership', $4, $5, null, 'succeeded', $6::jsonb)`,
      [auditEventId, d.organization.id, a.id, `${a.id}:${u2}`, correlationId,
        JSON.stringify({ kind: "workspace_membership", previous: { role: from, grants: [] }, current: { role: to, grants: [] } })]);
    const [after] = await rowsOf<{ role: string }>(c, "select role from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [a.id, u2]);
    const audited = await countOf(c, "select count(*)::int as n from audit.audit_events where correlation_id = $1 and action = 'workspace_membership.role_changed'", [correlationId]);
    if (after?.role !== to || audited !== 1) throw new Error("role_change_not_established");
    return roleReport("CHANGED", u2, from, to, null, { currentRole: to, auditEventId, correlationId });
  }, true);
}

export interface VerifyCheck { readonly name: string; readonly ok: boolean; readonly detail?: string }
export interface VerifyReport {
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
  readonly workItems: readonly { readonly workspace: WorkspaceKey; readonly conversation: string; readonly state: string; readonly version: number }[];
  readonly containment: Containment | null;
  readonly outsideDigest: string | null;
  readonly roleAuditEvents: number;
}

/** Read-only verification for W12-FIX/EXEC: identity, the approved memberships, negative access, containment. */
export async function verifyAcceptance(privileged: pg.Pool, u: Readonly<Record<"U1" | "U2", string>>, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE,
  directory: UserDirectory = AUTH_USERS_DIRECTORY): Promise<VerifyReport> {
  if (refusal(d) !== null || u.U1 === u.U2) return { ok: false, checks: [{ name: "descriptor and users", ok: false }], workItems: [], containment: null, outsideDigest: null, roleAuditEvents: 0 };
  return inTransaction(privileged, "repeatable read, read only", async (c) => {
    const fixture = await inspectWorkflowAcceptanceFixture(c, d);
    const members = await inspectMembers(c, d, u, directory);
    const role = async (key: WorkspaceKey, user: string): Promise<string | null> =>
      (await rowsOf<{ role: string }>(c, "select role from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [workspaceOf(d, key).id, user]))[0]?.role ?? null;
    const containment = await fixtureContainment(c, d);
    const checks: VerifyCheck[] = [
      { name: "fixture identity (stage 1)", ok: fixtureStatus(fixture) === "ALREADY_PRESENT_MATCH" },
      { name: "approved memberships present, nothing else", ok: membersStatus(members) === "ALREADY_PRESENT_MATCH" },
      { name: "U1 OWNER of A", ok: (await role("A", u.U1)) === "OWNER" },
      { name: "U1 OWNER of M (MONITOR_ONLY)", ok: (await role("M", u.U1)) === "OWNER" },
      { name: "U1 NOT a member of B", ok: (await role("B", u.U1)) === null },
      { name: "U2 MANAGER of B", ok: (await role("B", u.U2)) === "MANAGER" },
      { name: "U2 NOT a member of M", ok: (await role("M", u.U2)) === null },
      { name: "U1 and U2 have no membership outside the synthetic organization", ok: members.users.U1.foreignMemberships === 0 && members.users.U2.foreignMemberships === 0 },
      { name: "M is MONITOR_ONLY; A and B are STANDARD", ok: (await rowsOf<{ mode: string }>(c, "select mode from tenancy.workspaces where id = any($1::uuid[]) order by id", [workspaceIds(d)])).map((r) => r.mode).join(",") === "STANDARD,STANDARD,MONITOR_ONLY" },
      { name: "containment (allowed tables, interactions.observed only, no AI request)", ok: containment.ok },
      { name: "no credential, mutation intent or outbound reply in the fixture workspaces", ok: (await countOf(c,
        `select ((select count(*) from credentials.provider_credentials where workspace_id = any($1::uuid[]))
               + (select count(*) from mutations.mutation_intents where workspace_id = any($1::uuid[]))
               + (select count(*) from mutations.outbound_replies where workspace_id = any($1::uuid[])))::int as n`, [workspaceIds(d)])) === 0 },
    ];
    const u2a = await role("A", u.U2);
    checks.push({ name: "U2 role in A is a step of RESPONDER → ANALYST_VIEWER → CLIENT_GUEST", ok: u2a !== null && (U2_ROLE_SEQUENCE as readonly string[]).includes(u2a), detail: u2a ?? "none" });
    const workItems: { workspace: WorkspaceKey; conversation: string; state: string; version: number }[] = [];
    for (const root of fixture.roots) {
      if (root.conversationId === null) continue;
      const [row] = await rowsOf<{ state: string; version: number }>(c, "select state, version from workflow.work_items where workspace_id = $1 and id = $2", [workspaceOf(d, root.workspace).id, root.conversationId]);
      if (row !== undefined) workItems.push({ workspace: root.workspace, conversation: root.providerInteractionId, state: row.state, version: row.version });
    }
    const roleAuditEvents = await countOf(c, "select count(*)::int as n from audit.audit_events where workspace_id = $1 and action = 'workspace_membership.role_changed' and correlation_id like 'w12-acceptance.role.%'", [workspaceOf(d, "A").id]);
    return { ok: checks.every((check) => check.ok), checks, workItems, containment, outsideDigest: await outsideDigest(c, d), roleAuditEvents };
  }, false);
}

/** A stable digest of the approved memberships (for before/after evidence; user ids hashed, never printed). */
export async function membershipDigest(db: Queryable, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<string> {
  const rows = await rowsOf<{ t: string }>(db, "select string_agg(workspace_id::text || ':' || user_id::text || ':' || role, '|' order by workspace_id, user_id) as t from tenancy.workspace_memberships where workspace_id = any($1::uuid[])", [workspaceIds(d)]);
  return createHash("sha256").update(rows[0]?.t ?? "", "utf8").digest("hex").slice(0, 16);
}
