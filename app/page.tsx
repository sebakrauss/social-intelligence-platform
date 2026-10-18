import Link from "next/link";
import { signOutAction } from "@/server/auth/actions";
import { currentSessionState } from "@/server/auth/request-auth";
import { t } from "@/server/i18n";

/** Session state is per request: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Session status only (Step 1): proves sign-in, verification-required and sign-out behavior with a
 * server-validated identity. Not a dashboard; a signed-in user is pointed to onboarding (Step 7G-F3).
 */
export default async function SessionPage() {
  const state = await currentSessionState();

  return (
    <main>
      {state === "unavailable" ? <p role="status">{t("auth.status.unavailable")}</p> : null}
      {state === "signed_out" ? <Link href="/sign-in">{t("auth.sign_in.link")}</Link> : null}
      {state === "verification_required" ? <p role="status">{t("auth.status.verification_required")}</p> : null}
      {state === "signed_in" ? <p role="status">{t("auth.status.signed_in")}</p> : null}
      {state === "signed_in" ? <Link href="/onboarding">{t("onboarding.link")}</Link> : null}
      {state === "signed_in" || state === "verification_required" ? (
        <form action={signOutAction}>
          <button type="submit">{t("auth.sign_out.submit")}</button>
        </form>
      ) : null}
    </main>
  );
}
