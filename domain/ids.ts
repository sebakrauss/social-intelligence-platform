/**
 * Branded identifiers (shared kernel, TA §6.2). Internal identities are UUIDs and never reused.
 * Pure: parsing/validation only; generation lives in `platform/crypto`.
 */

declare const idBrand: unique symbol;

type Id<Tag extends string> = string & { readonly [idBrand]: Tag };

export type UserId = Id<"UserId">;
export type OrganizationId = Id<"OrganizationId">;
export type WorkspaceId = Id<"WorkspaceId">;
export type InvitationId = Id<"InvitationId">;
export type AuditEventId = Id<"AuditEventId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export const parseUserId = (value: unknown): UserId | undefined => (isUuid(value) ? (value as UserId) : undefined);
export const parseOrganizationId = (value: unknown): OrganizationId | undefined =>
  isUuid(value) ? (value as OrganizationId) : undefined;
export const parseWorkspaceId = (value: unknown): WorkspaceId | undefined => (isUuid(value) ? (value as WorkspaceId) : undefined);
export const parseInvitationId = (value: unknown): InvitationId | undefined => (isUuid(value) ? (value as InvitationId) : undefined);
export const parseAuditEventId = (value: unknown): AuditEventId | undefined => (isUuid(value) ? (value as AuditEventId) : undefined);
