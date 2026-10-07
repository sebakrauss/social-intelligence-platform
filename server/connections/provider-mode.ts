/**
 * Which provider adapters the JOB runtime composes (Step 5K, K2/K3). Selection happens only at the composition
 * boundary: the application services (discovery, capability refresh) are the same in every environment.
 *
 *   CAPABILITY_PROVIDER_MODE unset   the existing rules, unchanged: the provider simulator and the local keyring,
 *                                    development/test only (anything else is refused where they are built)
 *   CAPABILITY_PROVIDER_MODE=staging_stub
 *                                    the synthetic, I/O-free staging adapter (integrations/providers/staging-stub):
 *                                    zero provider calls, zero provider credentials, never opens a credential
 *                                    envelope. Allowed ONLY when the explicit deployment tier APP_DEPLOYMENT_ENV is
 *                                    `preview` or `staging`. A deployed Preview/Staging worker is a production-built
 *                                    artifact (NODE_ENV=production), so NODE_ENV neither allows nor forbids it: the
 *                                    explicit tier does.
 *
 * Fail closed: an unknown mode, an unknown tier, the `production` tier, or a missing tier with `staging_stub` all
 * refuse to compose anything. Messages name the variables, never their values.
 */

export const DEPLOYMENT_TIERS = ["preview", "staging", "production"] as const;
export type DeploymentTier = (typeof DEPLOYMENT_TIERS)[number];

/** The only tiers in which the staging stub may run. */
export const STAGING_STUB_TIERS = ["preview", "staging"] as const satisfies readonly DeploymentTier[];

export const PROVIDER_MODE_VARIABLES = { mode: "CAPABILITY_PROVIDER_MODE", tier: "APP_DEPLOYMENT_ENV" } as const;

export type ProviderComposition =
  | { readonly kind: "local_simulator" }
  | { readonly kind: "staging_stub"; readonly tier: (typeof STAGING_STUB_TIERS)[number] };

export class ProviderModeError extends Error {
  override readonly name = "ProviderModeError";
}

type Environment = Readonly<Record<string, string | undefined>>;

export function providerComposition(environment: Environment): ProviderComposition {
  const mode = environment[PROVIDER_MODE_VARIABLES.mode] ?? "";
  const tier = environment[PROVIDER_MODE_VARIABLES.tier] ?? "";
  if (tier !== "" && !(DEPLOYMENT_TIERS as readonly string[]).includes(tier)) {
    throw new ProviderModeError(`${PROVIDER_MODE_VARIABLES.tier} is not a known deployment tier`);
  }
  if (mode === "") return { kind: "local_simulator" };
  if (mode !== "staging_stub") throw new ProviderModeError(`${PROVIDER_MODE_VARIABLES.mode} is not a known provider mode`);
  if (tier === "preview" || tier === "staging") return { kind: "staging_stub", tier };
  throw new ProviderModeError(`staging_stub requires ${PROVIDER_MODE_VARIABLES.tier} to be preview or staging`);
}
