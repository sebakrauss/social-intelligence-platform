/**
 * Logo (UI-1): the four approved pieces render with the kit's viewBoxes and geometry (Loop arc, dot, letters, the V3
 * cut only where the manual puts it), the tones map to the kit's color and one-tint variants through tokens (never a
 * hex), and the image is decorative unless titled.
 */
import { Fragment, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LOGO_VIEW_BOX, Logo, type LogoVariant } from "@/ui/brand/logo";
import { WORDMARK_PATH } from "@/ui/brand/wordmark-path";

const VARIANTS: readonly LogoVariant[] = ["lockup", "wordmark", "wordmark-small", "symbol"];
const LOOP_ARC = 'd="M190.00,128.00 A62,62 0 1 1 128.00,66.00"';

describe("<Logo>", () => {
  it("uses the kit's viewBox for each piece", () => {
    expect(LOGO_VIEW_BOX).toEqual({ lockup: "-20 -790 5115 830", wordmark: "-20 -790 4125 830", "wordmark-small": "-20 -790 4125 830", symbol: "0 0 256 256" });
    for (const variant of VARIANTS) expect(renderToStaticMarkup(h(Logo, { variant: variant }))).toContain(`viewBox="${LOGO_VIEW_BOX[variant]}"`);
  });

  it("the Loop appears in the lockup and the symbol, the letters in the lockup and both wordmarks", () => {
    const markup = Object.fromEntries(VARIANTS.map((variant) => [variant, renderToStaticMarkup(h(Logo, { variant: variant }))]));
    expect(markup["lockup"]).toContain(LOOP_ARC);
    expect(markup["symbol"]).toContain(LOOP_ARC);
    expect(markup["wordmark"]).not.toContain(LOOP_ARC);
    expect(markup["wordmark-small"]).not.toContain(LOOP_ARC);
    for (const variant of ["lockup", "wordmark", "wordmark-small"] as const) expect(markup[variant]).toContain(`d="${WORDMARK_PATH}"`);
    expect(markup["symbol"]).not.toContain(WORDMARK_PATH.slice(0, 40));
    expect(markup["lockup"]).toContain('transform="translate(-251.7,-993.2) scale(4.9351)"');
    expect(markup["lockup"]).toContain('transform="translate(990,0)"');
  });

  it("only V3 (wordmark and lockup) carries the cut in the k; the small wordmark is V2", () => {
    const cut = /<mask id="[^"]+" maskUnits="userSpaceOnUse" x="-50" y="-900" width="4185" height="1100">.*<rect x="2406.0" y="-503" width="34" height="523" fill="black">/;
    expect(renderToStaticMarkup(h(Logo, { variant: "wordmark" }))).toMatch(cut);
    expect(renderToStaticMarkup(h(Logo, { variant: "lockup" }))).toMatch(cut);
    expect(renderToStaticMarkup(h(Logo, { variant: "wordmark-small" }))).not.toContain("<mask");
    expect(renderToStaticMarkup(h(Logo, { variant: "symbol" }))).not.toContain("<mask");
  });

  it("color tone: letters and Loop in currentColor on the theme text color, dot in the human token", () => {
    const markup = renderToStaticMarkup(h(Logo, { variant: "lockup" }));
    expect(markup).toContain('fill="var(--wk-human-dot)"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).toMatch(/class="[^"]*color/);
  });

  it("mono tone: everything in currentColor, nothing blue, no color class", () => {
    for (const variant of VARIANTS) {
      const markup = renderToStaticMarkup(h(Logo, { variant: variant, tone: "mono" }));
      expect(markup, variant).not.toContain("--wk-human-dot");
      expect(markup, variant).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(markup, variant).not.toMatch(/class="[^"]*color/);
      expect((markup.match(/currentColor/g) ?? []).length, variant).toBeGreaterThanOrEqual(2);
    }
  });

  it("is decorative without a title and an image with one", () => {
    expect(renderToStaticMarkup(h(Logo, { variant: "symbol" }))).toContain('aria-hidden="true"');
    const titled = renderToStaticMarkup(h(Logo, { variant: "lockup", title: "wrenkind" }));
    expect(titled).toContain('role="img"');
    expect(titled).toContain("<title>wrenkind</title>");
    expect(titled).not.toContain("aria-hidden");
  });

  it("two logos on one page get distinct mask ids", () => {
    const markup = renderToStaticMarkup(h(Fragment, {}, h(Logo, { variant: "wordmark" }), h(Logo, { variant: "wordmark" })));
    const ids = [...markup.matchAll(/<mask id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
