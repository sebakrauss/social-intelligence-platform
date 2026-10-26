/**
 * The Meta authorization-code exchange over HTTP (Step 7G-D; design/phase-7g/meta-provider/README.md, D1 G3):
 *
 *   GET https://graph.facebook.com/v25.0/oauth/access_token?client_id&redirect_uri&client_secret&code
 *
 * The transport owns the fixed endpoint: callers name the operation and its values, never a URL. Meta's contract is
 * a GET, so the request URL carries the App Secret and the authorization code: the URL is built here, handed to
 * `fetch`, and never logged, thrown, returned or serialized. Each call makes exactly ONE request — no retry, no
 * redirect (`manual`, and any 3xx is refused), no cookies or ambient credentials, a finite timeout over the whole
 * exchange and a bounded response body. Results are closed: a validated token (wrapped at once as a SecretValue),
 * the closed fields of a Graph error, or `ambiguous` — the request may have been processed (no response, timeout,
 * redirect, unreadable or unexpected body), so the authorization code must be considered spent.
 *
 * Every `ambiguous` carries ONE closed reason (Step 7G-H5.5-P12-C0-R5A) naming the branch, or for a 2xx body the
 * token-response check, that refused it: never a value, a body fragment, a status text or anything from an error.
 * Handling is unchanged — every reason is the same OutcomeUnknown.
 */
import { SecretValue } from "../contract/credential";
import type { OutcomeUnknownReason } from "../contract/errors";
import { META_TOKEN_URL } from "./endpoints";
import { graphErrorFields, type MetaGraphErrorFields } from "./errors";

/** The whole exchange (connect, response, body) must finish within this. */
export const META_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
/** A token response is a small JSON object; anything larger is refused unread. */
export const META_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

const ACCESS_TOKEN = /^[\x21-\x7E]{1,4096}$/;
/** Ten years: an upper bound that keeps the computed expiry a valid instant, not a provider-documented limit. */
const MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 3600;

export type MetaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MetaTokenExchangeRequest {
  readonly clientId: string;
  readonly clientSecret: SecretValue;
  /** Exactly the redirect URI of the authorization request that produced the code. */
  readonly redirectUri: string;
  readonly code: SecretValue;
}

export type MetaTokenOutcome =
  | { readonly kind: "token"; readonly accessToken: SecretValue; readonly expiresInSeconds: number }
  | { readonly kind: "graph_error"; readonly error: MetaGraphErrorFields }
  | { readonly kind: "ambiguous"; readonly reason: OutcomeUnknownReason };

export interface MetaTokenTransport {
  exchange(request: MetaTokenExchangeRequest): Promise<MetaTokenOutcome>;
}

export interface MetaTokenTransportOptions {
  readonly fetch?: MetaFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const ambiguous = (reason: OutcomeUnknownReason): MetaTokenOutcome => Object.freeze({ kind: "ambiguous", reason });

type BodyText = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: "response_too_large" | "response_not_utf8" };

/** The response body as UTF-8 text, or why it wasn't read: over the bound, or not valid UTF-8. */
async function boundedText(response: Response, maxBytes: number): Promise<BodyText> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return { ok: false, reason: "response_too_large" };
  }
  if (response.body === null) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "response_too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "response_not_utf8" };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A 2xx body → a validated token, or the first check of the documented `{access_token, token_type, expires_in}` it
 * fails (by field and absent/invalid only, never the value). `expires_in` is REQUIRED (Step 7G-D2A): a credential is
 * never accepted without a known expiry, and none is invented.
 */
function tokenOf(body: unknown): MetaTokenOutcome {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ambiguous("token_response_not_object");
  const record = body as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (accessToken === undefined) return ambiguous("token_response_access_token_missing");
  if (typeof accessToken !== "string" || !ACCESS_TOKEN.test(accessToken)) return ambiguous("token_response_access_token_invalid");
  const tokenType = record["token_type"];
  if (tokenType !== undefined && (typeof tokenType !== "string" || tokenType === "")) return ambiguous("token_response_token_type_invalid");
  const expiresIn = record["expires_in"];
  if (expiresIn === undefined) return ambiguous("token_response_expires_in_missing");
  if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN_SECONDS) return ambiguous("token_response_expires_in_invalid");
  return Object.freeze({ kind: "token", accessToken: new SecretValue(accessToken), expiresInSeconds: expiresIn });
}

/** A non-2xx, non-3xx status whose body isn't a Graph error: its class only. */
function unrecognizedStatus(status: number): OutcomeUnknownReason {
  if (status >= 500 && status <= 599) return "unrecognized_5xx_response";
  if (status >= 400 && status <= 499) return "unrecognized_4xx_response";
  return "unrecognized_status_response";
}

export function createMetaTokenTransport(options: MetaTokenTransportOptions = {}): MetaTokenTransport {
  const fetchImpl: MetaFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? META_TOKEN_EXCHANGE_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? META_TOKEN_RESPONSE_MAX_BYTES;

  return {
    async exchange(request) {
      let body: BodyText;
      let status: number;
      // Our own signal: whether IT fired is what tells a timeout from any other failure (the error is never read).
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const url = new URL(META_TOKEN_URL);
        url.search = new URLSearchParams([
          ["client_id", request.clientId],
          ["redirect_uri", request.redirectUri],
          ["client_secret", request.clientSecret.expose()],
          ["code", request.code.expose()],
        ]).toString();
        const response = await fetchImpl(url.href, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { accept: "application/json" },
          signal,
        });
        status = response.status;
        if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
          await response.body?.cancel();
          return ambiguous("unexpected_redirect");
        }
        body = await boundedText(response, maxBytes);
      } catch {
        // Network failure, timeout or abort: the request may have reached Meta. Nothing of the error is kept.
        return ambiguous(signal.aborted ? "timeout" : "network_error");
      }
      if (!body.ok) return ambiguous(body.reason);
      const parsed = parseJson(body.text);
      if (status >= 200 && status < 300) return tokenOf(parsed);
      const error = graphErrorFields(parsed);
      return error === null ? ambiguous(unrecognizedStatus(status)) : Object.freeze({ kind: "graph_error", error });
    },
  };
}
