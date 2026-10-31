/**
 * The model-provider SDK AMBIENT configuration (Step H7-D1b; H7-A0 D-H7-1, D-H7-6): the environment variables the
 * pinned official SDKs read ON THEIR OWN on the client paths our adapters reach — @anthropic-ai/sdk 1.3.0 (`client.js`,
 * `core/credentials.js`, `lib/credentials/credential-chain.js`, `internal/tracing.js`, `internal/utils/log.js`) and
 * openai 7.45.1 (`client.js`). A closed list grounded in those files (a test re-reads them: every ANTHROPIC_* /
 * OPENAI_* name they read is listed, and every listed name is read there) — never a prefix wildcard. Names read only by
 * entry points the adapters never construct (Anthropic environment workers, Azure, Bedrock, Vertex) are not listed.
 *
 * Every runtime REFUSES all of them — MAIN, INTEGRATION, INTELLIGENCE (jobs/plane-environment.ts) and the hosted WEB
 * (server/http/web-environment.ts). The product's one model credential is the vendor-neutral INTELLIGENCE_MODEL_API_KEY
 * (INTELLIGENCE only), handed EXPLICITLY to the adapter's client (the adapters read no environment), so an SDK can never
 * pick up an ambient credential, be redirected to another endpoint, receive injected headers or log / trace content.
 *
 * Detection-and-refusal data only (like domain/secret-patterns.ts): nothing reads these names as configuration.
 */

/** Credentials and credential-equivalent identity material an SDK would send. */
export const MODEL_PROVIDER_AMBIENT_CREDENTIALS: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_WEBHOOK_SIGNING_KEY",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_WEBHOOK_SECRET",
]);

/** Endpoint, credential-profile, header, logging and telemetry overrides an SDK would apply. */
export const MODEL_PROVIDER_AMBIENT_OVERRIDES: readonly string[] = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_LOG",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_OPEN_TELEMETRY",
  "ANTHROPIC_OPEN_TELEMETRY_PROPAGATION",
  "ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE",
  "ANTHROPIC_OPEN_TELEMETRY_TRACES_MAX_CONTENT_BYTES",
  "OPENAI_BASE_URL",
  "OPENAI_CUSTOM_HEADERS",
  "OPENAI_LOG",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
]);

export const MODEL_PROVIDER_AMBIENT_VARIABLES: readonly string[] = Object.freeze([...MODEL_PROVIDER_AMBIENT_CREDENTIALS, ...MODEL_PROVIDER_AMBIENT_OVERRIDES]);
