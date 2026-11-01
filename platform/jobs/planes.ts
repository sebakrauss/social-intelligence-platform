/**
 * Execution planes (Step 7E.4B.3; ADR-64; migration 0011). The SEMANTIC split of the job runtime into deployments,
 * drawn by credential-opening capability — not by tenant/system naming:
 *
 *   main          everything that never opens a provider credential: the outbox relay and sweepers, the Move saga steps
 *   integration   only the tasks that need the CredentialOpener (and, later, the worker's KMS Decrypt identity)
 *   intelligence  real model execution (H7-A0 D-H7-1): the only plane that may hold a model credential. Declared in
 *                 H7-D1b; a DELIVERY plane since H7-D1d, after migration 0025 admitted it in system.outbox — bound only
 *                 for `classification.understand_ai`, and that topic only to it (0025 `outbox_intelligence_routing`)
 *
 * Code that binds, dispatches, observes or wakes outbox deliveries takes a `DeliveryPlane`; a plane declared in source
 * becomes one only together with the database authority that admits it.
 *
 * The registry declares each task's plane explicitly; it decides the plane only for UNBOUND outbox work. A delivery's
 * plane is bound once, atomically with its first claim (system.outbox.execution_plane), and from then on the persisted
 * value — never the current registry — decides dispatch, recovery and run observation. Vendor project refs, keys and
 * environment names never appear here: they belong to the composition boundary.
 */
export const EXECUTION_PLANES = ["main", "integration", "intelligence"] as const;
export type ExecutionPlane = (typeof EXECUTION_PLANES)[number];

export function isExecutionPlane(value: unknown): value is ExecutionPlane {
  return typeof value === "string" && (EXECUTION_PLANES as readonly string[]).includes(value);
}

/** The planes an outbox delivery may be bound to (0011 `outbox_execution_plane_known`, widened by 0025). */
export const DELIVERY_PLANES = ["main", "integration", "intelligence"] as const satisfies readonly ExecutionPlane[];
export type DeliveryPlane = (typeof DELIVERY_PLANES)[number];

export function isDeliveryPlane(value: unknown): value is DeliveryPlane {
  return typeof value === "string" && (DELIVERY_PLANES as readonly string[]).includes(value);
}
