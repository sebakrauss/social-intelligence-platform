/**
 * Tenant-scoped transaction helpers (TA §9.3, §11.6). All application data access goes through one of
 * these; there is no generic "service role" helper.
 *
 *   user scope       web login → SET LOCAL ROLE authenticated → transaction-local claims → auth.uid()
 *                    → optional sealed workspace binding
 *   workspace job    worker login → SET LOCAL ROLE app_worker → sealed workspace binding (required)
 *   system scope     system login → SET LOCAL ROLE app_system → system tables only
 *
 * R3: every role switch is a fixed SQL literal chosen here, never a value from a token or input.
 * R2: the workspace is bound once per transaction by app.bind_workspace (sealed; rebinding refused).
 * All context is transaction-local: COMMIT or ROLLBACK leaves the pooled connection clean.
 * Inputs are validated BEFORE a connection is taken, so a forged identity never reaches the database.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RuntimeDatabase } from "./pool";

export type DatabaseTransaction = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

export class ScopeError extends Error {
  override readonly name = "ScopeError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The only claim role a web transaction may carry (R3 allowlist). */
export const ALLOWED_CLAIM_ROLES: readonly string[] = ["authenticated"];

export interface DatabaseClaims {
  readonly sub: string;
  readonly role: "authenticated";
}

/**
 * Validates the identity handed to the database: a server-verified user id and, if present, a role claim
 * from the allowlist. Anything else (e.g. `role: "service_role"`) is rejected before any query runs.
 */
export function parseDatabaseClaims(identity: unknown): DatabaseClaims {
  if (typeof identity !== "object" || identity === null) throw new ScopeError("user scope: identity required");
  const { sub, role } = identity as { readonly sub?: unknown; readonly role?: unknown };
  if (typeof sub !== "string" || !UUID.test(sub)) throw new ScopeError("user scope: invalid subject");
  if (role !== undefined && (typeof role !== "string" || !ALLOWED_CLAIM_ROLES.includes(role))) {
    throw new ScopeError("user scope: role claim not allowed");
  }
  return { sub, role: "authenticated" };
}

function parseWorkspace(workspaceId: unknown, required: boolean): string | undefined {
  if (workspaceId === undefined && !required) return undefined;
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) throw new ScopeError("scope: invalid workspace");
  return workspaceId;
}

export function assertKind(database: RuntimeDatabase, kind: RuntimeDatabase["kind"]): void {
  // Type-level kinds can be erased by casts; check at runtime too.
  if (database.kind !== kind) throw new ScopeError(`scope requires the ${kind} runtime database`);
}

/** Web request: the verified user, optionally bound to one workspace. */
export async function withUserScope<T>(
  database: RuntimeDatabase<"web">,
  identity: unknown,
  workspaceId: unknown,
  work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  assertKind(database, "web");
  const claims = parseDatabaseClaims(identity);
  const workspace = parseWorkspace(workspaceId, false);
  return database.db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    await tx.execute(sql`select
      pg_catalog.set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
      pg_catalog.set_config('request.jwt.claim.sub', ${claims.sub}, true),
      pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true)`);
    if (workspace !== undefined) await tx.execute(sql`select app.bind_workspace(${workspace}::uuid)`);
    return work(tx);
  });
}

/** Workspace job: exactly one workspace, from the job payload. */
export async function withWorkspaceJobScope<T>(
  database: RuntimeDatabase<"worker">,
  workspaceId: unknown,
  work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  assertKind(database, "worker");
  const workspace = parseWorkspace(workspaceId, true);
  return database.db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_worker`);
    await tx.execute(sql`select app.bind_workspace(${workspace}::uuid)`);
    return work(tx);
  });
}
