import Link from "next/link";
import { requestSignInLinkAction, signInWithPasswordAction } from "@/server/auth/actions";
import { AUTH_STATUS_MESSAGES, parseAuthStatus } from "@/server/auth/forms";
import { t } from "@/server/i18n";

/** Minimal, utilitarian sign-in surface (Step 1). No product design work. */
export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const status = parseAuthStatus((await searchParams)["status"]);

  return (
    <main>
      <h1>{t("auth.sign_in.heading")}</h1>
      {status === undefined ? null : <p role="status">{t(AUTH_STATUS_MESSAGES[status])}</p>}

      <form action={signInWithPasswordAction}>
        <label>
          {t("auth.field.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          {t("auth.field.password")}
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">{t("auth.sign_in.submit")}</button>
      </form>

      <h2>{t("auth.sign_in_link.heading")}</h2>
      <form action={requestSignInLinkAction}>
        <label>
          {t("auth.field.email")}
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <button type="submit">{t("auth.sign_in_link.submit")}</button>
      </form>

      <p>
        <Link href="/sign-up">{t("auth.sign_up.link")}</Link>
      </p>
    </main>
  );
}
