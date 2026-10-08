/**
 * The INTEGRATION worker's AWS identity (Step 7E.4C; TA §39, ADR-64) — DEV/non-prod only; production topology is open
 * (TA-Q-05). Composed only by the integration plane's credential-opening composition (jobs/connections.ts, dependency
 * rule): the main plane, the web and every shared module never reach it.
 *
 *   INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID       long-lived IAM user access key id      (secret store, integration only)
 *   INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY   its secret                             (secret store, integration only)
 *   INTEGRATION_AWS_WORKER_ROLE_ARN               the ONE role that user may assume      (non-secret, integration only)
 *
 * Every credential resolution re-reads these three names (never the AWS default chain, never AWS_ACCESS_KEY_ID & co.),
 * checks the role against the validated KMS key (same partition and account; IAM role ARNs carry no region) and returns
 * TEMPORARY credentials of the assumed role: one STS AssumeRole per session — exact role, 900 s, a fixed session name,
 * nothing else — through an STSClient pinned to the KMS key's region with configured endpoint URLs ignored. The bootstrap
 * credential is never handed to KMS. Sessions are cached in this provider's closure only (never disk, logs or outputs),
 * refreshed when 120 s or less remain, refreshed with ONE request however many callers wait, and dropped as soon as the
 * configured identity changes — bootstrap access key id or worker role ARN (a rotated Trigger secret or a re-targeted
 * role takes effect without a redeploy). Every failure becomes an
 * AwsIdentityError carrying only its category: no message, key, role, response or cause.
 */
import { AssumeRoleCommand, STSClient, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import { AwsIdentityError, isIamRoleArn, type AwsCredentialProvider, type AwsIdentityFailure, type AwsTemporaryCredentials } from "@/platform/aws/identity";
import type { KmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";
import { INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID_ENV, INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY_ENV, INTEGRATION_AWS_WORKER_ROLE_ARN_ENV } from "./plane-environment";

type Environment = Readonly<Record<string, string | undefined>>;

/** STS session length requested for the worker role. */
export const INTEGRATION_WORKER_SESSION_SECONDS = 900;
/** Stable, source-defined, non-secret session name (visible in CloudTrail as the assumed-role session). */
export const INTEGRATION_WORKER_ROLE_SESSION_NAME = "integration-worker";
/** A cached session with this little time left (or less) is replaced before it is served. */
export const INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS = 120;

/** IAM access key ids: 16–128 word characters (IAM API constraint); no prefix is assumed. */
const ACCESS_KEY_ID = /^\w{16,128}$/;
/** A secret is opaque: printable, no whitespace, bounded. */
const SECRET_ACCESS_KEY = /^[\x21-\x7E]{16,256}$/;

const misconfigured = (): never => {
  throw new AwsIdentityError("IDENTITY_MISCONFIGURED");
};

interface BootstrapIdentity {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly roleArn: string;
}

/** The principal an assumed-role session belongs to: bootstrap key id + assumed role. Never the secret. */
interface SessionIdentity {
  readonly accessKeyId: string;
  readonly roleArn: string;
}

const sameIdentity = (a: SessionIdentity, b: SessionIdentity): boolean => a.accessKeyId === b.accessKeyId && a.roleArn === b.roleArn;

/** `arn:<partition>:<service>:<region>:<account>:…` → partition and account (both already shape-validated). */
const arnScope = (arn: string): { readonly partition: string; readonly account: string } => {
  const [, partition = "", , , account = ""] = arn.split(":");
  return { partition, account };
};

/**
 * The bootstrap identity as configured NOW, or IDENTITY_MISCONFIGURED (missing, empty, padded or malformed; a role in
 * another partition or account than the KMS key). Values are never echoed.
 */
export function readBootstrapIdentity(environment: Environment, kms: Pick<KmsKeyringConfig, "currentKeyArn">): BootstrapIdentity {
  const accessKeyId = environment[INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID_ENV];
  const secretAccessKey = environment[INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY_ENV];
  const roleArn = environment[INTEGRATION_AWS_WORKER_ROLE_ARN_ENV];
  if (accessKeyId === undefined || !ACCESS_KEY_ID.test(accessKeyId)) return misconfigured();
  if (secretAccessKey === undefined || !SECRET_ACCESS_KEY.test(secretAccessKey)) return misconfigured();
  if (!isIamRoleArn(roleArn)) return misconfigured();
  const role = arnScope(roleArn);
  const key = arnScope(kms.currentKeyArn);
  if (role.partition !== key.partition || role.account !== key.account) return misconfigured();
  return { accessKeyId, secretAccessKey, roleArn };
}

/** The one STS operation the bootstrap credential performs. */
export interface AssumeRoleSender {
  send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput>;
}

/**
 * The real STS client for one bootstrap credential: explicit region (the KMS key's) and explicit static credentials
 * (no default chain, profile, IMDS/ECS, web identity or credential process), configured endpoint URLs ignored, no
 * FIPS/dual-stack variant picked up from the environment.
 */
export function stsClientFor(region: string, credentials: { readonly accessKeyId: string; readonly secretAccessKey: string }): AssumeRoleSender {
  return new STSClient({
    region,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
    ignoreConfiguredEndpointUrls: true,
    useFipsEndpoint: false,
    useDualstackEndpoint: false,
  });
}

const FAILURES_BY_NAME: Readonly<Record<string, AwsIdentityFailure>> = Object.freeze({
  AccessDenied: "IDENTITY_ACCESS_DENIED",
  AccessDeniedException: "IDENTITY_ACCESS_DENIED",
  InvalidClientTokenId: "IDENTITY_ACCESS_DENIED",
  UnrecognizedClientException: "IDENTITY_ACCESS_DENIED",
  SignatureDoesNotMatch: "IDENTITY_ACCESS_DENIED",
  ExpiredToken: "IDENTITY_ACCESS_DENIED",
  ExpiredTokenException: "IDENTITY_ACCESS_DENIED",

  Throttling: "IDENTITY_UNAVAILABLE",
  ThrottlingException: "IDENTITY_UNAVAILABLE",
  TooManyRequests: "IDENTITY_UNAVAILABLE",
  TooManyRequestsException: "IDENTITY_UNAVAILABLE",
  ServiceUnavailable: "IDENTITY_UNAVAILABLE",
  ServiceUnavailableException: "IDENTITY_UNAVAILABLE",
  InternalFailure: "IDENTITY_UNAVAILABLE",
  InternalError: "IDENTITY_UNAVAILABLE",
  InternalServerError: "IDENTITY_UNAVAILABLE",
  RequestTimeout: "IDENTITY_UNAVAILABLE",
  RequestTimeoutException: "IDENTITY_UNAVAILABLE",
  TimeoutError: "IDENTITY_UNAVAILABLE",
  // Clock skew on managed compute is an operational, time-source condition: retry rather than declare misconfiguration.
  RequestTimeTooSkewed: "IDENTITY_UNAVAILABLE",

  RegionDisabledException: "IDENTITY_MISCONFIGURED",
  MalformedPolicyDocument: "IDENTITY_MISCONFIGURED",
  MalformedPolicyDocumentException: "IDENTITY_MISCONFIGURED",
  PackedPolicyTooLarge: "IDENTITY_MISCONFIGURED",
  PackedPolicyTooLargeException: "IDENTITY_MISCONFIGURED",
  ValidationError: "IDENTITY_MISCONFIGURED",
});

const TRANSIENT_NETWORK_CODES: readonly string[] = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"];

/** The meaning of an STS failure. Unknown → IDENTITY_MISCONFIGURED (fail closed). Nothing of the error is kept. */
export function stsIdentityFailure(error: unknown): AwsIdentityFailure {
  if (error instanceof AwsIdentityError) return error.failure;
  if (typeof error !== "object" || error === null) return "IDENTITY_MISCONFIGURED";
  const record = error as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : "";
  if (Object.hasOwn(FAILURES_BY_NAME, name)) return FAILURES_BY_NAME[name] ?? "IDENTITY_MISCONFIGURED";
  const code = typeof record["code"] === "string" ? record["code"] : "";
  const cause = record["cause"];
  const causeCode = typeof cause === "object" && cause !== null && typeof (cause as Record<string, unknown>)["code"] === "string" ? String((cause as Record<string, unknown>)["code"]) : "";
  if (TRANSIENT_NETWORK_CODES.includes(code) || TRANSIENT_NETWORK_CODES.includes(causeCode)) return "IDENTITY_UNAVAILABLE";
  if (typeof record["$retryable"] === "object" && record["$retryable"] !== null) return "IDENTITY_UNAVAILABLE";
  if (record["$fault"] === "server") return "IDENTITY_UNAVAILABLE";
  return "IDENTITY_MISCONFIGURED";
}

const present = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Complete temporary credentials expiring in the future, or IDENTITY_MISCONFIGURED. */
function temporaryCredentials(output: AssumeRoleCommandOutput, nowMs: number): AwsTemporaryCredentials {
  const credentials = output.Credentials;
  if (credentials === undefined) return misconfigured();
  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = credentials;
  if (!present(AccessKeyId) || !present(SecretAccessKey) || !present(SessionToken)) return misconfigured();
  if (!(Expiration instanceof Date) || Number.isNaN(Expiration.getTime()) || Expiration.getTime() <= nowMs) return misconfigured();
  return Object.freeze({ accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: SessionToken, expiration: Expiration });
}

/** Injection seam for offline tests; production re-reads process.env on every resolution and uses the real STS client. */
export interface IntegrationAwsIdentityDependencies {
  readonly readEnvironment: () => Environment;
  readonly stsClient: (region: string, credentials: { readonly accessKeyId: string; readonly secretAccessKey: string }) => AssumeRoleSender;
  readonly nowMs: () => number;
}

const PRODUCTION: IntegrationAwsIdentityDependencies = Object.freeze({
  readEnvironment: () => process.env,
  stsClient: stsClientFor,
  nowMs: () => Date.now(),
});

/**
 * The integration worker's AwsCredentialProvider for the given (validated) KMS keyring configuration. Lazy: nothing is
 * read or requested until the KMS opener asks for credentials.
 */
export function createIntegrationWorkerAwsCredentials(kms: Pick<KmsKeyringConfig, "currentKeyArn" | "region">, overrides: Partial<IntegrationAwsIdentityDependencies> = {}): AwsCredentialProvider {
  const deps: IntegrationAwsIdentityDependencies = { ...PRODUCTION, ...overrides };
  // Every session and every refresh carries the identity that produced it: the bootstrap principal's key id and the
  // role it assumed (never the secret: AWS rotates a key by issuing a new key id, not by mutating its secret).
  let cached: { readonly identity: SessionIdentity; readonly credentials: AwsTemporaryCredentials } | undefined;
  let inflight: { readonly identity: SessionIdentity; readonly promise: Promise<AwsTemporaryCredentials> } | undefined;

  const assume = async (identity: BootstrapIdentity): Promise<AwsTemporaryCredentials> => {
    try {
      const output = await deps.stsClient(kms.region, identity).send(
        new AssumeRoleCommand({ RoleArn: identity.roleArn, RoleSessionName: INTEGRATION_WORKER_ROLE_SESSION_NAME, DurationSeconds: INTEGRATION_WORKER_SESSION_SECONDS }),
      );
      return temporaryCredentials(output, deps.nowMs());
    } catch (error) {
      throw new AwsIdentityError(stsIdentityFailure(error));
    }
  };

  return async () => {
    // The CURRENT configuration is parsed and validated first, every time: a cache hit never bypasses it, and withdrawn
    // or invalid configuration fails closed even while a cached session would still be valid.
    const bootstrap = readBootstrapIdentity(deps.readEnvironment(), kms);
    const identity: SessionIdentity = { accessKeyId: bootstrap.accessKeyId, roleArn: bootstrap.roleArn };
    // A session is reused only while the configuration still targets the principal that produced it.
    if (cached !== undefined && !sameIdentity(cached.identity, identity)) cached = undefined;
    const fresh = cached?.credentials.expiration;
    if (cached !== undefined && fresh !== undefined && fresh.getTime() - deps.nowMs() > INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS * 1000) return cached.credentials;
    if (inflight !== undefined && sameIdentity(inflight.identity, identity)) return inflight.promise;
    const flight: { current?: { readonly identity: SessionIdentity; readonly promise: Promise<AwsTemporaryCredentials> } } = {};
    const promise = assume(bootstrap).then((credentials) => {
      // Installed only by the refresh that is still the current one: a refresh superseded by a newer identity (its
      // configuration changed meanwhile) still answers its own caller but never becomes the cached session.
      if (inflight === flight.current) cached = { identity, credentials };
      return credentials;
    });
    const current = { identity, promise };
    flight.current = current;
    inflight = current;
    // A settled refresh — success or failure — never stays in flight, so a failure is retried by the next caller.
    const settle = (): void => {
      if (inflight === current) inflight = undefined;
    };
    promise.then(settle, settle);
    return promise;
  };
}
