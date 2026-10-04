/**
 * Step 1 tenancy commands (TA §10.3–§10.6). Each declares scope, permission and mode requirement;
 * the action pipeline enforces them and records the audit event in the same unit of work.
 * Audit drafts carry stable codes, opaque IDs and a closed-vocabulary previous/current state summary
 * only — never names, emails, tokens or request bodies.
 */
import { PERMISSION_KEYS, ORGANIZATION_ROLES, WORKSPACE_ROLES } from "@/domain/access";
import {
  parseInvitationId,
  parseOrganizationId,
  parseUserId,
  parseWorkspaceId,
  type InvitationId,
  type OrganizationId,
  type WorkspaceId,
} from "@/domain/ids";
import { email, list, object, oneOf, optional, parsed, text } from "@/domain/validation";
import {
  DEFAULT_INVITATION_TTL_DAYS,
  WORKSPACE_MODES,
  acceptInvitation,
  changeOrganizationMemberRole,
  changeWorkspaceMemberRole,
  changeWorkspaceMode,
  createOrganization,
  createWorkspace,
  inviteToOrganization,
  invitationExpiresAt,
  inviteToWorkspace,
  removeOrganizationMember,
  removeWorkspaceMember,
  revokeInvitation,
  setWorkspaceMemberGrants,
  type AcceptanceOutcome,
  type InvitationDelivery,
  type InvitationTokens,
  type IssuedInvitation,
  type MembershipChange,
  type OrganizationMemberRemoval,
  type OrganizationMembership,
  type WorkspaceMembership,
} from "@/modules/tenancy";
import type { OrganizationCommand, UserCommand, WorkspaceCommand } from "@/server/pipeline";

const NAME = text({ max: 120 });
const RAW_TOKEN = text({ min: 43, max: 43, pattern: /^[A-Za-z0-9_-]{43}$/ });

const membershipTarget = (membership: WorkspaceMembership): string => `${membership.workspaceId}:${membership.userId}`;
const organizationMembershipTarget = (membership: OrganizationMembership): string =>
  `${membership.organizationId}:${membership.userId}`;

/** Audit state summaries: only the role and grants, copied from the catalog-typed membership. */
const workspaceMembershipState = (membership: WorkspaceMembership) => ({ role: membership.role, grants: [...membership.grants] });
const organizationMembershipState = (membership: OrganizationMembership) => ({ role: membership.role });

const workspaceMembershipChange = ({ previous, current }: MembershipChange<WorkspaceMembership>) => ({
  kind: "workspace_membership" as const,
  previous: workspaceMembershipState(previous),
  current: workspaceMembershipState(current),
});

export interface TenancyCommandDependencies {
  readonly tokens: InvitationTokens;
  readonly delivery: InvitationDelivery;
  /** Invitation lifetime in days; the approved MVP default is DEFAULT_INVITATION_TTL_DAYS. */
  readonly invitationTtlDays?: number;
}

export function createTenancyCommands(deps: TenancyCommandDependencies) {
  const ttlDays = deps.invitationTtlDays ?? DEFAULT_INVITATION_TTL_DAYS;
  const deliver = (issued: IssuedInvitation): Promise<void> =>
    deps.delivery.deliver({
      invitationId: issued.invitation.id,
      recipientEmail: issued.invitation.recipientEmail,
      rawToken: issued.rawToken,
    });

  const createOrganizationCommand: UserCommand<{ readonly name: string }, OrganizationId, { readonly organizationId: OrganizationId }> = {
    scope: "user",
    name: "tenancy.organization.create",
    validate: object({ name: NAME }),
    async execute(context, input, tx, env) {
      const id = parseOrganizationId(env.newId());
      if (id === undefined) throw new TypeError("id generator must return UUIDs");
      await createOrganization(tx.tenancy, { id, name: input.name, ownerUserId: context.userId, now: env.now });
      return id;
    },
    audit: (organizationId) => ({ action: "organization.created", targetType: "organization", targetId: organizationId, organizationId }),
    respond: (organizationId) => ({ organizationId }),
  };

  const createWorkspaceCommand: OrganizationCommand<
    { readonly name: string; readonly mode: (typeof WORKSPACE_MODES)[number] | undefined },
    WorkspaceId,
    { readonly workspaceId: WorkspaceId }
  > = {
    scope: "organization",
    name: "tenancy.workspace.create",
    permission: "organization.manage",
    validate: object({ name: NAME, mode: optional(oneOf(WORKSPACE_MODES)) }),
    async execute(context, input, tx, env) {
      const id = parseWorkspaceId(env.newId());
      if (id === undefined) throw new TypeError("id generator must return UUIDs");
      await createWorkspace(tx.tenancy, {
        id,
        organizationId: context.organizationId,
        name: input.name,
        mode: input.mode ?? "STANDARD",
        creator: context.actor(),
        now: env.now,
      });
      return id;
    },
    audit: (workspaceId) => ({ action: "workspace.created", targetType: "workspace", targetId: workspaceId, workspaceId }),
    respond: (workspaceId) => ({ workspaceId }),
  };

  const changeWorkspaceModeCommand: WorkspaceCommand<
    { readonly mode: (typeof WORKSPACE_MODES)[number] },
    {
      readonly workspaceId: WorkspaceId;
      readonly changed: boolean;
      readonly previous: (typeof WORKSPACE_MODES)[number];
      readonly current: (typeof WORKSPACE_MODES)[number];
    },
    { readonly mode: (typeof WORKSPACE_MODES)[number] }
  > = {
    scope: "workspace",
    name: "tenancy.workspace.change_mode",
    permission: "workspace.mode.change",
    requiresStandardMode: false,
    validate: object({ mode: oneOf(WORKSPACE_MODES) }),
    async execute(context, input, tx) {
      const result = await changeWorkspaceMode(tx.tenancy, { workspace: context.workspace, mode: input.mode });
      return { workspaceId: context.workspaceId, ...result };
    },
    audit: (output) =>
      output.changed
        ? {
            action: "workspace.mode_changed",
            targetType: "workspace",
            targetId: output.workspaceId,
            change: { kind: "workspace_mode", previous: output.previous, current: output.current },
          }
        : undefined,
    respond: (output) => ({ mode: output.current }),
  };

  const inviteToWorkspaceCommand: WorkspaceCommand<
    { readonly recipientEmail: string; readonly role: (typeof WORKSPACE_ROLES)[number]; readonly grants: readonly (typeof PERMISSION_KEYS)[number][] | undefined },
    IssuedInvitation,
    { readonly invitationId: InvitationId }
  > = {
    scope: "workspace",
    name: "tenancy.invitation.create_workspace",
    permission: "members.manage",
    requiresStandardMode: false,
    validate: object({
      recipientEmail: email,
      role: oneOf(WORKSPACE_ROLES),
      grants: optional(list(oneOf(PERMISSION_KEYS), { max: PERMISSION_KEYS.length })),
    }),
    async execute(context, input, tx, env) {
      const invitationId = parseInvitationId(env.newId());
      if (invitationId === undefined) throw new TypeError("id generator must return UUIDs");
      return inviteToWorkspace(tx.tenancy, deps.tokens, {
        actor: context.actor(),
        workspace: context.workspace,
        role: input.role,
        grants: input.grants ?? [],
        invitationId,
        recipientEmail: input.recipientEmail,
        now: env.now,
        expiresAt: invitationExpiresAt(env.now, ttlDays),
      });
    },
    audit: (issued) => ({ action: "invitation.created", targetType: "invitation", targetId: issued.invitation.id }),
    afterCommit: deliver,
    respond: (issued) => ({ invitationId: issued.invitation.id }),
  };

  const inviteToOrganizationCommand: OrganizationCommand<
    { readonly recipientEmail: string; readonly role: (typeof ORGANIZATION_ROLES)[number] },
    IssuedInvitation,
    { readonly invitationId: InvitationId }
  > = {
    scope: "organization",
    name: "tenancy.invitation.create_organization",
    permission: "organization.manage",
    validate: object({ recipientEmail: email, role: oneOf(ORGANIZATION_ROLES) }),
    async execute(context, input, tx, env) {
      const invitationId = parseInvitationId(env.newId());
      if (invitationId === undefined) throw new TypeError("id generator must return UUIDs");
      return inviteToOrganization(tx.tenancy, deps.tokens, {
        actor: context.actor(),
        organizationId: context.organizationId,
        role: input.role,
        invitationId,
        recipientEmail: input.recipientEmail,
        now: env.now,
        expiresAt: invitationExpiresAt(env.now, ttlDays),
      });
    },
    audit: (issued) => ({ action: "invitation.created", targetType: "invitation", targetId: issued.invitation.id }),
    afterCommit: deliver,
    respond: (issued) => ({ invitationId: issued.invitation.id }),
  };

  const revokeWorkspaceInvitationCommand: WorkspaceCommand<{ readonly invitationId: InvitationId }, InvitationId, { readonly invitationId: InvitationId }> = {
    scope: "workspace",
    name: "tenancy.invitation.revoke_workspace",
    permission: "members.manage",
    requiresStandardMode: false,
    validate: object({ invitationId: parsed(parseInvitationId) }),
    async execute(context, input, tx, env) {
      await revokeInvitation(tx.tenancy, {
        scope: "workspace",
        actor: context.actor(),
        workspaceId: context.workspaceId,
        invitationId: input.invitationId,
        now: env.now,
      });
      return input.invitationId;
    },
    audit: (invitationId) => ({ action: "invitation.revoked", targetType: "invitation", targetId: invitationId }),
    respond: (invitationId) => ({ invitationId }),
  };

  const revokeOrganizationInvitationCommand: OrganizationCommand<{ readonly invitationId: InvitationId }, InvitationId, { readonly invitationId: InvitationId }> = {
    scope: "organization",
    name: "tenancy.invitation.revoke_organization",
    permission: "organization.manage",
    validate: object({ invitationId: parsed(parseInvitationId) }),
    async execute(context, input, tx, env) {
      await revokeInvitation(tx.tenancy, {
        scope: "organization",
        actor: context.actor(),
        organizationId: context.organizationId,
        invitationId: input.invitationId,
        now: env.now,
      });
      return input.invitationId;
    },
    audit: (invitationId) => ({ action: "invitation.revoked", targetType: "invitation", targetId: invitationId }),
    respond: (invitationId) => ({ invitationId }),
  };

  const acceptInvitationCommand: UserCommand<
    { readonly token: string },
    { readonly invitationId: InvitationId; readonly organizationId: OrganizationId; readonly workspaceId: WorkspaceId | undefined; readonly outcome: AcceptanceOutcome },
    { readonly organizationId: OrganizationId; readonly workspaceId: WorkspaceId | undefined; readonly outcome: AcceptanceOutcome }
  > = {
    scope: "user",
    name: "tenancy.invitation.accept",
    validate: object({ token: RAW_TOKEN }),
    async execute(context, input, tx, env) {
      const { invitation, outcome } = await acceptInvitation(tx.tenancy, deps.tokens, {
        rawToken: input.token,
        userId: context.userId,
        verifiedEmail: context.verifiedEmail,
        now: env.now,
      });
      return {
        invitationId: invitation.id,
        organizationId: invitation.organizationId,
        workspaceId: invitation.target.kind === "workspace" ? invitation.target.workspaceId : undefined,
        outcome,
      };
    },
    audit: (output) => ({
      action: "invitation.accepted",
      targetType: "invitation",
      targetId: output.invitationId,
      organizationId: output.organizationId,
      ...(output.workspaceId === undefined ? {} : { workspaceId: output.workspaceId }),
    }),
    respond: ({ organizationId, workspaceId, outcome }) => ({ organizationId, workspaceId, outcome }),
  };

  const memberInput = { userId: parsed(parseUserId) };

  const changeMemberRoleCommand: WorkspaceCommand<
    { readonly userId: NonNullable<ReturnType<typeof parseUserId>>; readonly role: (typeof WORKSPACE_ROLES)[number] },
    MembershipChange<WorkspaceMembership>,
    { readonly role: (typeof WORKSPACE_ROLES)[number] }
  > = {
    scope: "workspace",
    name: "tenancy.membership.change_role",
    permission: "members.manage",
    requiresStandardMode: false,
    validate: object({ ...memberInput, role: oneOf(WORKSPACE_ROLES) }),
    execute: (context, input, tx) =>
      changeWorkspaceMemberRole(tx.tenancy, { actor: context.actor(), workspaceId: context.workspaceId, userId: input.userId, role: input.role }),
    audit: (change) => ({
      action: "workspace_membership.role_changed",
      targetType: "workspace_membership",
      targetId: membershipTarget(change.current),
      change: workspaceMembershipChange(change),
    }),
    respond: (change) => ({ role: change.current.role }),
  };

  const setMemberGrantsCommand: WorkspaceCommand<
    { readonly userId: NonNullable<ReturnType<typeof parseUserId>>; readonly grants: readonly (typeof PERMISSION_KEYS)[number][] },
    MembershipChange<WorkspaceMembership>,
    { readonly grants: readonly (typeof PERMISSION_KEYS)[number][] }
  > = {
    scope: "workspace",
    name: "tenancy.membership.set_grants",
    permission: "members.manage",
    requiresStandardMode: false,
    validate: object({ ...memberInput, grants: list(oneOf(PERMISSION_KEYS), { max: PERMISSION_KEYS.length }) }),
    execute: (context, input, tx) =>
      setWorkspaceMemberGrants(tx.tenancy, { actor: context.actor(), workspaceId: context.workspaceId, userId: input.userId, grants: input.grants }),
    audit: (change) => ({
      action: "workspace_membership.grants_changed",
      targetType: "workspace_membership",
      targetId: membershipTarget(change.current),
      change: workspaceMembershipChange(change),
    }),
    respond: (change) => ({ grants: change.current.grants }),
  };

  const removeMemberCommand: WorkspaceCommand<
    { readonly userId: NonNullable<ReturnType<typeof parseUserId>> },
    WorkspaceMembership,
    { readonly removed: true }
  > = {
    scope: "workspace",
    name: "tenancy.membership.remove",
    permission: "members.manage",
    requiresStandardMode: false,
    validate: object(memberInput),
    execute: (context, input, tx) =>
      removeWorkspaceMember(tx.tenancy, { actor: context.actor(), workspaceId: context.workspaceId, userId: input.userId }),
    audit: (membership) => ({
      action: "workspace_membership.removed",
      targetType: "workspace_membership",
      targetId: membershipTarget(membership),
      change: { kind: "workspace_membership", previous: workspaceMembershipState(membership), current: null },
    }),
    respond: () => ({ removed: true }),
  };

  const organizationMemberInput = { userId: parsed(parseUserId) };

  const changeOrganizationMemberRoleCommand: OrganizationCommand<
    { readonly userId: NonNullable<ReturnType<typeof parseUserId>>; readonly role: (typeof ORGANIZATION_ROLES)[number] },
    MembershipChange<OrganizationMembership>,
    { readonly role: (typeof ORGANIZATION_ROLES)[number] }
  > = {
    scope: "organization",
    name: "tenancy.organization_membership.change_role",
    permission: "organization.manage",
    validate: object({ ...organizationMemberInput, role: oneOf(ORGANIZATION_ROLES) }),
    execute: (context, input, tx) =>
      changeOrganizationMemberRole(tx.tenancy, { actor: context.actor(), organizationId: context.organizationId, userId: input.userId, role: input.role }),
    audit: ({ previous, current }) => ({
      action: "organization_membership.role_changed",
      targetType: "organization_membership",
      targetId: organizationMembershipTarget(current),
      change: { kind: "organization_membership", previous: organizationMembershipState(previous), current: organizationMembershipState(current) },
    }),
    respond: ({ current }) => ({ role: current.role }),
  };

  const removeOrganizationMemberCommand: OrganizationCommand<
    { readonly userId: NonNullable<ReturnType<typeof parseUserId>> },
    OrganizationMemberRemoval,
    { readonly removed: true }
  > = {
    scope: "organization",
    name: "tenancy.organization_membership.remove",
    permission: "organization.manage",
    validate: object(organizationMemberInput),
    execute: (context, input, tx) =>
      removeOrganizationMember(tx.tenancy, { actor: context.actor(), organizationId: context.organizationId, userId: input.userId }),
    // One event for the organization membership plus one per cascaded workspace membership removal.
    audit: ({ membership, removedWorkspaceMemberships }) => [
      {
        action: "organization_membership.removed",
        targetType: "organization_membership",
        targetId: organizationMembershipTarget(membership),
        change: { kind: "organization_membership", previous: organizationMembershipState(membership), current: null },
      },
      ...removedWorkspaceMemberships.map((removed) => ({
        action: "workspace_membership.removed" as const,
        targetType: "workspace_membership" as const,
        targetId: membershipTarget(removed),
        workspaceId: removed.workspaceId,
        change: { kind: "workspace_membership" as const, previous: workspaceMembershipState(removed), current: null },
      })),
    ],
    respond: () => ({ removed: true }),
  };

  return {
    changeOrganizationMemberRole: changeOrganizationMemberRoleCommand,
    removeOrganizationMember: removeOrganizationMemberCommand,
    createOrganization: createOrganizationCommand,
    createWorkspace: createWorkspaceCommand,
    changeWorkspaceMode: changeWorkspaceModeCommand,
    inviteToWorkspace: inviteToWorkspaceCommand,
    inviteToOrganization: inviteToOrganizationCommand,
    revokeWorkspaceInvitation: revokeWorkspaceInvitationCommand,
    revokeOrganizationInvitation: revokeOrganizationInvitationCommand,
    acceptInvitation: acceptInvitationCommand,
    changeMemberRole: changeMemberRoleCommand,
    setMemberGrants: setMemberGrantsCommand,
    removeMember: removeMemberCommand,
  } as const;
}

export type TenancyCommands = ReturnType<typeof createTenancyCommands>;
