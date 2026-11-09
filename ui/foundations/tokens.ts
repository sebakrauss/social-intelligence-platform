/**
 * Wrenkind design tokens (UI-1): the machine-readable copy of the Manual de Marca v1.1 (approved 2026-10-09), sections
 * 2 (color), 3 (semantic tokens), 4 (typography), 5 (space and radius) and 10 (motion). The CSS in ./tokens.css is
 * written from this file and tests/unit/ui/tokens.test.ts proves both agree and that every text token meets the
 * manual's measured contrast (AA: 4.5:1 for text, 3:1 for graphics) in both themes.
 *
 * Source: brand kit v1.1 (wrenkind-brand-kit-v1.1.zip, sha256 e3c9a7b2…b35f529), 01-manual/tokens/tokens.json and
 * tokens.css. Values that the kit carries but the manual's table does not list (text.disabled) are marked below.
 *
 * Pure data: no I/O, no framework. The brand rule these tokens encode: black as the base, white to read, blue only
 * where a person decides (human.*), for links and for keyboard focus (interactive.*). Status colors never use blue.
 */

export const NEUTRAL = {
  0: "#FFFFFF",
  25: "#FAFAFA",
  50: "#F4F4F4",
  100: "#EBEBEB",
  200: "#DADADA",
  300: "#C2C2C2",
  400: "#A3A3A3",
  500: "#7A7A7A",
  600: "#5C5C5C",
  700: "#3D3D3D",
  800: "#262626",
  850: "#1A1A1A",
  900: "#141414",
  950: "#0A0A0A",
} as const;

/** Electric Blue is the 500. The brand uses almost only that step; text uses 300 (dark) and 600 (light). */
export const BLUE = {
  50: "#EEF3FF",
  100: "#DCE6FF",
  200: "#B9CCFF",
  300: "#8FA9FF",
  400: "#6E95FF",
  500: "#4C7DFF",
  600: "#2F5BDB",
  700: "#2446B0",
  800: "#1D3784",
  900: "#172A5E",
} as const;

export const THEME_NAMES = ["dark", "light"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const SEMANTIC_TOKENS = [
  "bg.canvas",
  "bg.surface",
  "bg.raised",
  "bg.hover",
  "border.default",
  "border.strong",
  "text.primary",
  "text.secondary",
  "text.tertiary",
  "text.disabled",
  "action.primary-bg",
  "action.primary-fg",
  "human.dot",
  "human.text",
  "human.bg",
  "interactive.link",
  "interactive.focus",
  "success.fg",
  "success.bg",
  "warning.fg",
  "warning.bg",
  "danger.fg",
  "danger.bg",
] as const;
export type SemanticToken = (typeof SEMANTIC_TOKENS)[number];

/** Manual §3 table, one column per theme. text.disabled comes from the kit's tokens.css (not in the manual's table). */
export const THEMES: { readonly [T in ThemeName]: { readonly [K in SemanticToken]: string } } = {
  dark: {
    "bg.canvas": NEUTRAL[950],
    "bg.surface": NEUTRAL[900],
    "bg.raised": NEUTRAL[850],
    "bg.hover": "#1F1F1F",
    "border.default": NEUTRAL[800],
    "border.strong": NEUTRAL[700],
    "text.primary": NEUTRAL[25],
    "text.secondary": NEUTRAL[400],
    "text.tertiary": "#8A8A8A",
    "text.disabled": NEUTRAL[600],
    "action.primary-bg": NEUTRAL[25],
    "action.primary-fg": NEUTRAL[950],
    "human.dot": BLUE[500],
    "human.text": BLUE[300],
    "human.bg": "#141C33",
    "interactive.link": BLUE[300],
    "interactive.focus": BLUE[400],
    "success.fg": "#3CCB7F",
    "success.bg": "#0F2A1C",
    "warning.fg": "#F5A524",
    "warning.bg": "#2E2208",
    "danger.fg": "#FF6B5E",
    "danger.bg": "#331412",
  },
  light: {
    "bg.canvas": NEUTRAL[0],
    "bg.surface": NEUTRAL[25],
    "bg.raised": NEUTRAL[0],
    "bg.hover": NEUTRAL[50],
    "border.default": NEUTRAL[100],
    "border.strong": NEUTRAL[200],
    "text.primary": NEUTRAL[950],
    "text.secondary": NEUTRAL[600],
    "text.tertiary": "#6E6E6E",
    "text.disabled": NEUTRAL[300],
    "action.primary-bg": NEUTRAL[950],
    "action.primary-fg": NEUTRAL[25],
    "human.dot": BLUE[500],
    "human.text": BLUE[600],
    "human.bg": BLUE[50],
    "interactive.link": BLUE[600],
    "interactive.focus": BLUE[600],
    "success.fg": "#16794A",
    "success.bg": "#E8F6EE",
    "warning.fg": "#8A5A00",
    "warning.bg": "#FFF4DE",
    "danger.fg": "#C42F24",
    "danger.bg": "#FDECEA",
  },
};

/**
 * What the manual promises (§3, §11): text tokens read at 4.5:1 or better against the canvas (or against their own
 * button), graphics such as the dot and the focus ring at 3:1 or better. text.disabled is excluded on purpose: it
 * marks a disabled control and is never used for text that must be read.
 */
export const CONTRAST_REQUIREMENTS: readonly { readonly foreground: SemanticToken; readonly background: SemanticToken; readonly minimum: 4.5 | 3 }[] = [
  { foreground: "text.primary", background: "bg.canvas", minimum: 4.5 },
  { foreground: "text.secondary", background: "bg.canvas", minimum: 4.5 },
  { foreground: "text.tertiary", background: "bg.canvas", minimum: 4.5 },
  { foreground: "action.primary-fg", background: "action.primary-bg", minimum: 4.5 },
  { foreground: "human.dot", background: "bg.canvas", minimum: 3 },
  { foreground: "human.text", background: "bg.canvas", minimum: 4.5 },
  { foreground: "interactive.link", background: "bg.canvas", minimum: 4.5 },
  { foreground: "interactive.focus", background: "bg.canvas", minimum: 3 },
  { foreground: "success.fg", background: "bg.canvas", minimum: 4.5 },
  { foreground: "warning.fg", background: "bg.canvas", minimum: 4.5 },
  { foreground: "danger.fg", background: "bg.canvas", minimum: 4.5 },
];

/** Manual §5: everything on a 4px base. */
export const SPACE = [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128] as const;

/** Manual §5: 6 on buttons and inputs, 8 on cards, 12 on panels, 4 on data tags, full on pills. */
export const RADIUS = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, full: 999 } as const;

/** Manual §10. `instant` and `reveal` come from the kit's tokens; the manual's table lists fast, base and slow. */
export const DURATION_MS = { instant: 80, fast: 120, base: 200, slow: 320, reveal: 640 } as const;

export const EASING = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  enter: "cubic-bezier(0, 0, 0, 1)",
  exit: "cubic-bezier(0.3, 0, 1, 1)",
} as const;

/**
 * Manual §4: Outfit speaks (17px and up), Inter works (product text), JetBrains Mono measures (data). The files are
 * self-hosted (./fonts, loaded by ./fonts.ts through next/font/local) and reach the page through these PRIVATE
 * variables, which only the loader sets.
 */
export const FONT_FILE_VARIABLE = {
  brand: "--wk-font-brand-file",
  ui: "--wk-font-ui-file",
  mono: "--wk-font-mono-file",
} as const;

/** The public token stacks: the loaded file when present, else the brand family by name, then the system family. */
export const FONT_FAMILY = {
  brand: `var(${FONT_FILE_VARIABLE.brand}, "Outfit"), system-ui, sans-serif`,
  ui: `var(${FONT_FILE_VARIABLE.ui}, "Inter"), system-ui, sans-serif`,
  mono: `var(${FONT_FILE_VARIABLE.mono}, "JetBrains Mono"), ui-monospace, monospace`,
} as const;

/** Manual §4 type scale: size and line height in px, letter spacing in em, weight. */
export const TYPE_SCALE = {
  "display-xl": { family: "brand", weight: 600, size: 72, lineHeight: 72, letterSpacing: -0.035 },
  "display-l": { family: "brand", weight: 600, size: 56, lineHeight: 58, letterSpacing: -0.03 },
  "heading-1": { family: "brand", weight: 600, size: 40, lineHeight: 44, letterSpacing: -0.025 },
  "heading-2": { family: "brand", weight: 600, size: 28, lineHeight: 34, letterSpacing: -0.02 },
  "heading-3": { family: "brand", weight: 600, size: 20, lineHeight: 26, letterSpacing: -0.01 },
  "body-l": { family: "brand", weight: 400, size: 17, lineHeight: 27, letterSpacing: 0 },
  "ui-body": { family: "ui", weight: 400, size: 14, lineHeight: 20, letterSpacing: 0 },
  "ui-body-s": { family: "ui", weight: 400, size: 13, lineHeight: 18, letterSpacing: 0 },
  "ui-label": { family: "ui", weight: 500, size: 12, lineHeight: 16, letterSpacing: 0.005 },
  "ui-caption": { family: "ui", weight: 400, size: 11, lineHeight: 16, letterSpacing: 0.01 },
  mono: { family: "mono", weight: 400, size: 12, lineHeight: 16, letterSpacing: 0 },
  "mono-s": { family: "mono", weight: 500, size: 11, lineHeight: 16, letterSpacing: 0.02 },
} as const satisfies Record<string, { family: keyof typeof FONT_FAMILY; weight: 400 | 500 | 600; size: number; lineHeight: number; letterSpacing: number }>;
export type TypeStyle = keyof typeof TYPE_SCALE;

/** The CSS custom property that carries a semantic token: `bg.canvas` → `--wk-bg-canvas`. */
export function cssVariable(token: SemanticToken): `--wk-${string}` {
  return `--wk-${token.replace(".", "-")}`;
}

/** Relative luminance (WCAG 2.x) of a #RRGGBB color. */
export function relativeLuminance(hex: string): number {
  const digits = /^#([0-9A-Fa-f]{6})$/.exec(hex)?.[1];
  if (digits === undefined) throw new RangeError(`not a #RRGGBB color: ${hex}`);
  const channel = (offset: number): number => {
    const value = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two #RRGGBB colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
