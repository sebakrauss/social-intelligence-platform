/**
 * Public Supabase Auth configuration. Only the project URL and the publishable (public) key are used:
 * no service-role or secret key ever reaches the application runtime (TA §11.5, R1).
 */

export interface SupabaseAuthConfig {
  readonly url: string;
  readonly publishableKey: string;
}

export const AUTH_ENV = {
  url: "NEXT_PUBLIC_SUPABASE_URL",
  publishableKey: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
} as const;

/** Returns the configuration, or undefined when it is absent or malformed (auth then reports "unavailable"). */
export function readSupabaseAuthConfig(env: Readonly<Record<string, string | undefined>>): SupabaseAuthConfig | undefined {
  const url = env[AUTH_ENV.url]?.trim();
  const publishableKey = env[AUTH_ENV.publishableKey]?.trim();
  if (url === undefined || url === "" || publishableKey === undefined || publishableKey === "") {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return undefined;
    return { url: parsed.origin, publishableKey };
  } catch {
    return undefined;
  }
}
