/**
 * Tenancy model (TA §9; Model §4; PD D-44 / C-11). The workspace is the primary operational, access
 * and intelligence boundary. Membership is the only source of access and is read live on every
 * consequential request; it is never cached in token claims.
 */
import type { OrganizationRole, PermissionKey, WorkspaceMode, WorkspaceRole } from "@/domain/access";
import { sameEmail, type VerifiedEmail } from "@/domain/email";
import type { InvitationId, OrganizationId, UserId, WorkspaceId } from "@/domain/ids";

/** Workspace operating modes (PD D-49; IA-11), defined in the shared kernel. */
export { WORKSPACE_MODES, isWorkspaceMode, type WorkspaceMode } from "@/domain/access";

export interface Organization {
  readonly id: OrganizationId;
  readonly name: string;
  readonly createdAt: Date;
}

export interface Workspace {
  readonly id: WorkspaceId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly mode: WorkspaceMode;
  readonly createdAt: Date;
}

export interface OrganizationMembership {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrganizationRole;
  readonly createdAt: Date;
}

/** An explicit permission added to a workspace membership beyond its role defaults. */
export type PermissionGrant = PermissionKey;

export interface WorkspaceMembership {
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly grants: readonly PermissionGrant[];
  readonly createdAt: Date;
}

export type InvitationTarget =
  | { readonly kind: "organization"; readonly role: OrganizationRole }
  | {
      readonly kind: "workspace";
      readonly workspaceId: WorkspaceId;
      readonly role: WorkspaceRole;
      readonly grants: readonly PermissionGrant[];
    };

export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED";

/** Approved MVP default lifetime of an invitation (not a commercial-plan decision). */
export const DEFAULT_INVITATION_TTL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function invitationExpiresAt(issuedAt: Date, ttlDays: number = DEFAULT_INVITATION_TTL_DAYS): Date {
  return new Date(issuedAt.getTime() + ttlDays * DAY_MS);
}

/**
 * Single-use, expiring invitation (TA §10.2), bound to its intended recipient. Only the one-way digest
 * of the delivered token is held. The recipient address (normalized) is used for delivery and for
 * matching the accepting user's verified email; it is never logged or audited.
 */
export interface Invitation {
  readonly id: InvitationId;
  readonly organizationId: OrganizationId;
  readonly target: InvitationTarget;
  readonly recipientEmail: string;
  readonly tokenDigest: string;
  readonly invitedBy: UserId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: InvitationStatus;
  readonly acceptedBy?: UserId;
  readonly closedAt?: Date;
}

export type InvitationAvailability = "acceptable" | "expired" | "accepted" | "revoked";

/** True only when the authenticated user's verified email is the invitation's recipient. */
export function isInvitationRecipient(invitation: Invitation, verifiedEmail: VerifiedEmail | undefined): boolean {
  return verifiedEmail !== undefined && sameEmail(invitation.recipientEmail, verifiedEmail);
}

/**
 * Bootstrap rule for a newly created workspace: its creator (an organization Owner or Admin) becomes
 * its first Workspace Owner, so every workspace starts with an Owner. Workspace and organization roles
 * are separate scopes: being Workspace Owner never grants organization authority, and after creation
 * only a Workspace Owner may grant Workspace Owner. Undefined for roles that may not create workspaces.
 */
export function workspaceRoleForCreator(organizationRole: OrganizationRole): "OWNER" | undefined {
  switch (organizationRole) {
    case "OWNER":
    case "ADMIN":
      return "OWNER";
    case "MEMBER":
      return undefined;
  }
}

export function invitationAvailability(invitation: Invitation, now: Date): InvitationAvailability {
  if (invitation.status === "ACCEPTED") return "accepted";
  if (invitation.status === "REVOKED") return "revoked";
  return now.getTime() >= invitation.expiresAt.getTime() ? "expired" : "acceptable";
}
