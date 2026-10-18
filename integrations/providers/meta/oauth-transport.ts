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
 */
import { SecretValue } from "../contract/credential";
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
  | { readonly kind: "ambiguous" };

export interface MetaTokenTransport {
  exchange(request: MetaTokenExchangeRequest): Promise<MetaTokenOutcome>;
}

export interface MetaTokenTransportOptions {
  readonly fetch?: MetaFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const AMBIGUOUS: MetaTokenOutcome = Object.freeze({ kind: "ambiguous" });

/** The response body as UTF-8 text, or undefined when it exceeds the bound or isn't valid UTF-8. */
async function boundedText(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
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
 * A 2xx body → a validated token, or undefined when it isn't the documented `{access_token, token_type, expires_in}`.
 * `expires_in` is REQUIRED (Step 7G-D2A): a credential is never accepted without a known expiry, and none is invented.
 */
function tokenOf(body: unknown): MetaTokenOutcome | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const accessToken = record["access_token"];
  if (typeof accessToken !== "string" || !ACCESS_TOKEN.test(accessToken)) return undefined;
  const tokenType = record["token_type"];
  if (tokenType !== undefined && (typeof tokenType !== "string" || tokenType === "")) return undefined;
  const expiresIn = record["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN_SECONDS) return undefined;
  return Object.freeze({ kind: "token", accessToken: new SecretValue(accessToken), expiresInSeconds: expiresIn });
}

export function createMetaTokenTransport(options: MetaTokenTransportOptions = {}): MetaTokenTransport {
  const fetchImpl: MetaFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? META_TOKEN_EXCHANGE_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? META_TOKEN_RESPONSE_MAX_BYTES;

  return {
    async exchange(request) {
      let text: string | undefined;
      let status: number;
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
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
          await response.body?.cancel();
          return AMBIGUOUS;
        }
        text = await boundedText(response, maxBytes);
      } catch {
        // Network failure, timeout or abort: the request may have reached Meta. Nothing of the error is kept.
        return AMBIGUOUS;
      }
      if (text === undefined) return AMBIGUOUS;
      const body = parseJson(text);
      if (status >= 200 && status < 300) return tokenOf(body) ?? AMBIGUOUS;
      const error = graphErrorFields(body);
      return error === null ? AMBIGUOUS : Object.freeze({ kind: "graph_error", error });
    },
  };
}
