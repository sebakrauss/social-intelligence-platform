/**
 * TEMPORARY operator invocation of the hosted web KMS identity diagnostic (Step 7E.10-C0; ./web-kms-diagnostic.ts).
 * It exists only for the one live Vercel OIDC proof and is removed by a cleanup commit right after it
 * (design/phase-7e/web-identity/README.md, "Temporary invocation lifecycle"). It is NOT part of the product
 * authentication model: no user, workspace, organization or platform-admin authority is involved.
 *
 * Every check runs before the diagnostic is reached, and every refusal is the SAME generic 404 — no hint which check
 * failed, no echo of anything the caller sent:
 *
 *   method     POST only (the app route exports nothing else)
 *   runtime    NODE_ENV and VERCEL_ENV exactly "production" (the diagnostic re-checks both on its own)
 *   key        WEB_KMS_DIAGNOSTIC_OPERATOR_KEY: an EPHEMERAL value of at least 32 random bytes (64+ hex or 43+
 *              base64url characters), provisioned to Vercel Production only for the proof and deleted after it.
 *              Absent, empty or weak → refused (the route is inert without it)
 *   header     the caller sends that value in exactly one header, x-wrenkind-diagnostic-key. Never a query string,
 *              URL or body: a request with any query string is refused outright. Compared in constant time
 *              (SHA-256 digests, so the comparison does not depend on the supplied length)
 *   body       exactly { "acknowledge": "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_V1" }, at most 1 KiB, checked with the
 *              diagnostic's own input contract; the key alone is never enough
 *
 * Then the diagnostic runs ONCE for this request (no retry). Its result is either the sanitized outcome (200) or its
 * closed failure code (500). The OIDC token is never read here: the diagnostic uses the platform request token only.
 * Nothing is logged, persisted or written: no database, file, Trigger.dev, provider or customer data.
 *
 * One-shot is OPERATIONAL, not technical: a serverless process can't promise "once" with an in-memory flag. The
 * proof is one manual request without retry, CloudTrail correlation, then the key's deletion and this route's removal.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { WebKmsDiagnosticError, assertWebDiagnosticInput, type WebKmsDiagnosticFailure, type WebKmsDiagnosticOutcome } from "./web-kms-diagnostic";

type Environment = Readonly<Record<string, string | undefined>>;

export const WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV = "WEB_KMS_DIAGNOSTIC_OPERATOR_KEY";
export const WEB_KMS_DIAGNOSTIC_OPERATOR_HEADER = "x-wrenkind-diagnostic-key";
/** Larger bodies are refused unread beyond this bound (the acknowledgement object is ~60 bytes). */
export const WEB_KMS_DIAGNOSTIC_MAX_BODY_BYTES = 1024;

const HEX_KEY = /^[0-9a-f]{64,512}$/i;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43,512}$/;

/** The configured key meets the ephemeral-key strength contract: ≥ 32 random bytes as hex or base64url. */
export function isStrongOperatorKey(value: string | undefined): value is string {
  if (value === undefined) return false;
  if (/^[0-9a-f]+$/i.test(value)) return HEX_KEY.test(value);
  return BASE64URL_KEY.test(value);
}

const HEADERS = Object.freeze({ "Cache-Control": "no-store", "Content-Type": "application/json", "Referrer-Policy": "no-referrer" });
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** The one generic refusal for every pre-diagnostic check (method, runtime, key, header, query, body). */
export const WEB_KMS_DIAGNOSTIC_ROUTE_REFUSED = Object.freeze({ result: "NOT_FOUND" });
const refused = (): Response => json(404, WEB_KMS_DIAGNOSTIC_ROUTE_REFUSED);

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

function operatorAuthenticated(request: Request, environment: Environment): boolean {
  const configured = environment[WEB_KMS_DIAGNOSTIC_OPERATOR_KEY_ENV];
  if (!isStrongOperatorKey(configured)) return false;
  const supplied = request.headers.get(WEB_KMS_DIAGNOSTIC_OPERATOR_HEADER);
  if (supplied === null || supplied === "") return false;
  return timingSafeEqual(digest(supplied), digest(configured));
}

/** The exact acknowledgement payload, or undefined (unparseable, oversized, or anything but the one object). */
async function acknowledgement(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > WEB_KMS_DIAGNOSTIC_MAX_BODY_BYTES) return undefined;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") > WEB_KMS_DIAGNOSTIC_MAX_BODY_BYTES) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  try {
    assertWebDiagnosticInput(payload);
  } catch {
    return undefined;
  }
  return payload;
}

export type WebKmsDiagnose = (payload: unknown, environment: Environment) => Promise<WebKmsDiagnosticOutcome>;

/** The temporary operator invocation. `diagnose` is the production composition (./runtime.ts); tests inject a spy. */
export async function handleWebKmsDiagnosticRequest(request: Request, environment: Environment, diagnose: WebKmsDiagnose): Promise<Response> {
  if (request.method !== "POST") return refused();
  if (environment["NODE_ENV"] !== "production" || environment["VERCEL_ENV"] !== "production") return refused();
  if (new URL(request.url).search !== "") return refused();
  if (!operatorAuthenticated(request, environment)) return refused();
  const payload = await acknowledgement(request);
  if (payload === undefined) return refused();
  try {
    return json(200, await diagnose(payload, environment));
  } catch (error) {
    const failure: WebKmsDiagnosticFailure = error instanceof WebKmsDiagnosticError ? error.failure : "web_kms_diagnostic_failed";
    return json(500, { result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_FAILED", failure });
  }
}
