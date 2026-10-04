import type { NextRequest, NextResponse } from "next/server";
import { refreshSessionCookies } from "@/server/auth/proxy";

/** Keeps Supabase Auth session cookies fresh. Never an authorization decision (see server/auth/proxy.ts). */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  return refreshSessionCookies(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
