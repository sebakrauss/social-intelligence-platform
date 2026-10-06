/**
 * Connection vocabulary (shared kernel; Model §53-D, TA §39). Status only: a status never implies what a
 * platform supports (capability comes from the validated catalog, TA §16). Mirrors the closed values the
 * database enforces in connections.connections (migration 0007).
 */
export const CONNECTION_STATUSES = ["CONNECTING", "ACTIVE", "DEGRADED", "FAILED", "DISCONNECTED", "REMOVED"] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const connectionStatusSet: ReadonlySet<string> = new Set(CONNECTION_STATUSES);

export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return typeof value === "string" && connectionStatusSet.has(value);
}
