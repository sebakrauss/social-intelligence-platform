/**
 * The credential-context environment label (ADR-64: `env` is part of the authenticated context), shared by the
 * web (seal) and the job runtime (open) so an envelope opens only in the environment that sealed it. Step 5D has
 * only the local keyring, allowed in development and test; deployed labels arrive with the KMS adapter (5I).
 */
export function credentialEnvironmentLabel(environment: Readonly<Record<string, string | undefined>>): "local" | "test" {
  const nodeEnv = environment["NODE_ENV"];
  if (nodeEnv === "test") return "test";
  if (nodeEnv === "development") return "local";
  throw new Error("credential environment: no keyring is configured for this environment");
}
