/**
 * Writes ui/icons/catalog.ts from the brand kit icons kept in ui/icons/svg (UI-1). Run after changing an icon file:
 *   node tools/brand/generate-icon-catalog.ts
 * Refuses any SVG the reader does not vouch for (see ./icon-svg.ts). Pass --check to only compare and exit 1 on drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readIconDirectory, renderIconCatalog } from "./icon-svg.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const ICON_SVG_DIRECTORY = path.join(ROOT, "ui/icons/svg");
export const ICON_CATALOG_FILE = path.join(ROOT, "ui/icons/catalog.ts");
export const ICON_SOURCE_NOTE = "Source: Wrenkind brand kit v1.1 (2026-10-09), 03-iconos/svg, 42 icons on a 24px grid, stroke 1.75, round caps.";

const icons = readIconDirectory(ICON_SVG_DIRECTORY);
const rendered = renderIconCatalog(icons, ICON_SOURCE_NOTE);
if (process.argv.includes("--check")) {
  const current = readFileSync(ICON_CATALOG_FILE, "utf8");
  if (current !== rendered) {
    console.log("icon catalog: OUT OF DATE (run without --check to regenerate)");
    process.exit(1);
  }
  console.log(`icon catalog: in sync (${String(icons.length)} icons)`);
} else {
  writeFileSync(ICON_CATALOG_FILE, rendered);
  console.log(`icon catalog: wrote ${String(icons.length)} icons to ${path.relative(ROOT, ICON_CATALOG_FILE)}`);
}
