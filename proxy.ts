import { NextResponse, type NextRequest } from "next/server";
import { refreshSessionCookies } from "@/server/auth/proxy";
import { rejectForbiddenWebEnvironment } from "@/server/http/web-environment";

/**
 * Public provider webhook receivers (Step H6-F3): trusted by the provider's signature, never by a browser session, so
 * they skip the session refresh (no cookie read or written). Exact paths only — never a prefix such as /api/.
 */
export const SESSIONLESS_PATHS: readonly string[] = Object.freeze(["/api/webhooks/meta"]);

/**
 * Refuses every request when a hosted web runtime carries forbidden configuration (TA-11A), then keeps Supabase
 * Auth session cookies fresh — except on the sessionless webhook paths. Never an authorization decision (see
 * server/auth/proxy.ts).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const refused = rejectForbiddenWebEnvironment();
  if (refused !== undefined) return refused;
  if (SESSIONLESS_PATHS.includes(request.nextUrl.pathname)) return NextResponse.next();
  return refreshSessionCookies(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
