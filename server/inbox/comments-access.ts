/**
 * COMMENTS-INT-03A — who may reach the redesigned Comments route (/workspaces/[workspaceId]/comments) while it is
 * piloted beside the Inbox. A SERVER-SIDE allowlist of workspace ids read from deployment configuration; the Inbox
 * stays the default for everyone and is never redirected.
 *
 * The list grants nothing by itself: it is consulted only AFTER the ordinary Inbox read has authorized the caller for
 * that workspace (sign-in, membership, `workspace.read_operational`, RLS). A caller who is not authorized gets exactly
 * the Inbox's own answer whether or not the workspace is listed, so the list can't be probed.
 *
 * Fail closed: an absent, empty or malformed value denies every workspace. One bad entry voids the whole list — a typo
 * never widens or half-applies access. The value never reaches a client, a log or an error.
 */
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";

type Environment = Readonly<Record<string, string | undefined>>;

/** Deployment configuration: canonical lowercase workspace UUIDs separated by commas (spaces around them allowed). */
export const COMMENTS_WORKSPACES_ENV = "COMMENTS_REDESIGN_WORKSPACES";
/** A pilot list, not a rollout mechanism: beyond this many entries the value is treated as malformed. */
export const COMMENTS_WORKSPACES_LIMIT = 50;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOBODY: ReadonlySet<string> = new Set();

/** The listed workspace ids; the empty set when the value is absent, empty or malformed in any way. */
export function parseCommentsAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return NOBODY;
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length > COMMENTS_WORKSPACES_LIMIT) return NOBODY;
  if (!entries.every((entry) => CANONICAL_UUID.test(entry) && parseWorkspaceId(entry) !== undefined)) return NOBODY;
  return new Set(entries);
}

/** Whether the redesigned Comments route is offered for this (already authorized) workspace. */
export function commentsOfferedFor(workspaceId: WorkspaceId, environment: Environment = process.env): boolean {
  return parseCommentsAllowlist(environment[COMMENTS_WORKSPACES_ENV]).has(workspaceId);
}
