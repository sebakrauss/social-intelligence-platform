/**
 * Tenancy onboarding (Step 7G-F3): a verified user creates their first organization, then its first Standard
 * workspace, through the existing pipeline commands only (tenancy.organization.create, tenancy.workspace.create) and
 * reads where they stand with tenancy.membership.list_own. The surface writes nothing itself: ownership memberships,
 * audit events and every authorization decision come from the commands and the pipeline.
 *
 *   - Identity is the server-validated session the pipeline authenticates; no form field names a user, role, owner or
 *     id that the pipeline would trust. Only the organization/workspace name and, for a workspace, the routing id of
 *     the target organization are read from the form; that id is untrusted routing data the pipeline resolves live
 *     (non-member → NOT_FOUND, no organization.manage → PERMISSION_DENIED).
 *   - The workspace mode is fixed here to STANDARD; the browser can't choose it.
 *   - Reading the state never mutates; every mutation is an explicit form submission.
 *   - Outcomes are closed codes; nothing from an error (database, auth service) reaches the user.
 *
 * Multiples are domain behavior, not an onboarding rule: a user may hold several organizations and workspaces, so two
 * concurrent submissions create two objects. The page only guides the first creation.
 */
import { tenancyOnboardingCommands } from "@/server/commands/tenancy";
import type { MessageKey } from "@/domain/i18n/message-keys";
import type { ActionPipeline, PipelineResult } from "@/server/pipeline";

export interface ReadyWorkspace {
  readonly id: string;
  readonly name: string;
  readonly organizationName: string;
}

export type OnboardingState =
  | { readonly kind: "signed_out" }
  | { readonly kind: "verification_required" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "create_organization" }
  | { readonly kind: "create_workspace"; readonly organizationId: string; readonly organizationName: string }
  | { readonly kind: "awaiting_access" }
  | { readonly kind: "ready"; readonly workspaces: readonly ReadyWorkspace[] };

export const ONBOARDING_STATUSES = ["invalid_input", "not_allowed", "unavailable"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_STATUS_MESSAGES: { readonly [S in OnboardingStatus]: MessageKey } = {
  invalid_input: "onboarding.status.invalid_input",
  not_allowed: "onboarding.status.not_allowed",
  unavailable: "onboarding.status.unavailable",
};

export function parseOnboardingStatus(value: unknown): OnboardingStatus | undefined {
  return typeof value === "string" && (ONBOARDING_STATUSES as readonly string[]).includes(value) ? (value as OnboardingStatus) : undefined;
}

export type OnboardingOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "verification_required" }
  | { readonly kind: "status"; readonly status: OnboardingStatus };

/** Where the caller stands. Read only: one list_own query, no mutation. */
export async function resolveOnboarding(pipeline: ActionPipeline): Promise<OnboardingState> {
  const result = await pipeline.run(tenancyOnboardingCommands.listOwnTenancy, { input: {} });
  if (result.status === "unauthenticated") return { kind: "signed_out" };
  if (result.status === "verification_required") return { kind: "verification_required" };
  if (result.status === "error") return { kind: "unavailable" };
  const organizations = result.value;
  if (organizations.length === 0) return { kind: "create_organization" };
  const workspaces = organizations.flatMap(({ organization, workspaces: own }) =>
    own.map(({ workspace }) => ({ id: workspace.id, name: workspace.name, organizationName: organization.name })),
  );
  if (workspaces.length > 0) return { kind: "ready", workspaces };
  const manageable = organizations.find(({ role }) => role === "OWNER" || role === "ADMIN");
  return manageable === undefined
    ? { kind: "awaiting_access" }
    : { kind: "create_workspace", organizationId: manageable.organization.id, organizationName: manageable.organization.name };
}

/** A text field as submitted, or undefined (absent or a file): validation itself belongs to the command. */
function formText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

function outcomeOf(result: PipelineResult<unknown>): OnboardingOutcome {
  switch (result.status) {
    case "ok":
      return { kind: "done" };
    case "unauthenticated":
      return { kind: "signed_out" };
    case "verification_required":
      return { kind: "verification_required" };
    case "error": {
      const code = result.error.code;
      if (code === "INVALID_INPUT") return { kind: "status", status: "invalid_input" };
      // Not a member, or a member without organization.manage: one closed status, no detail about which.
      if (code === "NOT_FOUND" || code === "PERMISSION_DENIED") return { kind: "status", status: "not_allowed" };
      return { kind: "status", status: "unavailable" };
    }
  }
}

/** Creates an organization owned by the session's user. Reads only the name from the form. */
export async function submitOrganization(pipeline: ActionPipeline, form: FormData): Promise<OnboardingOutcome> {
  return outcomeOf(await pipeline.run(tenancyOnboardingCommands.createOrganization, { input: { name: formText(form, "name") } }));
}

/** Creates a Standard workspace in the submitted organization, if the pipeline authorizes the caller there. */
export async function submitWorkspace(pipeline: ActionPipeline, form: FormData): Promise<OnboardingOutcome> {
  return outcomeOf(
    await pipeline.run(tenancyOnboardingCommands.createWorkspace, {
      organizationId: formText(form, "organizationId"),
      input: { name: formText(form, "name"), mode: "STANDARD" },
    }),
  );
}
