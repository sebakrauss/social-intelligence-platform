/**
 * Execution planes (Step 7E.4B.3; ADR-64; migration 0011). The SEMANTIC split of the job runtime into two deployments,
 * drawn by credential-opening capability — not by tenant/system naming:
 *
 *   main          everything that never opens a provider credential: the outbox relay and sweepers, the Move saga steps
 *   integration   only the tasks that need the CredentialOpener (and, later, the worker's KMS Decrypt identity)
 *
 * The registry declares each task's plane explicitly; it decides the plane only for UNBOUND outbox work. A delivery's
 * plane is bound once, atomically with its first claim (system.outbox.execution_plane), and from then on the persisted
 * value — never the current registry — decides dispatch, recovery and run observation. Vendor project refs, keys and
 * environment names never appear here: they belong to the composition boundary.
 */
export const EXECUTION_PLANES = ["main", "integration"] as const;
export type ExecutionPlane = (typeof EXECUTION_PLANES)[number];

export function isExecutionPlane(value: unknown): value is ExecutionPlane {
  return typeof value === "string" && (EXECUTION_PLANES as readonly string[]).includes(value);
}
