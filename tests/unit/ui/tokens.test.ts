/**
 * Design tokens (UI-1): the CSS carries exactly the typed values for both themes (light by default, dark under the
 * system preference and under the explicit override), every text and graphic token meets the contrast the manual
 * promises in both themes, the primitives are the manual's scales, and the semantic values that are not in a scale
 * are the known three (bg.hover dark, text.tertiary, human.bg dark).
 * Amendment 1 (Direction C, PO-approved 2026-11-17): the new roles reuse existing values only; blue extends to
 * selection.* and accent.brand-reply and nowhere else; status colors still never use blue; a text field's border
 * stands out (3:1) from every surface it can sit on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLUE,
  CONTRAST_REQUIREMENTS,
  DURATION_MS,
  EASING,
  FONT_FAMILY,
  NEUTRAL,
  RADIUS,
  SEMANTIC_TOKENS,
  SPACE,
  THEMES,
  THEME_NAMES,
  contrastRatio,
  cssVariable,
  relativeLuminance,
} from "@/ui/foundations/tokens";

const CSS = readFileSync(path.resolve(import.meta.dirname, "../../../ui/foundations/tokens.css"), "utf8");

/** The declarations inside the first block whose selector matches. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  const declarations = new Map<string, string>();
  for (const line of CSS.slice(open + 1, close).split("\n")) {
    const match = /^\s*(--[a-z0-9-]+|color-scheme):\s*([^;]+);/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

describe("tokens.css agrees with tokens.ts", () => {
  const root = block(":root {");
  const darkBySystem = block(':root:not([data-theme="light"])');
  const darkByOverride = block(':root[data-theme="dark"]');

  it("light is the default", () => {
    expect(root.get("color-scheme")).toBe("light");
    for (const token of SEMANTIC_TOKENS) expect(root.get(cssVariable(token)), token).toBe(THEMES.light[token]);
  });

  it.each([
    ["system preference", darkBySystem],
    ["explicit override", darkByOverride],
  ])("dark by %s carries every dark value and nothing else", (_label, declarations) => {
    expect(declarations.get("color-scheme")).toBe("dark");
    for (const token of SEMANTIC_TOKENS) expect(declarations.get(cssVariable(token)), token).toBe(THEMES.dark[token]);
    expect(declarations.size).toBe(SEMANTIC_TOKENS.length + 1);
  });

  it("the dark values live under a media query, so the system decides unless the page says light", () => {
    expect(CSS).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  });

  it("primitives are the manual's neutral and blue scales", () => {
    for (const [step, hex] of Object.entries(NEUTRAL)) expect(root.get(`--wk-neutral-${step}`)).toBe(hex);
    for (const [step, hex] of Object.entries(BLUE)) expect(root.get(`--wk-blue-${step}`)).toBe(hex);
    for (const step of SPACE) expect(root.get(`--wk-space-${String(step)}`)).toBe(`${String(step)}px`);
    for (const [name, px] of Object.entries(RADIUS)) expect(root.get(`--wk-radius-${name}`)).toBe(`${String(px)}px`);
    for (const [name, ms] of Object.entries(DURATION_MS)) expect(root.get(`--wk-duration-${name}`)).toBe(`${String(ms)}ms`);
    for (const [name, curve] of Object.entries(EASING)) expect(root.get(`--wk-ease-${name}`)).toBe(curve);
    for (const [name, stack] of Object.entries(FONT_FAMILY)) expect(root.get(`--wk-font-${name}`)).toBe(stack);
  });

  it("names no color outside the token declarations (no url(), no @import, nothing remote)", () => {
    expect(CSS).not.toMatch(/url\(|@import|https?:/);
  });
});

describe("contrast (manual §3 and §11)", () => {
  for (const theme of THEME_NAMES) {
    for (const { foreground, background, minimum } of CONTRAST_REQUIREMENTS) {
      it(`${theme}: ${foreground} on ${background} ≥ ${String(minimum)}:1`, () => {
        expect(contrastRatio(THEMES[theme][foreground], THEMES[theme][background])).toBeGreaterThanOrEqual(minimum);
      });
    }
    it(`${theme}: status foregrounds read on their own soft backgrounds`, () => {
      for (const status of ["success", "warning", "danger"] as const) {
        expect(contrastRatio(THEMES[theme][`${status}.fg`], THEMES[theme][`${status}.bg`]), status).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(THEMES[theme]["human.text"], THEMES[theme]["human.bg"])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("matches the manual's measured figures within rounding", () => {
    expect(contrastRatio(THEMES.dark["text.primary"], THEMES.dark["bg.canvas"])).toBeCloseTo(19.0, 0);
    expect(contrastRatio(THEMES.light["text.primary"], THEMES.light["bg.canvas"])).toBeCloseTo(19.8, 0);
    expect(contrastRatio(THEMES.dark["text.secondary"], THEMES.dark["bg.canvas"])).toBeCloseTo(7.8, 0);
    expect(contrastRatio(THEMES.light["text.secondary"], THEMES.light["bg.canvas"])).toBeCloseTo(6.7, 0);
    expect(contrastRatio(THEMES.dark["human.dot"], THEMES.dark["bg.canvas"])).toBeCloseTo(5.4, 0);
    expect(contrastRatio(THEMES.light["human.dot"], THEMES.light["bg.canvas"])).toBeCloseTo(3.7, 0);
    expect(contrastRatio(THEMES.light["danger.fg"], THEMES.light["bg.canvas"])).toBeCloseTo(5.6, 0);
  });

  it("text.disabled is documented as below AA in the light theme and is therefore not a reading color", () => {
    expect(contrastRatio(THEMES.light["text.disabled"], THEMES.light["bg.canvas"])).toBeLessThan(4.5);
    expect(CONTRAST_REQUIREMENTS.some((requirement) => requirement.foreground === "text.disabled")).toBe(false);
  });
});

describe("blue stays where the manual puts it (as amended by Amendment 1)", () => {
  // Manual v1.1: a person deciding (human.*), links and focus (interactive.*). Amendment 1 adds active navigation and
  // selection (selection.*) and the brand's own replies (accent.brand-reply). Nothing else may be blue.
  const BLUE_ROLES = (token: string): boolean => token.startsWith("human.") || token.startsWith("interactive.") || token.startsWith("selection.") || token === "accent.brand-reply";

  it("no other token uses a blue step — status colors, surfaces, borders and text never do", () => {
    const blues = new Set<string>([...Object.values(BLUE), THEMES.dark["human.bg"]]);
    for (const theme of THEME_NAMES) {
      for (const token of SEMANTIC_TOKENS) {
        if (BLUE_ROLES(token)) continue;
        expect(blues.has(THEMES[theme][token]), `${theme} ${token}`).toBe(false);
      }
    }
  });

  it("the blue roles are blue, and selection reuses the human surface rather than a new blue", () => {
    const blues = new Set<string>([...Object.values(BLUE), THEMES.dark["human.bg"]]);
    for (const theme of THEME_NAMES) for (const token of SEMANTIC_TOKENS.filter(BLUE_ROLES)) expect(blues.has(THEMES[theme][token]), `${theme} ${token}`).toBe(true);
    for (const theme of THEME_NAMES) expect(THEMES[theme]["selection.bg"]).toBe(THEMES[theme]["human.bg"]);
  });

  it("the dot is Electric Blue in both themes", () => {
    for (const theme of THEME_NAMES) expect(THEMES[theme]["human.dot"]).toBe(BLUE[500]);
  });
});

describe("Amendment 1 (Direction C): new roles reuse approved values only", () => {
  const NEW_ROLES = ["bg.app", "bg.content", "bg.reading", "bg.elevated-hover", "border.input", "selection.bg", "selection.fg", "selection.indicator", "accent.brand-reply"] as const;
  const isNew = (token: string): boolean => (NEW_ROLES as readonly string[]).includes(token);
  // What was approved before the amendment: the two scales and the semantic values of the manual's §3 table.
  const approvedBefore = new Set<string>([...Object.values(NEUTRAL), ...Object.values(BLUE), ...THEME_NAMES.flatMap((theme) => SEMANTIC_TOKENS.filter((token) => !isNew(token)).map((token) => THEMES[theme][token]))]);

  it("every new role is a neutral or blue scale step or an existing semantic value", () => {
    expect(SEMANTIC_TOKENS.filter(isNew)).toEqual([...NEW_ROLES]);
    for (const theme of THEME_NAMES) for (const token of NEW_ROLES) expect(approvedBefore.has(THEMES[theme][token]), `${theme} ${token} ${THEMES[theme][token]}`).toBe(true);
    expect(THEMES.dark["bg.reading"]).toBe(THEMES.dark["bg.hover"]); // the one non-scale value, already approved
  });

  it("surfaces step in both themes: canvas (app) → content → reading are three distinct values", () => {
    for (const theme of THEME_NAMES) expect(new Set([THEMES[theme]["bg.app"], THEMES[theme]["bg.content"], THEMES[theme]["bg.reading"]]).size, theme).toBe(3);
    expect(THEMES.dark["bg.app"]).not.toBe(NEUTRAL[950]); // Dark is charcoal, not black-on-black
  });

  // Perceptibility of a hover fill is not a WCAG requirement (1.4.11 covers boundaries and states needed to identify a
  // control, not hover backgrounds); it is measured here as the CIE L* difference, against the old Dark hover on the
  // old black canvas (ΔL* 9.0) as the design intent.
  const lStar = (hex: string): number => {
    const y = relativeLuminance(hex);
    return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
  };
  const deltaL = (a: string, b: string): number => Math.abs(lStar(a) - lStar(b));

  it("V-1 (7B-17V-VISUAL-AUDIT): a hover on an elevated surface is perceptible in Dark — at least ΔL* 6 on content, raised and reading", () => {
    for (const surface of ["bg.content", "bg.raised", "bg.reading"] as const) expect(deltaL(THEMES.dark["bg.elevated-hover"], THEMES.dark[surface]), surface).toBeGreaterThanOrEqual(6);
    // The defect it replaces: the global hover on the new Dark content surface.
    expect(deltaL(THEMES.dark["bg.hover"], THEMES.dark["bg.content"])).toBeLessThan(3);
    // Light keeps the hover it always had on white.
    expect(THEMES.light["bg.elevated-hover"]).toBe(THEMES.light["bg.hover"]);
  });

  it("V-4: the elevated hover never equals a surface it can be drawn on, in either theme", () => {
    // Elevated surfaces and what sits on them (bg.surface: Disclosure, quiet controls). Not bg.app: navigation on the
    // application canvas hovers with bg.content and never re-points its hover (brand-guards pins the allowed selectors).
    for (const theme of THEME_NAMES) {
      for (const surface of ["bg.content", "bg.raised", "bg.reading", "bg.surface"] as const) {
        expect(THEMES[theme]["bg.elevated-hover"], `${theme} ${surface}`).not.toBe(THEMES[theme][surface]);
      }
    }
    expect(deltaL(THEMES.dark["bg.elevated-hover"], THEMES.dark["bg.surface"])).toBeGreaterThanOrEqual(3);
  });

  it("text and focus keep AA on the elevated hover, and hover never looks like selection in Dark", () => {
    for (const theme of THEME_NAMES) {
      for (const text of ["text.primary", "text.secondary", "text.tertiary"] as const) expect(contrastRatio(THEMES[theme][text], THEMES[theme]["bg.elevated-hover"]), `${theme} ${text}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(THEMES[theme]["interactive.focus"], THEMES[theme]["bg.elevated-hover"])).toBeGreaterThanOrEqual(3);
    }
    expect(deltaL(THEMES.dark["selection.bg"], THEMES.dark["bg.elevated-hover"])).toBeGreaterThanOrEqual(6);
  });

  it("the input border stands out (≥ 3:1, WCAG 1.4.11) from every surface a field can sit on or be filled with", () => {
    for (const theme of THEME_NAMES) {
      for (const surface of ["bg.canvas", "bg.app", "bg.content", "bg.reading", "bg.raised", "bg.surface"] as const) {
        expect(contrastRatio(THEMES[theme]["border.input"], THEMES[theme][surface]), `${theme} border.input on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
    // The old boundary did not: the reason for the amendment.
    for (const theme of THEME_NAMES) expect(contrastRatio(THEMES[theme]["border.strong"], THEMES[theme]["bg.canvas"])).toBeLessThan(3);
  });
});
