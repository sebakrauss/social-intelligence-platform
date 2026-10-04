/**
 * Session refresh for the Next.js proxy (official @supabase/ssr pattern). This only keeps auth cookies
 * fresh; it never authorizes. Authorization always happens server-side in the action pipeline and pages.
 */
import { NextResponse, type NextRequest } from "next/server";
import { readSupabaseAuthConfig, refreshSession } from "@/platform/auth";

export async function refreshSessionCookies(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const config = readSupabaseAuthConfig(process.env);
  if (config === undefined) return response;

  await refreshSession(config, {
    getAll: () => request.cookies.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (toSet) => {
      for (const { name, value } of toSet) request.cookies.set(name, value);
      response = NextResponse.next({ request });
      for (const { name, value, options } of toSet) response.cookies.set({ ...options, name, value });
    },
  });
  // Responses that may carry refreshed auth cookies must never be cached by a CDN.
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
