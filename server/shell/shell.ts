/**
 * App shell state (UI-3): what surrounds every workspace screen — the workspace the URL names (if the caller is a
 * member of it), the caller's other workspaces, and which built destinations their role may reach. Read only, through
 * the existing tenancy.membership.list_own command (the same read onboarding uses): no new query, no mutation, no
 * authorization decision of its own — the pipeline and RLS decide, and a workspace the caller isn't a member of is
 * simply absent (never "forbidden").
 *
 * Destinations are the ones that exist today, gated by IA §18: Inbox for every non-guest role; Settings › Connections
 * for Owner and Admin. Nothing future (Home, Insights, Reports…) is named here, neither as active nor as disabled.
 */
import type { WorkspaceMode, WorkspaceRole } from "@/domain/access";
import { parseWorkspaceId } from "@/domain/ids";
import { tenancyOnboardingCommands } from "@/server/commands/tenancy";
import type { ActionPipeline } from "@/server/pipeline";

export interface ShellWorkspace {
  readonly id: string;
  readonly name: string;
  readonly organizationName: string;
  readonly role: WorkspaceRole;
  readonly mode: WorkspaceMode;
}

export type ShellState =
  | { readonly kind: "signed_out" }
  | { readonly kind: "verification_required" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "no_workspaces" }
  | { readonly kind: "ready"; readonly current: ShellWorkspace | undefined; readonly workspaces: readonly ShellWorkspace[] };

/** The built destinations a role may reach (IA §18). */
export interface ShellAccess {
  readonly inbox: boolean;
  readonly connections: boolean;
}

export function shellAccess(role: WorkspaceRole): ShellAccess {
  return { inbox: role !== "CLIENT_GUEST", connections: role === "OWNER" || role === "ADMIN" };
}

/** Where the caller stands for the workspace the URL names. One list_own read; nothing changes. */
export async function resolveShell(pipeline: ActionPipeline, workspaceId: unknown): Promise<ShellState> {
  const result = await pipeline.run(tenancyOnboardingCommands.listOwnTenancy, { input: {} });
  if (result.status === "unauthenticated") return { kind: "signed_out" };
  if (result.status === "verification_required") return { kind: "verification_required" };
  if (result.status === "error") return { kind: "unavailable" };
  const workspaces: ShellWorkspace[] = result.value.flatMap(({ organization, workspaces: own }) =>
    own.map(({ workspace, role }) => ({ id: workspace.id, name: workspace.name, organizationName: organization.name, role, mode: workspace.mode })),
  );
  if (workspaces.length === 0) return { kind: "no_workspaces" };
  const id = parseWorkspaceId(workspaceId);
  const current = id === undefined ? undefined : workspaces.find((workspace) => workspace.id === id);
  return { kind: "ready", current, workspaces };
}
