/**
 * PostgreSQL implementation of the tenancy store, used inside a tenant-scoped transaction (platform/db
 * scope helpers). Every statement runs under forced RLS as the transaction's runtime role, so a row the
 * caller may not see is simply absent. Rows are parsed back into domain types strictly: a value outside
 * the stable vocabularies is treated as corruption, never passed on.
 *
 * Invitation lookup by token digest goes through app.present_invitation(): it binds the presented
 * invitation to this transaction (sealed), which is what lets the not-yet-member accept it under RLS.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { isOrganizationRole, isPermissionKey, isWorkspaceMode, isWorkspaceRole, type PermissionKey } from "@/domain/access";
import { parseInvitationId, parseOrganizationId, parseUserId, parseWorkspaceId, type InvitationId } from "@/domain/ids";
import type { DatabaseTransaction } from "@/platform/db";
import type { TenancyStore } from "../application/ports";
import type { Invitation, InvitationStatus, Organization, OrganizationMembership, Workspace, WorkspaceMembership } from "../domain/model";
import { invitations, organizationMemberships, organizations, workspaceMemberships, workspaces } from "./tables";

function corrupt(table: string): never {
  throw new TypeError(`tenancy persistence: unexpected value in ${table}`);
}

function required<T>(value: T | undefined, table: string): T {
  return value === undefined ? corrupt(table) : value;
}

function grantsOf(values: readonly string[], table: string): PermissionKey[] {
  return values.map((value) => (isPermissionKey(value) ? value : corrupt(table)));
}

const INVITATION_STATUSES: readonly string[] = ["PENDING", "ACCEPTED", "REVOKED"];

function toOrganization(row: typeof organizations.$inferSelect): Organization {
  return { id: required(parseOrganizationId(row.id), "organizations"), name: row.name, createdAt: row.createdAt };
}

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: required(parseWorkspaceId(row.id), "workspaces"),
    organizationId: required(parseOrganizationId(row.organizationId), "workspaces"),
    name: row.name,
    mode: isWorkspaceMode(row.mode) ? row.mode : corrupt("workspaces"),
    createdAt: row.createdAt,
  };
}

function toOrganizationMembership(row: typeof organizationMemberships.$inferSelect): OrganizationMembership {
  return {
    organizationId: required(parseOrganizationId(row.organizationId), "organization_memberships"),
    userId: required(parseUserId(row.userId), "organization_memberships"),
    role: isOrganizationRole(row.role) ? row.role : corrupt("organization_memberships"),
    createdAt: row.createdAt,
  };
}

function toWorkspaceMembership(row: typeof workspaceMemberships.$inferSelect): WorkspaceMembership {
  return {
    organizationId: required(parseOrganizationId(row.organizationId), "workspace_memberships"),
    workspaceId: required(parseWorkspaceId(row.workspaceId), "workspace_memberships"),
    userId: required(parseUserId(row.userId), "workspace_memberships"),
    role: isWorkspaceRole(row.role) ? row.role : corrupt("workspace_memberships"),
    grants: grantsOf(row.grants, "workspace_memberships"),
    createdAt: row.createdAt,
  };
}

function toInvitation(row: typeof invitations.$inferSelect): Invitation {
  const table = "invitations";
  let target: Invitation["target"];
  if (row.targetKind === "organization" && row.workspaceId === null) {
    target = { kind: "organization", role: isOrganizationRole(row.role) ? row.role : corrupt(table) };
  } else if (row.targetKind === "workspace" && row.workspaceId !== null) {
    target = {
      kind: "workspace",
      workspaceId: required(parseWorkspaceId(row.workspaceId), table),
      role: isWorkspaceRole(row.role) ? row.role : corrupt(table),
      grants: grantsOf(row.grants, table),
    };
  } else {
    corrupt(table);
  }
  const acceptedBy = row.acceptedBy === null ? undefined : required(parseUserId(row.acceptedBy), table);
  return {
    id: required(parseInvitationId(row.id), table),
    organizationId: required(parseOrganizationId(row.organizationId), table),
    target,
    recipientEmail: row.recipientEmail,
    tokenDigest: row.tokenDigest,
    invitedBy: required(parseUserId(row.invitedBy), table),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: INVITATION_STATUSES.includes(row.status) ? (row.status as InvitationStatus) : corrupt(table),
    ...(acceptedBy === undefined ? {} : { acceptedBy }),
    ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
  };
}

export function createPostgresTenancyStore(tx: DatabaseTransaction): TenancyStore {
  const invitationById = async (id: InvitationId): Promise<Invitation | undefined> => {
    const [row] = await tx.select().from(invitations).where(eq(invitations.id, id));
    return row === undefined ? undefined : toInvitation(row);
  };

  return {
    organizations: {
      async get(id) {
        const [row] = await tx.select().from(organizations).where(eq(organizations.id, id));
        return row === undefined ? undefined : toOrganization(row);
      },
      async insert(organization) {
        await tx.insert(organizations).values({ id: organization.id, name: organization.name, createdAt: organization.createdAt });
      },
    },

    workspaces: {
      async get(id) {
        const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id));
        return row === undefined ? undefined : toWorkspace(row);
      },
      async insert(workspace) {
        await tx.insert(workspaces).values({
          id: workspace.id,
          organizationId: workspace.organizationId,
          name: workspace.name,
          mode: workspace.mode,
          createdAt: workspace.createdAt,
        });
      },
      async update(workspace) {
        // Only the mode is mutable (column-level grant); identity and organization never move.
        await tx.update(workspaces).set({ mode: workspace.mode }).where(eq(workspaces.id, workspace.id));
      },
    },

    organizationMemberships: {
      async find(organizationId, userId) {
        const [row] = await tx
          .select()
          .from(organizationMemberships)
          .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)));
        return row === undefined ? undefined : toOrganizationMembership(row);
      },
      async insert(membership) {
        await tx.insert(organizationMemberships).values({
          organizationId: membership.organizationId,
          userId: membership.userId,
          role: membership.role,
          createdAt: membership.createdAt,
        });
      },
      async update(membership) {
        await tx
          .update(organizationMemberships)
          .set({ role: membership.role })
          .where(and(eq(organizationMemberships.organizationId, membership.organizationId), eq(organizationMemberships.userId, membership.userId)));
      },
      async remove(organizationId, userId) {
        await tx
          .delete(organizationMemberships)
          .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)));
      },
      async countWithRole(organizationId, role) {
        const [row] = await tx
          .select({ value: count() })
          .from(organizationMemberships)
          .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.role, role)));
        return row?.value ?? 0;
      },
    },

    workspaceMemberships: {
      async find(workspaceId, userId) {
        const [row] = await tx
          .select()
          .from(workspaceMemberships)
          .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, userId)));
        return row === undefined ? undefined : toWorkspaceMembership(row);
      },
      async insert(membership) {
        await tx.insert(workspaceMemberships).values({
          organizationId: membership.organizationId,
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role,
          grants: [...membership.grants],
          createdAt: membership.createdAt,
        });
      },
      async update(membership) {
        await tx
          .update(workspaceMemberships)
          .set({ role: membership.role, grants: [...membership.grants] })
          .where(and(eq(workspaceMemberships.workspaceId, membership.workspaceId), eq(workspaceMemberships.userId, membership.userId)));
      },
      async remove(workspaceId, userId) {
        await tx.delete(workspaceMemberships).where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.userId, userId)));
      },
      async countWithRole(workspaceId, role) {
        const [row] = await tx
          .select({ value: count() })
          .from(workspaceMemberships)
          .where(and(eq(workspaceMemberships.workspaceId, workspaceId), eq(workspaceMemberships.role, role)));
        return row?.value ?? 0;
      },
      async listForUser(organizationId, userId) {
        const rows = await tx
          .select()
          .from(workspaceMemberships)
          .where(and(eq(workspaceMemberships.organizationId, organizationId), eq(workspaceMemberships.userId, userId)))
          .orderBy(workspaceMemberships.workspaceId);
        return rows.map(toWorkspaceMembership);
      },
    },

    invitations: {
      get: invitationById,
      async findByTokenDigest(digest) {
        const result = await tx.execute<{ id: string | null }>(sql`select app.present_invitation(${digest}) as id`);
        const id = parseInvitationId(result.rows[0]?.id);
        return id === undefined ? undefined : invitationById(id);
      },
      async insert(invitation) {
        const target = invitation.target;
        await tx.insert(invitations).values({
          id: invitation.id,
          organizationId: invitation.organizationId,
          targetKind: target.kind,
          workspaceId: target.kind === "workspace" ? target.workspaceId : null,
          role: target.role,
          grants: target.kind === "workspace" ? [...target.grants] : [],
          recipientEmail: invitation.recipientEmail,
          tokenDigest: invitation.tokenDigest,
          invitedBy: invitation.invitedBy,
          createdAt: invitation.createdAt,
          expiresAt: invitation.expiresAt,
          status: invitation.status,
          acceptedBy: invitation.acceptedBy ?? null,
          closedAt: invitation.closedAt ?? null,
        });
      },
      async update(invitation) {
        // Only the lifecycle columns change (column-level grant); target, recipient and digest are immutable.
        await tx
          .update(invitations)
          .set({ status: invitation.status, acceptedBy: invitation.acceptedBy ?? null, closedAt: invitation.closedAt ?? null })
          .where(eq(invitations.id, invitation.id));
      },
    },
  };
}
