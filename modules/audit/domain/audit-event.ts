/**
 * Audit events: append-only accountability records of consequential changes (TA §41; Model §40).
 *
 * Only declared, identifier-shaped metadata is accepted: stable action codes, opaque IDs, actor type,
 * correlation/request IDs, outcome, and a minimal previous/current state summary built from closed
 * vocabularies (modes, roles, permission keys). Never email addresses, organization or workspace names,
 * input bodies, personal content, free-form text, tokens (including raw invitation tokens) or secrets.
 * Anything undeclared is rejected as a programming error rather than stored.
 */
import {
  PERMISSION_KEYS,
  isOrganizationRole,
  isPermissionKey,
  isWorkspaceMode,
  isWorkspaceRole,
  type OrganizationRole,
  type PermissionKey,
  type WorkspaceMode,
  type WorkspaceRole,
} from "@/domain/access";
import { isConnectionStatus, type ConnectionStatus } from "@/domain/connections";
import { parseCorrelationId, parseRequestId, type CorrelationId, type RequestId } from "@/domain/correlation";
import {
  isUuid,
  parseAuditEventId,
  parseOrganizationId,
  parseUserId,
  parseWorkspaceId,
  type AuditEventId,
  type OrganizationId,
  type UserId,
  type WorkspaceId,
} from "@/domain/ids";
import { looksLikeSecret } from "@/domain/secret-patterns";

/** Stable action codes for the changes Step 1 makes. Later modules extend this list. */
export const AUDIT_ACTIONS = [
  "organization.created",
  "workspace.created",
  "workspace.mode_changed",
  "workspace_membership.role_changed",
  "workspace_membership.grants_changed",
  "workspace_membership.removed",
  "organization_membership.role_changed",
  "organization_membership.removed",
  "invitation.created",
  "invitation.revoked",
  "invitation.accepted",
  // Step 5 connections (vocabulary prepared in migration 0007; written by later slices)
  "connection.created",
  "connection.credential_replaced",
  "connection.validated",
  "connection.status_changed",
  "connection.removed",
  "connected_account.linked",
  "connected_account.unlinked",
  "connected_account.move_requested",
  "connected_account.moved_out",
  "connected_account.moved_in",
  "connected_account.move_failed",
  "connected_account.move_rejected",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
  "organization",
  "workspace",
  "organization_membership",
  "workspace_membership",
  "invitation",
  "connection",
  "connected_account",
  "asset_move",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** Initiator kinds (TA §41.1). Step 1 records only "user"; the others arrive with later modules. */
export const AUDIT_ACTOR_TYPES = ["user", "policy", "system", "native_platform", "ai_assisted_user"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_OUTCOMES = ["succeeded", "failed"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export interface WorkspaceMembershipState {
  readonly role: WorkspaceRole;
  readonly grants: readonly PermissionKey[];
}

export interface OrganizationMembershipState {
  readonly role: OrganizationRole;
}

/**
 * Minimal previous/current state of a change (TA §41). `current: null` records a removal: the previous
 * state is what was removed. Values come only from the stable catalogs, never from free-form input.
 */
export type AuditChange =
  | { readonly kind: "workspace_mode"; readonly previous: WorkspaceMode; readonly current: WorkspaceMode }
  | { readonly kind: "workspace_membership"; readonly previous: WorkspaceMembershipState; readonly current: WorkspaceMembershipState | null }
  | { readonly kind: "organization_membership"; readonly previous: OrganizationMembershipState; readonly current: OrganizationMembershipState | null }
  | { readonly kind: "connection_status"; readonly previous: ConnectionStatus; readonly current: ConnectionStatus };

/** Actions that must carry a change summary, its kind, and whether the change is a removal. Others carry none. */
const CHANGE_RULES: Partial<Record<AuditAction, { readonly kind: AuditChange["kind"]; readonly removal: boolean }>> = {
  "workspace.mode_changed": { kind: "workspace_mode", removal: false },
  "workspace_membership.role_changed": { kind: "workspace_membership", removal: false },
  "workspace_membership.grants_changed": { kind: "workspace_membership", removal: false },
  "workspace_membership.removed": { kind: "workspace_membership", removal: true },
  "organization_membership.role_changed": { kind: "organization_membership", removal: false },
  "organization_membership.removed": { kind: "organization_membership", removal: true },
  "connection.status_changed": { kind: "connection_status", removal: false },
};

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly occurredAt: Date;
  readonly action: AuditAction;
  readonly actorType: AuditActorType;
  readonly actorUserId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workspaceId?: WorkspaceId;
  readonly targetType: AuditTargetType;
  /** Internal opaque identifier of the target (a UUID, or a membership key of UUIDs). */
  readonly targetId: string;
  readonly correlationId: CorrelationId;
  readonly requestId?: RequestId;
  readonly outcome: AuditOutcome;
  readonly change?: AuditChange;
}

const DECLARED = new Set([
  "id",
  "occurredAt",
  "action",
  "actorType",
  "actorUserId",
  "organizationId",
  "workspaceId",
  "targetType",
  "targetId",
  "correlationId",
  "requestId",
  "outcome",
  "change",
]);

/** Membership targets are keyed "<workspaceId|organizationId>:<userId>"; every other target is a UUID. */
function isTargetId(value: unknown): value is string {
  if (typeof value !== "string" || looksLikeSecret(value)) return false;
  const parts = value.split(":");
  return parts.length <= 2 && parts.every(isUuid);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** A plain object with exactly these keys (no extras, no class instances). */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseGrants(value: unknown): readonly PermissionKey[] | undefined {
  if (!Array.isArray(value) || value.length > PERMISSION_KEYS.length) return undefined;
  const grants: unknown[] = value;
  if (!grants.every(isPermissionKey) || new Set(grants).size !== grants.length) return undefined;
  return Object.freeze([...grants]);
}

function parseWorkspaceMembershipState(value: unknown): WorkspaceMembershipState | undefined {
  if (!hasExactKeys(value, ["role", "grants"]) || !isWorkspaceRole(value["role"])) return undefined;
  const grants = parseGrants(value["grants"]);
  return grants === undefined ? undefined : Object.freeze({ role: value["role"], grants });
}

function parseOrganizationMembershipState(value: unknown): OrganizationMembershipState | undefined {
  if (!hasExactKeys(value, ["role"]) || !isOrganizationRole(value["role"])) return undefined;
  return Object.freeze({ role: value["role"] });
}

function parseChange(value: unknown, rule: { readonly kind: AuditChange["kind"]; readonly removal: boolean }): AuditChange | undefined {
  if (!hasExactKeys(value, ["kind", "previous", "current"]) || value["kind"] !== rule.kind) return undefined;
  const { previous, current } = value;
  switch (rule.kind) {
    case "workspace_mode":
      return isWorkspaceMode(previous) && isWorkspaceMode(current) ? Object.freeze({ kind: rule.kind, previous, current }) : undefined;
    case "workspace_membership": {
      const before = parseWorkspaceMembershipState(previous);
      const after = rule.removal ? (current === null ? null : undefined) : parseWorkspaceMembershipState(current);
      return before === undefined || after === undefined ? undefined : Object.freeze({ kind: rule.kind, previous: before, current: after });
    }
    case "organization_membership": {
      const before = parseOrganizationMembershipState(previous);
      const after = rule.removal ? (current === null ? null : undefined) : parseOrganizationMembershipState(current);
      return before === undefined || after === undefined ? undefined : Object.freeze({ kind: rule.kind, previous: before, current: after });
    }
    case "connection_status":
      return isConnectionStatus(previous) && isConnectionStatus(current) ? Object.freeze({ kind: rule.kind, previous, current }) : undefined;
  }
}

function reject(field: string): never {
  throw new TypeError(`AuditEvent: invalid or undeclared field '${field}'`);
}

/** Builds an audit event from untrusted-shaped input, keeping only validated, declared fields. */
export function createAuditEvent(input: unknown): AuditEvent {
  if (typeof input !== "object" || input === null) reject("event");
  const raw = input as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(raw)) {
    if (!DECLARED.has(key)) throw new TypeError("AuditEvent: undeclared field");
  }
  const id = parseAuditEventId(raw["id"]) ?? reject("id");
  const occurredAt = raw["occurredAt"] instanceof Date && !Number.isNaN(raw["occurredAt"].getTime()) ? raw["occurredAt"] : reject("occurredAt");
  const action = oneOf(AUDIT_ACTIONS, raw["action"]) ? raw["action"] : reject("action");
  const actorType = oneOf(AUDIT_ACTOR_TYPES, raw["actorType"]) ? raw["actorType"] : reject("actorType");
  const targetType = oneOf(AUDIT_TARGET_TYPES, raw["targetType"]) ? raw["targetType"] : reject("targetType");
  const targetId = isTargetId(raw["targetId"]) ? raw["targetId"] : reject("targetId");
  const correlationId = parseCorrelationId(raw["correlationId"]) ?? reject("correlationId");
  const outcome = oneOf(AUDIT_OUTCOMES, raw["outcome"]) ? raw["outcome"] : reject("outcome");

  const optional = <T>(name: string, parse: (value: unknown) => T | undefined): T | undefined => {
    const value = raw[name];
    return value === undefined ? undefined : (parse(value) ?? reject(name));
  };
  const actorUserId = optional("actorUserId", parseUserId);
  const organizationId = optional("organizationId", parseOrganizationId);
  const workspaceId = optional("workspaceId", parseWorkspaceId);
  const requestId = optional("requestId", parseRequestId);
  const rule = CHANGE_RULES[action];
  const change =
    rule === undefined
      ? raw["change"] === undefined
        ? undefined
        : reject("change")
      : (parseChange(raw["change"], rule) ?? reject("change"));

  return Object.freeze({
    id,
    occurredAt,
    action,
    actorType,
    ...(actorUserId === undefined ? {} : { actorUserId }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    targetType,
    targetId,
    correlationId,
    ...(requestId === undefined ? {} : { requestId }),
    outcome,
    ...(change === undefined ? {} : { change }),
  });
}
