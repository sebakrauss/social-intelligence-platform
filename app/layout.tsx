import type { ReactNode } from "react";
import { DEVELOPMENT_REFERENCE_LOCALE } from "@/platform/i18n";
import { FONT_CLASS_NAMES } from "@/ui/foundations/fonts";
import { themeAttributes } from "@/ui/foundations/theme";
import "@/ui/foundations/reset.css";
import "@/ui/foundations/tokens.css";
import "@/ui/foundations/base.css";
import "@/ui/foundations/motion.css";

/**
 * Root layout required by the Next.js App Router. UI-1 (brand foundations) loads the reset, the design tokens, the
 * base element styles and the reduced-motion rule for every surface, and puts the three self-hosted brand fonts on
 * <html> through their token variables (ui/foundations/fonts.ts); the theme follows the system preference until a
 * persisted override exists (ui/foundations/theme.ts). No product shell or navigation lives here yet. Interface locale
 * selection arrives with the product UI; PD OQ-20 (MVP interface languages) remains open.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang={DEVELOPMENT_REFERENCE_LOCALE} className={FONT_CLASS_NAMES} {...themeAttributes(undefined)}>
      <body>{children}</body>
    </html>
  );
}
