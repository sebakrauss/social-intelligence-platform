import { redirect } from "next/navigation";
import { createOrganizationAction, createWorkspaceAction } from "@/server/tenancy/actions";
import { ONBOARDING_STATUS_MESSAGES, parseOnboardingStatus } from "@/server/tenancy/onboarding";
import { currentOnboardingState } from "@/server/tenancy/runtime";
import { t } from "@/server/i18n";

/** Tenancy state is per request: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Onboarding (Step 7G-F3): a verified user creates their first organization, then its first workspace. Rendering only
 * reads; each form submits once to a server action that redirects back here. Minimal and utilitarian: no product
 * design work. Names are rendered as text.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const status = parseOnboardingStatus((await searchParams)["status"]);
  const state = await currentOnboardingState();
  if (state.kind === "signed_out") redirect("/sign-in");

  return (
    <main>
      <h1>{t("onboarding.heading")}</h1>
      {status === undefined ? null : <p role="status">{t(ONBOARDING_STATUS_MESSAGES[status])}</p>}

      {state.kind === "unavailable" ? <p role="status">{t("onboarding.status.unavailable")}</p> : null}
      {state.kind === "verification_required" ? <p role="status">{t("auth.status.verification_required")}</p> : null}
      {state.kind === "awaiting_access" ? <p role="status">{t("onboarding.awaiting_access")}</p> : null}

      {state.kind === "create_organization" ? (
        <form action={createOrganizationAction}>
          <h2>{t("onboarding.organization.heading")}</h2>
          <label>
            {t("onboarding.organization.field.name")}
            <input name="name" type="text" maxLength={120} required />
          </label>
          <button type="submit">{t("onboarding.organization.submit")}</button>
        </form>
      ) : null}

      {state.kind === "create_workspace" ? (
        <form action={createWorkspaceAction}>
          <h2>{t("onboarding.workspace.heading")}</h2>
          <p>{state.organizationName}</p>
          <input name="organizationId" type="hidden" value={state.organizationId} />
          <label>
            {t("onboarding.workspace.field.name")}
            <input name="name" type="text" maxLength={120} required />
          </label>
          <button type="submit">{t("onboarding.workspace.submit")}</button>
        </form>
      ) : null}

      {state.kind === "ready" ? (
        <section>
          <h2>{t("onboarding.ready.heading")}</h2>
          <p>{t("onboarding.ready.workspaces")}</p>
          <ul>
            {state.workspaces.map((workspace) => (
              <li key={workspace.id}>
                {workspace.name} · {workspace.organizationName}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
