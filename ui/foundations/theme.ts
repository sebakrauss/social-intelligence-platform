/**
 * Theme selection (UI-1). The tokens follow the system preference by default; an explicit theme is expressed as a
 * `data-theme` attribute on <html>, which ./tokens.css honors ("light" also wins over a dark system preference).
 * No override is persisted yet: the root layout passes `undefined`, and a later gate decides where a preference is
 * stored (TL decision: "posibilidad futura de override persistente").
 */
import type { ThemeName } from "./tokens";

export const THEME_ATTRIBUTE = "data-theme";

/** Attributes for <html>: the explicit theme when one is chosen, nothing when the system decides. */
export function themeAttributes(theme: ThemeName | undefined): { readonly [THEME_ATTRIBUTE]?: ThemeName } {
  return theme === undefined ? {} : { [THEME_ATTRIBUTE]: theme };
}
