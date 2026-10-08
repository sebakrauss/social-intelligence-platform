/**
 * The authenticated credential context (TA-Q-07 / ADR-64): exactly
 *   app · purpose · env · v · workspace_id · credential_id
 * It is not secret: it is bound (as additional authenticated data) to BOTH the wrapped data key and the
 * encrypted payload, so an envelope opens only under the exact workspace and credential it was sealed for.
 * The canonical encoding is fixed-order and independent of how the object was built.
 */
import { isUuid } from "@/domain/ids";
import { CredentialCryptoError } from "./errors";

export const CREDENTIAL_CONTEXT_APP = "social-intelligence-platform";
/** Closed set. Other short-lived material (e.g. PKCE verifiers) will get its own purpose, never this one. */
export const CREDENTIAL_PURPOSES = ["provider-credential"] as const;
export type CredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];
export const CREDENTIAL_CONTEXT_VERSION = "1";

/** Canonical field order; also the exact set of allowed fields. */
export const CREDENTIAL_CONTEXT_FIELDS = ["app", "purpose", "env", "v", "workspace_id", "credential_id"] as const;

/**
 * The closed set of cryptographic environment labels (`env`). This is its own concept, not the deployment tier
 * (APP_DEPLOYMENT_ENV): it names the key environment an envelope belongs to, so an envelope opens only where it was
 * sealed. "local" and "test" are the local-keyring environments; "dev" is the label the TA-Q-07b key policy pins
 * (`kms:EncryptionContext:env` = "dev"). Further deployed labels are added only together with their key policy.
 */
export const CREDENTIAL_CONTEXT_ENVS = ["local", "test", "dev"] as const;
export type CredentialContextEnv = (typeof CREDENTIAL_CONTEXT_ENVS)[number];

declare const contextBrand: unique symbol;

export interface CredentialContext {
  readonly app: typeof CREDENTIAL_CONTEXT_APP;
  readonly purpose: CredentialPurpose;
  readonly env: CredentialContextEnv;
  readonly v: typeof CREDENTIAL_CONTEXT_VERSION;
  readonly workspace_id: string;
  readonly credential_id: string;
  readonly [contextBrand]: true;
}

export interface CredentialContextInput {
  readonly purpose: CredentialPurpose;
  readonly env: string;
  readonly workspaceId: string;
  readonly credentialId: string;
}

const invalid = (): never => {
  throw new CredentialCryptoError("INVALID_CONTEXT");
};

function build(app: unknown, purpose: unknown, env: unknown, v: unknown, workspaceId: unknown, credentialId: unknown): CredentialContext {
  if (app !== CREDENTIAL_CONTEXT_APP) invalid();
  if (!(CREDENTIAL_PURPOSES as readonly unknown[]).includes(purpose)) invalid();
  if (!(CREDENTIAL_CONTEXT_ENVS as readonly unknown[]).includes(env)) invalid();
  if (v !== CREDENTIAL_CONTEXT_VERSION) invalid();
  if (!isUuid(workspaceId) || !isUuid(credentialId)) invalid();
  return Object.freeze({
    app: CREDENTIAL_CONTEXT_APP,
    purpose: purpose as CredentialPurpose,
    env: env as CredentialContextEnv,
    v: CREDENTIAL_CONTEXT_VERSION,
    workspace_id: workspaceId as string,
    credential_id: credentialId as string,
  }) as CredentialContext;
}

export function credentialContext(input: CredentialContextInput): CredentialContext {
  return build(CREDENTIAL_CONTEXT_APP, input.purpose, input.env, CREDENTIAL_CONTEXT_VERSION, input.workspaceId, input.credentialId);
}

/** Validates an untrusted context object: exactly the six fields, each valid; anything else fails closed. */
export function parseCredentialContext(value: unknown): CredentialContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CREDENTIAL_CONTEXT_FIELDS.length || !keys.every((key) => (CREDENTIAL_CONTEXT_FIELDS as readonly string[]).includes(key))) {
    return invalid();
  }
  return build(record["app"], record["purpose"], record["env"], record["v"], record["workspace_id"], record["credential_id"]);
}

/** Deterministic encoding: fixed field order, restricted value charsets, UTF-8. */
export function canonicalContextBytes(context: CredentialContext): Buffer {
  const checked = parseCredentialContext(context);
  return Buffer.from(JSON.stringify(CREDENTIAL_CONTEXT_FIELDS.map((field) => [field, checked[field]])), "utf8");
}
