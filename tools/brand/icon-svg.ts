/**
 * Brand icon SVG reader (UI-1). The brand kit's 42 icons are tiny SVGs on a 24px grid: `fill="none"
 * stroke="currentColor" stroke-width="1.75"` on the root and a flat list of <path d> and <circle cx cy r> children.
 * This reads exactly that shape into data (never markup, so the UI renders it as React elements and no HTML string
 * reaches the page) and refuses anything else: a script, a style, a foreign element, an unknown attribute or a
 * hard-coded color other than the one blue dot the manual allows on the Persona icon (which becomes the
 * `human` fill token).
 *
 * Node built-ins only; used by the catalog generator and by the test that keeps the generated catalog in sync.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ICON_FILE_PREFIX = "wrenkind_icon_";
/** The manual's one exception: only the Persona icon carries the blue dot. */
export const HUMAN_DOT_HEX = "#4C7DFF";
export const ICON_ROOT_ATTRIBUTES = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;
/** Manual §9: stroke 1.75 on the 24px grid. One kit icon (Más: three dots drawn as zero-length strokes) uses 3. */
export const ICON_STROKE_WIDTH = 1.75;

export type IconShape =
  | { readonly kind: "path"; readonly d: string }
  | { readonly kind: "rect"; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rx: number }
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number; readonly fill?: "human" };

export interface IconDefinition {
  /** Kit name without prefix, hyphenated: `nav_inbox` → `nav-inbox`. */
  readonly name: string;
  /** The kit's <title> text (Spanish), kept for provenance only; the UI labels icons through i18n. */
  readonly kitTitle: string;
  /** Present only when the kit file deviates from the manual's 1.75 (the dots of Más are strokes of width 3). */
  readonly strokeWidth?: number;
  readonly shapes: readonly IconShape[];
}

const ROOT = /^<svg\s([^>]*)>([\s\S]*)<\/svg>\s*$/;
const ATTRIBUTE = /([a-zA-Z:-]+)="([^"]*)"/g;
const CHILD = /<(path|circle|rect|title)\b([^>]*?)(?:\/>|>([^<]*)<\/\1>)/g;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) out.set(match[1] ?? "", match[2] ?? "");
  return out;
}

function number(value: string | undefined, what: string, file: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed)) throw new Error(`${file}: ${what} is not a number`);
  return parsed;
}

/** Reads one kit icon file; throws on any shape this reader does not vouch for. */
export function readIconSvg(file: string, svg: string): IconDefinition {
  const base = path.basename(file);
  if (!base.startsWith(ICON_FILE_PREFIX) || !base.endsWith(".svg")) throw new Error(`${file}: not a kit icon file name`);
  if (/<script|<style|javascript:|<!ENTITY|<foreignObject|<image|href=/i.test(svg)) throw new Error(`${file}: contains active or external content`);
  const root = ROOT.exec(svg.trim());
  if (root?.[1] === undefined || root[2] === undefined) throw new Error(`${file}: not a single <svg> element`);
  const rootAttributes = attributes(root[1]);
  for (const [name, expected] of Object.entries(ICON_ROOT_ATTRIBUTES)) {
    if (rootAttributes.get(name) !== expected) throw new Error(`${file}: root ${name} is not ${expected}`);
  }
  for (const name of rootAttributes.keys()) {
    if (!(name in ICON_ROOT_ATTRIBUTES) && name !== "xmlns" && name !== "width" && name !== "height" && name !== "stroke-width") throw new Error(`${file}: unexpected root attribute ${name}`);
  }
  const strokeWidth = number(rootAttributes.get("stroke-width"), "stroke-width", file);
  if (strokeWidth <= 0 || strokeWidth > 4) throw new Error(`${file}: stroke-width out of range`);
  const body = root[2].trim();
  let kitTitle = "";
  const shapes: IconShape[] = [];
  let consumed = "";
  for (const match of body.matchAll(CHILD)) {
    consumed += match[0];
    const tag = match[1];
    const attrs = attributes(match[2] ?? "");
    if (tag === "title") {
      kitTitle = (match[3] ?? "").trim();
      continue;
    }
    if (tag === "path") {
      const d = attrs.get("d");
      if (d === undefined || attrs.size !== 1 || !/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/.test(d)) throw new Error(`${file}: path must carry only a plain d`);
      shapes.push({ kind: "path", d });
      continue;
    }
    if (tag === "rect") {
      const expected = ["x", "y", "width", "height", "rx"];
      if (attrs.size !== expected.length || expected.some((name) => !attrs.has(name))) throw new Error(`${file}: rect must carry exactly x, y, width, height and rx`);
      shapes.push({ kind: "rect", x: number(attrs.get("x"), "x", file), y: number(attrs.get("y"), "y", file), width: number(attrs.get("width"), "width", file), height: number(attrs.get("height"), "height", file), rx: number(attrs.get("rx"), "rx", file) });
      continue;
    }
    const allowed = new Set(["cx", "cy", "r", "fill", "stroke"]);
    for (const name of attrs.keys()) if (!allowed.has(name)) throw new Error(`${file}: unexpected circle attribute ${name}`);
    const fill = attrs.get("fill");
    const stroke = attrs.get("stroke");
    const circle = { kind: "circle" as const, cx: number(attrs.get("cx"), "cx", file), cy: number(attrs.get("cy"), "cy", file), r: number(attrs.get("r"), "r", file) };
    if (fill === undefined && stroke === undefined) {
      shapes.push(circle);
    } else if (fill === HUMAN_DOT_HEX && stroke === "none") {
      shapes.push({ ...circle, fill: "human" });
    } else {
      throw new Error(`${file}: circle colors other than the Persona dot are not allowed`);
    }
  }
  if (consumed.replace(/\s+/g, "") !== body.replace(/\s+/g, "")) throw new Error(`${file}: contains elements other than path, circle, rect and title`);
  if (shapes.length === 0) throw new Error(`${file}: no shapes`);
  const name = base.slice(ICON_FILE_PREFIX.length, -".svg".length).replace(/_/g, "-");
  if (!/^[a-z]+-[a-z]+$/.test(name)) throw new Error(`${file}: icon name must be family-name`);
  return strokeWidth === ICON_STROKE_WIDTH ? { name, kitTitle, shapes } : { name, kitTitle, strokeWidth, shapes };
}

/** Every kit icon in a directory, sorted by name. */
export function readIconDirectory(directory: string): readonly IconDefinition[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".svg"))
    .sort()
    .map((entry) => readIconSvg(entry, readFileSync(path.join(directory, entry), "utf8")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The TypeScript source of ui/icons/catalog.ts for a set of icons: data only, no imports, stable ordering. */
export function renderIconCatalog(icons: readonly IconDefinition[], sourceNote: string): string {
  const lines: string[] = [
    "/**",
    " * GENERATED by tools/brand/generate-icon-catalog.ts from ui/icons/svg — do not edit by hand.",
    ` * ${sourceNote}`,
    " * Shapes are data (paths and circles), rendered as React elements by ./icon.tsx; the Persona dot is the only color and",
    " * it is the `human` token. tests/unit/ui/icons.test.ts regenerates this from the SVGs and fails when they differ.",
    " */",
    "",
    "export type IconShape =",
    '  | { readonly kind: "path"; readonly d: string }',
    '  | { readonly kind: "rect"; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rx: number }',
    '  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number; readonly fill?: "human" };',
    "",
    "export const ICON_NAMES = [",
    ...icons.map((icon) => `  ${JSON.stringify(icon.name)},`),
    "] as const;",
    "export type IconName = (typeof ICON_NAMES)[number];",
    "",
    "/** A kit icon: its shapes and, only where the kit deviates from the manual's 1.75, its own stroke width. */",
    "export interface IconDefinition {",
    "  readonly strokeWidth?: number;",
    "  readonly shapes: readonly IconShape[];",
    "}",
    "",
    "export const ICONS: { readonly [N in IconName]: IconDefinition } = {",
  ];
  for (const icon of icons) {
    lines.push(`  ${JSON.stringify(icon.name)}: {${icon.strokeWidth === undefined ? "" : ` strokeWidth: ${String(icon.strokeWidth)},`} shapes: [`);
    for (const shape of icon.shapes) {
      if (shape.kind === "path") lines.push(`    { kind: "path", d: ${JSON.stringify(shape.d)} },`);
      else if (shape.kind === "rect") lines.push(`    { kind: "rect", x: ${String(shape.x)}, y: ${String(shape.y)}, width: ${String(shape.width)}, height: ${String(shape.height)}, rx: ${String(shape.rx)} },`);
      else lines.push(`    { kind: "circle", cx: ${String(shape.cx)}, cy: ${String(shape.cy)}, r: ${String(shape.r)}${shape.fill === undefined ? "" : ', fill: "human"'} },`);
    }
    lines.push("  ] },");
  }
  lines.push("};", "");
  return lines.join("\n");
}
