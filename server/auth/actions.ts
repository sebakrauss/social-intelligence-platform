"use server";
/**
 * Auth server actions (sign-up, sign-in, sign-in link, sign-out). Credentials go straight to the auth adapter;
 * nothing identifying (email, password, tokens, cookies) is logged. Outcomes are reported to the page
 * through a closed set of status codes.
 */
import { redirect } from "next/navigation";
import { createLogger, stdoutSink } from "@/platform/observability";
import { AUTH_ENV_BASE_URL } from "./config";
import { callbackUrl, readCredentials, readEmail, type AuthStatus } from "./forms";
import { requestAuth } from "./request-auth";

const log = createLogger({ sink: stdoutSink, base: { module: "server.auth" } });

function toSignIn(status: AuthStatus): never {
  redirect(`/sign-in?status=${status}`);
}

function toSignUp(status: AuthStatus): never {
  redirect(`/sign-up?status=${status}`);
}

/**
 * Minimal account registration. Creates no organization (onboarding is a later step). The user must
 * verify their email before accessing any organization. Existing addresses get the same response.
 */
export async function signUpWithPasswordAction(form: FormData): Promise<void> {
  const credentials = readCredentials(form);
  if (credentials === undefined) toSignUp("invalid_input");
  const redirectTo = callbackUrl(process.env[AUTH_ENV_BASE_URL]);
  const auth = await requestAuth();
  if (auth === undefined || redirectTo === undefined) toSignUp("unavailable");
  const outcome = await auth.signUpWithPassword(credentials.email, credentials.password, redirectTo);
  log.info("auth.sign_up.finished", { operation: "sign_up_password", outcome: outcome === "verification_required" || outcome === "signed_in" ? "ok" : "error" });
  if (outcome === "signed_in") redirect("/");
  if (outcome === "verification_required") toSignIn("sign_up_check_email");
  toSignUp(outcome);
}

export async function signInWithPasswordAction(form: FormData): Promise<void> {
  const credentials = readCredentials(form);
  if (credentials === undefined) toSignIn("invalid_input");
  const auth = await requestAuth();
  if (auth === undefined) toSignIn("unavailable");
  const outcome = await auth.signInWithPassword(credentials.email, credentials.password);
  log.info("auth.sign_in.finished", { operation: "sign_in_password", outcome: outcome === "signed_in" ? "ok" : "error" });
  if (outcome === "signed_in") redirect("/");
  toSignIn(outcome);
}

export async function requestSignInLinkAction(form: FormData): Promise<void> {
  const address = readEmail(form);
  if (address === undefined) toSignIn("invalid_input");
  const redirectTo = callbackUrl(process.env[AUTH_ENV_BASE_URL]);
  const auth = await requestAuth();
  if (auth === undefined || redirectTo === undefined) toSignIn("unavailable");
  const outcome = await auth.requestSignInLink(address, redirectTo);
  log.info("auth.sign_in_link.finished", { operation: "sign_in_link", outcome: outcome === "sent" ? "ok" : "error" });
  toSignIn(outcome === "sent" ? "link_sent" : outcome);
}

export async function signOutAction(): Promise<void> {
  const auth = await requestAuth();
  await auth?.signOut();
  toSignIn("signed_out");
}
