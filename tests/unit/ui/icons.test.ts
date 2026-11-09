/**
 * Brand icons (UI-1): the generated catalog is exactly what the kit SVGs in ui/icons/svg say (the reader refuses any
 * unexpected element, attribute or color), the manual's 42 icons in six families are all there, only Persona carries
 * the blue dot, and the component renders them decorative by default, labelled on request, with the manual's stroke
 * widths per size and never a hard-coded color.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readIconDirectory, readIconSvg, renderIconCatalog } from "@/tools/brand/icon-svg";
import { ICONS, ICON_NAMES } from "@/ui/icons/catalog";
import { Icon, strokeWidthFor } from "@/ui/icons/icon";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SVG_DIRECTORY = path.join(ROOT, "ui/icons/svg");
const CATALOG = readFileSync(path.join(ROOT, "ui/icons/catalog.ts"), "utf8");
const SOURCE_NOTE = "Source: Wrenkind brand kit v1.1 (2026-10-09), 03-iconos/svg, 42 icons on a 24px grid, stroke 1.75, round caps.";

describe("catalog", () => {
  const icons = readIconDirectory(SVG_DIRECTORY);

  it("is generated from the SVGs and in sync", () => {
    expect(renderIconCatalog(icons, SOURCE_NOTE)).toBe(CATALOG);
  });

  it("holds the manual's 42 icons in six families", () => {
    expect(ICON_NAMES).toHaveLength(42);
    const families = new Map<string, number>();
    for (const name of ICON_NAMES) families.set(name.split("-")[0] ?? "", (families.get(name.split("-")[0] ?? "") ?? 0) + 1);
    expect(Object.fromEntries(families)).toEqual({ nav: 8, conv: 7, decision: 7, estado: 6, sentimiento: 3, util: 11 });
  });

  it("only Persona carries the blue dot", () => {
    const withColor = ICON_NAMES.filter((name) => ICONS[name].shapes.some((shape) => shape.kind === "circle" && shape.fill === "human"));
    expect(withColor).toEqual(["decision-human"]);
    expect(CATALOG).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("every icon keeps the manual's 1.75 stroke except Más, whose three dots are strokes of width 3", () => {
    const deviating = ICON_NAMES.filter((name) => ICONS[name].strokeWidth !== undefined);
    expect(deviating).toEqual(["util-more"]);
    expect(ICONS["util-more"].strokeWidth).toBe(3);
  });

  it("the reader refuses what the kit never ships", () => {
    const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><title>X</title><path d="M3 3h18"/></svg>';
    expect(readIconSvg("wrenkind_icon_util_x.svg", ok).shapes).toEqual([{ kind: "path", d: "M3 3h18" }]);
    expect(() => readIconSvg("wrenkind_icon_util_x.svg", ok.replace("<title>X</title>", "<script>1</script>"))).toThrow(/active/);
    expect(() => readIconSvg("wrenkind_icon_util_x.svg", ok.replace("<title>X</title>", "<polygon points=\"0,0 2,2\"/>"))).toThrow(/other than/);
    expect(() => readIconSvg("wrenkind_icon_util_x.svg", ok.replace('<path d="M3 3h18"/>', '<path d="M3 3h18" fill="#FF0000"/>'))).toThrow(/plain d/);
    expect(() => readIconSvg("wrenkind_icon_util_x.svg", ok.replace('<path d="M3 3h18"/>', '<circle cx="1" cy="1" r="1" fill="#FF0000" stroke="none"/>'))).toThrow(/Persona dot/);
    expect(readIconSvg("wrenkind_icon_util_x.svg", ok.replace('stroke-width="1.75"', 'stroke-width="2"')).strokeWidth).toBe(2);
    expect(() => readIconSvg("wrenkind_icon_util_x.svg", ok.replace('stroke-width="1.75"', 'stroke-width="9"'))).toThrow(/out of range/);
    expect(() => readIconSvg("other.svg", ok)).toThrow(/file name/);
  });
});

describe("<Icon>", () => {
  it("is decorative by default and an image when labelled", () => {
    const plain = renderToStaticMarkup(h(Icon, { name: "nav-inbox" }));
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain("<title>");
    expect(plain).not.toContain("role=");
    const labelled = renderToStaticMarkup(h(Icon, { name: "nav-inbox", label: "Inbox" }));
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain("<title>Inbox</title>");
    expect(labelled).not.toContain("aria-hidden");
  });

  it("uses the manual's stroke per size (1.5 at 16, 1.75 at 20 and 24, 2 at 32)", () => {
    expect(strokeWidthFor(16)).toBe(1.5);
    expect(strokeWidthFor(20)).toBe(1.75);
    expect(strokeWidthFor(24)).toBe(1.75);
    expect(strokeWidthFor(32)).toBe(2);
    expect(renderToStaticMarkup(h(Icon, { name: "util-search", size: 16 }))).toContain('stroke-width="1.5"');
    expect(renderToStaticMarkup(h(Icon, { name: "util-search", size: 32 }))).toContain('width="32" height="32"');
    expect(renderToStaticMarkup(h(Icon, { name: "util-more", size: 20 }))).toContain('stroke-width="3"');
    expect(renderToStaticMarkup(h(Icon, { name: "util-more", size: 16 }))).toContain('stroke-width="2.57"');
  });

  it("takes currentColor; the Persona dot is the human token, never a hex", () => {
    for (const name of ICON_NAMES) {
      const markup = renderToStaticMarkup(h(Icon, { name: name }));
      expect(markup, name).toContain('stroke="currentColor"');
      expect(markup, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(markup, name).not.toMatch(/<script|on[a-z]+=/i);
    }
    expect(renderToStaticMarkup(h(Icon, { name: "decision-human" }))).toContain('fill="var(--wk-human-dot)"');
    expect(renderToStaticMarkup(h(Icon, { name: "decision-assign" }))).not.toContain("--wk-human-dot");
  });
});
