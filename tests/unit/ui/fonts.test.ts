/**
 * Brand fonts (UI-1): every font file tracked in the repository is byte-identical to what the manifest records from
 * its official distribution (size and SHA-256), each license text is the OFL 1.1 of that distribution with its
 * copyright holder, the three families and the manual's weights are all covered, and the files carry the manual's
 * families in their own name tables (the WOFF2 files are checked by their decoded header, the TTF by its name table).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_FILES, FONT_LICENSE_FILES } from "@/ui/foundations/fonts/manifest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const bytesOf = (file: string): Buffer => readFileSync(path.join(ROOT, file));
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

describe("font files", () => {
  for (const font of FONT_FILES) {
    it(`${font.path} is the recorded ${font.family} file (${font.weights})`, () => {
      const data = bytesOf(font.path);
      expect(data.length).toBe(font.bytes);
      expect(sha256(data)).toBe(font.sha256);
      if (font.format === "woff2") {
        expect(data.subarray(0, 4).toString("latin1")).toBe("wOF2");
        expect(data.readUInt32BE(8)).toBe(data.length);
      } else {
        expect(data.readUInt32BE(0)).toBe(0x00010000);
      }
    });
  }

  it("covers the three families and the manual's weights (Outfit 400 and 600, Inter 400 and 500, Mono 400 and 500)", () => {
    const byFamily = new Map<string, string[]>();
    for (const font of FONT_FILES) byFamily.set(font.family, [...(byFamily.get(font.family) ?? []), font.weights]);
    expect([...byFamily.keys()].sort()).toEqual(["Inter", "JetBrains Mono", "Outfit"]);
    expect(byFamily.get("Outfit")?.[0]).toMatch(/^100 900/);
    expect(byFamily.get("Inter")).toEqual(["400", "500"]);
    expect(byFamily.get("JetBrains Mono")).toEqual(["400", "500"]);
  });

  it("stays small: under 600 KB in total, no file above 120 KB", () => {
    const total = FONT_FILES.reduce((sum, font) => sum + font.bytes, 0);
    expect(total).toBeLessThan(600_000);
    for (const font of FONT_FILES) expect(font.bytes, font.path).toBeLessThan(120_000);
  });

  it("the Outfit TTF names its family and version in its name table", () => {
    const names = nameTable(bytesOf("ui/foundations/fonts/outfit/Outfit[wght].ttf"));
    expect(names.get(1)).toMatch(/^Outfit/);
    expect(names.get(5)).toMatch(/^Version 1\.100/);
  });
});

describe("license texts", () => {
  for (const license of FONT_LICENSE_FILES) {
    it(`${license.path} is the distribution's text`, () => {
      const data = bytesOf(license.path);
      expect(sha256(data)).toBe(license.sha256);
      const text = data.toString("utf8");
      if (license.path.endsWith("AUTHORS.txt")) return;
      expect(text).toContain(license.holder);
      expect(text).toContain("SIL Open Font License, Version 1.1");
      expect(text).toMatch(/PERMISSION (&|AND) CONDITIONS/);
      expect(text).toContain("scripts.sil.org/OFL");
      expect(text).toContain("in Original or Modified Versions, may be sold by itself.");
      expect(text).toContain("TERMINATION");
      expect(text).toContain("DISCLAIMER");
    });
  }

  it("every font file points at a license that exists in the manifest", () => {
    const licenses = new Set(FONT_LICENSE_FILES.map((license) => license.path));
    for (const font of FONT_FILES) expect(licenses.has(font.license), font.path).toBe(true);
  });
});

/** Windows-platform (UTF-16BE) entries of an OpenType name table, by name id. */
function nameTable(data: Buffer): Map<number, string> {
  const tableCount = data.readUInt16BE(4);
  let nameOffset = -1;
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16;
    if (data.toString("latin1", record, record + 4) === "name") nameOffset = data.readUInt32BE(record + 8);
  }
  expect(nameOffset).toBeGreaterThan(0);
  const count = data.readUInt16BE(nameOffset + 2);
  const strings = nameOffset + data.readUInt16BE(nameOffset + 4);
  const names = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const record = nameOffset + 6 + i * 12;
    if (data.readUInt16BE(record) !== 3) continue;
    const id = data.readUInt16BE(record + 6);
    const length = data.readUInt16BE(record + 8);
    const offset = strings + data.readUInt16BE(record + 10);
    let text = "";
    for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(data.readUInt16BE(offset + k));
    names.set(id, text);
  }
  return names;
}
