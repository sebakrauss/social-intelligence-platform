/**
 * Resolved request contexts (TA §0.3 "tenant context"; §10.6). They can't be constructed by callers:
 * constructors are private and the only factories perform the live, authoritative lookup. Roles,
 * grants, permissions and mode always come from current membership and workspace rows, never from
 * client input, route parameters or token claims.
 */
import type { OrganizationRole, PermissionKey, WorkspaceRole } from "@/domain/access";
import type { VerifiedEmail } from "@/domain/email";
import { AppError } from "@/domain/errors";
import { parseOrganizationId, parseWorkspaceId, type OrganizationId, type UserId, type WorkspaceId } from "@/domain/ids";
import {
  loadOrganizationAccess,
  loadWorkspaceAccess,
  type OrganizationActor,
  type TenancyStore,
  type Workspace,
  type WorkspaceActor,
  type WorkspaceMode,
} from "@/modules/tenancy";
import { ORGANIZATION_ROLE_PERMISSIONS, effectivePermissions } from "@/platform/permissions";

/** An authenticated user whose email is verified. Created only by the pipeline. */
export class UserContext {
  readonly userId: UserId;
  /** Verified address from the auth service. Sensitive: used for invitation matching only, never logged or audited. */
  readonly verifiedEmail: VerifiedEmail | undefined;

  private constructor(userId: UserId, verifiedEmail: VerifiedEmail | undefined) {
    this.userId = userId;
    this.verifiedEmail = verifiedEmail;
  }

  /** @internal Called by the action pipeline after server-side session validation. */
  static fromVerifiedIdentity(identity: { readonly id: UserId; readonly verifiedEmail?: VerifiedEmail }): UserContext {
    return new UserContext(identity.id, identity.verifiedEmail);
  }
}

export class OrganizationContext {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly role: OrganizationRole;
  readonly permissions: ReadonlySet<PermissionKey>;

  private constructor(userId: UserId, organizationId: OrganizationId, role: OrganizationRole) {
    this.userId = userId;
    this.organizationId = organizationId;
    this.role = role;
    this.permissions = ORGANIZATION_ROLE_PERMISSIONS[role];
  }

  /** Live resolution. Unknown organization or non-member → NOT_FOUND (existence is never revealed). */
  static async resolve(store: TenancyStore, user: UserContext, organizationId: unknown): Promise<OrganizationContext> {
    const id = parseOrganizationId(organizationId);
    const access = id === undefined ? undefined : await loadOrganizationAccess(store, id, user.userId);
    if (access === undefined) throw new AppError("NOT_FOUND", {});
    return new OrganizationContext(user.userId, access.organization.id, access.membership.role);
  }

  actor(): OrganizationActor {
    return { userId: this.userId, role: this.role };
  }
}

export class WorkspaceContext {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
  readonly workspace: Workspace;
  readonly role: WorkspaceRole;
  readonly grants: readonly PermissionKey[];
  readonly permissions: ReadonlySet<PermissionKey>;
  readonly mode: WorkspaceMode;

  private constructor(userId: UserId, workspace: Workspace, role: WorkspaceRole, grants: readonly PermissionKey[]) {
    this.userId = userId;
    this.organizationId = workspace.organizationId;
    this.workspaceId = workspace.id;
    this.workspace = workspace;
    this.role = role;
    this.grants = grants;
    this.permissions = effectivePermissions(role, grants);
    this.mode = workspace.mode;
  }

  /**
   * Live resolution: workspace → workspace membership → organization membership → role, grants, mode.
   * Unknown workspace, non-member, or a membership in another workspace → NOT_FOUND.
   */
  static async resolve(store: TenancyStore, user: UserContext, workspaceId: unknown): Promise<WorkspaceContext> {
    const id = parseWorkspaceId(workspaceId);
    const access = id === undefined ? undefined : await loadWorkspaceAccess(store, id, user.userId);
    if (access === undefined) throw new AppError("NOT_FOUND", {});
    return new WorkspaceContext(user.userId, access.workspace, access.membership.role, access.membership.grants);
  }

  actor(): WorkspaceActor {
    return { userId: this.userId, role: this.role, permissions: this.permissions };
  }
}
