/**
 * Classification of PostgreSQL errors into the few outcomes the application distinguishes. Only the
 * SQLSTATE and constraint name are inspected; messages and details (which can carry values) are not.
 */

export type DatabaseFailure =
  /** The last-Owner invariant refused a demotion or removal (organization or workspace). */
  | "last_owner"
  /** A uniqueness rule (e.g. a membership or invitation that already exists). */
  | "duplicate"
  /** A reference to a row that doesn't exist, or exists in another tenant: indistinguishable (R5). */
  | "missing_reference"
  /** Row-level security or a privilege refused the statement: fail closed. */
  | "denied";

export const LAST_OWNER_CONSTRAINTS: readonly string[] = ["organization_keeps_an_owner", "workspace_keeps_an_owner"];

interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
}

/** The underlying driver error (query builders may wrap it in `cause`). */
export function postgresError(error: unknown): { readonly code: string; readonly constraint: string | undefined } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const shape = current as PgErrorShape;
    if (typeof shape.code === "string" && /^[0-9A-Z]{5}$/.test(shape.code)) {
      return { code: shape.code, constraint: typeof shape.constraint === "string" ? shape.constraint : undefined };
    }
    current = shape.cause;
  }
  return undefined;
}

export function classifyDatabaseError(error: unknown): DatabaseFailure | undefined {
  const pgError = postgresError(error);
  if (pgError === undefined) return undefined;
  if (pgError.code === "23514" && pgError.constraint !== undefined && LAST_OWNER_CONSTRAINTS.includes(pgError.constraint)) {
    return "last_owner";
  }
  if (pgError.code === "23505") return "duplicate";
  if (pgError.code === "23503") return "missing_reference";
  if (pgError.code === "42501") return "denied";
  return undefined;
}
