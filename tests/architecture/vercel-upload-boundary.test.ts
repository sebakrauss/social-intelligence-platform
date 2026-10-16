/**
 * The hosted web's Vercel CLI upload boundary (.vercelignore; TA-11A, Step 7E.10-C5A-R2A). The CLI applies only this
 * file plus its built-in defaults — never .gitignore or .git/info/exclude — so every local-only tree the repository
 * relies on git exclusion for must be listed here explicitly, root-anchored and exact.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT } from "../support/source-scan";

const rules = (): string[] =>
  readFileSync(path.join(REPOSITORY_ROOT, ".vercelignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

/** Directories and files `next build` needs: no rule may exclude them. */
const APPLICATION_PATHS = ["app", "ui", "server", "platform", "domain", "modules", "integrations", "jobs", "db", "tools", "fixtures", "package.json", "package-lock.json", "next.config.ts", "proxy.ts", "tsconfig.json"];

describe("Vercel CLI upload boundary (.vercelignore)", () => {
  it("excludes the local-only harness, evidence and tooling tree with the exact root-anchored rule", () => {
    const wrenkind = rules().filter((rule) => rule.includes("wrenkind"));
    expect(wrenkind).toEqual(["/.wrenkind-local/"]);
    expect(wrenkind[0]).not.toMatch(/[*?[\]!]/);
  });

  it("no rule excludes application source or the build's own configuration", () => {
    for (const rule of rules()) {
      const anchored = rule.replace(/^\//, "").replace(/\/$/, "");
      for (const required of APPLICATION_PATHS) expect(anchored, `${rule} must not exclude ${required}`).not.toBe(required);
      expect(rule, rule).not.toMatch(/^\*+\/?$|^\/\*|^\*\*/);
    }
  });
});
