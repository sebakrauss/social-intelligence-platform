/**
 * Design tokens (UI-1): the CSS carries exactly the typed values for both themes (light by default, dark under the
 * system preference and under the explicit override), every text and graphic token meets the contrast the manual
 * promises in both themes, the primitives are the manual's scales, and the semantic values that are not in a scale
 * are the known three (bg.hover dark, text.tertiary, human.bg dark).
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

describe("blue stays where the manual puts it", () => {
  it("no status token uses a blue step", () => {
    const blues = new Set<string>(Object.values(BLUE));
    for (const theme of THEME_NAMES) {
      for (const token of SEMANTIC_TOKENS) {
        if (token.startsWith("human.") || token.startsWith("interactive.")) continue;
        expect(blues.has(THEMES[theme][token]), `${theme} ${token}`).toBe(false);
      }
    }
  });

  it("the dot is Electric Blue in both themes", () => {
    for (const theme of THEME_NAMES) expect(THEMES[theme]["human.dot"]).toBe(BLUE[500]);
  });
});
