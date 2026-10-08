/**
 * The hosted web's AWS identity: Vercel OIDC → AssumeRoleWithWebIdentity (Step 7E.3B; TA §39, ADR-64). Server only.
 *
 * Every credential resolution, inside the request that needs it:
 *   1. read THIS request's Vercel OIDC token without any refresh capability: the request context's
 *      `x-vercel-oidc-token` header (via @vercel/oidc's public getContext()), else VERCEL_OIDC_TOKEN — exactly the
 *      sources and precedence of @vercel/oidc 3.8.10's synchronous reader. Neither getVercelOidcToken (refreshing)
 *      nor getVercelOidcTokenSync (deprecated) is used;
 *   2. preflight it locally, fail closed: present, a three-part JWT of bounded size, a base64url JSON-object payload
 *      with an integer `exp` at least VERCEL_OIDC_PREFLIGHT_MIN_TTL_SECONDS in the future. This is NOT
 *      authentication (signature, issuer, subject, project and environment are the AWS OIDC trust's job); it only
 *      guarantees the official provider is never entered with an absent, malformed, expired or nearly expired
 *      token, so @vercel/oidc's development-only refresh branch stays unreachable from our call graph;
 *   3. only then build and resolve the official awsCredentialsProvider: audience AWS_STS_OIDC_AUDIENCE, the
 *      validated web role, a one-hour session, and an STS client pinned to the KMS key's region with configured
 *      endpoint URLs ignored (no AWS_REGION, no AWS_ENDPOINT_URL_*, no shared config);
 *   4. normalize every failure to AwsIdentityError — no message, token, role, response body or cause is kept.
 *
 * Nothing is cached here and no module-level state holds a token: each resolution reads the current request's
 * token again. AWS credentials are cached only by the AWS SDK client that consumes this provider.
 */
import { getContext } from "@vercel/oidc";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { AWS_STS_OIDC_AUDIENCE, AwsIdentityError, type AwsCredentialProvider, type AwsIdentityFailure } from "@/platform/aws/identity";
import type { WebAwsIdentityFactory } from "./web-identity";

/** A token must stay valid at least this long, or the official provider (and its refresh branch) is not entered. */
export const VERCEL_OIDC_PREFLIGHT_MIN_TTL_SECONDS = 120;
/** Vercel OIDC JWTs are around 1 KB; anything beyond this is refused before decoding. */
export const VERCEL_OIDC_MAX_TOKEN_LENGTH = 8192;
/** STS session length requested for the web role (never more than one hour). */
export const VERCEL_WEB_SESSION_SECONDS = 3600;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The Vercel OIDC token's two documented sources. VERCEL_OIDC_TOKEN is read only here; it is not an AWS credential. */
const OIDC_TOKEN_HEADER = "x-vercel-oidc-token";
const OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN";

/**
 * The current request's OIDC token, or undefined. Same precedence as @vercel/oidc 3.8.10: the header unless it is
 * absent (undefined/null), then the environment variable; an empty value — including an empty header, which does NOT
 * fall back — counts as missing. No refresh, no file, no network, no write, no cache: read again on every call.
 */
function readVercelOidcTokenNoRefresh(): string | undefined {
  const token = getContext().headers?.[OIDC_TOKEN_HEADER] ?? process.env[OIDC_TOKEN_ENV];
  return typeof token === "string" && token !== "" ? token : undefined;
}

const refuse = (failure: AwsIdentityFailure): never => {
  throw new AwsIdentityError(failure);
};

/**
 * Structural, non-authenticating preflight. Missing → IDENTITY_MISCONFIGURED; malformed or expired →
 * IDENTITY_ACCESS_DENIED; valid but inside the safety window → IDENTITY_UNAVAILABLE (a later request may carry a
 * fresh token). Never echoes the token or its payload.
 */
export function preflightVercelOidcToken(token: unknown, nowSeconds: number): void {
  if (typeof token !== "string" || token === "") return refuse("IDENTITY_MISCONFIGURED");
  if (token.length > VERCEL_OIDC_MAX_TOKEN_LENGTH) return refuse("IDENTITY_ACCESS_DENIED");
  const segments = token.split(".");
  if (segments.length !== 3 || !segments.every((segment) => BASE64URL_SEGMENT.test(segment))) return refuse("IDENTITY_ACCESS_DENIED");
  const encoded = segments[1] ?? "";
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) return refuse("IDENTITY_ACCESS_DENIED");
  let payload: unknown;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    return refuse("IDENTITY_ACCESS_DENIED");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return refuse("IDENTITY_ACCESS_DENIED");
  const exp = (payload as Record<string, unknown>)["exp"];
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0) return refuse("IDENTITY_ACCESS_DENIED");
  if (exp <= nowSeconds) return refuse("IDENTITY_ACCESS_DENIED");
  if (exp - nowSeconds < VERCEL_OIDC_PREFLIGHT_MIN_TTL_SECONDS) return refuse("IDENTITY_UNAVAILABLE");
}

/** STS / web-identity / exchange failures by meaning. Anything not listed fails closed as IDENTITY_MISCONFIGURED. */
const FAILURES_BY_NAME: Readonly<Record<string, AwsIdentityFailure>> = Object.freeze({
  AccessDenied: "IDENTITY_ACCESS_DENIED",
  AccessDeniedException: "IDENTITY_ACCESS_DENIED",
  InvalidIdentityToken: "IDENTITY_ACCESS_DENIED",
  InvalidIdentityTokenException: "IDENTITY_ACCESS_DENIED",
  ExpiredToken: "IDENTITY_ACCESS_DENIED",
  ExpiredTokenException: "IDENTITY_ACCESS_DENIED",
  IDPRejectedClaim: "IDENTITY_ACCESS_DENIED",
  IDPRejectedClaimException: "IDENTITY_ACCESS_DENIED",

  IDPCommunicationError: "IDENTITY_UNAVAILABLE",
  IDPCommunicationErrorException: "IDENTITY_UNAVAILABLE",
  Throttling: "IDENTITY_UNAVAILABLE",
  ThrottlingException: "IDENTITY_UNAVAILABLE",
  RequestLimitExceeded: "IDENTITY_UNAVAILABLE",
  ServiceUnavailable: "IDENTITY_UNAVAILABLE",
  ServiceUnavailableException: "IDENTITY_UNAVAILABLE",
  InternalFailure: "IDENTITY_UNAVAILABLE",
  RequestTimeout: "IDENTITY_UNAVAILABLE",
  RequestTimeoutException: "IDENTITY_UNAVAILABLE",
  TimeoutError: "IDENTITY_UNAVAILABLE",

  MalformedPolicyDocument: "IDENTITY_MISCONFIGURED",
  MalformedPolicyDocumentException: "IDENTITY_MISCONFIGURED",
  PackedPolicyTooLarge: "IDENTITY_MISCONFIGURED",
  PackedPolicyTooLargeException: "IDENTITY_MISCONFIGURED",
  RegionDisabledException: "IDENTITY_MISCONFIGURED",
  ValidationError: "IDENTITY_MISCONFIGURED",
});

const TRANSIENT_NETWORK_CODES: readonly string[] = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"];

/** The meaning of a provider / federation failure. Messages are inspected only to classify; nothing is kept. */
export function vercelIdentityFailure(error: unknown): AwsIdentityFailure {
  if (error instanceof AwsIdentityError) return error.failure;
  if (typeof error !== "object" || error === null) return "IDENTITY_MISCONFIGURED";
  const record = error as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : "";
  if (Object.hasOwn(FAILURES_BY_NAME, name)) return FAILURES_BY_NAME[name] ?? "IDENTITY_MISCONFIGURED";
  const code = typeof record["code"] === "string" ? record["code"] : "";
  const causeCode = typeof (record["cause"] as Record<string, unknown> | undefined)?.["code"] === "string" ? String((record["cause"] as Record<string, unknown>)["code"]) : "";
  if (TRANSIENT_NETWORK_CODES.includes(code) || TRANSIENT_NETWORK_CODES.includes(causeCode)) return "IDENTITY_UNAVAILABLE";
  if (typeof record["$retryable"] === "object" && record["$retryable"] !== null) return "IDENTITY_UNAVAILABLE";
  if (record["$fault"] === "server") return "IDENTITY_UNAVAILABLE";
  const message = typeof record["message"] === "string" ? record["message"] : "";
  // The audience exchange (Vercel token service) failing or unreachable: a transient dependency for this request.
  if (message.startsWith("Failed to exchange token")) return "IDENTITY_UNAVAILABLE";
  if (name === "TypeError" && message === "fetch failed") return "IDENTITY_UNAVAILABLE";
  return "IDENTITY_MISCONFIGURED";
}

/** Injection seam for offline tests; production uses the official functions. */
export interface VercelAwsIdentityDependencies {
  readonly readToken: () => string | undefined;
  readonly officialProvider: typeof awsCredentialsProvider;
  readonly nowSeconds: () => number;
}

const OFFICIAL: VercelAwsIdentityDependencies = Object.freeze({
  readToken: readVercelOidcTokenNoRefresh,
  officialProvider: awsCredentialsProvider,
  nowSeconds: () => Math.floor(Date.now() / 1000),
});

/** Production uses the official functions; tests may override any of them (the real token reader stays testable). */
export function createVercelAwsIdentity(overrides: Partial<VercelAwsIdentityDependencies> = {}): WebAwsIdentityFactory {
  const dependencies: VercelAwsIdentityDependencies = { ...OFFICIAL, ...overrides };
  return (config): AwsCredentialProvider =>
    async () => {
      let token: string | undefined;
      try {
        token = dependencies.readToken();
      } catch {
        return refuse("IDENTITY_MISCONFIGURED");
      }
      preflightVercelOidcToken(token, dependencies.nowSeconds());
      token = undefined;
      try {
        const provider = dependencies.officialProvider({
          roleArn: config.roleArn,
          audience: AWS_STS_OIDC_AUDIENCE,
          durationSeconds: VERCEL_WEB_SESSION_SECONDS,
          clientConfig: { region: config.stsRegion, ignoreConfiguredEndpointUrls: true },
        });
        const credentials = await provider();
        return {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          ...(credentials.sessionToken === undefined ? {} : { sessionToken: credentials.sessionToken }),
          ...(credentials.expiration === undefined ? {} : { expiration: credentials.expiration }),
        };
      } catch (error) {
        throw new AwsIdentityError(vercelIdentityFailure(error));
      }
    };
}

/** The production adapter (official @vercel/oidc functions), injected into the web composition. */
export const vercelAwsIdentity: WebAwsIdentityFactory = createVercelAwsIdentity();
