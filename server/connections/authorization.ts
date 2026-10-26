/**
 * Connection authorization orchestration, web side (Step 5D; TA §38.7, §39; decisions B1–B3). It spans several
 * short pipeline runs (each its own user-scoped transaction) and makes the provider calls BETWEEN them, never
 * inside one:
 *
 *   start      pipeline: start (attempt PENDING, or a committed existing_connection / authorization_in_progress for a
 *              fresh Meta start — Step 7G-F4) → AFTER commit: port.authorizationRequest → the URL must target the
 *              provider's exact composed endpoint (origin + path; the query is never interpreted) → URL to the browser
 *   callback   parseCallback (adapter) → malformed: stop, nothing touched
 *              state routing prefix → pipeline: verify (digest match; denied → DENIED; code → EXCHANGING claim)
 *              → derive the PKCE verifier again from the returned state (never stored)
 *              → port.exchangeCode EXACTLY ONCE, no retry
 *              → bytes → seal (provider-credential purpose) → zero the plaintext
 *              → pipeline: complete (Connection + envelope + COMPLETED + event + audit + outbox), atomically
 *              → any failure: pipeline: fail (EXCHANGE_FAILED closed code | OUTCOME_UNKNOWN)
 *
 * Only the claim winner exchanges, so a replayed or concurrent callback can never exchange again. If the process
 * dies after the claim, the attempt stays EXCHANGING and is recovered as OUTCOME_UNKNOWN later (never replayed).
 * Logs carry IDs and closed codes only: never the state, the code, the verifier or the credential. An ambiguous
 * exchange also logs its closed sub-reason (Step 7G-H5.5-P12-C0-R5A), as an event name, and is handled exactly the same.
 */
import { parseCorrelationId } from "@/domain/correlation";
import {
  OutcomeUnknownError,
  ProviderError,
  isProviderError,
  parseOAuthState,
  parsePkceVerifier,
  type CallbackQuery,
  type ProviderAuthorizationPort,
} from "@/integrations/providers/contract";
import {
  AUTHORIZABLE_PROVIDERS,
  encodeProviderCredential,
  stateWorkspace,
  type AuthorizableProvider,
  type AuthorizationProviders,
  type CredentialSealing,
  type ExchangeFailureCode,
  type OAuthSecrets,
} from "@/modules/connections";
import type { Logger } from "@/platform/observability";
import type { ActionPipeline } from "@/server/pipeline";
import type { ConnectionCommands } from "@/server/commands/connections";

export interface ConnectionAuthorizationDependencies {
  readonly pipeline: ActionPipeline;
  readonly commands: ConnectionCommands;
  readonly providers: AuthorizationProviders;
  readonly secrets: OAuthSecrets;
  readonly sealing: CredentialSealing;
  readonly newId: () => string;
  readonly logger: Logger;
}

type Unauthenticated = { readonly status: "unauthenticated" } | { readonly status: "verification_required" };

export type StartResult =
  | { readonly status: "ok"; readonly authorizationUrl: string }
  | { readonly status: "existing_connection" }
  | { readonly status: "authorization_in_progress" }
  | Unauthenticated
  | { readonly status: "error"; readonly code: string };

/**
 * Whether an adapter-built authorization URL may be followed: https, no userinfo, no fragment, and exactly the
 * composed endpoint's origin and path. The query (state, client id, configuration, redirect URI) belongs to the
 * adapter contract and is never read here.
 */
export function isAuthorizationDestination(url: string, endpoint: string): boolean {
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(url);
    expected = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    expected.protocol === "https:" &&
    actual.protocol === "https:" &&
    actual.username === "" &&
    actual.password === "" &&
    actual.hash === "" &&
    !url.includes("#") &&
    actual.origin === expected.origin &&
    actual.pathname === expected.pathname
  );
}

export const RESTART_REASONS = ["invalid_callback", "not_found", "exchange_failed", "outcome_unknown", "not_stored", "connection_unavailable"] as const;
export type RestartReason = (typeof RESTART_REASONS)[number];

export type CallbackResult =
  | { readonly status: "connected"; readonly connectionId: string }
  | { readonly status: "reauthorized"; readonly connectionId: string }
  | { readonly status: "denied" }
  | { readonly status: "restart_required"; readonly reason: RestartReason }
  | Unauthenticated;

const isAuthorizable = (value: string): value is AuthorizableProvider => (AUTHORIZABLE_PROVIDERS as readonly string[]).includes(value);

/** Exchange errors → the attempt's terminal outcome. Anything not provably definite is OUTCOME_UNKNOWN. */
export function exchangeOutcome(error: unknown): ExchangeFailureCode | "OUTCOME_UNKNOWN" {
  if (!isProviderError(error)) return "OUTCOME_UNKNOWN";
  switch (error.kind) {
    case "credential_invalid":
      return "CREDENTIAL_INVALID";
    case "permission_missing":
      return "PERMISSION_MISSING";
    case "permanent_rejected":
    case "target_not_found":
    case "target_not_eligible":
      return "REQUEST_REJECTED";
    // Real code-replay semantics are unvalidated: transient failures are NOT retried with the same code.
    case "transient":
      return "PROVIDER_UNAVAILABLE";
    case "rate_limited":
      return "RATE_LIMITED";
    case "outcome_unknown":
      return "OUTCOME_UNKNOWN";
  }
}

export async function startConnectionAuthorization(
  deps: ConnectionAuthorizationDependencies,
  request: { readonly workspaceId: unknown; readonly provider: unknown; readonly reconnectConnectionId?: unknown; readonly correlationId?: unknown },
): Promise<StartResult> {
  const result = await deps.pipeline.run(deps.commands.start, {
    workspaceId: request.workspaceId,
    correlationId: request.correlationId,
    input: { provider: request.provider, ...(request.reconnectConnectionId === undefined ? {} : { reconnectConnectionId: request.reconnectConnectionId }) },
  });
  if (result.status === "unauthenticated" || result.status === "verification_required") return { status: result.status };
  if (result.status === "error") return { status: "error", code: result.error.code };
  if (result.value.kind !== "started") return { status: result.value.kind };
  const started = result.value.authorization;
  const port = deps.providers.authorization(started.provider);
  const state = parseOAuthState(started.state);
  if (port === undefined || state === undefined) return { status: "error", code: "PROVIDER_PERMANENT" };
  let url: string;
  try {
    // After commit (no transaction, no lock is held here): the attempt exists before the user can be sent anywhere. A
    // failure here leaves a PENDING attempt that simply expires.
    url = (await port.authorizationRequest({ state, redirectUri: started.redirectUri, pkce: started.pkce })).url;
  } catch {
    deps.logger.warn("connections.authorization.request_failed", { outcome: "error", workspaceId: String(request.workspaceId) });
    return { status: "error", code: "PROVIDER_PERMANENT" };
  }
  const endpoint = deps.providers.authorizationEndpoint(started.provider);
  if (endpoint !== undefined && !isAuthorizationDestination(url, endpoint)) {
    deps.logger.warn("connections.authorization.destination_rejected", { outcome: "error", workspaceId: String(request.workspaceId) });
    return { status: "error", code: "PROVIDER_PERMANENT" };
  }
  return { status: "ok", authorizationUrl: url };
}

export async function completeConnectionAuthorization(
  deps: ConnectionAuthorizationDependencies,
  request: { readonly provider: string; readonly query: CallbackQuery; readonly correlationId?: unknown },
): Promise<CallbackResult> {
  const correlationId = parseCorrelationId(request.correlationId);
  const log = deps.logger.child({ module: "server.connections", operation: "connections.authorization.callback", ...(correlationId === undefined ? {} : { correlationId }) });
  const restart = (reason: RestartReason): CallbackResult => {
    log.info(`connections.authorization.restart_required.${reason}`, { outcome: "error" });
    return { status: "restart_required", reason };
  };

  const port: ProviderAuthorizationPort | undefined = isAuthorizable(request.provider) ? deps.providers.authorization(request.provider) : undefined;
  if (port === undefined || !isAuthorizable(request.provider)) return restart("invalid_callback");
  const provider = request.provider;

  // 1. Normalize the raw query (adapter). Malformed: nothing is looked up, nothing is touched.
  const outcome = port.parseCallback(request.query);
  if (outcome.kind === "malformed") return restart("invalid_callback");

  // 2. Routing prefix → bind that workspace; the digest match inside it is what verifies the state.
  const workspaceId = stateWorkspace(outcome.state);
  if (workspaceId === undefined) return restart("not_found");
  const routed = { workspaceId, correlationId: request.correlationId };
  const verified = await deps.pipeline.run(deps.commands.verify, {
    ...routed,
    input: { provider, stateDigest: deps.secrets.stateDigest(outcome.state), kind: outcome.kind },
  });
  if (verified.status === "unauthenticated" || verified.status === "verification_required") return { status: verified.status };
  if (verified.status === "error") return restart("not_found");
  if (verified.value === "denied") return { status: "denied" };
  if (outcome.kind !== "code") return restart("not_found");
  const claim = verified.value;

  const failWith = async (code: ExchangeFailureCode | "OUTCOME_UNKNOWN", reason: RestartReason): Promise<CallbackResult> => {
    await deps.pipeline.run(deps.commands.fail, { ...routed, input: { attemptId: claim.attemptId, outcome: code } });
    log.info(`connections.authorization.exchange_closed.${code.toLowerCase()}`, { outcome: "error", workspaceId });
    return { status: "restart_required", reason };
  };

  // 3. The single exchange. The verifier is derived again from the returned state; it was never stored.
  const verifier = port.pkce === "not_supported" ? null : (parsePkceVerifier(deps.secrets.pkceVerifier(outcome.state)) ?? null);
  if (port.pkce !== "not_supported" && verifier === null) return failWith("REQUEST_REJECTED", "exchange_failed");
  let exchanged;
  try {
    exchanged = await port.exchangeCode({ code: outcome.code, redirectUri: claim.redirectUri, pkceVerifier: verifier });
  } catch (error) {
    const code = exchangeOutcome(error);
    if (!(error instanceof ProviderError)) log.warn("connections.authorization.exchange_unexpected_error", { outcome: "error", workspaceId });
    // Step 7G-H5.5-P12-C0-R5A: an ambiguous exchange names its closed sub-reason in the event (never a value). Same handling.
    if (error instanceof OutcomeUnknownError && error.reason !== null) log.info(`connections.authorization.exchange_ambiguous.${error.reason}`, { outcome: "error", workspaceId });
    return failWith(code, code === "OUTCOME_UNKNOWN" ? "outcome_unknown" : "exchange_failed");
  }

  // 4. Bytes → seal → zero, before any database work.
  const credentialId = deps.newId();
  let envelope: Uint8Array;
  try {
    const plaintext = encodeProviderCredential(exchanged.data.credential);
    try {
      envelope = await deps.sealing.seal(plaintext, { workspaceId, credentialId });
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return failWith("CREDENTIAL_NOT_STORED", "not_stored");
  }

  // 5. One transaction: Connection + credential + attempt COMPLETED + event + audit + outbox.
  const expiresAt = exchanged.data.expiresAt === null ? null : new Date(exchanged.data.expiresAt);
  const completed = await deps.pipeline.run(deps.commands.complete, {
    ...routed,
    input: { attemptId: claim.attemptId, credentialId, envelope, expiresAt },
  });
  if (completed.status !== "ok") {
    // Nothing was committed: the sealed envelope is discarded, and the code is never exchanged again.
    return completed.status === "error" ? failWith("CREDENTIAL_NOT_STORED", "not_stored") : { status: completed.status };
  }
  const output = completed.value;
  if (output.kind === "connection_unavailable") return restart("connection_unavailable");
  log.info(`connections.authorization.completed.${output.kind}`, { outcome: "ok", workspaceId });
  return output.kind === "created" ? { status: "connected", connectionId: output.connection.id } : { status: "reauthorized", connectionId: output.connection.id };
}
