/**
 * Brand fonts (UI-1; Manual de Marca v1.1 §4), served from this repository through next/font/local: the files are
 * bundled and hashed at build time and the page never asks a font service for anything. Each loader writes a PRIVATE
 * variable (--wk-font-brand-file / --wk-font-ui-file / --wk-font-mono-file) onto <html>; the public tokens in
 * ./tokens.css read it with `var(--wk-font-…-file, "<family>")` followed by the system stack, so the loaded family is
 * selected whenever the loader is present, independently of the order in which Next's generated styles and
 * tokens.css are applied, and nothing else ever declares the public token. Fallback while the file arrives is the
 * size-adjusted system font Next derives (display: swap). Files, versions, hashes and licenses: ./fonts/manifest.ts.
 *
 * Outfit speaks (titles, 400 and 600 from the variable file), Inter works (product text, 400 and 500), JetBrains
 * Mono measures (data, 400 and 500). No italics: the manual defines none.
 */
import localFont from "next/font/local";

/** Outfit — Google Fonts distribution (variable, wght 100–900). */
export const brandFont = localFont({
  src: "./fonts/outfit/Outfit[wght].ttf",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: true,
  variable: "--wk-font-brand-file",
});

/** Inter — rsms/inter 4.1 web statics for the two weights the manual uses. */
export const uiFont = localFont({
  src: [
    { path: "./fonts/inter/Inter-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/inter/Inter-Medium.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: true,
  variable: "--wk-font-ui-file",
});

/** JetBrains Mono — JetBrains/JetBrainsMono 2.304 web statics for the two weights the manual uses. */
export const monoFont = localFont({
  src: [
    { path: "./fonts/jetbrains-mono/JetBrainsMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono/JetBrainsMono-Medium.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  preload: false,
  variable: "--wk-font-mono-file",
  adjustFontFallback: false,
});

/** The class names that put the three private file variables on <html>; the public tokens pick them up. */
export const FONT_CLASS_NAMES = [brandFont.variable, uiFont.variable, monoFont.variable].join(" ");
