/**
 * HOSTED WEB KMS identity DIAGNOSTIC (Step 7E.10-B; TA §39, ADR-64; DEV/non-prod only). Proves, with one synthetic
 * credential and no provider, database, outbox or file, that the hosted web seals through the SAME production path as
 * the connection flow:
 *
 *   composeCredentialSealer(env, composeWebAwsCredentials(env, Vercel identity))
 *     → six-field context → Vercel OIDC token → audience exchange → AssumeRoleWithWebIdentity into the web role
 *     → ONE KMS GenerateDataKey → AES-GCM → envelope v1, re-decoded and checked in memory
 *
 * It is NOT a product route: no app/ route, server action or page invokes it (WEB_DIAGNOSTIC_INVOCATION is
 * BLOCKED_PENDING_SAFE_ROUTE_PROTECTION — the application has no platform-operator authority, and a customer workspace
 * role must never trigger infrastructure work). Its production composition lives in ./runtime.ts. Every guard below
 * runs before anything AWS-capable exists, and each failure is one fixed code (never an AWS message, ARN or value).
 *
 *   input      exactly { acknowledge: WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT }
 *   runtime    NODE_ENV and VERCEL_ENV exactly "production" (a refusal guard only; the AWS trust is the boundary)
 *   node       Node.js 22
 *   web env    no forbidden hosted-web variable (static AWS keys, worker or tooling credentials, ...)
 *   crypto     the KMS keyring (never the local one), CREDENTIAL_CONTEXT_ENV exactly "dev", exactly ONE allowed key
 *   role       CREDENTIAL_KMS_WEB_ROLE_ARN present and well formed
 *   identity   the request's Vercel OIDC token passes the adapter's preflight, and its UNVERIFIED issuer and subject are
 *              the ones the identity adapter expects (the Team issuer and the exact Production subject). Decoding
 *              authenticates nothing: it only spares the one GenerateDataKey when the token can't match the trust;
 *              AWS STS authenticates the token.
 *
 * Plaintext handling is BEST EFFORT: the encoded synthetic credential is zeroed after sealing; the sealer zeroes its
 * data key. Nothing is logged, persisted or returned except the sanitized outcome. No Decrypt, Encrypt, ReEncrypt or
 * grant exists on this path (the web composes a sealer only).
 */
import { randomBytes } from "node:crypto";
import { encodeProviderCredential } from "@/modules/connections";
import { providerCredential } from "@/integrations/providers/contract";
import type { AwsSingleAttempt } from "@/platform/crypto/credentials/aws-kms-client";
import { KMS_PROVIDER_CREDENTIALS_KEY_REF } from "@/platform/crypto/credentials/aws-kms-config";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { IV_BYTES, TAG_BYTES, decodeEnvelope, encodeEnvelope, type EnvelopeV1 } from "@/platform/crypto/credentials/envelope";
import { isCredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { forbiddenWebVariables } from "@/server/http/web-environment";
import type { ComposedCredentialSealer } from "./credential-crypto";
import { selectCredentialCrypto } from "./environment";
import { WEB_AWS_ROLE_SESSION_NAME, readWebAwsIdentityConfig } from "./web-identity";

type Environment = Readonly<Record<string, string | undefined>>;

export const WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT = "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_V1";
/** Reserved synthetic identifiers: never generated for, stored as or accepted from a real workspace or credential. */
export const WEB_KMS_DIAGNOSTIC_WORKSPACE_ID = "5eed0000-d1a9-4000-8000-00000000e001";
export const WEB_KMS_DIAGNOSTIC_CREDENTIAL_ID = "5eed0000-d1a9-4000-8000-00000000e002";
/** The ProviderCredential id sealed into the synthetic envelope. */
export const WEB_KMS_DIAGNOSTIC_CREDENTIAL_LABEL = "vercel-web-kms-diagnostic";
/** The only cryptographic environment the diagnostic accepts. */
export const WEB_KMS_DIAGNOSTIC_CONTEXT_ENV = "dev";
/** One attempt for each AWS client of the diagnostic (STS and KMS): no SDK retry, so at most one GenerateDataKey. */
export const WEB_KMS_DIAGNOSTIC_AWS_ATTEMPTS: AwsSingleAttempt = Object.freeze({ maxAttempts: 1 } as const);

/** The ONE closed vocabulary of diagnostic failures. No AWS-derived value ever becomes a code. */
export const WEB_KMS_DIAGNOSTIC_FAILURES = [
  "web_kms_diagnostic_input_refused",
  "web_kms_diagnostic_runtime_refused",
  "web_kms_diagnostic_node_refused",
  "web_kms_diagnostic_environment_refused",
  "web_kms_diagnostic_kms_configuration_refused",
  "web_kms_diagnostic_role_refused",
  "web_kms_diagnostic_oidc_token_refused",
  "web_kms_diagnostic_oidc_subject_refused",
  "web_kms_diagnostic_keyring_access_denied",
  "web_kms_diagnostic_keyring_misconfigured",
  "web_kms_diagnostic_keyring_unavailable",
  "web_kms_diagnostic_envelope_invalid",
  "web_kms_diagnostic_failed",
] as const;
export type WebKmsDiagnosticFailure = (typeof WEB_KMS_DIAGNOSTIC_FAILURES)[number];

/** A refusal or failure of the diagnostic: its fixed code only (no cause, message detail or value). */
export class WebKmsDiagnosticError extends Error {
  override readonly name = "WebKmsDiagnosticError";
  readonly failure: WebKmsDiagnosticFailure;
  constructor(failure: WebKmsDiagnosticFailure) {
    super(failure);
    this.failure = failure;
  }
}

const refuse = (failure: WebKmsDiagnosticFailure): never => {
  throw new WebKmsDiagnosticError(failure);
};

export interface WebKmsDiagnosticOutcome {
  readonly result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_PASSED";
  readonly nodeVersion: string;
  readonly node22: true;
  readonly contextEnv: typeof WEB_KMS_DIAGNOSTIC_CONTEXT_ENV;
  readonly issuerMode: "team";
  readonly expectedSubjectMatched: true;
  readonly roleSessionName: typeof WEB_AWS_ROLE_SESSION_NAME;
  readonly generateDataKey: true;
}

/** The request token's issuer and subject as stated (unauthenticated). */
export interface WebOidcClaims {
  readonly issuer: string | undefined;
  readonly subject: string | undefined;
}

export interface WebKmsDiagnosticDependencies {
  readonly nodeVersion: string;
  /** The current request's unverified claims after the identity adapter's preflight; throws when the token is unusable. */
  readonly readClaims: () => WebOidcClaims;
  /** The issuer and subject the web role trust admits, owned by the identity adapter (design/phase-7e/web-identity). */
  readonly expected: WebOidcClaims;
  /** Builds the one-attempt KMS sealer with the web's federated identity; called only after every guard passed. */
  readonly composeSealer: (environment: Environment) => ComposedCredentialSealer;
}

/** The payload must be exactly the acknowledgement object. */
export function assertWebDiagnosticInput(payload: unknown): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) refuse("web_kms_diagnostic_input_refused");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "acknowledge" || record["acknowledge"] !== WEB_KMS_DIAGNOSTIC_ACKNOWLEDGEMENT) refuse("web_kms_diagnostic_input_refused");
}

/** Every precondition, in order, before anything AWS-capable exists. */
export function assertWebDiagnosticPreconditions(payload: unknown, environment: Environment, deps: Pick<WebKmsDiagnosticDependencies, "nodeVersion" | "readClaims" | "expected">): void {
  assertWebDiagnosticInput(payload);
  if (environment["NODE_ENV"] !== "production" || environment["VERCEL_ENV"] !== "production") refuse("web_kms_diagnostic_runtime_refused");
  if (!deps.nodeVersion.startsWith("v22.")) refuse("web_kms_diagnostic_node_refused");
  if (forbiddenWebVariables(environment).length > 0) refuse("web_kms_diagnostic_environment_refused");
  let selection;
  try {
    selection = selectCredentialCrypto(environment);
  } catch {
    return refuse("web_kms_diagnostic_kms_configuration_refused");
  }
  if (selection.kind !== "kms" || selection.config.contextEnv !== WEB_KMS_DIAGNOSTIC_CONTEXT_ENV) return refuse("web_kms_diagnostic_kms_configuration_refused");
  const allowed = selection.config.allowedKeyArns;
  if (allowed.size !== 1 || !allowed.has(selection.config.currentKeyArn)) return refuse("web_kms_diagnostic_kms_configuration_refused");
  let role;
  try {
    role = readWebAwsIdentityConfig(environment);
  } catch {
    return refuse("web_kms_diagnostic_role_refused");
  }
  if (role === undefined) return refuse("web_kms_diagnostic_role_refused");
  let claims: WebOidcClaims;
  try {
    claims = deps.readClaims();
  } catch {
    return refuse("web_kms_diagnostic_oidc_token_refused");
  }
  const { issuer, subject } = deps.expected;
  if (issuer === undefined || subject === undefined || claims.issuer !== issuer || claims.subject !== subject) refuse("web_kms_diagnostic_oidc_subject_refused");
}

/** A sealing failure as one fixed diagnostic code. */
function sealFailure(error: unknown): WebKmsDiagnosticFailure {
  if (!isCredentialCryptoError(error)) return "web_kms_diagnostic_failed";
  if (error.code === "KEYRING_ACCESS_DENIED") return "web_kms_diagnostic_keyring_access_denied";
  if (error.code === "KEYRING_MISCONFIGURED") return "web_kms_diagnostic_keyring_misconfigured";
  if (error.code === "KEYRING_UNAVAILABLE") return "web_kms_diagnostic_keyring_unavailable";
  return "web_kms_diagnostic_failed";
}

/** The sealed envelope, re-encoded and re-decoded in memory: v1, aws-kms, the logical key reference, sane lengths. */
function assertEnvelope(envelope: EnvelopeV1): void {
  try {
    const decoded = decodeEnvelope(encodeEnvelope(envelope));
    if (
      decoded.kekProvider !== "aws-kms" ||
      decoded.keyRef !== KMS_PROVIDER_CREDENTIALS_KEY_REF ||
      decoded.wrappedDek.byteLength === 0 ||
      decoded.iv.byteLength !== IV_BYTES ||
      decoded.authTag.byteLength !== TAG_BYTES ||
      decoded.ciphertext.byteLength === 0
    ) {
      refuse("web_kms_diagnostic_envelope_invalid");
    }
  } catch {
    refuse("web_kms_diagnostic_envelope_invalid");
  }
}

/**
 * The diagnostic: guards, then ONE seal of a synthetic credential through the production sealer (one GenerateDataKey),
 * then the in-memory envelope check. Throws WebKmsDiagnosticError (fixed code); returns the sanitized outcome otherwise.
 */
export async function runWebKmsIdentityDiagnostic(payload: unknown, environment: Environment, deps: WebKmsDiagnosticDependencies): Promise<WebKmsDiagnosticOutcome> {
  assertWebDiagnosticPreconditions(payload, environment, deps);
  let composed: ComposedCredentialSealer;
  try {
    composed = deps.composeSealer(environment);
  } catch {
    return refuse("web_kms_diagnostic_kms_configuration_refused");
  }
  if (composed.contextEnv !== WEB_KMS_DIAGNOSTIC_CONTEXT_ENV) return refuse("web_kms_diagnostic_kms_configuration_refused");
  const context = credentialContext({ purpose: "provider-credential", env: WEB_KMS_DIAGNOSTIC_CONTEXT_ENV, workspaceId: WEB_KMS_DIAGNOSTIC_WORKSPACE_ID, credentialId: WEB_KMS_DIAGNOSTIC_CREDENTIAL_ID });
  const plaintext = encodeProviderCredential(providerCredential(WEB_KMS_DIAGNOSTIC_CREDENTIAL_LABEL, `synthetic-web-diagnostic-secret-${randomBytes(16).toString("hex")}`));
  let envelope: EnvelopeV1;
  try {
    envelope = await composed.sealer.seal(plaintext, context);
  } catch (error) {
    return refuse(sealFailure(error));
  } finally {
    plaintext.fill(0);
  }
  assertEnvelope(envelope);
  return Object.freeze({
    result: "VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_PASSED",
    nodeVersion: deps.nodeVersion,
    node22: true,
    contextEnv: WEB_KMS_DIAGNOSTIC_CONTEXT_ENV,
    issuerMode: "team",
    expectedSubjectMatched: true,
    roleSessionName: WEB_AWS_ROLE_SESSION_NAME,
    generateDataKey: true,
  });
}
