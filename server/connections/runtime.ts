/**
 * Web composition of the connection authorization flow (Step 5D). Built lazily on first use, never at import or
 * build time. Fail closed, no fallback:
 *   - the local-keyring startup guard runs first: LOCAL_KEYRING_KEY present outside development/test aborts;
 *   - the web receives a SEALER only (TA §39, ADR-64): no opener, no unwrap capability exists here — the local
 *     keyring's sealer in development/test, the KMS GenerateDataKey sealer where KMS is configured (Step 7D);
 *   - OAUTH_PKCE_DERIVATION_KEY must be a canonical 32-byte key (no generated or default key);
 *   - providers: the local simulator only (development/test); real providers stay VALIDATE. A hosted runtime
 *     composes NO provider adapter (Step 7E.10-B): it never constructs the simulator, every provider is unavailable,
 *     and the flow fails closed before any database work — while the sealer is still the real KMS one.
 */
import { randomUUID } from "node:crypto";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { encodeEnvelope } from "@/platform/crypto/credentials/envelope";
import { assertNoLocalKeyringOutsideLocal } from "@/platform/crypto/credentials/local-sealer";
import type { CredentialSealer } from "@/platform/crypto/credentials/seal";
import { newOAuthState, oauthStateDigest, pkceDeriverFromEnvironment, type PkceDeriver } from "@/platform/crypto/oauth";
import type { ProviderAuthorizationPort } from "@/integrations/providers/contract";
import type { AuthorizationProviders, CredentialSealing, OAuthSecrets } from "@/modules/connections";
import type { IdentityPort } from "@/platform/auth/port";
import { createLogger, stdoutSink } from "@/platform/observability";
import { createConnectionCommands, type ConnectionCommands } from "@/server/commands/connections";
import { createOutboxNotifier, webJobRuntime } from "@/server/jobs/outbox-notifier";
import { webUnitOfWork } from "@/server/persistence/runtime";
import { createActionPipeline } from "@/server/pipeline";
import type { ConnectionAuthorizationDependencies } from "./authorization";
import { composeCredentialSealer } from "./credential-crypto";
import { VERCEL_OIDC_TEAM_ISSUER, VERCEL_PRODUCTION_SUBJECT, createVercelAwsIdentity, unverifiedVercelOidcClaims, vercelAwsIdentity } from "./vercel-aws-identity";
import { WEB_KMS_DIAGNOSTIC_AWS_ATTEMPTS, runWebKmsIdentityDiagnostic, type WebKmsDiagnosticOutcome } from "./web-kms-diagnostic";
import { composeWebAwsCredentials, type WebAwsIdentityFactory } from "./web-identity";
import { isLocalSimulatorRuntime, localSimulator } from "./simulator";

type Environment = Readonly<Record<string, string | undefined>>;

export function createOAuthSecrets(deriver: PkceDeriver): OAuthSecrets {
  return {
    newState: newOAuthState,
    stateDigest: oauthStateDigest,
    pkceVerifier: (state) => deriver.verifier(state),
    pkceChallenge: (state) => deriver.challenge(state),
  };
}

/** Seals provider-credential plaintext under ADR-64's context (purpose provider-credential, env, workspace, credential). */
export function createCredentialSealing(sealer: CredentialSealer, env: string): CredentialSealing {
  return {
    async seal(plaintext, binding) {
      const context = credentialContext({ purpose: "provider-credential", env, workspaceId: binding.workspaceId, credentialId: binding.credentialId });
      return encodeEnvelope(await sealer.seal(plaintext, context));
    },
  };
}

/** The app's fixed, query-free callback URL per provider (0007 persists exactly that shape). An absent port is unavailable. */
export function authorizationProviders(ports: { readonly simulator?: ProviderAuthorizationPort }, appBaseUrl: string): AuthorizationProviders {
  const base = new URL(appBaseUrl);
  return {
    authorization: (provider) => ({ simulator: ports.simulator })[provider],
    redirectUri: (provider) => new URL(`/api/oauth/${provider}/callback`, base.origin).href,
  };
}

interface Composition {
  readonly commands: ConnectionCommands;
  readonly providers: AuthorizationProviders;
  readonly secrets: OAuthSecrets;
  readonly sealing: CredentialSealing;
}

let composition: Composition | undefined;

/**
 * The web's AWS identity adapter (7E.3B): Vercel OIDC → AssumeRoleWithWebIdentity, preflighted. It resolves nothing
 * until a KMS operation needs credentials, and without the KMS configuration and web role it isn't used at all.
 */
const WEB_AWS_IDENTITY: WebAwsIdentityFactory = vercelAwsIdentity;

function compose(environment: Environment): Composition {
  assertNoLocalKeyringOutsideLocal(environment);
  const appBaseUrl = environment["APP_BASE_URL"];
  if (appBaseUrl === undefined || appBaseUrl === "") throw new Error("APP_BASE_URL is not set");
  const secrets = createOAuthSecrets(pkceDeriverFromEnvironment(environment));
  // Local-only adapters exist only where their own rule allows them; a hosted runtime has none (real providers VALIDATE).
  const ports = isLocalSimulatorRuntime(environment) ? { simulator: localSimulator(environment).authorization } : {};
  const providers = authorizationProviders(ports, appBaseUrl);
  // Local keyring in development/test; KMS where configured, with the web's lazy Vercel OIDC identity.
  const crypto = composeCredentialSealer(environment, composeWebAwsCredentials(environment, WEB_AWS_IDENTITY));
  const sealing = createCredentialSealing(crypto.sealer, crypto.contextEnv);
  return { commands: createConnectionCommands({ secrets, providers }), providers, secrets, sealing };
}

/**
 * The web KMS identity diagnostic's production composition (Step 7E.10-B; ./web-kms-diagnostic.ts): the product
 * sealer composition and the product Vercel identity, each bounded to ONE AWS attempt. No route invokes it
 * (BLOCKED_PENDING_SAFE_ROUTE_PROTECTION); nothing is composed until every diagnostic guard passed.
 */
export function webKmsIdentityDiagnostic(payload: unknown, environment: Environment = process.env): Promise<WebKmsDiagnosticOutcome> {
  return runWebKmsIdentityDiagnostic(payload, environment, {
    nodeVersion: process.version,
    readClaims: () => unverifiedVercelOidcClaims(),
    expected: { issuer: VERCEL_OIDC_TEAM_ISSUER, subject: VERCEL_PRODUCTION_SUBJECT },
    composeSealer: (env) =>
      composeCredentialSealer(env, composeWebAwsCredentials(env, createVercelAwsIdentity({}, WEB_KMS_DIAGNOSTIC_AWS_ATTEMPTS)), WEB_KMS_DIAGNOSTIC_AWS_ATTEMPTS),
  });
}

/** Per-request dependencies: the shared composition plus a pipeline bound to this request's identity. */
export function connectionAuthorizationRuntime(identity: IdentityPort, environment: Environment = process.env): ConnectionAuthorizationDependencies {
  composition ??= compose(environment);
  const logger = createLogger({ sink: stdoutSink, base: { module: "server.connections" } });
  const jobs = webJobRuntime(environment);
  const pipeline = createActionPipeline({
    identity,
    unitOfWork: webUnitOfWork(),
    clock: () => new Date(),
    newId: randomUUID,
    logger,
    ...(jobs === undefined ? {} : { outboxCommitted: createOutboxNotifier(jobs) }),
  });
  return { ...composition, pipeline, newId: randomUUID, logger };
}
