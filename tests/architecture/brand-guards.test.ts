/**
 * Brand foundation guards (UI-1; Manual de Marca v1.1). Static, repository-wide: the brand's colors live in one file
 * and everything else reaches them through semantic tokens; the blue is used only where the manual allows it (the
 * logo's dot, the Persona icon, links and focus); the foundations are server-rendered CSS with nothing remote or
 * active in it; the kit assets kept in the repository are exactly the reviewed ones; and the root layout loads the
 * foundations without acquiring any product behavior.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_FILES } from "@/ui/foundations/fonts/manifest";
import { FONT_FILE_VARIABLE } from "@/ui/foundations/tokens";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
/** The only places a brand color may be spelled out. */
const COLOR_SOURCES = new Set(["ui/foundations/tokens.ts", "ui/foundations/tokens.css", "tools/brand/icon-svg.ts"]);
/** The only places the human/brand blue may be referenced. */
const BLUE_USERS = new Set(["ui/foundations/tokens.css", "ui/foundations/tokens.ts", "ui/brand/logo.tsx", "ui/icons/icon.tsx", "ui/primitives/state-pill.module.css"]);

function filesUnder(root: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    const absolute = path.join(REPOSITORY_ROOT, relative);
    if (statSync(absolute).isFile()) {
      if (accept(relative)) out.push(relative);
      return;
    }
    for (const entry of readdirSync(absolute)) walk(path.join(relative, entry));
  };
  walk(root);
  return out.sort();
}

const textOf = (file: string): string => readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");

describe("one source of color", () => {
  it("no hex color appears in app/, ui/ or server/ outside the token files (kit SVG and app icons excepted)", () => {
    const files = [...sourceFiles(["app", "ui", "server"]), ...filesUnder("ui", (file) => file.endsWith(".css")), ...filesUnder("app", (file) => file.endsWith(".css"))];
    for (const file of files) {
      if (COLOR_SOURCES.has(file)) continue;
      expect(codeOf(file), file).not.toMatch(HEX_COLOR);
    }
  });

  it("the blue is referenced only by the logo, the Persona icon, the human state pill and the token files", () => {
    const files = [...sourceFiles(["app", "ui", "server"]), ...filesUnder("ui", (file) => file.endsWith(".css")), ...filesUnder("app", (file) => file.endsWith(".css"))];
    for (const file of files) {
      if (BLUE_USERS.has(file)) continue;
      expect(codeOf(file), file).not.toMatch(/--wk-human-|--wk-blue-|BLUE\[|BLUE\./);
    }
  });

  it("base styles use the interactive tokens for links and focus, never the human ones", () => {
    const base = textOf("ui/foundations/base.css");
    expect(base).toContain("color: var(--wk-interactive-link)");
    expect(base).toMatch(/:focus-visible \{[^}]*outline: var\(--wk-focus-width\) solid var\(--wk-interactive-focus\)/);
    expect(base).not.toContain("--wk-human-");
  });

  it("the focus ring does not depend on :focus-visible support: drawn on :focus, hidden only for pointer focus where supported", () => {
    const base = textOf("ui/foundations/base.css");
    expect(base).toMatch(/\n:focus \{[^}]*outline: var\(--wk-focus-width\) solid var\(--wk-interactive-focus\);[^}]*outline-offset: var\(--wk-focus-offset\);/);
    expect(base).toMatch(/:focus:not\(:focus-visible\) \{\s*outline: none;\s*\}/);
    expect(base).not.toMatch(/\n:focus \{\s*outline: none/);
    expect((base.match(/outline: none/g) ?? []).length).toBe(1);
  });
});

describe("foundations are inert", () => {
  const css = filesUnder("ui", (file) => file.endsWith(".css"));

  it("ships CSS only through ui/foundations, ui/brand and ui/primitives, as plain or module files", () => {
    for (const file of css) expect(file).toMatch(/^ui\/(foundations|brand|primitives)\/[a-z-]+(\.module)?\.css$/);
    expect(filesUnder("ui/primitives", (file) => file.endsWith(".css")).every((file) => file.endsWith(".module.css"))).toBe(true);
  });

  it("no CSS imports anything, fetches anything or carries an expression", () => {
    for (const file of css) expect(textOf(file), file).not.toMatch(/@import|url\(|expression\(|https?:|javascript:/);
  });

  it("the foundation, brand, icon and primitive components are server components", () => {
    for (const file of sourceFiles(["ui/foundations", "ui/brand", "ui/icons", "ui/primitives"])) expect(codeOf(file), file).not.toMatch(/"use client"|from "react-dom"|useState|useEffect|onClick|onChange/);
  });

  it("primitives render native elements and never raw HTML, scripts or inline handlers", () => {
    for (const file of sourceFiles(["ui/primitives"])) expect(codeOf(file), file).not.toMatch(/dangerouslySetInnerHTML|<script|javascript:|on[A-Z][a-z]+=\{/);
  });

  it("nothing in ui/ reaches tools/, server/, platform/ or the database", () => {
    for (const file of sourceFiles(["ui"])) expect(codeOf(file), file).not.toMatch(/from "@\/(tools|server|platform|modules|db|integrations|ai|mutations|jobs)\//);
  });
});

describe("kit assets kept in the repository", () => {
  it("the icon SVGs are the kit's 42, each a single inert <svg>", () => {
    const files = filesUnder("ui/icons/svg", (file) => file.endsWith(".svg"));
    expect(files).toHaveLength(42);
    for (const file of files) {
      const svg = textOf(file);
      expect(file).toMatch(/\/wrenkind_icon_[a-z]+_[a-z]+\.svg$/);
      expect(svg, file).not.toMatch(/<script|<style|<metadata|c2pa|href=|javascript:/i);
      expect(svg, file).toMatch(/^<svg[^>]*stroke="currentColor"[^>]*>[\s\S]*<\/svg>\s*$/);
    }
  });

  it("app icons are the kit's symbol on its dark square, metadata removed", () => {
    const icon = textOf("app/icon.svg");
    expect(icon).not.toMatch(/<metadata|c2pa|<script/i);
    expect(icon).toContain('rx="56"');
    expect(icon).toContain('d="M190.00,128.00 A62,62 0 1 1 128.00,66.00"');
    const png = readFileSync(path.join(REPOSITORY_ROOT, "app/apple-icon.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.includes(Buffer.from("caBX"))).toBe(false);
    expect(png.includes(Buffer.from("c2pa"))).toBe(false);
    expect(png.includes(Buffer.from("tEXt"))).toBe(false);
    expect(png.length).toBeLessThan(10_000);
    const ico = readFileSync(path.join(REPOSITORY_ROOT, "app/favicon.ico"));
    expect(ico.subarray(0, 4).toString("hex")).toBe("00000100");
    expect(ico.includes(Buffer.from("c2pa"))).toBe(false);
  });

  it("the only font binaries are the five in the manifest, each beside its license, none under app/", () => {
    expect(filesUnder("ui", (file) => /\.(woff2?|ttf|otf)$/.test(file))).toEqual([...FONT_FILES.map((font) => font.path)].sort());
    expect(filesUnder("app", (file) => /\.(woff2?|ttf|otf)$/.test(file))).toEqual([]);
    for (const font of FONT_FILES) expect(path.dirname(font.license)).toBe(path.dirname(font.path));
  });

  it("fonts are self-hosted through next/font/local onto the token variables; no font service is ever named", () => {
    const fonts = codeOf("ui/foundations/fonts.ts");
    expect(fonts).toContain('from "next/font/local"');
    for (const font of FONT_FILES) expect(fonts).toContain(`"./${path.relative("ui/foundations", font.path)}"`);
    for (const variable of Object.values(FONT_FILE_VARIABLE)) expect(fonts).toContain(`variable: "${variable}"`);
    expect(fonts).not.toMatch(/variable: "--wk-font-(brand|ui|mono)"/);
    // The public tokens are declared once, in tokens.css, as `var(--wk-font-…-file, "<family>")`: no other stylesheet or
    // loader may set --wk-font-brand / --wk-font-ui / --wk-font-mono, so the cascade order never decides the family.
    const tokens = textOf("ui/foundations/tokens.css");
    expect(tokens).toContain('--wk-font-brand: var(--wk-font-brand-file, "Outfit"), system-ui, sans-serif;');
    expect(tokens).toContain('--wk-font-ui: var(--wk-font-ui-file, "Inter"), system-ui, sans-serif;');
    expect(tokens).toContain('--wk-font-mono: var(--wk-font-mono-file, "JetBrains Mono"), ui-monospace, monospace;');
    const declarers = [...sourceFiles(["app", "ui", "server"]), ...filesUnder("ui", (file) => file.endsWith(".css"))].filter((file) => /--wk-font-(brand|ui|mono):/.test(textOf(file)));
    expect(declarers).toEqual(["ui/foundations/tokens.css"]);
    for (const file of sourceFiles(["app", "ui", "server"])) expect(codeOf(file), file).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|next\/font\/google|@fontsource|typekit|fonts\.bunny/);
  });
});

describe("UI reference page (development only)", () => {
  const page = codeOf("app/dev/ui-reference/page.tsx");

  it("is a 404 outside next dev, indexes nothing, reads no data and offers no action", () => {
    expect(page).toMatch(/const IS_DEVELOPMENT = process\.env\.NODE_ENV === "development";/);
    expect(page).toMatch(/if \(!IS_DEVELOPMENT\) notFound\(\);/);
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(page).not.toMatch(/@\/server\/|@\/platform\/|@\/modules\/|@\/db\/|<form|action=|"use server"|fetch\(/);
    expect((page.match(/process\.env/g) ?? []).length).toBe(1);
  });
});

describe("root layout", () => {
  const layout = codeOf("app/layout.tsx");

  it("loads reset, tokens, base and motion, in that order", () => {
    const order = ["reset.css", "tokens.css", "base.css", "motion.css"].map((file) => layout.indexOf(`@/ui/foundations/${file}`));
    for (const position of order) expect(position).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("stays a shell without data, navigation or client code", () => {
    expect(layout).not.toMatch(/"use client"|@\/server\/|@\/platform\/(?!i18n)|@\/modules\/|fetch\(|cookies\(|headers\(/);
    expect(layout).toContain("themeAttributes(undefined)");
    expect(layout).toContain("className={FONT_CLASS_NAMES}");
  });
});
