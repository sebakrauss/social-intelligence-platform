/**
 * Type scale (UI-1): the CSS module declares one class per approved style with the manual's exact size, line height
 * (as the pixel ratio), weight, family token and letter spacing; `textStyle` reaches every one of them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TYPE_SCALE, type TypeStyle } from "@/ui/foundations/tokens";
import { textStyle } from "@/ui/foundations/typography";

const CSS = readFileSync(path.resolve(import.meta.dirname, "../../../ui/foundations/typography.module.css"), "utf8");
const CLASS_OF: { readonly [K in TypeStyle]: string } = {
  "display-xl": "displayXl",
  "display-l": "displayL",
  "heading-1": "heading1",
  "heading-2": "heading2",
  "heading-3": "heading3",
  "body-l": "bodyL",
  "ui-body": "uiBody",
  "ui-body-s": "uiBodyS",
  "ui-label": "uiLabel",
  "ui-caption": "uiCaption",
  mono: "mono",
  "mono-s": "monoS",
};

function rule(className: string): string {
  const match = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(match?.[1], className).toBeDefined();
  return match?.[1] ?? "";
}

describe("typography.module.css follows the manual's scale", () => {
  for (const [style, spec] of Object.entries(TYPE_SCALE) as [TypeStyle, (typeof TYPE_SCALE)[TypeStyle]][]) {
    it(style, () => {
      const body = rule(CLASS_OF[style]);
      expect(body).toContain(`font: ${String(spec.weight)} ${String(spec.size)}px / calc(${String(spec.lineHeight)} / ${String(spec.size)}) var(--wk-font-${spec.family});`);
      expect(body).toContain(spec.letterSpacing === 0 ? "letter-spacing: 0;" : `letter-spacing: ${String(spec.letterSpacing)}em;`);
    });
  }

  it("Outfit only from 17px up, Inter only below 16px, mono only for data sizes", () => {
    for (const spec of Object.values(TYPE_SCALE)) {
      if (spec.family === "brand") expect(spec.size).toBeGreaterThanOrEqual(17);
      if (spec.family === "ui") expect(spec.size).toBeLessThan(16);
      if (spec.family === "mono") expect(spec.size).toBeLessThanOrEqual(12);
    }
  });

  it("readable text is 13px or more; 11px exists only for captions and mono metadata (manual §11)", () => {
    for (const [style, spec] of Object.entries(TYPE_SCALE)) {
      if (spec.size < 13) expect(["ui-label", "ui-caption", "mono", "mono-s"]).toContain(style);
    }
  });

  it("names no color and nothing remote", () => {
    expect(CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b|url\(|@import/);
  });

  it("textStyle resolves every style to a class", () => {
    for (const style of Object.keys(TYPE_SCALE) as TypeStyle[]) expect(textStyle(style), style).toMatch(/\S/);
  });
});
