/**
 * Reply composer start-stage contract (Step 7B-15D; audit 7B-15C, P2-A). The composer may be started at a stage through
 * `initialStage` / `initialText`. Production code is authorized to pass exactly ONE thing: `initialStage: "write"` —
 * a stage that has no form (only the review stage posts, after the explicit Publish confirmation). "review", "done",
 * any computed stage and `initialText` are for tests and the development reference only.
 *
 * Checked on the SYNTAX TREE of every production source file (never a text search): each place that names
 * `initialStage` / `initialText` as a JSX attribute, an object property, a shorthand or a computed key — wherever it
 * sits (a prop, a spread object, a variable) — outside the composer's own definition.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, codeOf, isClientModule, sourceFiles } from "../support/source-scan";

const COMPOSER = "ui/inbox/reply-composer.tsx";
/** Everything that ships: every source root of the package except tests, tools and one-off scripts. */
const PRODUCTION_ROOTS = ["app", "ui", "server", "domain", "modules", "mutations", "platform", "jobs", "integrations", "ai"];
const STAGE_PROPS = new Set(["initialStage", "initialText"]);

interface Use {
  readonly file: string;
  readonly line: number;
  readonly prop: string;
  /** The literal string given, or a marker for anything that is not a plain string literal. */
  readonly value: string;
}

const literal = (node: ts.Expression | undefined): string => {
  if (node === undefined) return "<none>";
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : "<computed>";
};

/** Every place a source text names a stage prop as a key (attribute, property, shorthand, computed or quoted key). */
export function stagePropUses(file: string, text: string): Use[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const uses: Use[] = [];
  const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const keyName = (name: ts.PropertyName | ts.JsxAttributeName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) return literal(name.expression);
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const name = keyName(node.name);
      if (name !== undefined && STAGE_PROPS.has(name)) {
        const init = node.initializer;
        const value = init === undefined ? "<none>" : ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) ? literal(init.expression) : "<computed>";
        uses.push({ file, line: at(node), prop: name, value });
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = keyName(node.name);
      if (name !== undefined && STAGE_PROPS.has(name)) uses.push({ file, line: at(node), prop: name, value: literal(node.initializer) });
    } else if (ts.isShorthandPropertyAssignment(node) && STAGE_PROPS.has(node.name.text)) {
      uses.push({ file, line: at(node), prop: node.name.text, value: "<computed>" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

const productionUses = (): Use[] =>
  sourceFiles(PRODUCTION_ROOTS)
    .filter((file) => file !== COMPOSER)
    .flatMap((file) => stagePropUses(file, readFileSync(path.join(REPOSITORY_ROOT, file), "utf8")));

describe("reply composer start stage: production callers", () => {
  it("the scanner sees every way of naming the prop (so the rule below cannot pass by not looking)", () => {
    const probe = `
      const a = <ReplyComposer initialStage="review" />;
      const b = <ReplyComposer initialStage={"done"} initialText={text} />;
      const c = { initialStage: "write" } as const;
      const d = { "initialStage": ("review" as const), ["initialText"]: "x" };
      const e = { initialStage: stage, initialText };
      const f = cond ? ({ initialStage: \`write\` } as const) : {};
    `;
    expect(stagePropUses("probe.tsx", probe).map((use) => `${use.prop}=${use.value}`)).toEqual([
      "initialStage=review",
      "initialStage=done",
      "initialText=<computed>",
      "initialStage=write",
      "initialStage=review",
      "initialText=x",
      "initialStage=<computed>",
      "initialText=<computed>",
      "initialStage=write",
    ]);
    // A comment or a string that merely mentions the name is not a use.
    expect(stagePropUses("probe.ts", `// initialStage: "review"\nconst s = "initialText";`)).toEqual([]);
  });

  it('no production file passes initialText, and every initialStage is the literal "write" — never "review", "done" or a computed stage', () => {
    const uses = productionUses();
    expect(uses.filter((use) => use.prop === "initialText").map((use) => `${use.file}:${String(use.line)}`)).toEqual([]);
    expect(uses.filter((use) => use.prop === "initialStage" && use.value !== "write").map((use) => `${use.file}:${String(use.line)} = ${use.value}`)).toEqual([]);
  });

  it("the one production caller is the Inbox conversation view (a new caller is a reviewed change, not an accident)", () => {
    expect([...new Set(productionUses().map((use) => use.file))]).toEqual(["app/workspaces/[workspaceId]/inbox/views.tsx"]);
  });

  it("the composer itself: the start stage only seeds local state — the form exists in the review stage alone, and nothing submits on mount", () => {
    const composer = readFileSync(path.join(REPOSITORY_ROOT, COMPOSER), "utf8");
    // Step 7B-15F/H: a kept draft always opens the WRITE stage (whatever the start stage); otherwise the caller's own.
    expect(composer).toMatch(/const \[stage, setStage\] = useState<ComposerStage>\(restored !== undefined \? "write" : initialStage\);/);
    expect([...composer.matchAll(/initialStage/g)].length).toBeGreaterThan(0);
    // No effect, no programmatic submit, no auto-run of the action: publishing is only the review form's submit button.
    expect(composer).not.toMatch(/useEffect|useLayoutEffect|requestSubmit|\.submit\(|formAction\(|startTransition/);
    expect([...composer.matchAll(/<form\b/g)]).toHaveLength(1);
    expect(composer).toMatch(/\{shownStage === "review" \? \(\s*<form action=\{formAction\}/);
  });
});

/**
 * Step 7B-15F/H — unsent reply drafts (ui/inbox/reply-drafts.ts, ui/inbox/reply-drafts-boundary.tsx). The composer may
 * keep the person's text in the tab's MEMORY and give it back to the same composer key; nothing else. Checked on the
 * SYNTAX TREE (Step 7B-15H, audit 7B-15G P2-3), not on today's spelling: every client module — and the drafts module —
 * may not NAME a storage, network, navigation or global-escape API in any form (identifier, property, string, alias,
 * computed access, dynamic import); `window` has exactly two allowed shapes; the publish action has exactly one way in.
 * What a syntax rule cannot prove (an effect actually running, the order of a real browser's events) is covered by the
 * behavioral tests in tests/unit/ui/reply-drafts.test.ts and the 7B-15H browser evidence.
 */
const DRAFTS = "ui/inbox/reply-drafts.ts";
const BOUNDARY = "ui/inbox/reply-drafts-boundary.tsx";
/** Step 7B-17K: the drafts' conversation boundary and the in-app link (the two other client modules near the drafts). */
const SCOPE = "ui/inbox/reply-drafts-scope.tsx";
const APP_LINK = "ui/navigation/app-link.tsx";
/** Step 7B-17R (Comments 2.1): the one other client module on the Comments surface — a time read in the browser's zone. */
const LOCAL_TIME = "ui/time/local-time.tsx";
const LOCAL_TIME_FORMAT = "ui/time/local-time-format.ts";

const sourceOf = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(path.join(REPOSITORY_ROOT, file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const nodesOf = (root: ts.Node): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
};
const unwrapped = (node: ts.Expression): ts.Expression => {
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isNonNullExpression(inner) || ts.isTypeAssertionExpression(inner)) inner = inner.expression;
  return inner;
};
const rootName = (node: ts.Expression): string | undefined => {
  const inner = unwrapped(node);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner) || ts.isCallExpression(inner)) return rootName(inner.expression);
  return undefined;
};
const where = (file: string, source: ts.SourceFile, node: ts.Node): string => `${file}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;

/** Names no client module may use in any position: web storage, cookies, network, navigation/URL, global escapes, loaders. */
const FORBIDDEN_NAMES = new Set(["localStorage", "sessionStorage", "indexedDB", "cookie", "cookieStore", "caches", "history", "location", "navigator", "sendBeacon", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "BroadcastChannel", "SharedWorker", "Worker", "postMessage", "globalThis", "self", "Reflect", "eval", "Function", "require", "importScripts", "document", "opener", "top", "parent", "frames", "console", "arguments", "constructor", "prototype", "__proto__"]);
const FORBIDDEN_TEXT = /storage|cookie|indexeddb|sendbeacon|globalthis|history|location|navigator/i;
/** Receivers a client module may index with a computed key (its own local tables; never a global). */
const COMPUTED_RECEIVERS: Readonly<Record<string, readonly string[]>> = { "ui/inbox/reply-composer.tsx": ["outcomes", "OUTCOME_TONE"] };

function clientEscapes(file: string): string[] {
  const source = sourceOf(file);
  const problems: string[] = [];
  for (const node of nodesOf(source)) {
    if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text)) problems.push(`${where(file, source, node)} names ${node.text}`);
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !ts.isImportDeclaration(node.parent) && FORBIDDEN_TEXT.test(node.text)) problems.push(`${where(file, source, node)} spells "${node.text}"`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push(`${where(file, source, node)} dynamic import()`);
    if (ts.isElementAccessExpression(node)) {
      const argument = unwrapped(node.argumentExpression);
      const literal = ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument);
      const receiver = rootName(node.expression);
      if (receiver === "window") problems.push(`${where(file, source, node)} indexes window`);
      else if (!literal && !(receiver !== undefined && (COMPUTED_RECEIVERS[file] ?? []).includes(receiver))) problems.push(`${where(file, source, node)} computed access on ${receiver ?? "an expression"}`);
    }
    if (ts.isIdentifier(node) && node.text === "window") {
      const parent = node.parent;
      const typeofWindow = ts.isTypeOfExpression(parent);
      const listener =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        (parent.name.text === "addEventListener" || parent.name.text === "removeEventListener") &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        parent.parent.arguments[0] !== undefined &&
        ts.isStringLiteral(parent.parent.arguments[0]) &&
        parent.parent.arguments[0].text === "beforeunload";
      if (!typeofWindow && !listener) problems.push(`${where(file, source, node)} uses window outside \`typeof window\` / the beforeunload listener`);
    }
  }
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) problems.push(`${file}: re-export from ${statement.moduleSpecifier.getText(source)}`);
  }
  return problems;
}

/** Every module import of a file: [specifier, type-only]. */
const importsOfFile = (file: string): string[] =>
  sourceOf(file)
    .statements.filter(ts.isImportDeclaration)
    .map((statement) => `${statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? "type " : ""}${(statement.moduleSpecifier as ts.StringLiteral).text}`);

/** Value references to a binding name (not a declaration, a property name, a JSX attribute name or a type). */
function valueReferences(source: ts.SourceFile, within: ts.Node, name: string): ts.Identifier[] {
  return nodesOf(within).filter((node): node is ts.Identifier => {
    if (!ts.isIdentifier(node) || node.text !== name) return false;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if ((ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node) return false;
    if (ts.isJsxAttribute(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
    if (ts.isParameter(parent) && parent.name === node) return false;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
    if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
    return source === node.getSourceFile();
  });
}
const functionNamed = (source: ts.SourceFile, name: string): ts.FunctionDeclaration => {
  const found = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (found === undefined) throw new Error(`function ${name} not found`);
  return found;
};
const calleeName = (call: ts.CallExpression): string | undefined => (ts.isIdentifier(unwrapped(call.expression)) ? (unwrapped(call.expression) as ts.Identifier).text : undefined);

/**
 * Step 7B-15J/L — the globals a file touches, RESOLVED by the type checker (never by spelling). A global is a value
 * identifier whose symbol is declared only in ambient declaration files — TypeScript's own library, the DOM, or ANY
 * package's types — and is not a member of something else. Step 7B-15L (audit 7B-15K K06): the earlier rule asked for
 * every declaration to sit in TypeScript's default library, so a global that @types/node declares as well (setTimeout,
 * setInterval, setImmediate, queueMicrotask, structuredClone, fetch, console…) was not seen at all.
 */
const MEMBER = ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Accessor | ts.SymbolFlags.EnumMember | ts.SymbolFlags.TypeParameter;
/** The memory map, the two sets, Math.max and the window listener of the drafts module; String() is the composer's character counter (a pure conversion). */
const ALLOWED_GLOBALS = new Set(["Map", "Set", "Math", "String", "window"]);
function globalsUsed(files: readonly string[], probe?: { readonly file: string; readonly code: string }): string[] {
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(REPOSITORY_ROOT, "tsconfig.json"), (name) => ts.sys.readFile(name)).config, ts.sys, REPOSITORY_ROOT);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const probePath = probe === undefined ? undefined : path.join(REPOSITORY_ROOT, probe.file);
  if (probe !== undefined && probePath !== undefined) {
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.getSourceFile = (name, languageVersion, ...rest) => (path.resolve(name) === probePath ? ts.createSourceFile(name, probe.code, languageVersion, true, ts.ScriptKind.TSX) : getSourceFile(name, languageVersion, ...rest));
    host.fileExists = (name) => path.resolve(name) === probePath || fileExists(name);
    host.readFile = (name) => (path.resolve(name) === probePath ? probe.code : readFile(name));
  }
  const all = probe === undefined ? files : [...files, probe.file];
  const program = ts.createProgram(all.map((file) => path.join(REPOSITORY_ROOT, file)), options, host);
  const checker = program.getTypeChecker();
  const used: string[] = [];
  for (const file of all) {
    const source = program.getSourceFile(path.join(REPOSITORY_ROOT, file));
    if (source === undefined) throw new Error(`${file} not in the program`);
    for (const node of nodesOf(source)) {
      if (!ts.isIdentifier(node)) continue;
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) continue;
      if (ts.findAncestor(node.parent, ts.isTypeNode) !== undefined) continue;
      const symbol = checker.getSymbolAtLocation(node);
      const declarations = symbol?.declarations ?? [];
      if (symbol === undefined || declarations.length === 0 || (symbol.flags & MEMBER) !== 0) continue;
      if (declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) used.push(`${file}: ${node.text}`);
    }
  }
  return used;
}

describe("reply drafts: memory only, never publishing (syntax tree)", () => {
  // Step 7B-15J (audit 7B-15I Z08): a client module is recognized by its directive in EITHER quote style.
  const clientModules = (): string[] => sourceFiles([...PRODUCTION_ROOTS]).filter(isClientModule);

  it("the scanner itself sees the escape routes (so the rules below cannot pass by not looking)", () => {
    const probe = (code: string): string[] => {
      const file = "probe.tsx";
      const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const problems: string[] = [];
      for (const node of nodesOf(source)) {
        if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text)) problems.push(node.text);
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && FORBIDDEN_TEXT.test(node.text)) problems.push(`"${node.text}"`);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push("import()");
        if (ts.isElementAccessExpression(node) && rootName(node.expression) === "window") problems.push("window[]");
      }
      return problems;
    };
    expect(probe(`(globalThis as any)["local" + "Storage"].setItem("k", v);`)).toEqual(expect.arrayContaining(["globalThis", '"Storage"']));
    expect(probe(`const s = window["session" + "Storage"];`)).toContain("window[]");
    expect(probe(`void import("@/platform/observability");`)).toContain("import()");
    expect(probe(`history.replaceState(null, "", "?d=" + text);`)).toContain("history");
    expect(probe(`Reflect.apply(action, undefined, []);`)).toContain("Reflect");
    expect(probe(`const r = require("x");`)).toContain("require");
    expect(probe(`document.cookie = "d=" + text;`)).toEqual(expect.arrayContaining(["document", "cookie"]));
  });

  it("no client module, and not the drafts module, names a storage, cookie, network, URL or global-escape API, indexes a global, or imports dynamically", () => {
    const files = [...new Set([...clientModules(), DRAFTS])];
    expect(files).toEqual(expect.arrayContaining([COMPOSER, BOUNDARY, DRAFTS]));
    expect(files.flatMap(clientEscapes)).toEqual([]);
  });

  it("Step 7B-15L (audit 7B-15K K06): the global resolver sees timers and every other deferred-execution or escape global whether the DOM or @types/node declares it — and never mistakes a local, an import, a JSX tag or an attribute for one", () => {
    const code = `
      import { useState } from "react";
      declare const text: string;
      export function Probe() {
        const [own] = useState(0);
        const later = (): number => own;
        setTimeout(later, 200);
        setInterval(later, 200);
        setImmediate(later);
        queueMicrotask(later);
        requestAnimationFrame(later);
        requestIdleCallback(later);
        void Promise.resolve().then(later);
        process.nextTick(later);
        new MessageChannel().port1.postMessage(text);
        new Image().src = text;
        open(text);
        reportError(new Error(text));
        structuredClone(text);
        void fetch(text);
        console.log(name);
        return <form className="x" onClick={later} />;
      }
    `;
    const probe = "ui/inbox/globals-probe.tsx";
    const seen = globalsUsed([], { file: probe, code }).map((entry) => entry.slice(entry.lastIndexOf(" ") + 1));
    expect([...new Set(seen)].sort()).toEqual(["Error", "Image", "MessageChannel", "Promise", "console", "fetch", "name", "open", "process", "queueMicrotask", "reportError", "requestAnimationFrame", "requestIdleCallback", "setImmediate", "setInterval", "setTimeout", "structuredClone"]);
    // The exact audit mutation: a delayed restore scheduled from the drafts module is a use of a global outside the allowlist.
    const drafts = readFileSync(path.join(REPOSITORY_ROOT, DRAFTS), "utf8");
    const line = "    if (UNKNOWN_OUTCOME.has(result.kind)) uncertain.add(key);\n";
    expect(drafts.split(line)).toHaveLength(2);
    const mutated = drafts.replace(line, '    if (UNKNOWN_OUTCOME.has(result.kind)) { uncertain.add(key); if (typeof submitted === "string") setTimeout(() => { uncertain.delete(key); drafts.set(key, submitted); syncLeaveGuard(); }, 200); }\n');
    const leaked = globalsUsed([], { file: "ui/inbox/reply-drafts-probe.ts", code: mutated }).map((entry) => entry.slice(entry.lastIndexOf(" ") + 1));
    expect(leaked.filter((name) => !ALLOWED_GLOBALS.has(name))).toEqual(["setTimeout"]);
  });

  it("Step 7B-15J/L: every global a client module (or the drafts module) touches is RESOLVED by the type checker and must be on a short allowlist — so timers, open, name, Image, reportError, requestIdleCallback, storage or any other browser or Node global fail whatever they are called", () => {
    const files = [...new Set([...clientModules(), DRAFTS])];
    const used = globalsUsed(files);
    expect(used.filter((entry) => !ALLOWED_GLOBALS.has(entry.slice(entry.lastIndexOf(" ") + 1)))).toEqual([]);
    // The allowlist is not decorative: it is exactly what these modules need today.
    expect([...new Set(used.map((entry) => entry.slice(entry.lastIndexOf(" ") + 1)))].sort()).toEqual([...ALLOWED_GLOBALS].sort());
  });

  it("Step 7B-15J: the publish action cannot be renamed on the way in — no client module destructures `action` under another name", () => {
    const renamed: string[] = [];
    for (const file of [...new Set([...clientModules(), DRAFTS])]) {
      const source = sourceOf(file);
      for (const node of nodesOf(source)) {
        if (ts.isBindingElement(node) && node.propertyName !== undefined && ts.isIdentifier(node.propertyName) && /^(action|formAction)$/.test(node.propertyName.text)) renamed.push(where(file, source, node));
      }
    }
    expect(renamed).toEqual([]);
  });

  it("each draft file imports only what it is allowed to (no other module can be reached)", () => {
    expect(importsOfFile(DRAFTS)).toEqual(["type @/server/inbox/reply-state"]);
    expect(importsOfFile(BOUNDARY)).toEqual(["react", "./reply-drafts"]);
    expect(importsOfFile(COMPOSER)).toEqual(["react", "react-dom", "type @/server/inbox/reply-state", "@/ui/primitives/button", "@/ui/primitives/notice", "./reply-drafts", "./reply-composer.module.css"]);
    // Step 7B-17K: the boundary reads the address's two route segments; the link is the framework's <Link>.
    expect(importsOfFile(SCOPE)).toEqual(["next/navigation", "react", "./reply-drafts"]);
    expect(importsOfFile(APP_LINK)).toEqual(["next/link", "react", "@/ui/inbox/reply-drafts"]);
  });

  it("Step 7B-17R: the local-time reading only reads an instant it is given — no request, storage, timer, page or drafts access", () => {
    expect(importsOfFile(LOCAL_TIME)).toEqual(["react", "./local-time-format"]);
    expect(importsOfFile(LOCAL_TIME_FORMAT)).toEqual([]);
    for (const file of [LOCAL_TIME, LOCAL_TIME_FORMAT]) {
      expect(codeOf(file), file).not.toMatch(/\bfetch\b|Storage|indexedDB|cookie|document\.|navigator|location|history|setTimeout|setInterval|XMLHttpRequest|WebSocket|reply-drafts|dangerouslySetInnerHTML/);
    }
    // It subscribes to nothing: the reading is computed from the instant, the clock and the zone at render.
    expect(codeOf(LOCAL_TIME)).toMatch(/const noSubscription = \(\): \(\(\) => void\) => \(\) => undefined;/);
  });

  it("only the composer, the signed-out boundary, the conversation boundary and the in-app link reach the drafts module — by any import, static or dynamic, anywhere in production code", () => {
    const reachers = sourceFiles([...PRODUCTION_ROOTS]).filter((file) => file !== DRAFTS && /reply-drafts(?!-(boundary|scope))/.test(codeOf(file)));
    expect(reachers.sort()).toEqual([APP_LINK, BOUNDARY, COMPOSER, SCOPE].sort());
    // Step 7B-17K: each of the two new readers takes exactly what it needs — the link only reads, the boundary only reports.
    expect(codeOf(APP_LINK)).toMatch(/^import \{ hasReplyDrafts, subscribeReplyDrafts \} from "@\/ui\/inbox\/reply-drafts";$/m);
    expect(codeOf(SCOPE)).toMatch(/^import \{ showReplyDraftsConversation \} from "\.\/reply-drafts";$/m);
  });

  it("the composer: the publish action has ONE way in — the argument of settleReplyDraft, itself the argument of useActionState — and the form posts through formAction only", () => {
    const source = sourceOf(COMPOSER);
    const composer = functionNamed(source, "ReplyComposer");
    const actionRefs = valueReferences(source, composer, "action");
    expect(actionRefs.map((ref) => where(COMPOSER, source, ref))).toHaveLength(1);
    const [actionRef] = actionRefs;
    if (actionRef === undefined) throw new Error("action");
    const settle = actionRef.parent;
    expect(ts.isCallExpression(settle) && calleeName(settle) === "settleReplyDraft" && settle.arguments[0] === actionRef).toBe(true);
    const outer = settle.parent;
    expect(ts.isCallExpression(outer) && calleeName(outer) === "useActionState" && outer.arguments[0] === settle).toBe(true);
    // formAction: only as the value of the one <form action={...}>; never called, aliased or passed elsewhere.
    const formRefs = valueReferences(source, composer, "formAction");
    expect(formRefs).toHaveLength(1);
    const attribute = formRefs[0]?.parent.parent;
    expect(attribute !== undefined && ts.isJsxAttribute(attribute) && (attribute.name as ts.Identifier).text === "action" && ts.isJsxOpeningElement(attribute.parent.parent) && (attribute.parent.parent.tagName as ts.Identifier).text === "form").toBe(true);
    // No other way to run anything on mount or by program: no effect, transition or programmatic submit, anywhere in the file.
    const calls = nodesOf(source).filter(ts.isCallExpression);
    expect(calls.map(calleeName).filter((name) => name !== undefined && /^(useEffect|useLayoutEffect|useInsertionEffect|startTransition|useTransition|queueMicrotask|setTimeout|setInterval|requestAnimationFrame)$/.test(name))).toEqual([]);
    expect(nodesOf(source).filter((node) => ts.isPropertyAccessExpression(node) && /^(submit|requestSubmit|then|call|apply|bind)$/.test(node.name.text)).map((node) => where(COMPOSER, source, node))).toEqual([]);
  });

  it("the composer: while the publication is pending, the review stage cannot be reopened — Edit is the form-status button, disabled while pending", () => {
    const source = sourceOf(COMPOSER);
    const edit = functionNamed(source, "EditButton");
    expect(edit.body?.getText(source).replace(/\s+/g, " ")).toMatch(/^\{ const \{ pending \} = useFormStatus\(\); return \( <Button variant="ghost" size="sm" disabled=\{pending\} onClick=\{onEdit\}>/);
    // The review stage's only way back to writing is that button (no other element sets the write stage inside the form).
    const form = nodesOf(source).find((node): node is ts.JsxElement => ts.isJsxElement(node) && (node.openingElement.tagName as ts.Identifier).text === "form");
    const inForm = form === undefined ? [] : nodesOf(form);
    expect(inForm.filter((node) => ts.isJsxSelfClosingElement(node) && (node.tagName as ts.Identifier).text === "EditButton")).toHaveLength(1);
    expect(inForm.filter((node) => ts.isJsxElement(node) && (node.openingElement.tagName as ts.Identifier).text === "Button")).toHaveLength(0);
  });

  it("Step 7B-15L (audit 7B-15K K14): the write stage is reopened from exactly two places — the closed composer's Reply button and the pending-aware Edit control — whatever element, component or handler asks", () => {
    const source = sourceOf(COMPOSER);
    const attributeOf = (node: ts.Node): ts.JsxAttribute | undefined => ts.findAncestor(node, ts.isJsxAttribute);
    const ownerOf = (attribute: ts.JsxAttribute): string => attribute.parent.parent.tagName.getText(source);
    // setStage is only ever CALLED, with one literal stage: never aliased, stored, passed on or given a computed stage.
    const stages = valueReferences(source, source, "setStage").map((ref) => {
      const call = ref.parent;
      const argument = ts.isCallExpression(call) && call.expression === ref && call.arguments.length === 1 ? call.arguments[0] : undefined;
      if (argument === undefined || !ts.isStringLiteral(argument)) return `other@${where(COMPOSER, source, ref)}`;
      if (argument.text !== "write") return argument.text;
      // Where a "write" comes from: the handler attribute it sits in, and whether that is the closed composer's branch.
      const attribute = attributeOf(ref);
      const closedBranch = ts.findAncestor(ref, (node) => ts.isIfStatement(node) && node.expression.getText(source) === 'shownStage === "closed"') !== undefined;
      if (attribute === undefined) return `write outside a handler@${where(COMPOSER, source, ref)}`;
      return `write: ${ownerOf(attribute)}.${attribute.name.getText(source)}${closedBranch ? " (closed composer)" : ""}`;
    });
    expect(stages.sort()).toEqual(["closed", "review", "write: Button.onClick (closed composer)", "write: EditButton.onEdit"]);
    // The Edit control is drawn once in the whole file, and that once is inside the form (useFormStatus is the FORM's status).
    const form = nodesOf(source).find((node): node is ts.JsxElement => ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "form");
    if (form === undefined) throw new Error("form");
    const drawn = (root: ts.Node, tag: string): number => nodesOf(root).filter((node) => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === tag).length;
    expect([drawn(source, "EditButton"), drawn(form, "EditButton")]).toEqual([1, 1]);
    // Inside the form there is ONE handler of any kind (click, keyboard, pointer, focus — on any element or component):
    // the Edit control's. Nothing is spread onto an element anywhere in the file (a spread could carry a handler).
    const handlers = nodesOf(form).filter((node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(source)));
    expect(handlers.map((attribute) => `${ownerOf(attribute)}.${attribute.name.getText(source)}`)).toEqual(["EditButton.onEdit"]);
    expect(nodesOf(source).filter((node) => ts.isJsxSpreadAttribute(node) || ts.isSpreadAssignment(node)).map((node) => where(COMPOSER, source, node))).toEqual([]);
    // Inside EditButton, onEdit has ONE use: the click of the button that is disabled while the publication is pending.
    const edit = functionNamed(source, "EditButton");
    const uses = valueReferences(source, edit, "onEdit").map((ref) => {
      const attribute = attributeOf(ref);
      if (attribute === undefined || attribute.initializer === undefined || !ts.isJsxExpression(attribute.initializer) || attribute.initializer.expression !== ref) return `other@${where(COMPOSER, source, ref)}`;
      const siblings = attribute.parent.properties.map((property) => property.getText(source));
      return `${ownerOf(attribute)}.${attribute.name.getText(source)} [${siblings.includes("disabled={pending}") ? "disabled={pending}" : "NOT pending-aware"}]`;
    });
    expect(uses).toEqual(["Button.onClick [disabled={pending}]"]);
    // The reviewed text itself changes in one place only: the write stage's textarea.
    expect(valueReferences(source, source, "setText").map((ref) => { const attribute = attributeOf(ref); return attribute === undefined ? "outside a handler" : `${ownerOf(attribute)}.${attribute.name.getText(source)}`; })).toEqual(["textarea.onChange"]);
  });

  it("Step 7B-15L: that rule sees each alternative control the audits tried (so it cannot pass by not looking)", () => {
    const original = readFileSync(path.join(REPOSITORY_ROOT, COMPOSER), "utf8");
    const publish = "<PublishButton label={labels.publish} pendingLabel={labels.publishing} />";
    const handlersIn = (code: string): string[] => {
      const source = ts.createSourceFile(COMPOSER, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const form = nodesOf(source).find((node): node is ts.JsxElement => ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "form");
      const inForm = new Set(form === undefined ? [] : nodesOf(form));
      return valueReferences(source, source, "setStage")
        .filter((ref) => ts.isCallExpression(ref.parent) && ref.parent.arguments[0]?.getText(source) === '"write"')
        .map((ref) => {
          const attribute = ts.findAncestor(ref, ts.isJsxAttribute);
          return attribute === undefined ? "none" : `${attribute.parent.parent.tagName.getText(source)}.${attribute.name.getText(source)}${inForm.has(attribute) ? " in form" : ""}`;
        })
        .sort();
    };
    const add = (extra: string): string => {
      expect(original.split(publish)).toHaveLength(2);
      return original.replace(publish, `${publish}\n${extra}`);
    };
    expect(handlersIn(original)).toEqual(["Button.onClick", "EditButton.onEdit in form"]);
    const write = '() => { setStage("write"); }';
    expect(handlersIn(add(`<button type="button" onClick={${write}}>{labels.edit}</button>`))).toContain("button.onClick in form");
    expect(handlersIn(add(`<Button variant="ghost" onClick={${write}} />`))).toContain("Button.onClick in form");
    expect(handlersIn(add(`<span role="button" tabIndex={0} onClick={${write}}>{labels.edit}</span>`))).toContain("span.onClick in form");
    expect(handlersIn(add(`<span role="button" tabIndex={0} onKeyDown={${write}}>{labels.edit}</span>`))).toContain("span.onKeyDown in form");
    expect(handlersIn(add(`<EditButton label={labels.edit} onEdit={${write}} />`)).filter((entry) => entry === "EditButton.onEdit in form")).toHaveLength(2);
    const outside = '      {shownStage === "done" && outcome';
    expect(original.split(outside)).toHaveLength(2);
    expect(handlersIn(original.replace(outside, `      {shownStage === "review" ? <EditButton label={labels.edit} onEdit={${write}} /> : null}\n${outside}`))).toContain("EditButton.onEdit");
  });

  it("the composer: no shared fallback scope — without a scope from the server there is no key; Cancel forgets THIS composer's draft", () => {
    const source = sourceOf(COMPOSER);
    const composer = functionNamed(source, "ReplyComposer");
    const declaration = nodesOf(composer).find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "draftKey");
    const init = declaration?.initializer === undefined ? undefined : unwrapped(declaration.initializer);
    expect(init !== undefined && ts.isConditionalExpression(init)).toBe(true);
    if (init === undefined || !ts.isConditionalExpression(init)) return;
    expect(init.condition.getText(source)).toBe("draftScope === undefined");
    expect(init.whenTrue.getText(source)).toBe("undefined");
    expect(init.whenFalse.getText(source)).toBe("replyDraftKey(draftScope, fields)");
    // Every draft call in the composer uses exactly this key (never a constant, another key or nothing).
    const draftCalls = nodesOf(composer).filter((node): node is ts.CallExpression => ts.isCallExpression(node) && /^(keepReplyDraft|forgetReplyDraft|restoreReplyDraft|settleReplyDraft)$/.test(calleeName(node) ?? ""));
    for (const call of draftCalls) {
      const keyArgument = calleeName(call) === "settleReplyDraft" ? call.arguments[1] : call.arguments[0];
      expect(keyArgument?.getText(source), where(COMPOSER, source, call)).toBe("draftKey");
    }
    expect(draftCalls.map(calleeName).sort()).toEqual(["forgetReplyDraft", "keepReplyDraft", "restoreReplyDraft", "settleReplyDraft"]);
    // The forget call is the Cancel button's own handler (the button whose label is labels.cancel).
    const cancel = nodesOf(composer).find((node): node is ts.JsxElement => ts.isJsxElement(node) && node.children.some((child) => ts.isJsxExpression(child) && child.expression?.getText(source) === "labels.cancel"));
    const onClick = cancel?.openingElement.attributes.properties.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && (attribute.name as ts.Identifier).text === "onClick");
    expect(onClick?.initializer?.getText(source)).toMatch(/setStage\("closed"\);\s*forgetReplyDraft\(draftKey\);/);
  });

  it("the drafts module: settleReplyDraft calls the action at most once per submission, with the same arguments, returns its answer, and loops nowhere", () => {
    const source = sourceOf(DRAFTS);
    const settle = functionNamed(source, "settleReplyDraft");
    const refs = valueReferences(source, settle, "action");
    expect(refs).toHaveLength(2);
    const roles = refs.map((ref) => (ts.isReturnStatement(ref.parent) ? "return" : ts.isCallExpression(ref.parent) && ref.parent.expression === ref ? `call(${ref.parent.arguments.map((argument) => argument.getText(source)).join(", ")})` : `other@${where(DRAFTS, source, ref)}`));
    expect(roles.sort()).toEqual(["call(previous, form)", "return"]);
    expect(nodesOf(settle).filter((node) => ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node))).toEqual([]);
    expect(nodesOf(settle).filter((node) => ts.isCallExpression(node) && calleeName(node) === "settleReplyDraft")).toEqual([]);
    // The answer is returned as received; the form is only read for its text.
    expect(nodesOf(settle).filter(ts.isReturnStatement).filter((statement) => statement.expression === undefined || !ts.isArrowFunction(statement.expression)).map((statement) => statement.expression?.getText(source))).toEqual(["action", "result"]);
    expect(nodesOf(source).filter((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && rootName(node.expression) === "form").map((call) => call.getText(source))).toEqual(['form.get("text")']);
    // Only the three nothing-created outcomes may give the text back.
    expect(source.getFullText()).toMatch(/const NOTHING_CREATED: ReadonlySet<ReplyActionState\["kind"\]> = new Set\(\["refused", "blocked", "signed_out"\]\);/);
  });

  it("the drafts module: its one browser listener is the native beforeunload confirmation", () => {
    const source = sourceOf(DRAFTS);
    const listeners = nodesOf(source).filter((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /EventListener$/.test(node.expression.name.text));
    expect(listeners.map((call) => call.getText(source))).toEqual(['window.addEventListener("beforeunload", warnBeforeLeaving)', 'window.removeEventListener("beforeunload", warnBeforeLeaving)']);
    expect(functionNamed(source, "warnBeforeLeaving").body?.getText(source).replace(/\s+/g, " ")).toBe("{ event.preventDefault(); }");
  });

  it("the signed-out boundary: one effect that only clears the drafts, rendered by every signed-out surface the sign-out reaches", () => {
    const source = sourceOf(BOUNDARY);
    const calls = nodesOf(source).filter(ts.isCallExpression);
    expect(calls.map((call) => call.getText(source).replace(/\s+/g, " "))).toEqual(["useEffect(() => { clearReplyDrafts(); }, [])", "clearReplyDrafts()"]);
    for (const page of ["app/sign-in/page.tsx", "app/sign-up/page.tsx"]) {
      expect(codeOf(page), page).toMatch(/^import \{ ReplyDraftsSignedOut \} from "@\/ui\/inbox\/reply-drafts-boundary";$/m);
      // (Comments are stripped by codeOf, leaving an empty `{}` where the JSX comment was.)
      expect(codeOf(page), page).toMatch(/<main>\s*(\{\s*\}\s*)?<ReplyDraftsSignedOut \/>/);
    }
    // Step 7B-15J (audit 7B-15I F4/Y05): "/" is a signed-out surface as well — it draws the boundary when signed out.
    const home = codeOf("app/page.tsx");
    expect(home).toMatch(/^import \{ ReplyDraftsSignedOut \} from "@\/ui\/inbox\/reply-drafts-boundary";$/m);
    expect(home).toMatch(/\{state === "signed_out" \? <ReplyDraftsSignedOut \/> : null\}/);
    // Sign-out always lands on /sign-in (an in-app redirect), so the boundary is always reached after a successful sign-out.
    const actions = codeOf("server/auth/actions.ts");
    expect(actions).toMatch(/function toSignIn\(status: AuthStatus\): never \{\s*redirect\(`\/sign-in\?status=\$\{status\}`\);/);
    expect(actions).toMatch(/export async function signOutAction\(\): Promise<void> \{\s*const auth = await requestAuth\(\);\s*await auth\?\.signOut\(\);\s*toSignIn\("signed_out"\);\s*\}/);
  });

  it("moving the composer is an in-app navigation (so the tab's memory survives), never prefetched", () => {
    const views = codeOf("app/workspaces/[workspaceId]/inbox/views.tsx");
    expect([...views.matchAll(/<TextLink [^>]*\binPage\b[^>]*>/g)].map((m) => m[0])).toEqual(["<TextLink href={replyHere} inPage>"]);
    const link = codeOf("ui/primitives/text-link.tsx");
    expect(link).toMatch(/^import Link from "next\/link";$/m);
    expect(link).toMatch(/if \(inPage && !external\) \{\s*return \(\s*<Link href=\{href\} prefetch=\{false\}/);
    expect([...link.matchAll(/<Link\b/g)]).toHaveLength(1);
  });

  it("Step 7B-17K: the Inbox rows, previous / next / close and the shell's destinations are in-app links; the only other links are the skip links", () => {
    const inbox = codeOf("ui/inbox/inbox.tsx");
    expect([...inbox.matchAll(/<AppLink href=\{[^}]+\}[^>]*>/g)].map((m) => m[0])).toEqual([
      '<AppLink href={href} className={styles["row"]} pendingClassName={styles["rowPending"]} current={current} focusKey={id}>',
      '<AppLink href={target.href} className={styles["navLink"]} pendingClassName={styles["navPending"]}>',
      '<AppLink href={close.href} className={join(styles["navLink"], styles["navClose"])} pendingClassName={styles["navPending"]}>',
    ]);
    expect([...inbox.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])).toEqual(['<a href={skipToConversation.href} className={styles["skipToDetail"]}>']);
    const shell = codeOf("ui/shell/app-shell.tsx");
    expect([...shell.matchAll(/<AppLink\b[^>]*>/g)]).toHaveLength(3);
    expect([...shell.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])).toEqual(['<a href={`#${CONTENT_ID}`} className={styles["skip"]}>']);
    // Nothing else composes the in-app link (a new caller is a reviewed change, not an accident).
    expect(sourceFiles([...PRODUCTION_ROOTS]).filter((file) => file !== APP_LINK && /@\/ui\/navigation\/app-link/.test(codeOf(file))).sort()).toEqual(["ui/inbox/comments.tsx", "ui/inbox/inbox.tsx", "ui/shell/app-shell.tsx"]);
    // COMMENTS-INT-03A: the redesigned Comments list has two in-app links — its row (the same contract as the Inbox row)
    // and, since 03A-FIX, the way back to the list, which stands for the selected row's anchor so focus is never lost.
    expect([...codeOf("ui/inbox/comments.tsx").matchAll(/<AppLink href=\{[^}]+\}[^>]*>/g)].map((m) => m[0])).toEqual([
      '<AppLink href={href} className={styles["row"]} pendingClassName={styles["rowPending"]} current={current} focusKey={id}>',
      '<AppLink href={back.href} className={styles["backLink"]} focusKey={back.focusKey}>',
    ]);
    expect([...codeOf("ui/inbox/comments.tsx").matchAll(/<a\b[^>]*>/g)]).toHaveLength(0);
  });

  it("Step 7B-17K: the in-app link is never prefetched, never navigates by script, and is a plain link while a draft is kept", () => {
    const link = codeOf(APP_LINK);
    expect(link).toMatch(/^"use client";/);
    // One framework link, never prefetched; no router, no programmatic navigation, no reload.
    expect([...link.matchAll(/<Link\b/g)]).toHaveLength(1);
    expect(link).toMatch(/<Link\s+ref=\{ref\}\s+href=\{href\}\s+prefetch=\{false\}/);
    expect(link).not.toMatch(/useRouter|\brouter\b|\.push\(|\.replace\(|\.refresh\(|\.prefetch\(|\breload\b/);
    // While any draft is kept (read through the drafts module; never on the server), the link is a native <a>: leaving is
    // a full navigation and the browser's own leave confirmation still guards it (UX-20).
    expect(link).toMatch(/const draftsKept = useSyncExternalStore\(subscribeReplyDrafts, hasReplyDrafts, noDrafts\);/);
    expect(link).toMatch(/const noDrafts = \(\): boolean => false;/);
    expect(link).toMatch(/if \(draftsKept\) \{\s*return \(\s*<a ref=\{ref\} href=\{href\} className=\{className\} \{\.\.\.ariaCurrent\}>\s*\{children\}\s*<\/a>\s*\);\s*\}/);
    // The move's only side effect here is which link takes the focus afterwards.
    const source = sourceOf(APP_LINK);
    const navigate = nodesOf(source).find((node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "onNavigate");
    expect(navigate?.initializer?.getText(source).replace(/\s+/g, " ")).toBe("{() => { focusAfterMove = anchorOf(href); }}");
  });

  it("Step 7B-17K: the conversation boundary reports the address's workspace and conversation in one effect, and the Inbox layout draws it", () => {
    const source = sourceOf(SCOPE);
    const calls = nodesOf(source).filter(ts.isCallExpression).map((call) => call.getText(source).replace(/\s+/g, " "));
    expect(calls).toEqual([
      "useParams()",
      'segment(params === null ? undefined : params["workspaceId"])',
      'segment(params === null ? undefined : params["conversationId"])',
      "useEffect(() => showReplyDraftsConversation(workspaceId, conversationId), [workspaceId, conversationId])",
      "showReplyDraftsConversation(workspaceId, conversationId)",
    ]);
    const layout = codeOf("app/workspaces/[workspaceId]/inbox/layout.tsx");
    expect(layout).toMatch(/^import \{ ReplyDraftsConversationScope \} from "@\/ui\/inbox\/reply-drafts-scope";$/m);
    expect(layout).toMatch(/<WorkspaceShell workspaceId=\{workspaceId\} section="inbox">\s*<ReplyDraftsConversationScope \/>\s*\{children\}\s*<\/WorkspaceShell>/);
  });

  it("Step 7B-17K: leaving a conversation forgets every draft, only the conversation on screen keeps one, and no navigation forgets an uncertain outcome", () => {
    const source = sourceOf(DRAFTS);
    const show = functionNamed(source, "showReplyDraftsConversation");
    const body = show.body?.getText(source).replace(/\s+/g, " ") ?? "";
    expect(body).toContain("for (const key of [...drafts.keys()]) if (shown === undefined || conversationOf(key) !== shown) drafts.delete(key);");
    expect(body).toMatch(/return \(\) => \{ if \(shownConversation === shown\) shownConversation = undefined; drafts\.clear\(\); syncLeaveGuard\(\); \};/);
    expect(valueReferences(source, show, "uncertain")).toEqual([]);
    expect(valueReferences(source, show, "pending")).toEqual([]);
    const keep = functionNamed(source, "keepReplyDraft").body?.getText(source).replace(/\s+/g, " ") ?? "";
    expect(keep).toContain("if (scoped && conversationOf(key) !== shownConversation) return;");
  });
});
