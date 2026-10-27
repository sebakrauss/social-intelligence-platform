/**
 * Instants (shared kernel). A canonical UTC instant string, millisecond precision, exactly as `Date#toISOString()`
 * renders it. Mirrors the provider contract's IsoInstant format (a unit test pins them equal) so pure module domains,
 * which may not import the contract, can carry provider and observed times. Pure: parsing and ordering only.
 */

declare const instantBrand: unique symbol;

export type Instant = string & { readonly [instantBrand]: true };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseInstant(value: unknown): Instant | undefined {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) || new Date(time).toISOString() !== value ? undefined : (value as Instant);
}

/** Total order on instants: negative when `a` is earlier, 0 when equal, positive when later. */
export function compareInstants(a: Instant, b: Instant): number {
  return Date.parse(a) - Date.parse(b);
}
