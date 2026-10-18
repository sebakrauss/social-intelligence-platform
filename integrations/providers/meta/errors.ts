/**
 * Graph API error normalization (Step 7G-D; TA §15.2). Meta's error object is
 * `{error: {message, type, code, error_subcode, error_user_title, error_user_msg, fbtrace_id}}`. Only `code`,
 * `error_subcode` and whether `type` is `OAuthException` are read; every provider string (message, user texts,
 * trace id) is discarded before anything leaves the transport.
 *
 * Mapping (Graph error-handling and rate-limiting references, Step 7G-B1):
 *   4, 17, 32, 341, 613, 80000, 80001, 80002, 80004, 80008   rate limited (no delay is trusted: backoff)
 *   10, 200–299                                              permission missing
 *   1, 2                                                     temporary provider issue
 *   368                                                      policy block
 *   190 or 102, or any OAuthException                        credential invalid: subcode 463 expired,
 *                                                            458 / 460 revoked, anything else unknown
 *   anything else understood as a Graph error                permanent rejection (unknown)
 * A response that isn't a recognizable Graph error is not mapped here: the caller treats it as an unknown outcome.
 *
 * Graph reads (Step 7G-E) add one documented case first: error_subcode 492 (the User has no role on the Page) is a
 * missing permission, never an invalid credential — even inside an OAuthException. The authorization-code exchange
 * keeps the mapping above unchanged.
 */
import {
  CredentialInvalidError,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TransientError,
  type PermissionCapability,
  type ProviderError,
  type ProviderOperation,
} from "../contract/errors";

/** The closed facts kept from a Graph error body: numbers and one boolean, never provider text. */
export interface MetaGraphErrorFields {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly oauthException: boolean;
}

const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 341, 613, 80000, 80001, 80002, 80004, 80008]);
const TEMPORARY_CODES: ReadonlySet<number> = new Set([1, 2]);
const POLICY_BLOCK_CODE = 368;
const CREDENTIAL_CODES: ReadonlySet<number> = new Set([102, 190]);

const integerOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);

/** The closed fields of a Graph error body, or null when the body is not a recognizable Graph error. */
export function graphErrorFields(body: unknown): MetaGraphErrorFields | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const code = integerOrNull(record["code"]);
  const oauthException = record["type"] === "OAuthException";
  if (code === null && !oauthException) return null;
  return Object.freeze({ code, subcode: integerOrNull(record["error_subcode"]), oauthException });
}

/** One normalized provider error for a Graph error. `capability` is what a missing permission blocks. */
export function metaGraphError(operation: ProviderOperation, fields: MetaGraphErrorFields, capability: PermissionCapability): ProviderError {
  const { code, subcode } = fields;
  if (code !== null && RATE_LIMIT_CODES.has(code)) return new RateLimitedError(operation, null);
  if (code !== null && (code === 10 || (code >= 200 && code <= 299))) return new PermissionMissingError(operation, capability);
  if (code !== null && TEMPORARY_CODES.has(code)) return new TransientError(operation, "provider_unavailable");
  if (code === POLICY_BLOCK_CODE) return new PermanentRejectedError(operation, "content_policy");
  if ((code !== null && CREDENTIAL_CODES.has(code)) || fields.oauthException) {
    if (subcode === 463) return new CredentialInvalidError(operation, "expired");
    if (subcode === 458 || subcode === 460) return new CredentialInvalidError(operation, "revoked");
    return new CredentialInvalidError(operation, "unknown");
  }
  return new PermanentRejectedError(operation, "unknown");
}

const NO_PAGE_ROLE_SUBCODE = 492;

/** Graph READ errors: subcode 492 → permission missing, then the shared mapping. */
export function metaGraphReadError(operation: ProviderOperation, fields: MetaGraphErrorFields, capability: PermissionCapability): ProviderError {
  if (fields.subcode === NO_PAGE_ROLE_SUBCODE) return new PermissionMissingError(operation, capability);
  return metaGraphError(operation, fields, capability);
}
