/**
 * Stable permission keys (TA §10.3). This is the vocabulary only; the authoritative role → permission
 * matrix, grant policy and escalation rules live in `platform/permissions`.
 */
export const PERMISSION_KEYS = [
  "workspace.read_operational",
  "intelligence.read",
  "reports.read",
  "reply.public",
  "reply.private",
  "moderate.hide_unhide",
  "moderate.delete",
  "moderate.block",
  "workflow.internal",
  "automation.configure",
  "recommendations.decide",
  "responding.manage",
  "escalation.default_contact.set",
  "connections.manage",
  "members.manage",
  "workspace.mode.change",
  "organization.manage",
  "billing.manage",
  "attention.read",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const permissionKeySet: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && permissionKeySet.has(value);
}
