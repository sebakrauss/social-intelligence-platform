import Link from "next/link";
import { requestSignInLinkAction, signInWithPasswordAction } from "@/server/auth/actions";
import { AUTH_STATUS_MESSAGES, parseAuthStatus } from "@/server/auth/forms";
import { t } from "@/server/i18n";
import { SingleSubmitForm } from "@/ui/auth/single-submit-form";
import { PendingSubmitButton } from "@/ui/connections/pending-submit-button";
import { ReplyDraftsSignedOut } from "@/ui/inbox/reply-drafts-boundary";

/** Minimal, utilitarian sign-in surface (Step 1). No product design work. */
export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const status = parseAuthStatus((await searchParams)["status"]);

  return (
    <main>
      {/* Step 7B-15H: a signed-out surface forgets every unsent reply draft kept in this tab. */}
      <ReplyDraftsSignedOut />
      <h1>{t("auth.sign_in.heading")}</h1>
      {status === undefined ? null : <p role="status">{t(AUTH_STATUS_MESSAGES[status])}</p>}

      {/* W12-AUTH-FIX-01: one submission at a time per form, with a visible pending state. */}
      <SingleSubmitForm action={signInWithPasswordAction}>
        <label>
          {t("auth.field.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          {t("auth.field.password")}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <PendingSubmitButton label={t("auth.sign_in.submit")} pendingLabel={t("auth.sign_in.submitting")} />
      </SingleSubmitForm>

      <h2>{t("auth.sign_in_link.heading")}</h2>
      <SingleSubmitForm action={requestSignInLinkAction}>
        <label>
          {t("auth.field.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <PendingSubmitButton label={t("auth.sign_in_link.submit")} pendingLabel={t("auth.sign_in_link.submitting")} />
      </SingleSubmitForm>

      <p>
        <Link href="/sign-up">{t("auth.sign_up.link")}</Link>
      </p>
    </main>
  );
}
