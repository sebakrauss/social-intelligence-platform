/**
 * The provider OAuth callback transport (Step 5D; TA-04: route handlers are reserved for callbacks). It collects
 * the raw query pairs, hands them to the orchestration, and redirects to a closed status. It never echoes a
 * callback parameter, never caches, and sends no Referer onward. Any composition failure fails closed.
 */
import type { CallbackQuery } from "@/integrations/providers/contract";
import { requestAuth } from "@/server/auth/request-auth";
import { completeConnectionAuthorization } from "./authorization";
import { connectionAuthorizationRuntime } from "./runtime";

const MAX_PARAMETERS = 32;

export async function handleOAuthCallback(request: Request, provider: string): Promise<Response> {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  let status = "unavailable";
  if (entries.length <= MAX_PARAMETERS) {
    try {
      const auth = await requestAuth();
      if (auth !== undefined) {
        const query: CallbackQuery = entries;
        const result = await completeConnectionAuthorization(connectionAuthorizationRuntime(auth), { provider, query });
        status = result.status;
      }
    } catch {
      status = "unavailable";
    }
  } else {
    status = "restart_required";
  }
  const target = new URL("/", url.origin);
  target.searchParams.set("connection", status);
  return new Response(null, { status: 303, headers: { Location: target.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
