/**
 * Tenancy use cases. Callers (the action pipeline) have already authenticated, resolved the tenant and
 * checked the command's base permission; these functions enforce the domain rules that depend on the
 * target: role escalation, grant policy, membership state and invitation lifecycle.
 * Audit is NOT written here: the pipeline records it in the same unit of work (tenancy never imports audit).
 */
import type { OrganizationRole, PermissionKey, WorkspaceRole } from "@/domain/access";
import type { VerifiedEmail } from "@/domain/email";
import { AppError } from "@/domain/errors";
import type { InvitationId, OrganizationId, UserId, WorkspaceId } from "@/domain/ids";
import {
  canAssignOrganizationRole,
  canAssignWorkspaceRole,
  canGrant,
  canManageOrganizationMember,
  canManageWorkspaceMember,
  isGrantable,
} from "@/platform/permissions";
import {
  invitationAvailability,
  isInvitationRecipient,
  workspaceRoleForCreator,
  type Invitation,
  type Organization,
  type OrganizationMembership,
  type Workspace,
  type WorkspaceMembership,
  type WorkspaceMode,
} from "../domain/model";
import type { InvitationTokens, TenancyStore } from "./ports";

export interface WorkspaceActor {
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly permissions: ReadonlySet<PermissionKey>;
}

export interface OrganizationActor {
  readonly userId: UserId;
  readonly role: OrganizationRole;
}

/** A membership before and after a change, so the pipeline can audit what changed without re-querying. */
export interface MembershipChange<M> {
  readonly previous: M;
  readonly current: M;
}

const denied = (): AppError<"PERMISSION_DENIED"> => new AppError("PERMISSION_DENIED", {});
const notFound = (): AppError<"NOT_FOUND"> => new AppError("NOT_FOUND", {});
/**
 * Attempted violation of the last-Owner invariant: every organization and workspace keeps an Owner.
 * Step 1 checks it at application level (count Owners, then update/remove), which is sufficient for the
 * in-memory foundation only. Step 2 MUST make it concurrency-safe inside the real PostgreSQL transaction
 * (row locking and/or a constraint), so two concurrent demotions/removals can't both pass the count.
 */
const lastOwner = (): AppError<"CONFLICT"> => new AppError("CONFLICT", {});

async function assertWorkspaceKeepsAnOwner(store: TenancyStore, membership: WorkspaceMembership): Promise<void> {
  if (membership.role === "OWNER" && (await store.workspaceMemberships.countWithRole(membership.workspaceId, "OWNER")) <= 1) {
    throw lastOwner();
  }
}

async function assertOrganizationKeepsAnOwner(store: TenancyStore, membership: OrganizationMembership): Promise<void> {
  if (membership.role === "OWNER" && (await store.organizationMemberships.countWithRole(membership.organizationId, "OWNER")) <= 1) {
    throw lastOwner();
  }
}

/** Grants must be valid for the target role and held by the actor (nobody grants above their authority). */
function checkGrants(actor: WorkspaceActor, role: WorkspaceRole, grants: readonly PermissionKey[]): void {
  for (const grant of grants) {
    if (!isGrantable(role, grant)) throw new AppError("INVALID_INPUT", { field: "grants" });
    if (!canGrant(actor.permissions, grant)) throw denied();
  }
}

// ── Organizations and workspaces ───────────────────────────────────────────────────────────────

export async function createOrganization(
  store: TenancyStore,
  input: { readonly id: OrganizationId; readonly name: string; readonly ownerUserId: UserId; readonly now: Date },
): Promise<Organization> {
  const organization: Organization = { id: input.id, name: input.name, createdAt: input.now };
  await store.organizations.insert(organization);
  await store.organizationMemberships.insert({
    organizationId: input.id,
    userId: input.ownerUserId,
    role: "OWNER",
    createdAt: input.now,
  });
  return organization;
}

/**
 * Creates a workspace with its creator (an organization Owner or Admin) as its first Workspace Owner, so
 * it never exists without an Owner. This is a bootstrap rule only: it grants no organization authority,
 * and afterwards Workspace Owner is granted only by an existing Workspace Owner. Mode defaults to
 * Standard (UX-02).
 */
export async function createWorkspace(
  store: TenancyStore,
  input: {
    readonly id: WorkspaceId;
    readonly organizationId: OrganizationId;
    readonly name: string;
    readonly mode: WorkspaceMode;
    readonly creator: OrganizationActor;
    readonly now: Date;
  },
): Promise<Workspace> {
  const creatorRole = workspaceRoleForCreator(input.creator.role);
  if (creatorRole === undefined) throw denied();
  const workspace: Workspace = {
    id: input.id,
    organizationId: input.organizationId,
    name: input.name,
    mode: input.mode,
    createdAt: input.now,
  };
  await store.workspaces.insert(workspace);
  await store.workspaceMemberships.insert({
    organizationId: input.organizationId,
    workspaceId: input.id,
    userId: input.creator.userId,
    role: creatorRole,
    grants: [],
    createdAt: input.now,
  });
  return workspace;
}

/** Records the authoritative mode (PD D-49). Automation side effects (IA-16) arrive with the automation module. */
export async function changeWorkspaceMode(
  store: TenancyStore,
  input: { readonly workspace: Workspace; readonly mode: WorkspaceMode },
): Promise<{ readonly previous: WorkspaceMode; readonly current: WorkspaceMode; readonly changed: boolean }> {
  const previous = input.workspace.mode;
  if (previous === input.mode) return { previous, current: previous, changed: false };
  await store.workspaces.update({ ...input.workspace, mode: input.mode });
  return { previous, current: input.mode, changed: true };
}

// ── Workspace memberships ─────────────────────────────────────────────────────────────────────

async function findMember(store: TenancyStore, workspaceId: WorkspaceId, userId: UserId): Promise<WorkspaceMembership> {
  const membership = await store.workspaceMemberships.find(workspaceId, userId);
  if (membership === undefined) throw notFound();
  return membership;
}

export async function changeWorkspaceMemberRole(
  store: TenancyStore,
  input: { readonly actor: WorkspaceActor; readonly workspaceId: WorkspaceId; readonly userId: UserId; readonly role: WorkspaceRole },
): Promise<MembershipChange<WorkspaceMembership>> {
  const member = await findMember(store, input.workspaceId, input.userId);
  if (!canManageWorkspaceMember(input.actor.role, member.role) || !canAssignWorkspaceRole(input.actor.role, input.role)) {
    throw denied();
  }
  if (input.role !== "OWNER") await assertWorkspaceKeepsAnOwner(store, member);
  // Grants that aren't valid for the new role are dropped rather than left inert.
  const updated: WorkspaceMembership = {
    ...member,
    role: input.role,
    grants: member.grants.filter((grant) => isGrantable(input.role, grant)),
  };
  await store.workspaceMemberships.update(updated);
  return { previous: member, current: updated };
}

export async function setWorkspaceMemberGrants(
  store: TenancyStore,
  input: {
    readonly actor: WorkspaceActor;
    readonly workspaceId: WorkspaceId;
    readonly userId: UserId;
    readonly grants: readonly PermissionKey[];
  },
): Promise<MembershipChange<WorkspaceMembership>> {
  const member = await findMember(store, input.workspaceId, input.userId);
  if (!canManageWorkspaceMember(input.actor.role, member.role)) throw denied();
  checkGrants(input.actor, member.role, input.grants);
  const updated: WorkspaceMembership = { ...member, grants: [...input.grants] };
  await store.workspaceMemberships.update(updated);
  return { previous: member, current: updated };
}

export async function removeWorkspaceMember(
  store: TenancyStore,
  input: { readonly actor: WorkspaceActor; readonly workspaceId: WorkspaceId; readonly userId: UserId },
): Promise<WorkspaceMembership> {
  const member = await findMember(store, input.workspaceId, input.userId);
  if (!canManageWorkspaceMember(input.actor.role, member.role)) throw denied();
  await assertWorkspaceKeepsAnOwner(store, member);
  await store.workspaceMemberships.remove(input.workspaceId, input.userId);
  return member;
}

// ── Organization memberships ──────────────────────────────────────────────────────────────────

async function findOrganizationMember(store: TenancyStore, organizationId: OrganizationId, userId: UserId): Promise<OrganizationMembership> {
  const membership = await store.organizationMemberships.find(organizationId, userId);
  if (membership === undefined) throw notFound();
  return membership;
}

/** Ownership transfer is two ordinary steps: make another member Owner first, then demote or remove the previous one. */
export async function changeOrganizationMemberRole(
  store: TenancyStore,
  input: { readonly actor: OrganizationActor; readonly organizationId: OrganizationId; readonly userId: UserId; readonly role: OrganizationRole },
): Promise<MembershipChange<OrganizationMembership>> {
  const member = await findOrganizationMember(store, input.organizationId, input.userId);
  if (!canManageOrganizationMember(input.actor.role, member.role) || !canAssignOrganizationRole(input.actor.role, input.role)) {
    throw denied();
  }
  if (input.role !== "OWNER") await assertOrganizationKeepsAnOwner(store, member);
  const updated: OrganizationMembership = { ...member, role: input.role };
  await store.organizationMemberships.update(updated);
  return { previous: member, current: updated };
}

export interface OrganizationMemberRemoval {
  readonly membership: OrganizationMembership;
  /** Every workspace membership removed with it, so each can be audited individually. */
  readonly removedWorkspaceMemberships: readonly WorkspaceMembership[];
}

/**
 * Removes a user from the organization, including their workspace memberships in it (organization
 * membership is a precondition of workspace access). Refused, before anything is removed, if it would
 * leave the organization, or any of its workspaces, without an Owner.
 */
export async function removeOrganizationMember(
  store: TenancyStore,
  input: { readonly actor: OrganizationActor; readonly organizationId: OrganizationId; readonly userId: UserId },
): Promise<OrganizationMemberRemoval> {
  const member = await findOrganizationMember(store, input.organizationId, input.userId);
  if (!canManageOrganizationMember(input.actor.role, member.role)) throw denied();
  await assertOrganizationKeepsAnOwner(store, member);
  const workspaceMemberships = await store.workspaceMemberships.listForUser(input.organizationId, input.userId);
  for (const membership of workspaceMemberships) {
    await assertWorkspaceKeepsAnOwner(store, membership);
  }
  for (const membership of workspaceMemberships) {
    await store.workspaceMemberships.remove(membership.workspaceId, membership.userId);
  }
  await store.organizationMemberships.remove(input.organizationId, input.userId);
  return { membership: member, removedWorkspaceMemberships: workspaceMemberships };
}

// ── Invitations ───────────────────────────────────────────────────────────────────────────────

export interface IssuedInvitation {
  readonly invitation: Invitation;
  /** Returned once for delivery. Never stored, logged or audited. */
  readonly rawToken: string;
}

interface InvitationBasics {
  readonly invitationId: InvitationId;
  readonly recipientEmail: string;
  readonly now: Date;
  readonly expiresAt: Date;
}

async function issue(
  store: TenancyStore,
  tokens: InvitationTokens,
  invitation: Omit<Invitation, "tokenDigest" | "status">,
): Promise<IssuedInvitation> {
  const token = tokens.issue();
  const stored: Invitation = { ...invitation, tokenDigest: token.digest, status: "PENDING" };
  await store.invitations.insert(stored);
  return { invitation: stored, rawToken: token.raw };
}

export async function inviteToWorkspace(
  store: TenancyStore,
  tokens: InvitationTokens,
  input: InvitationBasics & {
    readonly actor: WorkspaceActor;
    readonly workspace: Workspace;
    readonly role: WorkspaceRole;
    readonly grants: readonly PermissionKey[];
  },
): Promise<IssuedInvitation> {
  if (!canAssignWorkspaceRole(input.actor.role, input.role)) throw denied();
  checkGrants(input.actor, input.role, input.grants);
  return issue(store, tokens, {
    id: input.invitationId,
    organizationId: input.workspace.organizationId,
    target: { kind: "workspace", workspaceId: input.workspace.id, role: input.role, grants: [...input.grants] },
    recipientEmail: input.recipientEmail,
    invitedBy: input.actor.userId,
    createdAt: input.now,
    expiresAt: input.expiresAt,
  });
}

export async function inviteToOrganization(
  store: TenancyStore,
  tokens: InvitationTokens,
  input: InvitationBasics & {
    readonly actor: OrganizationActor;
    readonly organizationId: OrganizationId;
    readonly role: OrganizationRole;
  },
): Promise<IssuedInvitation> {
  if (!canAssignOrganizationRole(input.actor.role, input.role)) throw denied();
  return issue(store, tokens, {
    id: input.invitationId,
    organizationId: input.organizationId,
    target: { kind: "organization", role: input.role },
    recipientEmail: input.recipientEmail,
    invitedBy: input.actor.userId,
    createdAt: input.now,
    expiresAt: input.expiresAt,
  });
}

/** Revokes a pending invitation within the actor's own scope. Out-of-scope invitations are not found. */
export async function revokeInvitation(
  store: TenancyStore,
  input:
    | { readonly scope: "workspace"; readonly actor: WorkspaceActor; readonly workspaceId: WorkspaceId; readonly invitationId: InvitationId; readonly now: Date }
    | { readonly scope: "organization"; readonly actor: OrganizationActor; readonly organizationId: OrganizationId; readonly invitationId: InvitationId; readonly now: Date },
): Promise<Invitation> {
  const invitation = await store.invitations.get(input.invitationId);
  if (invitation === undefined) throw notFound();
  const target = invitation.target;
  if (input.scope === "workspace") {
    if (target.kind !== "workspace" || target.workspaceId !== input.workspaceId) throw notFound();
    if (!canAssignWorkspaceRole(input.actor.role, target.role)) throw denied();
  } else {
    if (target.kind !== "organization" || invitation.organizationId !== input.organizationId) throw notFound();
    if (!canAssignOrganizationRole(input.actor.role, target.role)) throw denied();
  }
  if (invitation.status !== "PENDING") throw new AppError("CONFLICT", {});
  const revoked: Invitation = { ...invitation, status: "REVOKED", closedAt: input.now };
  await store.invitations.update(revoked);
  return revoked;
}

export type AcceptanceOutcome = "joined" | "already_member";

/**
 * Accepts a pending, unexpired invitation exactly once, and only by its intended recipient: a valid
 * token AND a verified email matching the invitation's recipient. Unknown, expired, revoked, already
 * used and someone else's invitations all fail with the same NOT_FOUND (nothing is revealed, including
 * that a valid invitation exists for another address). An existing membership is kept unchanged
 * (no duplicate, no silent role change) and the invitation is consumed.
 */
export async function acceptInvitation(
  store: TenancyStore,
  tokens: InvitationTokens,
  input: { readonly rawToken: string; readonly userId: UserId; readonly verifiedEmail: VerifiedEmail | undefined; readonly now: Date },
): Promise<{ readonly invitation: Invitation; readonly outcome: AcceptanceOutcome }> {
  const invitation = await store.invitations.findByTokenDigest(tokens.digest(input.rawToken));
  if (invitation === undefined || !tokens.matches(input.rawToken, invitation.tokenDigest)) throw notFound();
  if (invitationAvailability(invitation, input.now) !== "acceptable") throw notFound();
  if (!isInvitationRecipient(invitation, input.verifiedEmail)) throw notFound();

  const target = invitation.target;
  let outcome: AcceptanceOutcome = "already_member";
  const organizationMembership = await store.organizationMemberships.find(invitation.organizationId, input.userId);
  if (organizationMembership === undefined) {
    await store.organizationMemberships.insert({
      organizationId: invitation.organizationId,
      userId: input.userId,
      role: target.kind === "organization" ? target.role : "MEMBER",
      createdAt: input.now,
    });
    outcome = "joined";
  }

  if (target.kind === "workspace") {
    const workspace = await store.workspaces.get(target.workspaceId);
    if (workspace?.organizationId !== invitation.organizationId) throw notFound();
    const existing = await store.workspaceMemberships.find(target.workspaceId, input.userId);
    if (existing === undefined) {
      await store.workspaceMemberships.insert({
        organizationId: invitation.organizationId,
        workspaceId: target.workspaceId,
        userId: input.userId,
        role: target.role,
        grants: target.grants.filter((grant) => isGrantable(target.role, grant)),
        createdAt: input.now,
      });
      outcome = "joined";
    }
  }

  const accepted: Invitation = { ...invitation, status: "ACCEPTED", acceptedBy: input.userId, closedAt: input.now };
  await store.invitations.update(accepted);
  return { invitation: accepted, outcome };
}
