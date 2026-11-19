// @vitest-environment happy-dom
/**
 * COMMENTS-UX-07B — the approved usability refinements in the Comments prototype (development only, synthetic data):
 * - the open conversation lives in the address, so the browser's Back and Forward move between the list and the
 *   conversations opened — and the page never mistakes its own address changes for them;
 * - a new (simulated) reply never moves the reader;
 * - arrows move, chevrons open: ← to a named destination, ↑ ↓ previous / next, one close (×) for Details;
 * - refined scroll model C in the stylesheet: the page scrolls (no inner scroll in the main column or the thread), the
 *   list sticks with its own scroll that never contains the wheel, the header sticks and keeps focus clear of it;
 *   below 1024 px one panel and natural page scroll.
 * Layout itself (sticky, wheel, real focus scrolling) is verified in a browser; here: behavior and the rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsRedesign } from "@/app/dev/ui-reference/comments-redesign/prototype";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The address as the App Router would hold it: pushes and replacements apply at once (unless held back). */
const nav = vi.hoisted(() => ({ search: "", pushes: [] as string[], replaces: [] as string[], held: [] as string[], hold: false }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      nav.pushes.push(href);
      if (nav.hold) nav.held.push(href);
      else nav.search = href.split("?")[1] ?? "";
    },
    replace: (href: string) => {
      nav.replaces.push(href);
      nav.search = href.split("?")[1] ?? "";
    },
  }),
  usePathname: () => "/dev/ui-reference/comments-redesign",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const ROOT = path.resolve(__dirname, "../../..");
const DIR = path.join(ROOT, "app/dev/ui-reference/comments-redesign");
const css = readFileSync(path.join(DIR, "prototype.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const source = readFileSync(path.join(DIR, "prototype.tsx"), "utf8");

let container: HTMLElement;
let root: Root | undefined;

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}
/** The browser moved through its history: the address changes, the page renders again. */
async function browse(search: string): Promise<void> {
  nav.search = search;
  await settle(() => { root?.render(h(CommentsRedesign)); });
}
const q = (selector: string, scope: ParentNode = container): HTMLElement => {
  const found = scope.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`not found: ${selector}`);
  return found;
};
const text = (element: Element): string => element.textContent.replace(/\s+/g, " ").trim();
const named = (button: HTMLButtonElement): string => text(button);
const buttonNamed = (scope: ParentNode, name: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((button) => named(button).startsWith(name));
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};
const row = (id: string): HTMLButtonElement => q(`#row-${id}`) as HTMLButtonElement;
const pane = (id: string): HTMLElement => q(`#focus-${id}`);
const selectedRow = (): Element | null => container.querySelector("[aria-current=true][id^=row-]");
const active = (): Element | null => container.ownerDocument.activeElement;
const click = (element: HTMLElement): Promise<void> => settle(() => { element.click(); });
const listed = (): string[] => [...container.querySelectorAll<HTMLButtonElement>("[id^=row-]")].map((button) => button.id.slice(4));
/** The body of a CSS rule whose selector is exactly this, outside or inside the <1024 px block. */
function rule(selector: string, scope: "desktop" | "tablet" = "desktop"): string {
  const start = css.indexOf("@media (max-width: 1023px)");
  const block = scope === "desktop" ? css.slice(0, start) : css.slice(start, css.indexOf("@media (max-width: 639px)"));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(block);
  if (found === null) throw new Error(`no rule ${selector} (${scope})`);
  return found[1] ?? "";
}

beforeEach(async () => {
  nav.search = "";
  nav.pushes = [];
  nav.replaces = [];
  nav.held = [];
  nav.hold = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await settle(() => { root?.render(h(CommentsRedesign)); });
  // UX-08B: the page opens on Open (the approved Phase 1 landing; see comments-redesign-ux08b.test.ts). These scenarios
  // were written in Needs attention and start there, chosen in the sidebar as a person would.
  await click(buttonNamed(q('nav[aria-label="Comments views"]'), "Needs attention"));
  nav.pushes = [];
  nav.replaces = [];
});

afterEach(async () => {
  await settle(() => { root?.unmount(); });
  container.remove();
});

describe("the open conversation is in the address: Back and Forward behave as on the product's routes", () => {
  it("opening a conversation and moving with Previous / Next each add a step; the list is the address without one", async () => {
    const [first, second] = listed();
    await click(row(first ?? ""));
    expect(nav.search).toBe(`conversation=${first ?? ""}`);
    await click(q('[data-nav="next"]', pane(first ?? "")));
    expect(nav.search).toBe(`conversation=${second ?? ""}`);
    expect(nav.pushes).toEqual([`/dev/ui-reference/comments-redesign?conversation=${first ?? ""}`, `/dev/ui-reference/comments-redesign?conversation=${second ?? ""}`]);
    await click(buttonNamed(pane(second ?? ""), "Back to Needs attention"));
    expect(nav.search).toBe("");
    expect(nav.pushes.at(-1)).toBe("/dev/ui-reference/comments-redesign");
  });

  it("browser Back returns to the conversation before, then to the list with focus on its row; Forward opens it again", async () => {
    const [first, second] = listed();
    await click(row(first ?? ""));
    await click(row(second ?? ""));
    await browse(`conversation=${first ?? ""}`);
    expect(selectedRow()?.id).toBe(`row-${first ?? ""}`);
    expect(container.querySelector(`#focus-${first ?? ""}`)).not.toBeNull();
    await browse("");
    expect(selectedRow()).toBeNull();
    expect(container.querySelector("[class*=splitActive]")).toBeNull();
    expect(active()).toBe(row(first ?? ""));
    await browse(`conversation=${first ?? ""}`);
    expect(selectedRow()?.id).toBe(`row-${first ?? ""}`);
    // Following the address never writes it again.
    expect(nav.pushes).toHaveLength(2);
  });

  it("a conversation named in the address opens when the page loads (a reload keeps it)", async () => {
    await settle(() => { root?.unmount(); });
    nav.search = "conversation=cv-10";
    root = createRoot(container);
    await settle(() => { root?.render(h(CommentsRedesign)); });
    expect(selectedRow()?.id).toBe("row-cv-10");
    expect(nav.pushes).toEqual([]);
  });

  it("the page's own address changes are never taken for Back: quick clicks whose addresses arrive late keep the last choice", async () => {
    const [first, second] = listed();
    nav.hold = true;
    await click(row(first ?? ""));
    await click(row(second ?? ""));
    expect(nav.held).toHaveLength(2);
    // UX-10: the App Router discards a pending navigation when a newer one starts (Next 16.4.5,
    // client/components/app-router-instance.js: "Mark the pending action as discarded (so the state is never applied)"),
    // and writes the history entry only when a navigation commits — so the first address never arrives; the second does.
    // (Until UX-10 this test delivered both, in order: a sequence that router cannot produce.)
    await browse((nav.held[1] ?? "").split("?")[1] ?? "");
    expect(selectedRow()?.id).toBe(`row-${second ?? ""}`);
    expect(container.querySelector(`#focus-${second ?? ""}`)).not.toBeNull();
    // The page's own address coming back is not followed as a Back: nothing is written again.
    expect(nav.pushes).toHaveLength(2);
    expect(nav.replaces).toHaveLength(0);
  });

  it("a filter that clears the selection replaces the address instead of adding a step", async () => {
    await click(row("cv-10"));
    const search = q('input[type="search"], input[placeholder^="Search"]') as HTMLInputElement;
    await settle(() => {
      Reflect.set(Object.getPrototypeOf(search) as object, "value", "zzzz no match", search);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(selectedRow()).toBeNull();
    expect(nav.replaces.at(-1)).toBe("/dev/ui-reference/comments-redesign");
    expect(nav.search).toBe("");
  });
});

describe("a new (simulated) reply never moves the reader", () => {
  it("the arrival scrolls nothing and takes no focus; the reply joins the end of the thread", async () => {
    await click(row("cv-10"));
    const before = q('ol[aria-label="Comments and replies"]', pane("cv-10")).querySelectorAll("article").length;
    const heading = q("#pane-cv-10");
    heading.focus();
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const arrive = buttonNamed(container, "Simulate a new reply from");
    await settle(() => { arrive.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(scrolled).not.toHaveBeenCalled();
    scrolled.mockRestore();
    expect(q('ol[aria-label="Comments and replies"]', pane("cv-10")).querySelectorAll("article").length).toBe(before + 1);
    expect(active()).toBe(heading);
  });
});

describe("arrows move, chevrons open", () => {
  it("Back is an arrow and its destination; Previous / Next are up and down arrows with their names", async () => {
    await click(row("cv-10"));
    const back = buttonNamed(pane("cv-10"), "Back to Needs attention");
    expect(back.querySelector("path")?.getAttribute("d")).toBe("M13 8H3");
    expect(q('[data-nav="previous"]', pane("cv-10")).querySelector("path")?.getAttribute("d")).toBe("M8 13V3");
    expect(q('[data-nav="next"]', pane("cv-10")).querySelector("path")?.getAttribute("d")).toBe("M8 3v10");
    expect(q('[data-nav="next"]', pane("cv-10")).getAttribute("aria-label")).toBe("Next conversation");
    expect(q('[data-nav="previous"]', pane("cv-10")).getAttribute("title")).toBe("Previous conversation");
  });

  it("no left chevron remains: the glyph is gone from the prototype", () => {
    expect(source).not.toMatch(/chevronLeft/);
    expect(source).toMatch(/arrowLeft: \["M13 8H3", "M7 4L3 8l4 4"\]/);
  });

  it("Details has one close (× or Esc) — no second 'Conversation' back beside it", async () => {
    await click(row("cv-10"));
    await click(q("#time-cv-10-m00"));
    const drawer = q('[role="dialog"]', pane("cv-10"));
    expect([...drawer.querySelectorAll(".drawerHead button, [class*=drawerHead] button")].map((button) => button.getAttribute("aria-label") ?? text(button))).toEqual(["Close details"]);
    expect(text(drawer)).not.toMatch(/^Conversation/);
  });

  it("the disclosure chevron turns when open; the choice chevron trails Assign, Mark done, Labels, (UX-08A) the period and (UX-08B) the toolbar's selects", () => {
    expect(css).toMatch(/\.capabilityDisclosure\[open\] > \.disclosureSummary > \.glyph:first-child \{\s*transform: rotate\(90deg\);/);
    expect((source.match(/<Glyph name="chevronDown" \/>/g) ?? []).length).toBe(5);
  });
});

describe("refined model C in the stylesheet", () => {
  it("≥1024 px: the main column is not a scroller; the page is", () => {
    const main = rule(".main");
    expect(main).not.toMatch(/overflow/);
    expect(main).not.toMatch(/(^|\s)height: 100dvh/);
    expect(main).toMatch(/min-height: 100dvh/);
    expect(rule(".paneBody")).not.toMatch(/overflow/);
  });

  it("≥1024 px: the list sticks with its own scroll and never contains the wheel; the header sticks; Details hangs under it", () => {
    const list = rule(".listColumn");
    for (const declaration of ["position: sticky", "top: 0", "align-self: start", "max-height: 100dvh", "overflow-y: auto"]) expect(list).toContain(declaration);
    expect(css).not.toMatch(/overscroll-behavior/);
    expect(rule(".paneHead")).toMatch(/position: sticky;\s*top: 0;/);
    expect(rule(".drawer")).toMatch(/top: 100%;[\s\S]*height: calc\(100dvh - 100%\)/);
    // Anything scrolled into view in the thread stops below the measured header.
    expect(rule(".split .paneBody *")).toContain("scroll-margin-top: calc(var(--pane-head, 0px) + var(--wk-space-16))");
    expect(source).toMatch(/style\.setProperty\("--pane-head", `\$\{String\(head\.offsetHeight\)\}px`\)/);
  });

  it("<1024 px: one panel, natural page scroll — the list flows, the header does not stick", () => {
    expect(rule(".listColumn", "tablet")).toMatch(/position: static;\s*max-height: none;\s*overflow: visible;/);
    expect(rule(".paneHead", "tablet")).toMatch(/position: relative;/);
    expect(rule(".main", "tablet")).toMatch(/overflow: visible;/);
    expect(rule(".splitActive .listColumn", "tablet")).toMatch(/display: none;/);
  });
});
