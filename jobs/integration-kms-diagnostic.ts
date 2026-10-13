/**
 * INTEGRATION-plane KMS worker-authentication DIAGNOSTIC (Step 7E.7-B; TA §39, ADR-64; DEV/non-prod only).
 * Proves, with one synthetic envelope and no provider, database or outbox, that a deployed integration worker opens a
 * provider-credential envelope through the SAME production path as discovery and capability evaluation:
 *
 *   createCredentialAccess(composeCredentialOpener(env, integrationWorkerAwsCredentials(env)))
 *     → envelope decoding → six-field context → worker identity (bootstrap user → worker role) → KMS Decrypt
 *     → returned key checked against CREDENTIAL_KMS_ALLOWED_KEY_ARNS → AES-GCM → ProviderCredential codec
 *
 * It is NOT a product task: it is absent from the task registry (the outbox can never route to it), has no schedule
 * and no hook, and runs only when an operator triggers it by id. Knowing the id is not enough: every guard below runs
 * before any AWS-capable object is built, and each failure is one fixed code (never an AWS message, ARN or value).
 *
 *   input      exactly { acknowledge: KMS_DIAGNOSTIC_ACKNOWLEDGEMENT } — no identifiers, envelope or provider input
 *   release    a deployed Trigger.dev PRODUCTION run with an external deployment id (pinned)
 *   plane      no other plane's capability in the environment (jobs/plane-environment.ts)
 *   tier       APP_DEPLOYMENT_ENV exactly "staging"
 *   runtime    Node.js 22 (process.version "v22.…")
 *   crypto     the KMS keyring (never the local one), CREDENTIAL_CONTEXT_ENV exactly "dev", and exactly ONE allowed
 *              key (the current one)
 *   fixture    INTEGRATION_KMS_DIAGNOSTIC_FIXTURE: { v, workspace_id, credential_id, envelope, digest }, strictly
 *              parsed; the ids must be the compile-time synthetic constants below; the envelope must be a well-formed
 *              v1 aws-kms envelope of the provider-credential key reference. The Decrypt context is always built
 *              from the constants, never from the fixture.
 *
 * The opened credential must carry KMS_DIAGNOSTIC_CREDENTIAL_LABEL and its domain-separated SHA-256 must equal the
 * fixture digest (constant-time). The output names only the result, the Node version and the context env.
 *
 * Plaintext handling is BEST EFFORT, not a physical guarantee (PLAINTEXT_MEMORY_ZEROIZATION =
 * BEST_EFFORT_NOT_PHYSICAL_GUARANTEE): the opener zeroes its plaintext and data-key buffers, and the digest input and
 * digest buffers are zeroed here, but the ProviderCredential codec materializes the synthetic secret as an immutable
 * JavaScript string that only the garbage collector reclaims. Nothing is logged, serialized or returned.
 *
 * AWS attempt counts (Step 7E.7-B-R1): three INDEPENDENT controls bound the run — the Trigger.dev task retry
 * (maxAttempts 1), the STS client (KMS_DIAGNOSTIC_AWS_ATTEMPTS: one AssumeRole attempt) and the KMS client
 * (KMS_DIAGNOSTIC_AWS_ATTEMPTS: one Decrypt attempt). The task retry alone would not stop SDK-internal retries. The
 * bound travels as an explicit argument of the production composition; the product tasks never pass it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { CredentialUnreadableError, encodeProviderCredential, type ProviderCredentialAccess } from "@/modules/connections";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { KMS_PROVIDER_CREDENTIALS_KEY_REF } from "@/platform/crypto/credentials/aws-kms-config";
import { decodeEnvelope } from "@/platform/crypto/credentials/envelope";
import { isCredentialCryptoError, isRetryableCredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { NonRetryableJobError, type JobRelease } from "@/platform/jobs";
import { selectCredentialCrypto } from "@/server/connections/environment";
import { PROVIDER_MODE_VARIABLES } from "@/server/connections/provider-mode";
import { composeCredentialOpener, createCredentialAccess, integrationWorkerAwsCredentials } from "./connections";
import { INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV, planeEnvironmentProblems } from "./plane-environment";

type Environment = Readonly<Record<string, string | undefined>>;

export const KMS_DIAGNOSTIC_TASK_ID = "integration.kms_worker_auth_diagnostic";
export const KMS_DIAGNOSTIC_ACKNOWLEDGEMENT = "INTEGRATION_KMS_WORKER_AUTH_DIAGNOSTIC_V1";
/** Reserved synthetic identifiers: never generated for, stored as or accepted from a real workspace or credential. */
export const KMS_DIAGNOSTIC_WORKSPACE_ID = "5eed0000-d1a9-4000-8000-00000000d001";
export const KMS_DIAGNOSTIC_CREDENTIAL_ID = "5eed0000-d1a9-4000-8000-00000000d002";
/** The ProviderCredential id sealed into the synthetic envelope. */
export const KMS_DIAGNOSTIC_CREDENTIAL_LABEL = "kms-worker-auth-diagnostic";
/** Domain separation of the plaintext digest (shared with the future operator sealing step). */
export const KMS_DIAGNOSTIC_DIGEST_DOMAIN = "social-intelligence-platform/kms-worker-auth-diagnostic/v1\0";
export const KMS_DIAGNOSTIC_FIXTURE_VERSION = 1;
/** The only deployment tier and cryptographic environment the diagnostic accepts. */
export const KMS_DIAGNOSTIC_TIER = "staging";
export const KMS_DIAGNOSTIC_CONTEXT_ENV = "dev";
/** Trigger.dev environment type of the integration project's deployment (TRIGGER_PROVIDER_ENV = prod). */
export const KMS_DIAGNOSTIC_TRIGGER_ENVIRONMENT = "PRODUCTION";

const FIXTURE_FIELDS = ["v", "workspace_id", "credential_id", "envelope", "digest"] as const;
const MAX_FIXTURE_CHARS = 16 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * The ONE closed vocabulary of diagnostic failures: every code the module or its task can emit, and nothing else
 * (Step 7E.7-B-R4). No AWS-derived value ever becomes a code; anything unexpected is kms_diagnostic_failed.
 */
export const KMS_DIAGNOSTIC_FAILURES = [
  "kms_diagnostic_input_refused",
  "kms_diagnostic_release_refused",
  "kms_diagnostic_plane_refused",
  "kms_diagnostic_tier_refused",
  "kms_diagnostic_runtime_refused",
  "kms_diagnostic_local_keyring_refused",
  "kms_diagnostic_credential_context_refused",
  "kms_diagnostic_kms_configuration_refused",
  "kms_diagnostic_fixture_refused",
  "kms_diagnostic_credential_unreadable",
  "kms_diagnostic_keyring_access_denied",
  "kms_diagnostic_keyring_misconfigured",
  "kms_diagnostic_keyring_unavailable",
  "kms_diagnostic_plaintext_mismatch",
  "kms_diagnostic_failed",
] as const;
export type KmsDiagnosticFailure = (typeof KMS_DIAGNOSTIC_FAILURES)[number];

/** A refusal or failure of the diagnostic: its fixed code only (no cause, message detail or value). */
export class KmsDiagnosticError extends NonRetryableJobError {
  readonly failure: KmsDiagnosticFailure;
  constructor(failure: KmsDiagnosticFailure) {
    super(failure);
    this.failure = failure;
  }
}

const refuse = (failure: KmsDiagnosticFailure): never => {
  throw new KmsDiagnosticError(failure);
};

export interface KmsDiagnosticOutcome {
  readonly result: "KMS_WORKER_AUTH_DIAGNOSTIC_PASSED" | "KMS_WORKER_AUTH_DIAGNOSTIC_PLAINTEXT_MISMATCH";
  readonly nodeVersion: string;
  readonly node22: boolean;
  readonly contextEnv: typeof KMS_DIAGNOSTIC_CONTEXT_ENV;
  readonly plaintextMatches: boolean;
}

/** The run facts the guards need, from the Trigger.dev run context (never from the payload). */
export interface KmsDiagnosticRun {
  readonly environmentType: string | undefined;
  readonly release: JobRelease;
}

/** One attempt for each AWS client of the diagnostic (STS and KMS): no SDK retry, independent of the task retry. */
export const KMS_DIAGNOSTIC_AWS_ATTEMPTS = Object.freeze({ maxAttempts: 1 } as const);

/** The composed production credential access, and the context env it seals/opens under. */
export interface KmsDiagnosticAccess {
  readonly access: ProviderCredentialAccess;
  readonly contextEnv: string;
}

export interface KmsDiagnosticDependencies {
  readonly nodeVersion: string;
  /** Builds the credential access; called only after every guard passed. */
  readonly composeAccess: (environment: Environment) => KmsDiagnosticAccess;
}

/**
 * The production composition: exactly the integration plane's opener and worker identity (jobs/connections.ts), with
 * both AWS clients explicitly bounded to a single attempt.
 */
export function productionDiagnosticAccess(environment: Environment): KmsDiagnosticAccess {
  const opening = composeCredentialOpener(environment, integrationWorkerAwsCredentials(environment, KMS_DIAGNOSTIC_AWS_ATTEMPTS), KMS_DIAGNOSTIC_AWS_ATTEMPTS);
  return { access: createCredentialAccess(opening.opener, opening.contextEnv), contextEnv: opening.contextEnv };
}

const PRODUCTION: KmsDiagnosticDependencies = Object.freeze({ nodeVersion: process.version, composeAccess: productionDiagnosticAccess });

/** The payload must be exactly the acknowledgement object. */
export function assertDiagnosticInput(payload: unknown): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) refuse("kms_diagnostic_input_refused");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "acknowledge" || record["acknowledge"] !== KMS_DIAGNOSTIC_ACKNOWLEDGEMENT) refuse("kms_diagnostic_input_refused");
}

export interface KmsDiagnosticFixture {
  readonly envelope: Uint8Array;
  readonly digest: Buffer;
}

/** Strict fixture parsing: exact fields, version, synthetic ids, canonical base64 v1 aws-kms envelope, hex digest. */
export function parseDiagnosticFixture(raw: string | undefined): KmsDiagnosticFixture {
  if (raw === undefined || raw === "" || raw.length > MAX_FIXTURE_CHARS) return refuse("kms_diagnostic_fixture_refused");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return refuse("kms_diagnostic_fixture_refused");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("kms_diagnostic_fixture_refused");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== FIXTURE_FIELDS.length || !FIXTURE_FIELDS.every((field) => keys.includes(field))) return refuse("kms_diagnostic_fixture_refused");
  if (record["v"] !== KMS_DIAGNOSTIC_FIXTURE_VERSION) return refuse("kms_diagnostic_fixture_refused");
  if (record["workspace_id"] !== KMS_DIAGNOSTIC_WORKSPACE_ID || record["credential_id"] !== KMS_DIAGNOSTIC_CREDENTIAL_ID) return refuse("kms_diagnostic_fixture_refused");
  const envelopeText = record["envelope"];
  const digestText = record["digest"];
  if (typeof envelopeText !== "string" || !BASE64.test(envelopeText) || typeof digestText !== "string" || !DIGEST.test(digestText)) return refuse("kms_diagnostic_fixture_refused");
  const envelope = new Uint8Array(Buffer.from(envelopeText, "base64"));
  try {
    const decoded = decodeEnvelope(envelope);
    if (decoded.kekProvider !== "aws-kms" || decoded.keyRef !== KMS_PROVIDER_CREDENTIALS_KEY_REF) return refuse("kms_diagnostic_fixture_refused");
  } catch (error) {
    if (error instanceof KmsDiagnosticError) throw error;
    return refuse("kms_diagnostic_fixture_refused");
  }
  return { envelope, digest: Buffer.from(digestText, "hex") };
}

/** Every precondition, in order, before anything AWS-capable exists. Returns the strictly parsed fixture. */
export function assertDiagnosticPreconditions(payload: unknown, run: KmsDiagnosticRun, environment: Environment, nodeVersion: string): KmsDiagnosticFixture {
  assertDiagnosticInput(payload);
  if (run.environmentType !== KMS_DIAGNOSTIC_TRIGGER_ENVIRONMENT || run.release.kind !== "pinned") refuse("kms_diagnostic_release_refused");
  if (planeEnvironmentProblems("integration", run.release, environment).length > 0) refuse("kms_diagnostic_plane_refused");
  if (environment[PROVIDER_MODE_VARIABLES.tier] !== KMS_DIAGNOSTIC_TIER) refuse("kms_diagnostic_tier_refused");
  if (!nodeVersion.startsWith("v22.")) refuse("kms_diagnostic_runtime_refused");
  // The keyring selection (environment.ts) is the ONE reader of CREDENTIAL_CONTEXT_ENV, the KMS key variables and
  // LOCAL_KEYRING_KEY: it accepts only "dev" as a KMS context env and refuses a local key next to KMS (or a local key in
  // a deployed runtime), so each of those is refused here as a misconfigured keyring. The local keyring itself
  // (development/test only) is refused explicitly.
  let selection;
  try {
    selection = selectCredentialCrypto(environment);
  } catch {
    return refuse("kms_diagnostic_kms_configuration_refused");
  }
  if (selection.kind !== "kms") return refuse("kms_diagnostic_local_keyring_refused");
  if (selection.config.contextEnv !== KMS_DIAGNOSTIC_CONTEXT_ENV) return refuse("kms_diagnostic_credential_context_refused");
  const allowed = selection.config.allowedKeyArns;
  if (allowed.size !== 1 || !allowed.has(selection.config.currentKeyArn)) return refuse("kms_diagnostic_kms_configuration_refused");
  return parseDiagnosticFixture(environment[INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]);
}

/** SHA-256 over the domain separator and the codec bytes of a ProviderCredential; the input buffer is zeroed. */
export function diagnosticPlaintextDigest(encodedCredential: Uint8Array): Buffer {
  const domain = Buffer.from(KMS_DIAGNOSTIC_DIGEST_DOMAIN, "utf8");
  try {
    return createHash("sha256").update(domain).update(encodedCredential).digest();
  } finally {
    encodedCredential.fill(0);
  }
}

/** The credential-access failure as one fixed diagnostic code (retryable or not, it is never retried here). */
function accessFailure(error: unknown): KmsDiagnosticFailure {
  if (error instanceof KmsDiagnosticError) return error.failure;
  if (error instanceof CredentialUnreadableError) return "kms_diagnostic_credential_unreadable";
  if (error instanceof NonRetryableJobError) {
    if (error.failureClass === "credential_keyring_access_denied") return "kms_diagnostic_keyring_access_denied";
    if (error.failureClass === "credential_keyring_misconfigured") return "kms_diagnostic_keyring_misconfigured";
  }
  if (isCredentialCryptoError(error)) {
    if (isRetryableCredentialCryptoError(error)) return "kms_diagnostic_keyring_unavailable";
    return error.code === "KEYRING_ACCESS_DENIED" ? "kms_diagnostic_keyring_access_denied" : "kms_diagnostic_keyring_misconfigured";
  }
  return "kms_diagnostic_failed";
}

/**
 * The diagnostic: guards, then ONE credential opening through the production access, then the digest comparison.
 * Throws KmsDiagnosticError (fixed code) on any refusal or failure; returns the outcome otherwise.
 */
export async function runKmsWorkerAuthDiagnostic(
  payload: unknown,
  run: KmsDiagnosticRun,
  environment: Environment,
  overrides: Partial<KmsDiagnosticDependencies> = {},
): Promise<KmsDiagnosticOutcome> {
  const deps: KmsDiagnosticDependencies = { ...PRODUCTION, ...overrides };
  const fixture = assertDiagnosticPreconditions(payload, run, environment, deps.nodeVersion);
  const workspaceId: WorkspaceId | undefined = parseWorkspaceId(KMS_DIAGNOSTIC_WORKSPACE_ID);
  if (workspaceId === undefined) return refuse("kms_diagnostic_fixture_refused");
  let matches: boolean;
  try {
    const composed = deps.composeAccess(environment);
    if (composed.contextEnv !== KMS_DIAGNOSTIC_CONTEXT_ENV) refuse("kms_diagnostic_credential_context_refused");
    matches = await composed.access.withCredential({ workspaceId, credentialId: KMS_DIAGNOSTIC_CREDENTIAL_ID, envelope: fixture.envelope }, (credential) => {
      if (credential.id !== KMS_DIAGNOSTIC_CREDENTIAL_LABEL) return Promise.resolve(false);
      const digest = diagnosticPlaintextDigest(encodeProviderCredential(credential));
      try {
        return Promise.resolve(digest.byteLength === fixture.digest.byteLength && timingSafeEqual(digest, fixture.digest));
      } finally {
        digest.fill(0);
      }
    });
  } catch (error) {
    return refuse(accessFailure(error));
  } finally {
    fixture.digest.fill(0);
  }
  return Object.freeze({
    result: matches ? "KMS_WORKER_AUTH_DIAGNOSTIC_PASSED" : "KMS_WORKER_AUTH_DIAGNOSTIC_PLAINTEXT_MISMATCH",
    nodeVersion: deps.nodeVersion,
    node22: deps.nodeVersion.startsWith("v22."),
    contextEnv: KMS_DIAGNOSTIC_CONTEXT_ENV,
    plaintextMatches: matches,
  });
}
