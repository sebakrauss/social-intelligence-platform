/**
 * The AWS runtime-identity contract (Step 7E.2; TA §39, ADR-64). Pure and vendor-neutral: it knows nothing about
 * Vercel, Trigger.dev, STS commands or KMS, and holds no token, key or secret. Adapters that obtain temporary
 * AWS credentials (7E.3: Vercel OIDC → AssumeRoleWithWebIdentity for the web; the worker's mechanism is still
 * open) implement it; the KMS client factory consumes it.
 *
 *   AwsCredentialProvider   an async, refreshable source of temporary credentials — always a function, never a
 *                           static identity, so nothing is resolved until an AWS operation asks for it (the web's
 *                           OIDC token only exists inside a request). It is structurally what AWS SDK clients
 *                           accept as `credentials`; the SDK's own type packages are not dependencies here.
 *   AwsIdentityError        the three outcomes an identity adapter normalizes every failure to; it carries the
 *                           category only (no message, cause, token, role or vendor detail)
 *   IAM role ARNs           the only role configuration is a full role ARN; anything else is refused
 *   AWS_STS_OIDC_AUDIENCE   the audience every OIDC token presented to AWS STS carries (TL decision, exact)
 */

/** The audience of web-identity tokens exchanged with AWS STS. Exactly this — not an https:// URL. */
export const AWS_STS_OIDC_AUDIENCE = "sts.amazonaws.com";

/** Temporary AWS credentials, as AWS SDK clients consume them. */
export interface AwsTemporaryCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

/** Lazily resolves (and refreshes) temporary credentials; invoked only when an AWS operation needs them. */
export type AwsCredentialProvider = () => Promise<AwsTemporaryCredentials>;

export const AWS_IDENTITY_FAILURES = ["IDENTITY_UNAVAILABLE", "IDENTITY_ACCESS_DENIED", "IDENTITY_MISCONFIGURED"] as const;

/**
 *   IDENTITY_UNAVAILABLE    a transient dependency failed: token exchange, STS or the IdP was unreachable/throttled
 *   IDENTITY_ACCESS_DENIED  the identity flow ran, but the token or the role assumption was rejected
 *   IDENTITY_MISCONFIGURED  the identity can't be obtained as configured: missing/invalid role ARN, no workload
 *                           token capability, invalid configuration
 */
export type AwsIdentityFailure = (typeof AWS_IDENTITY_FAILURES)[number];

export class AwsIdentityError extends Error {
  override readonly name = "AwsIdentityError";
  readonly failure: AwsIdentityFailure;

  constructor(failure: AwsIdentityFailure) {
    super(`aws_identity_${failure.toLowerCase()}`);
    this.failure = failure;
  }

  toJSON(): { readonly failure: AwsIdentityFailure } {
    return { failure: this.failure };
  }
}

/**
 * A full IAM role ARN: `arn:<partition>:iam::<12-digit account>:role/<optional path/><name>`. IAM is global, so the
 * region field is empty. Role names are 1–64 of [A-Za-z0-9+=,.@_-]; path segments are printable ASCII without "/".
 */
const IAM_ROLE_ARN = /^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/((?:[\x21-\x2E\x30-\x7E]+\/)*)([\w+=,.@-]{1,64})$/;
const MAX_ROLE_PATH = 512;

export function isIamRoleArn(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = IAM_ROLE_ARN.exec(value);
  return match !== null && (match[1] ?? "").length + 1 <= MAX_ROLE_PATH;
}

/** The role ARN, or IDENTITY_MISCONFIGURED. The value is never echoed. */
export function parseIamRoleArn(value: unknown): string {
  if (!isIamRoleArn(value)) throw new AwsIdentityError("IDENTITY_MISCONFIGURED");
  return value;
}
