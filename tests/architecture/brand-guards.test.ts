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
    for (const file of css) expect(file).toMatch(/^ui\/(foundations|brand|primitives|shell|inbox)\/[a-z-]+(\.module)?\.css$/);
    expect([...filesUnder("ui/primitives", (file) => file.endsWith(".css")), ...filesUnder("ui/shell", (file) => file.endsWith(".css")), ...filesUnder("ui/inbox", (file) => file.endsWith(".css"))].every((file) => file.endsWith(".module.css"))).toBe(true);
  });

  it("no CSS imports anything, fetches anything or carries an expression", () => {
    for (const file of css) expect(textOf(file), file).not.toMatch(/@import|url\(|expression\(|https?:|javascript:/);
  });

  /** Step 7B-3: the ONE client component in ui/ — the contextual reply composer — pinned below with its own rule. */
  const CLIENT_COMPONENTS = ["ui/inbox/reply-composer.tsx"];

  it("the foundation, brand, icon and primitive components are server components", () => {
    for (const file of sourceFiles(["ui/foundations", "ui/brand", "ui/icons", "ui/primitives", "ui/shell", "ui/inbox"]).filter((file) => !CLIENT_COMPONENTS.includes(file))) {
      // No client directive, hook or BOUND handler (a primitive may forward an optional `onClick` prop for client components).
      expect(codeOf(file), file).not.toMatch(/"use client"|from "react-dom"|useState|useEffect|onClick=\{|onChange=\{/);
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
