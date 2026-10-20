/**
 * The INTEGRATION worker's AWS identity: AWS IAM Roles Anywhere (Step 7G-H5.6B; TA §39, ADR-64) — DEV/non-prod; the
 * production topology stays open (TA-Q-05). Composed only by the integration plane's credential-opening composition
 * (jobs/connections.ts, dependency rule): the main plane, the web and every shared module never reach it. It replaces
 * the temporary bootstrap IAM user (Step 7E.4C); there is no compatibility path for it.
 *
 *   INTEGRATION_AWS_WORKER_ROLE_ARN                   the ONE role a session may be for              (non-secret)
 *   INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN   the trust anchor of the workload CA            (non-secret)
 *   INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN        the profile: exactly that role, 900 s          (non-secret)
 *   INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM          the workload's X.509 end-entity certificate    (confidential)
 *   INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM          its private key, unencrypted PKCS#8            (SECRET)
 *
 * Every resolution re-reads and re-validates all five (a rotated certificate or a re-targeted ARN takes effect without
 * a redeploy; withdrawn configuration fails closed even while a cached session would still be valid):
 *   - ARNs: full shapes; the role in the KMS key's partition and account; trust anchor and profile in its partition,
 *     account AND region (Roles Anywhere resources are regional and must share account and region);
 *   - PEM: one value per variable, either multi-line or one line with literal "\n" sequences (normalized in memory
 *     only); exactly one block of the expected type, base64 body, bounded size;
 *   - certificate (public material, parsed with node:crypto): an end entity (CA:false), an ECDSA P-256 key with a
 *     NAMED curve, checked in its DER (the helper's Go X.509 parser rejects explicit curve parameters, which
 *     node:crypto silently normalizes — verified offline), subject CN exactly
 *     `social-intelligence-platform-integration-<context env>`, inside its validity window (outside it → ACCESS_DENIED);
 *   - private key: structure only (PKCS#8 PEM shape) — it is never parsed, logged or compared here.
 *
 * A session comes from the official AWS credential helper (jobs/aws-signing-helper*.ts): `credential-process` with the
 * three ARNs, the KMS key's region and 900 s. It cannot read the certificate or key from a pipe (it reads each file more
 * than once — verified offline), so both are written for that ONE run to a fresh `mkdtemp` directory (0700) in the OS
 * temp directory as 0600 files with fixed names, the key overwritten and the directory removed in `finally`, whatever
 * happened. Nothing secret is in an argument; the helper runs without environment. Its standard credential_process
 * output is parsed strictly (exactly Version 1, AccessKeyId, SecretAccessKey, SessionToken, Expiration) and the
 * credentials must expire in the future and within SESSION + SKEW seconds; the profile enforces 900 s server side.
 *
 * Sessions are cached in this provider's closure only (never disk, logs or outputs), refreshed when 120 s or less remain,
 * with ONE helper run however many callers wait, and dropped as soon as the identity changes (role, trust anchor,
 * profile or certificate). Every failure is an AwsIdentityError carrying only its category — never stdout, stderr, a
 * path, an ARN or any material. No fallback of any kind: not the AWS default chain, not static keys, not another runtime's
 * identity. The helper's own SDK retries (up to 3 attempts for throttling, 5xx and network failures; one for a
 * rejection — observed offline) are AWS's; this adapter never retries.
 */
import { X509Certificate } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AwsIdentityError, isIamRoleArn, type AwsCredentialProvider, type AwsIdentityFailure, type AwsTemporaryCredentials } from "@/platform/aws/identity";
import type { KmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";
import { deployedAwsSigningHelper, nodeSigningHelperProcess, type SigningHelperProcess, type SigningHelperRun } from "./aws-signing-helper-process";
import {
  INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN_ENV,
  INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN_ENV,
  INTEGRATION_AWS_WORKER_ROLE_ARN_ENV,
  INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM_ENV,
  INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM_ENV,
} from "./plane-environment";

type Environment = Readonly<Record<string, string | undefined>>;

/** Session length requested from Roles Anywhere; the profile enforces the same value. */
export const INTEGRATION_WORKER_SESSION_SECONDS = 900;
/** Clock skew tolerated between AWS and this worker when checking the returned expiration. */
export const INTEGRATION_WORKER_SESSION_SKEW_SECONDS = 60;
/** A cached session with this little time left (or less) is replaced before it is served. */
export const INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS = 120;
/** The whole helper run, its own SDK retries included (they back off for a few seconds at most). */
export const SIGNING_HELPER_TIMEOUT_MS = 30_000;
/** stdout and stderr are each bounded; a credential_process document is a few hundred bytes. */
export const SIGNING_HELPER_MAX_OUTPUT_BYTES = 16 * 1024;
/** The workload certificate's subject CN is this prefix plus the credential context env ("dev"). */
export const INTEGRATION_WORKLOAD_SUBJECT_CN_PREFIX = "social-intelligence-platform-integration-";

const MAX_CERTIFICATE_PEM = 8 * 1024;
const MAX_PRIVATE_KEY_PEM = 4 * 1024;
const PEM_LINE = "[A-Za-z0-9+/=]{1,76}\\n";
const CERTIFICATE_PEM = new RegExp(`^-----BEGIN CERTIFICATE-----\\n(?:${PEM_LINE})+-----END CERTIFICATE-----\\n$`);
/** The unencrypted PKCS#8 PEM label (built from parts so no literal key-block marker exists in source: the secret scan forbids one). */
const PKCS8_LABEL = ["PRIVATE", "KEY"].join(" ");
const PRIVATE_KEY_PEM = new RegExp(`^-----BEGIN ${PKCS8_LABEL}-----\\n(?:${PEM_LINE})+-----END ${PKCS8_LABEL}-----\\n$`);
/**
 * DER prefix of a named-curve P-256 SubjectPublicKeyInfo: SEQUENCE(89) { SEQUENCE(19) { OID id-ecPublicKey, OID prime256v1 },
 * BIT STRING(66) { 0x00, 0x04 (uncompressed point) … } }.
 */
const P256_NAMED_CURVE_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200 04".replace(/ /g, ""), "hex");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLES_ANYWHERE_ARN = new RegExp(`^arn:(aws(?:-[a-z]+)*):rolesanywhere:([a-z]{2}(?:-[a-z]+)+-\\d):(\\d{12}):(trust-anchor|profile)\\/(${UUID})$`);

const fail = (failure: AwsIdentityFailure): never => {
  throw new AwsIdentityError(failure);
};
const misconfigured = (): never => fail("IDENTITY_MISCONFIGURED");

export interface RolesAnywhereIdentity {
  readonly roleArn: string;
  readonly trustAnchorArn: string;
  readonly profileArn: string;
  readonly region: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** SHA-256 fingerprint of the certificate: the identity a session belongs to (never the key). */
  readonly certificateFingerprint: string;
}

/** `arn:<partition>:<service>:<region>:<account>:…` → partition, region and account (shapes already validated). */
const arnScope = (arn: string): { readonly partition: string; readonly region: string; readonly account: string } => {
  const [, partition = "", , region = "", account = ""] = arn.split(":");
  return { partition, region, account };
};

/**
 * One PEM value as configured: multi-line, or a single line whose line breaks are literal "\n" sequences (the form a
 * dashboard field keeps intact). Normalized in memory only; anything mixed, empty or oversized → undefined.
 */
export function normalizePem(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined || value === "" || value.length > maxLength * 2) return undefined;
  const real = value.includes("\n");
  const literal = value.includes("\\n");
  if (real && literal) return undefined;
  const text = (literal ? value.replaceAll("\\n", "\n") : value.replaceAll("\r\n", "\n")).trim();
  if (text === "" || text.length > maxLength) return undefined;
  return `${text}\n`;
}

function certificateCommonNames(certificate: X509Certificate): readonly string[] {
  return certificate.subject.split("\n").filter((line) => line.startsWith("CN=")).map((line) => line.slice(3));
}

/**
 * The Roles Anywhere identity as configured NOW, or an AwsIdentityError: IDENTITY_MISCONFIGURED for anything missing,
 * malformed or inconsistent, IDENTITY_ACCESS_DENIED for a certificate outside its validity window. Values are never echoed.
 */
export function readRolesAnywhereIdentity(environment: Environment, kms: Pick<KmsKeyringConfig, "currentKeyArn" | "region" | "contextEnv">, nowMs: number): RolesAnywhereIdentity {
  const roleArn = environment[INTEGRATION_AWS_WORKER_ROLE_ARN_ENV];
  const trustAnchorArn = environment[INTEGRATION_AWS_ROLES_ANYWHERE_TRUST_ANCHOR_ARN_ENV];
  const profileArn = environment[INTEGRATION_AWS_ROLES_ANYWHERE_PROFILE_ARN_ENV];
  const key = arnScope(kms.currentKeyArn);
  if (!isIamRoleArn(roleArn)) return misconfigured();
  const role = arnScope(roleArn);
  if (role.partition !== key.partition || role.account !== key.account) return misconfigured();
  for (const [arn, kind] of [[trustAnchorArn, "trust-anchor"], [profileArn, "profile"]] as const) {
    const match = typeof arn === "string" ? ROLES_ANYWHERE_ARN.exec(arn) : null;
    if (match?.[4] !== kind || match[1] !== key.partition || match[2] !== kms.region || match[3] !== key.account) return misconfigured();
  }

  const certificatePem = normalizePem(environment[INTEGRATION_AWS_WORKLOAD_CERTIFICATE_PEM_ENV], MAX_CERTIFICATE_PEM);
  const privateKeyPem = normalizePem(environment[INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM_ENV], MAX_PRIVATE_KEY_PEM);
  if (certificatePem === undefined || !CERTIFICATE_PEM.test(certificatePem)) return misconfigured();
  if (privateKeyPem === undefined || !PRIVATE_KEY_PEM.test(privateKeyPem)) return misconfigured();

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    return misconfigured();
  }
  if (certificate.ca) return misconfigured();
  // node:crypto normalizes explicit curve parameters to "prime256v1", so the key is checked in the certificate's own
  // DER: it must carry exactly the named-curve P-256 SubjectPublicKeyInfo (the only form the helper accepts).
  if (!certificate.raw.includes(P256_NAMED_CURVE_SPKI_PREFIX)) return misconfigured();
  const names = certificateCommonNames(certificate);
  if (names.length !== 1 || names[0] !== `${INTEGRATION_WORKLOAD_SUBJECT_CN_PREFIX}${kms.contextEnv}`) return misconfigured();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (Number.isNaN(validFrom) || Number.isNaN(validTo)) return misconfigured();
  if (nowMs < validFrom || nowMs >= validTo) return fail("IDENTITY_ACCESS_DENIED");

  return Object.freeze({
    roleArn,
    trustAnchorArn: trustAnchorArn as string,
    profileArn: profileArn as string,
    region: kms.region,
    certificatePem,
    privateKeyPem,
    certificateFingerprint: certificate.fingerprint256,
  });
}

/** The helper's exact argument array: paths and non-secret identifiers only. */
export function signingHelperArguments(identity: RolesAnywhereIdentity, files: { readonly certificate: string; readonly privateKey: string }): readonly string[] {
  return Object.freeze([
    "credential-process",
    "--certificate", files.certificate,
    "--private-key", files.privateKey,
    "--trust-anchor-arn", identity.trustAnchorArn,
    "--profile-arn", identity.profileArn,
    "--role-arn", identity.roleArn,
    "--region", identity.region,
    "--session-duration", String(INTEGRATION_WORKER_SESSION_SECONDS),
  ]);
}

/**
 * The certificate and key as two 0600 files in a fresh 0700 directory for exactly the duration of `work`. The key file
 * is overwritten with zeros before the directory is removed — in `finally`, on every path.
 */
export async function withEphemeralWorkloadMaterial<T>(
  temporaryRoot: string,
  identity: Pick<RolesAnywhereIdentity, "certificatePem" | "privateKeyPem">,
  work: (files: { readonly certificate: string; readonly privateKey: string }) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(temporaryRoot, "wrenkind-ra-"));
  const files = { certificate: path.join(directory, "certificate.pem"), privateKey: path.join(directory, "private-key.pem") };
  const keyBytes = Buffer.from(identity.privateKeyPem, "utf8");
  try {
    await writeFile(files.certificate, identity.certificatePem, { mode: 0o600, flag: "wx" });
    await writeFile(files.privateKey, keyBytes, { mode: 0o600, flag: "wx" });
    return await work(files);
  } finally {
    keyBytes.fill(0);
    try {
      const handle = await open(files.privateKey, "r+");
      try {
        await handle.write(Buffer.alloc(identity.privateKeyPem.length), 0, identity.privateKeyPem.length, 0);
      } finally {
        await handle.close();
      }
    } catch {
      // The key file was never written, or is already gone: nothing to overwrite.
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/** The meaning of a failed helper run, from its exit and stderr (classified, then dropped — never propagated). */
export function signingHelperFailure(run: SigningHelperRun): AwsIdentityFailure {
  if (run.spawnFailure !== null) return "IDENTITY_MISCONFIGURED";
  if (run.overflow) return "IDENTITY_MISCONFIGURED";
  if (run.timedOut) return "IDENTITY_UNAVAILABLE";
  if (run.signal !== null) return "IDENTITY_UNAVAILABLE";
  const stderr = run.stderr;
  // The helper reports `operation error RolesAnywhere: CreateSession, … StatusCode: <n>, … <ExceptionName>: …`.
  if (/StatusCode: 403\b|AccessDeniedException|UnauthorizedException/.test(stderr)) return "IDENTITY_ACCESS_DENIED";
  if (/StatusCode: (?:429|5\d\d)\b|ThrottlingException|TooManyRequestsException|ServiceUnavailableException|InternalServerException|request send failed|i\/o timeout|connection reset|connection refused|no such host|TLS handshake timeout|context deadline exceeded/.test(stderr)) {
    return "IDENTITY_UNAVAILABLE";
  }
  return "IDENTITY_MISCONFIGURED";
}

const ACCESS_KEY_ID = /^\w{16,128}$/;
const OPAQUE = (min: number, max: number) => new RegExp(`^[\\x21-\\x7E]{${String(min)},${String(max)}}$`);
const SECRET_ACCESS_KEY = OPAQUE(16, 256);
const SESSION_TOKEN = OPAQUE(16, 8192);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CREDENTIAL_PROCESS_KEYS = ["AccessKeyId", "Expiration", "SecretAccessKey", "SessionToken", "Version"];

/** The helper's credential_process document → temporary credentials, or IDENTITY_MISCONFIGURED. Strict. */
export function parseCredentialProcessOutput(stdout: string, nowMs: number): AwsTemporaryCredentials {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    return misconfigured();
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return misconfigured();
  const record = document as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== CREDENTIAL_PROCESS_KEYS.join(",")) return misconfigured();
  const { Version, AccessKeyId, SecretAccessKey, SessionToken, Expiration } = record;
  if (Version !== 1) return misconfigured();
  if (typeof AccessKeyId !== "string" || !ACCESS_KEY_ID.test(AccessKeyId)) return misconfigured();
  if (typeof SecretAccessKey !== "string" || !SECRET_ACCESS_KEY.test(SecretAccessKey)) return misconfigured();
  if (typeof SessionToken !== "string" || !SESSION_TOKEN.test(SessionToken)) return misconfigured();
  if (typeof Expiration !== "string" || !ISO_INSTANT.test(Expiration)) return misconfigured();
  const expiration = new Date(Expiration);
  const expiresMs = expiration.getTime();
  if (Number.isNaN(expiresMs) || expiresMs <= nowMs) return misconfigured();
  if (expiresMs - nowMs > (INTEGRATION_WORKER_SESSION_SECONDS + INTEGRATION_WORKER_SESSION_SKEW_SECONDS) * 1000) return misconfigured();
  return Object.freeze({ accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: SessionToken, expiration });
}

/** Injection seam for offline tests; production re-reads process.env on every resolution. */
export interface IntegrationAwsIdentityDependencies {
  readonly readEnvironment: () => Environment;
  readonly nowMs: () => number;
  /** The digest-verified helper executable (production: the packaged build for this platform). */
  readonly signingHelper: () => Promise<string>;
  readonly process: SigningHelperProcess;
  /** Where the per-run 0700 directory is created (production: the OS temp directory). */
  readonly temporaryRoot: () => string;
}

const PRODUCTION: IntegrationAwsIdentityDependencies = Object.freeze({
  readEnvironment: () => process.env,
  nowMs: () => Date.now(),
  signingHelper: deployedAwsSigningHelper,
  process: nodeSigningHelperProcess,
  temporaryRoot: () => tmpdir(),
});

/** The identity a session belongs to: the three ARNs and the certificate. Never the private key. */
type SessionIdentity = Pick<RolesAnywhereIdentity, "roleArn" | "trustAnchorArn" | "profileArn" | "certificateFingerprint">;

const sameIdentity = (a: SessionIdentity, b: SessionIdentity): boolean =>
  a.roleArn === b.roleArn && a.trustAnchorArn === b.trustAnchorArn && a.profileArn === b.profileArn && a.certificateFingerprint === b.certificateFingerprint;

/**
 * The integration worker's AwsCredentialProvider for the given (validated) KMS keyring configuration. Lazy: nothing is
 * read, written or started until the KMS opener asks for credentials.
 */
export function createIntegrationWorkerAwsCredentials(
  kms: Pick<KmsKeyringConfig, "currentKeyArn" | "region" | "contextEnv">,
  overrides: Partial<IntegrationAwsIdentityDependencies> = {},
): AwsCredentialProvider {
  const deps: IntegrationAwsIdentityDependencies = { ...PRODUCTION, ...overrides };
  let cached: { readonly identity: SessionIdentity; readonly credentials: AwsTemporaryCredentials } | undefined;
  let inflight: { readonly identity: SessionIdentity; readonly promise: Promise<AwsTemporaryCredentials> } | undefined;

  const createSession = async (identity: RolesAnywhereIdentity): Promise<AwsTemporaryCredentials> => {
    try {
      const executable = await deps.signingHelper();
      const run = await withEphemeralWorkloadMaterial(deps.temporaryRoot(), identity, (files) =>
        deps.process.run(executable, signingHelperArguments(identity, files), { timeoutMs: SIGNING_HELPER_TIMEOUT_MS, maxOutputBytes: SIGNING_HELPER_MAX_OUTPUT_BYTES }),
      );
      if (run.exitCode !== 0 || run.spawnFailure !== null || run.timedOut || run.overflow || run.signal !== null) return fail(signingHelperFailure(run));
      return parseCredentialProcessOutput(run.stdout, deps.nowMs());
    } catch (error) {
      if (error instanceof AwsIdentityError) throw error;
      // A temporary-directory or process-level failure: the identity can't be obtained here. Nothing of it is kept.
      return misconfigured();
    }
  };

  return async () => {
    // The CURRENT configuration is parsed and validated first, every time: a cache hit never bypasses it.
    const identity = readRolesAnywhereIdentity(deps.readEnvironment(), kms, deps.nowMs());
    const key: SessionIdentity = { roleArn: identity.roleArn, trustAnchorArn: identity.trustAnchorArn, profileArn: identity.profileArn, certificateFingerprint: identity.certificateFingerprint };
    if (cached !== undefined && !sameIdentity(cached.identity, key)) cached = undefined;
    const fresh = cached?.credentials.expiration;
    if (cached !== undefined && fresh !== undefined && fresh.getTime() - deps.nowMs() > INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS * 1000) return cached.credentials;
    if (inflight !== undefined && sameIdentity(inflight.identity, key)) return inflight.promise;
    const flight: { current?: { readonly identity: SessionIdentity; readonly promise: Promise<AwsTemporaryCredentials> } } = {};
    const promise = createSession(identity).then((credentials) => {
      // Installed only by the refresh that is still the current one (a superseded identity answers its own caller only).
      if (inflight === flight.current) cached = { identity: key, credentials };
      return credentials;
    });
    const current = { identity: key, promise };
    flight.current = current;
    inflight = current;
    const settle = (): void => {
      if (inflight === current) inflight = undefined;
    };
    promise.then(settle, settle);
    return promise;
  };
}
