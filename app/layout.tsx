import type { ReactNode } from "react";
import { DEVELOPMENT_REFERENCE_LOCALE } from "@/platform/i18n";

/**
 * Root layout required by the Next.js App Router. Step 0 (repository foundation) ships no
 * product surface: there is intentionally no page yet. Interface locale selection arrives
 * with the product UI; PD OQ-20 (MVP interface languages) remains open.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang={DEVELOPMENT_REFERENCE_LOCALE}>
      <body>{children}</body>
    </html>
  );
}
