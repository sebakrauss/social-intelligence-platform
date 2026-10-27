/**
 * Provider object identifiers (shared kernel): an external object's id exactly as its provider assigned it, opaque to
 * the product. Mirrors the provider contract's id format (a unit test pins them equal) so pure module domains can name
 * provider objects without importing the contract. Never an internal identity, never interpreted.
 */

declare const providerIdBrand: unique symbol;

export type ProviderId = string & { readonly [providerIdBrand]: true };

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseProviderId(value: unknown): ProviderId | undefined {
  return typeof value === "string" && PROVIDER_ID.test(value) ? (value as ProviderId) : undefined;
}
