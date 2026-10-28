/**
 * The hosted web's Meta WEBHOOK configuration (Step H6-F3; design H6-F0 §4). Web-only, like the Meta app config it
 * extends; both jobs planes refuse every name here (jobs/plane-environment.ts):
 *
 *   PROVIDER_META_CLIENT_SECRET          the Meta App Secret (signs deliveries) — reused from ./../connections/meta-app-config,
 *                                        never duplicated or re-read here
 *   PROVIDER_META_WEBHOOK_VERIFY_TOKEN   SECRET  the subscription verify token (GET handshake)
 *
 * The receiver is available only when BOTH are present and valid; otherwise it is unavailable (fail closed: 503, nothing
 * read, nothing stored). There is no development bypass. Errors name variables, never values.
 */
import type { SecretValue } from "@/integrations/providers/contract";
import { SecretValue as Secret } from "@/integrations/providers/contract";
import { readMetaAppConfig } from "../connections/meta-app-config";

type Environment = Readonly<Record<string, string | undefined>>;

export const PROVIDER_META_WEBHOOK_VERIFY_TOKEN = "PROVIDER_META_WEBHOOK_VERIFY_TOKEN";

export interface MetaWebhookConfig {
  readonly appSecret: SecretValue;
  readonly verifyToken: SecretValue;
}

export class MetaWebhookConfigError extends Error {
  override readonly name = "MetaWebhookConfigError";
  readonly variables: readonly string[];
  constructor(variables: readonly string[]) {
    super(`meta webhook configuration invalid: ${variables.join(", ")}`);
    this.variables = variables;
  }
}

/** Printable ASCII without whitespace, bounded (no provider format assumed). */
const OPAQUE_TOKEN = /^[\x21-\x7E]{16,256}$/;

/** The receiver's secrets, or undefined when the receiver isn't configured (Meta app config or verify token absent). */
export function readMetaWebhookConfig(environment: Environment): MetaWebhookConfig | undefined {
  const app = readMetaAppConfig(environment);
  const token = environment[PROVIDER_META_WEBHOOK_VERIFY_TOKEN] ?? "";
  if (app === undefined || token === "") return undefined;
  if (!OPAQUE_TOKEN.test(token)) throw new MetaWebhookConfigError([PROVIDER_META_WEBHOOK_VERIFY_TOKEN]);
  return Object.freeze({ appSecret: app.clientSecret, verifyToken: new Secret(token) });
}
