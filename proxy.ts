import type { NextRequest, NextResponse } from "next/server";
import { refreshSessionCookies } from "@/server/auth/proxy";
import { rejectForbiddenWebEnvironment } from "@/server/http/web-environment";

/**
 * Refuses every request when a hosted web runtime carries forbidden configuration (TA-11A), then keeps Supabase
 * Auth session cookies fresh. Never an authorization decision (see server/auth/proxy.ts).
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  return rejectForbiddenWebEnvironment() ?? refreshSessionCookies(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
