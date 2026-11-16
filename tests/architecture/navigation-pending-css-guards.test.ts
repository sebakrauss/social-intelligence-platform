/**
 * Step 7B-17M — the "on its way" signal of the in-app links (ui/navigation/app-link.tsx) is hidden at rest and drawn
 * only while its link's move is under way (data-pending="true"). Step 7B-17L found a rule whose first selector had lost
 * that condition, so every Inbox row showed the signal permanently. Here: in the stylesheets that draw the signal, every
 * rule that shows it (a visible opacity or an animation) names the pending state on EVERY selector that names a signal
 * class, and the signal's base rule hides it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT } from "../support/source-scan";

const SHEETS: Readonly<Record<string, readonly string[]>> = {
  "ui/inbox/inbox.module.css": ["rowPending", "navPending"],
  "ui/shell/app-shell.module.css": ["linkPending"],
};
const ACTIVE = '[data-pending="true"]';

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** The innermost rules of a stylesheet (comments removed): each selector list with its declarations. */
function rulesOf(css: string): Rule[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selectors: (match[1] ?? "").split(",").map((selector) => selector.trim()), body: match[2] ?? "" }));
}

const names = (selector: string, signal: string): boolean => new RegExp(`\\.${signal}\\b`).test(selector);
/** Whether these declarations make the signal visible: an opacity other than 0, or an animation. */
const shows = (body: string): boolean => /(^|;)\s*animation(-name)?\s*:/.test(body) || [...body.matchAll(/(^|;)\s*opacity\s*:\s*([^;]+)/g)].some((match) => Number.parseFloat(match[2] ?? "") !== 0);

/** Selectors that show a signal without naming its pending state. */
function unconditional(css: string, signals: readonly string[]): string[] {
  return rulesOf(css)
    .filter((rule) => shows(rule.body))
    .flatMap((rule) => rule.selectors.filter((selector) => signals.some((signal) => names(selector, signal)) && !selector.includes(ACTIVE)));
}

describe("the in-app links' pending signal", () => {
  for (const [file, signals] of Object.entries(SHEETS)) {
    const css = readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");

    it(`${file}: hidden at rest, shown only while data-pending="true"`, () => {
      expect(unconditional(css, signals)).toEqual([]);
      for (const signal of signals) {
        const rules = rulesOf(css).filter((rule) => rule.selectors.some((selector) => names(selector, signal)));
        // The base rule (the bare class) hides it and takes it out of the flow (no layout shift).
        const base = rules.filter((rule) => rule.selectors.some((selector) => selector === `.${signal}`));
        expect(base, signal).toHaveLength(1);
        expect(base[0]?.body, signal).toMatch(/opacity:\s*0;/);
        expect(base[0]?.body, signal).toMatch(/position:\s*absolute;/);
        // And one rule does show it, in the pending state.
        expect(rules.some((rule) => shows(rule.body) && rule.selectors.some((selector) => selector === `.${signal}${ACTIVE}`)), signal).toBe(true);
      }
    });
  }

  it("the check tells an unconditional selector from a scoped one (the Step 7B-17L defect)", () => {
    const defect = '.rowPending,\n.navPending[data-pending="true"] {\n  opacity: 1;\n  animation: linkPending 1s forwards;\n}';
    const fixed = '.rowPending[data-pending="true"],\n.navPending[data-pending="true"] {\n  opacity: 1;\n  animation: linkPending 1s forwards;\n}';
    expect(unconditional(defect, ["rowPending", "navPending"])).toEqual([".rowPending"]);
    expect(unconditional(fixed, ["rowPending", "navPending"])).toEqual([]);
    expect(unconditional(".rowPending { opacity: 0; position: absolute; }", ["rowPending"])).toEqual([]);
    expect(unconditional(".rowPending { opacity: 0.5; }", ["rowPending"])).toEqual([".rowPending"]);
  });
});
