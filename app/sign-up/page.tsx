import Link from "next/link";
import { signUpWithPasswordAction } from "@/server/auth/actions";
import { AUTH_STATUS_MESSAGES, parseAuthStatus } from "@/server/auth/forms";
import { t } from "@/server/i18n";

/** Minimal account registration (Step 1). Onboarding (create organization) is a later step. */
export default async function SignUpPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const status = parseAuthStatus((await searchParams)["status"]);

  return (
    <main>
      <h1>{t("auth.sign_up.heading")}</h1>
      {status === undefined ? null : <p role="status">{t(AUTH_STATUS_MESSAGES[status])}</p>}

      <form action={signUpWithPasswordAction}>
        <label>
          {t("auth.field.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          {t("auth.field.password")}
          <input name="password" type="password" autoComplete="new-password" required />
        </label>
        <button type="submit">{t("auth.sign_up.submit")}</button>
      </form>

      <p>
        <Link href="/sign-in">{t("auth.sign_in.link")}</Link>
      </p>
    </main>
  );
}
