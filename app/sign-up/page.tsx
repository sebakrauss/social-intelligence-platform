import Link from "next/link";
import { signUpWithPasswordAction } from "@/server/auth/actions";
import { AUTH_STATUS_MESSAGES, parseAuthStatus } from "@/server/auth/forms";
import { t } from "@/server/i18n";
import { SingleSubmitForm } from "@/ui/auth/single-submit-form";
import { PendingSubmitButton } from "@/ui/connections/pending-submit-button";
import { ReplyDraftsSignedOut } from "@/ui/inbox/reply-drafts-boundary";

/** Minimal account registration (Step 1). Onboarding (create organization) is a later step. */
export default async function SignUpPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const status = parseAuthStatus((await searchParams)["status"]);

  return (
    <main>
      {/* Step 7B-15H: a signed-out surface forgets every unsent reply draft kept in this tab. */}
      <ReplyDraftsSignedOut />
      <h1>{t("auth.sign_up.heading")}</h1>
      {status === undefined ? null : <p role="status">{t(AUTH_STATUS_MESSAGES[status])}</p>}

      {/* W12-AUTH-FIX-01: one submission at a time, with a visible pending state (no duplicate sign-up request). */}
      <SingleSubmitForm action={signUpWithPasswordAction}>
        <label>
          {t("auth.field.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          {t("auth.field.password")}
          <input name="password" type="password" autoComplete="new-password" required />
        </label>
        <PendingSubmitButton label={t("auth.sign_up.submit")} pendingLabel={t("auth.sign_up.submitting")} />
      </SingleSubmitForm>

      <p>
        <Link href="/sign-in">{t("auth.sign_in.link")}</Link>
      </p>
    </main>
  );
}
