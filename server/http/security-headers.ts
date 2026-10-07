/**
 * Security headers for every web response (TA-11A; TA §38.7). The reviewed MINIMUM for a hosted web runtime:
 *
 *   Content-Security-Policy   only directives that can't break Next.js hydration: no framing (clickjacking), no
 *                             foreign <base>, forms post only to this origin (server actions are same-origin), no
 *                             plugins. A full script/style CSP needs per-request nonce infrastructure and is NOT
 *                             claimed here (tracked separately); no 'unsafe-*' source is ever added to fake one.
 *   X-Frame-Options           legacy twin of frame-ancestors 'none'
 *   X-Content-Type-Options    nosniff
 *   Referrer-Policy           no-referrer (matches the OAuth callback's own header)
 *   Permissions-Policy        every powerful feature the product doesn't use is denied
 *   Strict-Transport-Security HTTPS only on hosted origins (ignored by browsers on plain-HTTP localhost)
 *
 * No third-party origin appears anywhere (no provider frontend integration exists). Cache-Control is deliberately
 * NOT set here: the proxy marks session-bearing responses `private, no-store`, and nothing here may weaken that.
 */

export const CONTENT_SECURITY_POLICY = ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join("; ");

export const SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] = Object.freeze([
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
]);

/** The next.config `headers()` rule set: the same headers on every path. */
export function securityHeaderRules(): { source: string; headers: { key: string; value: string }[] }[] {
  return [{ source: "/:path*", headers: SECURITY_HEADERS.map(({ key, value }) => ({ key, value })) }];
}
