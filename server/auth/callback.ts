/** Completes an email-link sign-in (magic link or email verification) for the callback route. */
import { readCallbackParams } from "./forms";
import { requestAuth } from "./request-auth";

/** Returns the relative path to redirect to. Never an externally supplied destination (no open redirect). */
export async function completeEmailLink(requestUrl: URL): Promise<string> {
  const params = readCallbackParams(requestUrl);
  if (params === undefined) return "/sign-in?status=invalid_link";
  const auth = await requestAuth();
  if (auth === undefined) return "/sign-in?status=unavailable";
  const outcome = await auth.completeEmailLink(params);
  return outcome === "signed_in" ? "/" : `/sign-in?status=${outcome}`;
}
