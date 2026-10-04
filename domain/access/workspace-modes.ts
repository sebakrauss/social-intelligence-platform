/**
 * Workspace operating modes (PD D-49; IA-11). Stable tokens; no other modes exist. Part of the shared
 * kernel because tenancy owns the authoritative value while the pipeline's mode guard and the audit
 * change summary must speak the same closed vocabulary.
 */
export const WORKSPACE_MODES = ["STANDARD", "MONITOR_ONLY"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === "STANDARD" || value === "MONITOR_ONLY";
}
