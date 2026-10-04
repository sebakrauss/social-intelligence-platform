/**
 * Persistence ports for tenancy. Implementations arrive with the database foundation (Step 2); until
 * then only deterministic test adapters implement them. All reads are live: there is no cache.
 */
import type { OrganizationRole, WorkspaceRole } from "@/domain/access";
import type { InvitationId, OrganizationId, UserId, WorkspaceId } from "@/domain/ids";
import type { Invitation, Organization, OrganizationMembership, Workspace, WorkspaceMembership } from "../domain/model";

export interface TenancyStore {
  readonly organizations: {
    get(id: OrganizationId): Promise<Organization | undefined>;
    insert(organization: Organization): Promise<void>;
  };
  readonly workspaces: {
    get(id: WorkspaceId): Promise<Workspace | undefined>;
    insert(workspace: Workspace): Promise<void>;
    update(workspace: Workspace): Promise<void>;
  };
  readonly organizationMemberships: {
    find(organizationId: OrganizationId, userId: UserId): Promise<OrganizationMembership | undefined>;
    insert(membership: OrganizationMembership): Promise<void>;
    update(membership: OrganizationMembership): Promise<void>;
    remove(organizationId: OrganizationId, userId: UserId): Promise<void>;
    countWithRole(organizationId: OrganizationId, role: OrganizationRole): Promise<number>;
  };
  readonly workspaceMemberships: {
    find(workspaceId: WorkspaceId, userId: UserId): Promise<WorkspaceMembership | undefined>;
    insert(membership: WorkspaceMembership): Promise<void>;
    update(membership: WorkspaceMembership): Promise<void>;
    remove(workspaceId: WorkspaceId, userId: UserId): Promise<void>;
    countWithRole(workspaceId: WorkspaceId, role: WorkspaceRole): Promise<number>;
    /** All of a user's workspace memberships within one organization. */
    listForUser(organizationId: OrganizationId, userId: UserId): Promise<readonly WorkspaceMembership[]>;
  };
  readonly invitations: {
    get(id: InvitationId): Promise<Invitation | undefined>;
    findByTokenDigest(digest: string): Promise<Invitation | undefined>;
    insert(invitation: Invitation): Promise<void>;
    update(invitation: Invitation): Promise<void>;
  };
}

/** Opaque invitation tokens: the raw value is returned once for delivery; only the digest is stored. */
export interface InvitationTokens {
  issue(): { readonly raw: string; readonly digest: string };
  digest(raw: string): string;
  /** Timing-safe comparison of a presented raw token with a stored digest. */
  matches(raw: string, digest: string): boolean;
}

/** Delivers an invitation link. The transactional email vendor is not chosen yet (TA-Q-24 VALIDATE). */
export interface InvitationDelivery {
  deliver(message: { readonly invitationId: InvitationId; readonly recipientEmail: string; readonly rawToken: string }): Promise<void>;
}
