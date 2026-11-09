/**
 * Type-style class names (UI-1): the typed way to reach ./typography.module.css, keyed by the manual's style names
 * so call sites read like the brand manual (`textStyle("ui-body")`). Each name is proven to exist in the module by
 * tests/unit/ui/typography.test.ts.
 */
import styles from "./typography.module.css";
import type { TypeStyle } from "./tokens";

const CLASS_NAMES: { readonly [K in TypeStyle]: string } = {
  "display-xl": styles["displayXl"] ?? "",
  "display-l": styles["displayL"] ?? "",
  "heading-1": styles["heading1"] ?? "",
  "heading-2": styles["heading2"] ?? "",
  "heading-3": styles["heading3"] ?? "",
  "body-l": styles["bodyL"] ?? "",
  "ui-body": styles["uiBody"] ?? "",
  "ui-body-s": styles["uiBodyS"] ?? "",
  "ui-label": styles["uiLabel"] ?? "",
  "ui-caption": styles["uiCaption"] ?? "",
  mono: styles["mono"] ?? "",
  "mono-s": styles["monoS"] ?? "",
};

/** The class that applies one approved text style. */
export function textStyle(style: TypeStyle): string {
  return CLASS_NAMES[style];
}
