/**
 * Product UI primitives (UI-2), rendered on the server: native elements with the right semantics and accessible
 * names, the approved tones, no color as the only cue, no hard-coded color, no client code, and nothing that
 * simulates behavior (a pending button is really disabled and busy; a disclosure is a real <details>).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, DataTag, Disclosure, Field, NOTICE_ICON, Notice, OriginMark, PLATFORM_MONOGRAM, StatePill, TextLink } from "@/ui/primitives";

const HEX = /#[0-9a-fA-F]{3,8}\b/;

describe("Button", () => {
  it("is a native button that never submits by accident and carries its variant", () => {
    const markup = renderToStaticMarkup(h(Button, { variant: "primary", children: "Save" }));
    expect(markup).toMatch(/^<button type="button" class="[^"]*button[^"]*primary[^"]*"/);
    expect(markup).toContain(">Save</button>");
    expect(renderToStaticMarkup(h(Button, { type: "submit", variant: "ghost", children: "Go" }))).toContain('type="submit"');
  });

  it("disabled and pending are real: the disabled attribute, aria-busy and the pending label", () => {
    expect(renderToStaticMarkup(h(Button, { disabled: true, children: "Save" }))).toContain(" disabled");
    const pending = renderToStaticMarkup(h(Button, { pending: true, pendingLabel: "Saving…", children: "Save" }));
    expect(pending).toContain(" disabled");
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("Saving…");
    expect(pending).not.toContain(">Save<");
    expect(renderToStaticMarkup(h(Button, { children: "Save" }))).not.toContain("aria-busy");
  });

  it("renders a leading decorative icon and no hex color", () => {
    const markup = renderToStaticMarkup(h(Button, { icon: "util-plus", children: "Add" }));
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("<svg");
    expect(markup).not.toMatch(HEX);
  });
});

describe("TextLink", () => {
  it("is an underlined anchor; external links open safely and say so", () => {
    expect(renderToStaticMarkup(h(TextLink, { href: "/x", children: "Open" }))).toMatch(/^<a href="\/x" class="[^"]*link[^"]*">Open<\/a>$/);
    const external = renderToStaticMarkup(h(TextLink, { href: "https://example.test", external: true, externalLabel: "opens in a new tab", children: "Platform" }));
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer"');
    expect(external).toContain("<svg");
    expect(external).toContain('<span class="wk-sr-only">opens in a new tab</span>');
    expect(renderToStaticMarkup(h(TextLink, { href: "/x", ariaCurrent: "page", children: "Here" }))).toContain('aria-current="page"');
  });
});

describe("Field", () => {
  it("ties label, help and error to the control and marks errors beyond color", () => {
    const markup = renderToStaticMarkup(h(Field, { id: "email", name: "email", label: "Email", type: "email", help: "Only for sign-in", error: "Enter a valid address", required: true }));
    expect(markup).toContain('<label for="email"');
    expect(markup).toMatch(/<input id="email" class="[^"]*" required="" aria-describedby="email-help email-error" aria-invalid="true" type="email" name="email"\/>/);
    expect(markup).toContain('aria-describedby="email-help email-error"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(" required");
    expect(markup).toContain('<p id="email-help"');
    expect(markup).toMatch(/<p id="email-error" class="[^"]*" role="alert"><svg/);
    expect(markup).toContain('type="email"');
    expect(markup).toContain('aria-hidden="true">*</span>');
  });

  it("without help or error it describes nothing and is valid; multiline renders a textarea", () => {
    const plain = renderToStaticMarkup(h(Field, { id: "n", name: "n", label: "Name" }));
    expect(plain).not.toContain("aria-describedby");
    expect(plain).not.toContain("aria-invalid");
    expect(plain).not.toContain(" required");
    const area = renderToStaticMarkup(h(Field, { id: "note", name: "note", label: "Note", multiline: true, rows: 4, defaultValue: "hi" }));
    expect(area).toMatch(/<textarea id="note"[^>]*rows="4"[^>]*>hi<\/textarea>/);
    expect(area).toContain('name="note"');
    expect(renderToStaticMarkup(h(Field, { id: "d", name: "d", label: "D", disabled: true }))).toContain(" disabled");
  });
});

describe("Notice", () => {
  it("has one icon per tone, a live role by choice, and a spoken tone word", () => {
    expect(NOTICE_ICON).toEqual({ info: "conv-comment", success: "decision-approve", warning: "estado-alert", danger: "decision-reject" });
    const polite = renderToStaticMarkup(h(Notice, { tone: "success", title: "Replied", toneLabel: "Success", children: "Published." }));
    expect(polite).toContain('role="status"');
    expect(polite).toContain('<span class="wk-sr-only">Success</span>');
    expect(polite).toContain(">Replied</p>");
    expect(polite).toContain("<svg");
    expect(renderToStaticMarkup(h(Notice, { tone: "danger", live: "assertive", children: "Failed." }))).toContain('role="alert"');
    expect(renderToStaticMarkup(h(Notice, { live: "off", children: "Note." }))).not.toContain("role=");
    for (const tone of ["info", "success", "warning", "danger"] as const) expect(renderToStaticMarkup(h(Notice, { tone, children: "x" }))).not.toMatch(HEX);
  });
});

describe("Disclosure", () => {
  it("is a native details/summary, closed unless asked, with optional mono meta", () => {
    const closed = renderToStaticMarkup(h(Disclosure, { summary: "Earlier versions", meta: "3", children: "body" }));
    expect(closed).toMatch(/^<details class="[^"]*"><summary class="[^"]*">Earlier versions<span class="[^"]*">3<\/span><\/summary><div class="[^"]*">body<\/div><\/details>$/);
    expect(closed).not.toContain(" open");
    expect(renderToStaticMarkup(h(Disclosure, { summary: "S", open: true, children: "b" }))).toMatch(/^<details class="[^"]*" open="">/);
  });
});

describe("StatePill", () => {
  it("is round state: a dot or an icon plus the text; human is the only blue tone", () => {
    const neutral = renderToStaticMarkup(h(StatePill, { children: "Open" }));
    expect(neutral).toMatch(/^<span class="[^"]*pill[^"]*"><span class="[^"]*dot[^"]*" aria-hidden="true"><\/span>Open<\/span>$/);
    expect(neutral).not.toMatch(/human|success|warning|danger/);
    const human = renderToStaticMarkup(h(StatePill, { tone: "human", icon: "decision-human", children: "Needs review" }));
    expect(human).toMatch(/class="[^"]*human/);
    expect(human).toContain("<svg");
    expect(human).toContain("Needs review");
    expect(human).not.toMatch(/class="[^"]*dot/);
    for (const tone of ["success", "warning", "danger"] as const) expect(renderToStaticMarkup(h(StatePill, { tone, children: "x" }))).toMatch(new RegExp(`class="[^"]*${tone}`));
    expect(renderToStaticMarkup(h(StatePill, { tone: "danger", children: "x" }))).not.toMatch(HEX);
  });
});

describe("DataTag", () => {
  it("is square data: text, optional icon, optional mono, border-only tones", () => {
    expect(renderToStaticMarkup(h(DataTag, { children: "Organic" }))).toMatch(/^<span class="[^"]*tag[^"]*">Organic<\/span>$/);
    const icon = renderToStaticMarkup(h(DataTag, { icon: "conv-post", children: "Post" }));
    expect(icon).toContain("<svg");
    expect(icon).toContain("Post");
    expect(renderToStaticMarkup(h(DataTag, { mono: true, children: "12" }))).toMatch(/class="[^"]*mono/);
    expect(renderToStaticMarkup(h(DataTag, { tone: "positive", children: "p" }))).toMatch(/class="[^"]*positive/);
    expect(renderToStaticMarkup(h(DataTag, { tone: "negative", children: "n" }))).toMatch(/class="[^"]*negative/);
  });
});

describe("OriginMark", () => {
  it("uses the manual's monograms for the product's platforms, names the platform for assistive technology, marks paid", () => {
    expect(PLATFORM_MONOGRAM).toEqual({ facebook: "FB", instagram: "IG", tiktok: "TT" });
    const ig = renderToStaticMarkup(h(OriginMark, { platform: "instagram", name: "Instagram" }));
    expect(ig).toContain('aria-hidden="true">IG</span>');
    expect(ig).toContain('<span class="wk-sr-only">Instagram</span>');
    expect(ig).not.toContain("AD");
    const paid = renderToStaticMarkup(h(OriginMark, { platform: "facebook", name: "Facebook", paid: true, paidLabel: "Ad", showName: true }));
    expect(paid).toContain('aria-hidden="true">FB</span>');
    expect(paid).toMatch(/<span class="[^"]*name[^"]*">Facebook<\/span>/);
    expect(paid).toContain('aria-hidden="true">AD</span>');
    expect(paid).toContain('<span class="wk-sr-only">Ad</span>');
    const unknown = renderToStaticMarkup(h(OriginMark, { platform: "unknown", name: "Unknown platform" }));
    expect(unknown).toMatch(/class="[^"]*unknown[^"]*" aria-hidden="true">–<\/span>/);
    expect(unknown).not.toMatch(HEX);
  });
});
