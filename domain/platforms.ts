/**
 * Social platforms confirmed as product vocabulary (PD D-04, D-06; IA §21).
 *
 * Display identity only: a platform key says NOTHING about what the platform supports.
 * Capability always comes from the validated capability catalog (PD C-07, OQ-18; TA §16).
 */
export const PLATFORM_KEYS = ["facebook", "instagram", "tiktok"] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

/** Proper nouns, identical in every interface language. */
export const PLATFORM_DISPLAY_NAMES: Readonly<Record<PlatformKey, string>> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};

const platformKeySet: ReadonlySet<string> = new Set(PLATFORM_KEYS);

export function isPlatformKey(value: unknown): value is PlatformKey {
  return typeof value === "string" && platformKeySet.has(value);
}
