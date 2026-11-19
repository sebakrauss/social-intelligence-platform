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

describe("Manual v1.1 Amendment 1 (Direction C, PO-approved 2026-11-17): the new blues and surfaces stay in their roles", () => {
  const css = [...filesUnder("ui", (file) => file.endsWith(".css")), ...filesUnder("app", (file) => file.endsWith(".css"))];
  const NEW_BLUES = /--wk-selection-|--wk-accent-brand-reply/;
  /** Where active navigation, a selected conversation and the brand's own replies are drawn. */
  // COMMENTS-INT-03A adds ui/inbox/comments.module.css: the redesigned Comments list (the selected conversation only).
  // COMMENTS-UX-07A adds the development-only scroll comparison (the selected row and the brand's own replies only).
  const SELECTION_USERS = new Set(["ui/foundations/tokens.css", "ui/shell/app-shell.module.css", "ui/inbox/inbox.module.css", "ui/inbox/comments.module.css", "app/dev/ui-reference/comments-redesign/prototype.module.css", "app/dev/ui-reference/comments-scroll/comparison.module.css"]);
  /** The CSS rules (selector → body) of a stylesheet, comments removed. */
  const rulesOf = (file: string): { readonly selector: string; readonly body: string }[] =>
    [...codeOf(file).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" }));

  it("selection and brand-reply blues are used only by navigation, the conversation list and the Comments reference", () => {
    for (const file of [...css, ...sourceFiles(["app", "ui", "server"])]) {
      if (SELECTION_USERS.has(file)) continue;
      expect(codeOf(file), file).not.toMatch(NEW_BLUES);
    }
  });

  it("selection never marks a label, an assessment, a priority, a status or a tag (selection is not urgency or meaning)", () => {
    for (const file of [...SELECTION_USERS].filter((file) => file.endsWith(".module.css"))) {
      for (const rule of rulesOf(file)) {
        if (!NEW_BLUES.test(rule.body)) continue;
        expect(rule.selector, `${file}: ${rule.selector}`).not.toMatch(/chip|label|tag|assessment|priority|pill|status|state|badge|marker/i);
      }
    }
    // The label and status primitives stay on neutral and status tokens.
    for (const file of ["ui/primitives/data-tag.module.css", "ui/primitives/state-pill.module.css"]) expect(codeOf(file), file).not.toMatch(NEW_BLUES);
  });

  /**
   * 7B-17V-VISUAL-FIX V-4: the one token re-declaration allowed outside tokens.css — an elevated surface re-pointing
   * its hover to the elevated-hover role — and ONLY at these root selectors. Anything else (another token, another
   * value, another selector, another file) fails.
   */
  const ELEVATED_HOVER_ROOTS = new Set([
    "ui/shell/app-shell.module.css .main",
    "ui/shell/app-shell.module.css .panel",
    "ui/inbox/inbox.module.css .workspace",
    "app/dev/ui-reference/comments-redesign/prototype.module.css .list",
    "app/dev/ui-reference/comments-redesign/prototype.module.css .split",
    "app/dev/ui-reference/comments-redesign/prototype.module.css .popover",
  ]);

  it("design tokens are declared only in tokens.css — except the elevated-hover re-point, at the approved root selectors only", () => {
    const seen = new Set<string>();
    for (const file of css) {
      if (file === "ui/foundations/tokens.css") continue;
      for (const rule of rulesOf(file)) {
        const declarations = [...rule.body.matchAll(/(--wk-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => `${m[1] ?? ""}: ${(m[2] ?? "").trim()}`);
        for (const declaration of declarations) {
          const where = `${file} ${rule.selector}`;
          expect(declaration, where).toBe("--wk-bg-hover: var(--wk-bg-elevated-hover)");
          expect(ELEVATED_HOVER_ROOTS.has(where), `${where} is not an approved elevated-surface root`).toBe(true);
          seen.add(where);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ELEVATED_HOVER_ROOTS].sort());
  });

  it("the active rail item carries a shape indicator in selection.indicator, not only a color (V-2)", () => {
    for (const file of ["ui/shell/app-shell.module.css", "app/dev/ui-reference/comments-redesign/prototype.module.css"]) {
      const bar = rulesOf(file).find((rule) => rule.selector === '.railItem[aria-current="page"]::before');
      expect(bar?.body, file).toMatch(/content: ""/);
      expect(bar?.body, file).toMatch(/background: var\(--wk-selection-indicator\)/);
      expect(bar?.body, file).toMatch(/width: 3px/);
    }
  });

  it("nothing inside the reading area is painted with the black canvas (V-3): composer, preview, context box, sticky bar", () => {
    const composer = rulesOf("ui/inbox/reply-composer.module.css");
    for (const selector of [".composer", ".textarea", ".preview"]) expect(composer.find((rule) => rule.selector === selector)?.body, selector).not.toMatch(/--wk-bg-canvas/);
    const inbox = rulesOf("ui/inbox/inbox.module.css");
    for (const selector of [".contextBox", ".replySlot a", ".conversationNav"]) for (const rule of inbox.filter((item) => item.selector === selector)) expect(rule.body, selector).not.toMatch(/--wk-bg-canvas/);
  });

  it("a secondary button (itself a raised surface) hovers with the elevated hover; an invalid field keeps its error border on hover", () => {
    const button = rulesOf("ui/primitives/button.module.css").find((rule) => rule.selector === ".secondary:hover:not(:disabled)");
    expect(button?.body).toMatch(/background: var\(--wk-bg-elevated-hover\)/);
    const invalid = rulesOf("ui/primitives/field.module.css").find((rule) => rule.selector.includes(".invalid:hover:not(:disabled)"));
    expect(invalid?.body).toMatch(/border-color: var\(--wk-danger-fg\)/);
  });

  it("text fields draw their boundary with border.input (WCAG 1.4.11), never the quiet borders", () => {
    const field = rulesOf("ui/primitives/field.module.css").find((rule) => rule.selector === ".control");
    expect(field?.body).toMatch(/border: 1px solid var\(--wk-border-input\)/);
    const composer = rulesOf("ui/inbox/reply-composer.module.css").find((rule) => rule.selector === ".textarea");
    expect(composer?.body).toMatch(/border: 1px solid var\(--wk-border-input\)/);
    const prototype = rulesOf("app/dev/ui-reference/comments-redesign/prototype.module.css").find((rule) => /\.input,\s*\.select,\s*\.textarea/.test(rule.selector));
    expect(prototype?.body).toMatch(/border: 1px solid var\(--wk-border-input\)/);
  });

  it("the page canvas is the application canvas, and the shell separates navigation (bg.app) from content (bg.content)", () => {
    expect(textOf("ui/foundations/base.css")).toMatch(/html \{\s*background: var\(--wk-bg-app\)/);
    const shell = rulesOf("ui/shell/app-shell.module.css");
    for (const selector of [".rail", ".sidebar"]) expect(shell.find((rule) => rule.selector === selector)?.body, selector).toMatch(/background: var\(--wk-bg-app\)/);
    expect(shell.find((rule) => rule.selector === ".main")?.body).toMatch(/background: var\(--wk-bg-content\)/);
  });
});

describe("foundations are inert", () => {
  const css = filesUnder("ui", (file) => file.endsWith(".css"));

  it("ships CSS only through ui/foundations, ui/brand and ui/primitives, as plain or module files", () => {
    for (const file of css) expect(file).toMatch(/^ui\/(foundations|brand|primitives|shell|inbox)\/[a-z-]+(\.module)?\.css$/);
    expect([...filesUnder("ui/primitives", (file) => file.endsWith(".css")), ...filesUnder("ui/shell", (file) => file.endsWith(".css")), ...filesUnder("ui/inbox", (file) => file.endsWith(".css"))].every((file) => file.endsWith(".module.css"))).toBe(true);
  });

  it("no CSS imports anything, fetches anything or carries an expression", () => {
    for (const file of css) expect(textOf(file), file).not.toMatch(/@import|url\(|expression\(|https?:|javascript:/);
  });

  /**
   * Step 7B-3: the contextual reply composer — pinned below with its own rule. Step 7B-15H: + the signed-out boundary that
   * clears the composer's in-memory drafts (one effect; pinned in tests/architecture/inbox-composer-guards.test.ts).
   * Step 7B-17K: + the drafts' conversation boundary (one effect; pinned there too). The in-app link lives outside these
   * folders (ui/navigation/app-link.tsx) and is pinned there as well.
   */
  // COMMENTS-INT-03B-FIX: + the Comments list column (one layout effect on its own scroll; pinned in inbox-composer-guards).
  const CLIENT_COMPONENTS = ["ui/inbox/comments-list-column.tsx", "ui/inbox/reply-composer.tsx", "ui/inbox/reply-drafts-boundary.tsx", "ui/inbox/reply-drafts-scope.tsx"];

  it("the foundation, brand, icon and primitive components are server components", () => {
    for (const file of sourceFiles(["ui/foundations", "ui/brand", "ui/icons", "ui/primitives", "ui/shell", "ui/inbox"]).filter((file) => !CLIENT_COMPONENTS.includes(file))) {
      // No client directive, hook or BOUND handler (a primitive may forward an optional `onClick` prop for client components).
      expect(codeOf(file), file).not.toMatch(/["']use client["']|from "react-dom"|useState|useEffect|onClick=\{|onChange=\{/);
    }
    expect(codeOf("ui/primitives/button.tsx")).not.toMatch(/onClick=\{|useState|"use client"/);
  });

  it("the reply composer is the only client component: labels from props, a type-only import of the action's state, no fetch, no raw HTML, no catalog, no persistence", () => {
    const composer = codeOf("ui/inbox/reply-composer.tsx");
    expect(composer).toMatch(/^"use client";/);
    const imports = [...composer.matchAll(/^import (type )?\{[^}]*\} from "([^"]+)";/gm)].map((m) => [m[1] === undefined ? "value" : "type", m[2] ?? ""] as const);
    expect(imports.filter(([, from]) => from.startsWith("@/server/"))).toEqual([["type", "@/server/inbox/reply-state"]]);
    expect(imports.filter(([, from]) => /^@\/(tools|platform|modules|db|integrations|ai|mutations|jobs)\//.test(from))).toEqual([]);
    expect(composer).not.toMatch(/dangerouslySetInnerHTML|<script|javascript:|fetch\(|\bt\(|@\/server\/i18n|process\.env/);
    // No persistence (Step 7B-15H made this title true): no web storage, cookie or URL write; the full syntax-tree rule for
    // every client module is in tests/architecture/inbox-composer-guards.test.ts.
    expect(composer).not.toMatch(/localStorage|sessionStorage|indexedDB|cookie|history\.|location\.|globalThis/);
    // Only the review stage posts; the hidden field is the same state string the review shows.
    expect(composer).toMatch(/<form action=\{formAction\}/);
    expect([...composer.matchAll(/<form/g)]).toHaveLength(1);
    expect(composer).toMatch(/<blockquote className=\{styles\["preview"\]\}>\{text\}<\/blockquote>/);
    expect(composer).toMatch(/<input type="hidden" name="text" value=\{text\} \/>/);
    // Step 7B-14I2: + ONE optional mode flag for an operator-authorized validation reply — a constant "1", never an identifier.
    expect([...composer.matchAll(/<input type="hidden" name="([^"]+)"/g)].map((m) => m[1])).toEqual(["workspaceId", "conversationId", "targetInteractionId", "idempotencyKey", "validation", "text"]);
    expect(composer).toMatch(/\{fields\.validation === true \? <input type="hidden" name="validation" value="1" \/> : null\}/);
    expect(composer).not.toMatch(/validationAuthorization|authorizationId/);
  });

  it("primitives render native elements and never raw HTML, scripts or inline handlers", () => {
    for (const file of sourceFiles(["ui/primitives"])) expect(codeOf(file), file).not.toMatch(/dangerouslySetInnerHTML|<script|javascript:|on[A-Z][a-z]+=\{/);
  });

  it("nothing in ui/ reaches tools/, server/, platform/ or the database (the composer's type-only import of the action state is pinned above)", () => {
    for (const file of sourceFiles(["ui"])) expect(codeOf(file).replace(/^import type \{[^}]*\} from "@\/server\/inbox\/reply-state";$/m, ""), file).not.toMatch(/from "@\/(tools|server|platform|modules|db|integrations|ai|mutations|jobs)\//);
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

describe("UI reference pages (development only)", () => {
  it.each(["app/dev/ui-reference/page.tsx", "app/dev/ui-reference/shell/page.tsx", "app/dev/ui-reference/inbox/page.tsx"])("%s is a 404 outside next dev, indexes nothing, reads no data and offers no action", (file) => {
    const page = codeOf(file);
    expect(page).toMatch(/const IS_DEVELOPMENT = process\.env\.NODE_ENV === "development";/);
    expect(page).toMatch(/if \(!IS_DEVELOPMENT\) notFound\(\);/);
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    // The Inbox reference imports view-model TYPES from server/inbox/inbox and the app's own views; never a runtime read.
    expect(page.replace(/import type \{[^}]*\} from "@\/server\/inbox\/inbox";/, "")).not.toMatch(/@\/server\/|@\/platform\/|@\/modules\/|@\/db\/|<form|action=|"use server"|fetch\(|runtime/);
    expect((page.match(/process\.env/g) ?? []).length).toBe(1);
  });

  it("the reply harness (Step 7B-3) is a 404 outside next dev, indexes nothing, and its only action is the development-only simulation that reaches no pipeline, database, provider or job", () => {
    const page = codeOf("app/dev/ui-reference/reply/page.tsx");
    expect(page).toMatch(/const IS_DEVELOPMENT = process\.env\.NODE_ENV === "development";/);
    expect(page).toMatch(/if \(!IS_DEVELOPMENT\) notFound\(\);/);
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(page.replace(/import type \{[^}]*\} from "@\/server\/inbox\/inbox";/, "")).not.toMatch(/@\/server\/|@\/platform\/|@\/modules\/|@\/db\/|@\/mutations\/|publishReplyAction|fetch\(|runtime/);
    expect(page).toMatch(/replyAction=\{simulateReplyAction\}/);
    // The simulation never claims a delivery: its request outcomes read "demo", and the real catalog copy is untouched.
    expect(page).toMatch(/const DEMO_OUTCOME = "Demo only — no reply was sent\.";/);
    expect(page).toMatch(/replyOutcomes=\{\{ \.\.\.replyOutcomeMessages\(\), requested: DEMO_OUTCOME, existing: DEMO_OUTCOME \}\}/);
    expect(codeOf("ui/inbox/reply-composer.tsx")).toMatch(/requested: "info"/);
    const action = codeOf("app/dev/ui-reference/reply/actions.ts");
    expect(action).toMatch(/^"use server";/);
    expect(action).toMatch(/const IS_DEVELOPMENT = process\.env\.NODE_ENV === "development";/);
    expect(action).toMatch(/if \(!IS_DEVELOPMENT\) return \{ kind: "unavailable" \};/);
    expect([...action.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["@/server/inbox/reply-state"]);
    expect(action).not.toMatch(/pipeline|requestPublicReplyCommand|mutations\/|platform\/db|fetch\(|requestAuth/);
  });
});

describe("Inbox › Comments prototype (Step 7B-15N, development only)", () => {
  const DIR = "app/dev/ui-reference/comments";

  it("is a 404 outside next dev, indexes nothing, and its only action is the reply harness's development-only simulation", () => {
    const page = codeOf(`${DIR}/page.tsx`);
    expect(page).toMatch(/const IS_DEVELOPMENT = process\.env\.NODE_ENV === "development";/);
    expect(page).toMatch(/if \(!IS_DEVELOPMENT\) notFound\(\);/);
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    expect((page.match(/process\.env/g) ?? []).length).toBe(1);
    expect(page).toMatch(/^import \{ simulateReplyAction \} from "\.\.\/reply\/actions";$/m);
    expect(page).toMatch(/action: simulateReplyAction/);
    // The simulation never claims a delivery: its request outcomes read "demo".
    expect(page).toMatch(/const DEMO_OUTCOME = "Demo only — no reply was sent\.";/);
    expect(page).toMatch(/requested: DEMO_OUTCOME, existing: DEMO_OUTCOME/);
    expect(page).not.toMatch(/publishReplyAction|@\/server\/|@\/platform\/|@\/modules\/|@\/db\/|@\/mutations\/|fetch\(|runtime|"use (client|server)"/);
  });

  it("the prototype's components and fixtures read nothing, send nothing and add no client code", () => {
    for (const file of [`${DIR}/prototype.tsx`, `${DIR}/fixtures.ts`]) {
      const code = codeOf(file);
      expect(code.replace(/^import type \{ ReplyAction \} from "@\/server\/inbox\/reply-state";$/m, ""), file).not.toMatch(/@\/server\/|@\/platform\/|@\/modules\/|@\/db\/|@\/mutations\/|@\/integrations\/|publishReplyAction|fetch\(|process\.env|["']use (client|server)["']|localStorage|sessionStorage|cookie|dangerouslySetInnerHTML/);
    }
    // The one composer is the real, unchanged component; the prototype never gives it a start stage or a text.
    expect(codeOf(`${DIR}/prototype.tsx`)).not.toMatch(/initialStage|initialText/);
  });
});

describe("Comments experience redesign prototype (Step 7B-17V, development only)", () => {
  const DIR = "app/dev/ui-reference/comments-redesign";

  it("is a 404 outside next dev, indexes nothing, and loads the client prototype only on the development path", () => {
    const page = codeOf(`${DIR}/page.tsx`);
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    expect((page.match(/process\.env/g) ?? []).length).toBe(1);
    // Written inline so the build folds it: outside `next dev` the dynamic import is dead code (not bundled) and the
    // page ends in notFound().
    expect(page).toMatch(/if \(process\.env\.NODE_ENV === "development"\) \{\n\s+const \{ CommentsRedesign \} = await import\("\.\/prototype"\);\n\s+return <CommentsRedesign \/>;\n\s+\}\n\s+notFound\(\);\n\}/);
    expect([...page.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["next/navigation", "next"]);
    expect((page.match(/import\(/g) ?? []).length).toBe(1);
  });

  it("reads nothing, sends nothing, stores nothing: local React state over synthetic fixtures only", () => {
    for (const file of [`${DIR}/page.tsx`, `${DIR}/prototype.tsx`, `${DIR}/model.ts`, `${DIR}/fixtures.ts`]) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/@\/server\/|@\/platform\/|@\/modules\/|@\/db\/|@\/mutations\/|@\/integrations\/|@\/ai\/|@\/jobs\/|"use server"|<form[^>]*action=|formAction|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|cookie|dangerouslySetInnerHTML|history\.|location\./);
    }
    // Only the prototype is a client module; the rules and the data are plain modules.
    expect(codeOf(`${DIR}/prototype.tsx`)).toMatch(/^"use client";/);
    for (const file of [`${DIR}/page.tsx`, `${DIR}/model.ts`, `${DIR}/fixtures.ts`]) expect(codeOf(file), file).not.toMatch(/["']use client["']/);
    // Its imports are the brand UI (logo, icons, primitives, the local-time element) and its own files.
    // UX-07B: + next/navigation, only to keep the open conversation in the address (?conversation=…) so the browser's
    // Back and Forward behave as on the product's own routes — the router, the path and the search parameters, nothing else.
    const imports = [...codeOf(`${DIR}/prototype.tsx`).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const specifier of imports) expect(specifier).toMatch(/^(react|next\/navigation|@\/ui\/(brand\/logo|icons\/icon|primitives|time\/local-time|time\/local-time-format)|\.\/(fixtures|model|prototype\.module\.css))$/);
    expect(codeOf(`${DIR}/prototype.tsx`)).toMatch(/^import \{ usePathname, useRouter, useSearchParams \} from "next\/navigation";$/m);
  });

  it("the reply composer is a preview that cannot publish", () => {
    const code = codeOf(`${DIR}/prototype.tsx`);
    expect(code).toMatch(/Preview — nothing is sent/);
    expect(code).toMatch(/Publishing isn&apos;t part of this preview/);
    expect(code).not.toMatch(/type="submit"[^>]*>\s*Publish|ReplyComposer|simulateReplyAction|publishReplyAction/);
  });
});

describe("Comments scroll comparison (COMMENTS-UX-07A, development only)", () => {
  const DIR = "app/dev/ui-reference/comments-scroll";

  it("is a 404 outside next dev, indexes nothing, and loads the client comparison only on the development path", () => {
    const page = codeOf(`${DIR}/page.tsx`);
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    expect((page.match(/process\.env/g) ?? []).length).toBe(1);
    expect(page).toMatch(/if \(process\.env\.NODE_ENV === "development"\) \{\n\s+const \{ ScrollComparison \} = await import\("\.\/comparison"\);\n\s+return <ScrollComparison \/>;\n\s+\}\n\s+notFound\(\);\n\}/);
    expect([...page.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["next/navigation", "next"]);
    expect((page.match(/import\(/g) ?? []).length).toBe(1);
  });

  it("reads nothing, sends nothing, stores nothing, and leaves the approved prototype alone: synthetic fixtures read-only, local React state", () => {
    for (const file of [`${DIR}/page.tsx`, `${DIR}/comparison.tsx`, `${DIR}/data.ts`]) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/@\/server\/|@\/platform\/|@\/modules\/|@\/db\/|@\/mutations\/|@\/integrations\/|@\/ai\/|@\/jobs\/|"use server"|<form|formAction|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|cookie|dangerouslySetInnerHTML|history\.|location\.|ReplyComposer|publishReplyAction/);
    }
    expect(codeOf(`${DIR}/comparison.tsx`)).toMatch(/^"use client";/);
    for (const file of [`${DIR}/page.tsx`, `${DIR}/data.ts`]) expect(codeOf(file), file).not.toMatch(/["']use client["']/);
    const imports = [...codeOf(`${DIR}/comparison.tsx`).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const specifier of imports) expect(specifier).toMatch(/^(react|@\/ui\/icons\/icon|\.\/(data|comparison\.module\.css))$/);
    // The data module reads the approved prototype's fixtures and nothing else of it (never its model, UI or styles).
    expect([...codeOf(`${DIR}/data.ts`).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["../comments-redesign/fixtures"]);
  });

  it("labels are the conversation's: no reply carries a label control, and the comment menu acts on nothing", () => {
    const code = codeOf(`${DIR}/comparison.tsx`);
    // The reference sheet (Conventions) names "+ Label" only to say it goes; the comparison itself never draws one.
    expect(code.slice(0, code.indexOf("function Conventions("))).not.toMatch(/\+ Label|Add label/);
    const entry = code.slice(code.indexOf("function Entry("), code.indexOf("function MenuItem("));
    expect(entry).not.toMatch(/util-tag|Labels|onToggleLabel/);
    expect(code).toMatch(/<button type="button" className=\{c\("menuItem", danger && "menuDanger"\)\} aria-disabled="true">/);
    expect(code.slice(code.indexOf("function MenuItem("), code.indexOf("function Cell("))).not.toMatch(/onClick/);
  });
});

describe("app shell (UI-3)", () => {
  const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");

  it("the shell read is the onboarding's list_own command and nothing else; it reaches no persistence, provider or job code", () => {
    const shell = codeOf("server/shell/shell.ts");
    expect([...shell.matchAll(/tenancyOnboardingCommands\.(\w+)/g)].map((match) => match[1])).toEqual(["listOwnTenancy"]);
    expect(shell).not.toMatch(/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|sql`|\.insert\(|\.update\(|\.delete\(|tx\.|process\.env/i);
    for (const file of ["server/shell/shell.ts", "server/shell/runtime.ts", "app/workspaces/[workspaceId]/workspace-shell.tsx", "ui/shell/app-shell.tsx"]) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} → ${specifier}`).not.toMatch(/platform\/db|modules\/[^/]+\/persistence|integrations\/|server\/connections|modules\/connections|platform\/crypto|platform\/aws|platform\/jobs|jobs\/|@trigger\.dev|@aws-sdk|^pg$|drizzle/);
      }
    }
    expect(importsOf("server/shell/runtime.ts")).toContain("@/server/persistence/runtime");
  });

  it("the composition's only form is the existing sign-out action; the section layouts only delegate to it", () => {
    const composition = codeOf("app/workspaces/[workspaceId]/workspace-shell.tsx");
    expect((composition.match(/<form\b/g) ?? []).length).toBe(1);
    expect(composition).toMatch(/<form action=\{signOutAction\}>/);
    expect(composition).not.toMatch(/"use client"|"use server"|process\.env|fetch\(/);
    for (const layout of ["app/workspaces/[workspaceId]/inbox/layout.tsx", "app/workspaces/[workspaceId]/settings/layout.tsx"]) {
      const code = codeOf(layout);
      expect(code).toMatch(/<WorkspaceShell workspaceId=\{workspaceId\} section="(inbox|settings)">/);
      expect(code).not.toMatch(/<form|action=|@\/server\/|@\/platform\/|process\.env/);
    }
  });

  it("the shell names no destination that does not exist yet", () => {
    for (const file of ["app/workspaces/[workspaceId]/workspace-shell.tsx", "ui/shell/app-shell.tsx", "server/shell/shell.ts"]) {
      expect(codeOf(file), file).not.toMatch(/\b(Home|Insights|Reports|TikTok|Content & Ads|Alerts)\b/);
    }
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

describe("Manual v1.1 Amendment 2 (label markers, PO-approved 2026-11-18): the label palette fills the marker and nothing else", () => {
  const MARKER_IDS = ["gray", "teal", "plum", "magenta", "olive"] as const;
  const LABEL_TOKEN = /--wk-label-/;
  /** Where a label color may be named: the token file and the stylesheet that draws the marker. */
  const LABEL_USERS = new Set(["ui/foundations/tokens.css", "app/dev/ui-reference/comments-redesign/prototype.module.css"]);
  const css = [...filesUnder("ui", (file) => file.endsWith(".css")), ...filesUnder("app", (file) => file.endsWith(".css"))];
  const rulesOf = (file: string): { readonly selector: string; readonly body: string }[] =>
    [...codeOf(file).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" }));

  it("label tokens are referenced only by the token file and the marker's stylesheet — never by components, inline styles or other CSS", () => {
    for (const file of [...css, ...sourceFiles(["app", "ui", "server"])]) {
      if (LABEL_USERS.has(file)) continue;
      expect(codeOf(file), file).not.toMatch(LABEL_TOKEN);
    }
  });

  it("only the marker rules use them, each one color for its own marker id, as the marker's fill color — never a background, border or text", () => {
    const file = "app/dev/ui-reference/comments-redesign/prototype.module.css";
    const users = rulesOf(file).filter((rule) => LABEL_TOKEN.test(rule.body));
    const seen: string[] = [];
    for (const rule of users) {
      const match = /^\.marker(?:\[data-marker="([a-z]+)"\])?$/.exec(rule.selector);
      expect(match, `${file}: "${rule.selector}" may not use a label color`).not.toBeNull();
      const id = match?.[1] ?? "gray";
      expect(rule.body.trim(), rule.selector).toMatch(new RegExp(`^color: var\\(--wk-label-${id}\\);$`));
      seen.push(id);
    }
    expect(seen.sort()).toEqual([...MARKER_IDS].sort());
    // The marker draws its fill from currentColor, and selection, status and blue tokens never mark a label.
    const fill = rulesOf(file).find((rule) => rule.selector === ".marker > path");
    expect(fill?.body).toMatch(/fill: currentColor/);
    for (const rule of rulesOf(file).filter((item) => /marker/i.test(item.selector))) expect(rule.body, rule.selector).not.toMatch(/--wk-(selection|accent|human|blue|success|warning|danger)-/);
  });

  it("the chip that carries a label stays neutral: no label color in a chip, row label, picker or sidebar rule", () => {
    for (const rule of rulesOf("app/dev/ui-reference/comments-redesign/prototype.module.css")) {
      if (!/chip|rowLabel|sideItem|check|markerOption|settingsTable|labelPanel/i.test(rule.selector)) continue;
      expect(rule.body, rule.selector).not.toMatch(LABEL_TOKEN);
    }
  });
});
