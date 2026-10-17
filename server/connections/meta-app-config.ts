/**
 * The Meta app configuration of the hosted web (Step 7G-C; TA §39; decisions D5, D13, D14). Facebook Login for
 * Business with a User Access Token configuration: the web builds the authorization URL (client ID + configuration ID)
 * and redeems the code (client ID + client secret). Nothing else needs these values:
 *
 *   PROVIDER_META_CLIENT_ID       NON_SECRET   the Meta App ID
 *   PROVIDER_META_CONFIG_ID       NON_SECRET   the Facebook Login for Business configuration ID (`config_id`)
 *   PROVIDER_META_CLIENT_SECRET   SECRET       the Meta App Secret: only the authorization-code exchange uses it
 *
 * Plane ownership: the hosted web only. "Require App Secret" is OFF (D13), so reads carry no appsecret_proof and the
 * integration worker never needs the secret; both jobs planes refuse all three names (jobs/plane-environment.ts). The
 * Meta Client Token is not part of the architecture: no variable exists for it.
 *
 * Read only where the Meta authorization adapter is composed (Step 7G-D), never at boot: none set → Meta is simply
 * unavailable (fail closed, never a simulator stand-in); some set → incomplete, refused; all set → each validated as
 * an opaque value (no provider format is assumed). Errors name variables, never values. Composition roots pass their
 * environment; nothing here reads process.env.
 */
import { SecretValue } from "@/integrations/providers/contract";

type Environment = Readonly<Record<string, string | undefined>>;

export const PROVIDER_META_CLIENT_ID = "PROVIDER_META_CLIENT_ID";
export const PROVIDER_META_CONFIG_ID = "PROVIDER_META_CONFIG_ID";
export const PROVIDER_META_CLIENT_SECRET = "PROVIDER_META_CLIENT_SECRET";

export type MetaAppVariableClass = "non_secret" | "secret";

/** The closed Meta app configuration contract: every variable and its classification. */
export const META_APP_CONFIG_VARIABLES: Readonly<Record<string, MetaAppVariableClass>> = Object.freeze({
  [PROVIDER_META_CLIENT_ID]: "non_secret",
  [PROVIDER_META_CONFIG_ID]: "non_secret",
  [PROVIDER_META_CLIENT_SECRET]: "secret",
});

export interface MetaAppConfig {
  readonly clientId: string;
  readonly configId: string;
  readonly clientSecret: SecretValue;
}

export class MetaAppConfigError extends Error {
  override readonly name = "MetaAppConfigError";
  readonly reason: "incomplete" | "invalid";
  readonly variables: readonly string[];
  constructor(reason: "incomplete" | "invalid", variables: readonly string[]) {
    super(`meta app configuration ${reason}: ${variables.join(", ")}`);
    this.reason = reason;
    this.variables = variables;
  }
}

/** Printable ASCII without whitespace: catches pasted padding or line breaks, assumes no provider-specific format. */
const OPAQUE_IDENTIFIER = /^[\x21-\x7E]{1,256}$/;
const OPAQUE_SECRET = /^[\x21-\x7E]{1,1024}$/;

const configured = (value: string | undefined): value is string => value !== undefined && value !== "";

/** The Meta app configuration: undefined when none of its variables is set; otherwise all must be set and valid. */
export function readMetaAppConfig(environment: Environment): MetaAppConfig | undefined {
  const names = Object.keys(META_APP_CONFIG_VARIABLES);
  if (!names.some((name) => configured(environment[name]))) return undefined;
  const missing = names.filter((name) => !configured(environment[name]));
  if (missing.length > 0) throw new MetaAppConfigError("incomplete", missing);
  const clientId = environment[PROVIDER_META_CLIENT_ID] ?? "";
  const configId = environment[PROVIDER_META_CONFIG_ID] ?? "";
  const clientSecret = environment[PROVIDER_META_CLIENT_SECRET] ?? "";
  const invalid = [
    ...(OPAQUE_IDENTIFIER.test(clientId) ? [] : [PROVIDER_META_CLIENT_ID]),
    ...(OPAQUE_IDENTIFIER.test(configId) ? [] : [PROVIDER_META_CONFIG_ID]),
    ...(OPAQUE_SECRET.test(clientSecret) ? [] : [PROVIDER_META_CLIENT_SECRET]),
  ];
  if (invalid.length > 0) throw new MetaAppConfigError("invalid", invalid);
  return Object.freeze({ clientId, configId, clientSecret: new SecretValue(clientSecret) });
}
