/**
 * PUSH-01A — no real Trigger.dev project reference is ever committed. The repository is public and the project ref is
 * configuration, read from TRIGGER_PROJECT_REF (trigger.config.ts: "The project reference is never committed"). PUSH-01
 * found a real ref in a unit test of an unpublished commit; PUSH-01A removed it from the unpublished history.
 *
 * The guard scans EVERY tracked file (git ls-files, so untracked local evidence such as tools/perf/ is never read) for
 * anything in the operator's project-ref format (`proj_` + 8–64 lower-case letters or digits, tools/trigger/release-pair.ts)
 * and allows only the exact synthetic fixtures listed below. Each listed fixture must itself LOOK synthetic (a marker
 * word, a repeated letter or a sequential run), so a random-looking real ref cannot be allow-listed quietly.
 *
 * LIMITATION: the format alone cannot tell a real ref from a synthetic one. This guard does not "detect real refs"; it
 * refuses every ref that is not an explicitly reviewed synthetic fixture. It does not see refs written in another form
 * (upper case, split or encoded strings, URLs with a different shape), files outside git, or history already published,
 * and it runs when the tests run (locally before a commit or push, and in CI only after a push).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT } from "../support/source-scan";

/** The operator's project-ref format (tools/trigger/release-pair.ts PROJECT_REF), unanchored, as a scan. */
const PROJECT_REF_SCAN = /proj_[a-z0-9]{8,64}/g;

/** The ONLY project-shaped strings the repository may contain: synthetic test fixtures. Review every addition. */
const SYNTHETIC_PROJECT_REFS: readonly string[] = Object.freeze([
  "proj_a1234567",
  "proj_b1234567",
  "proj_c1234567",
  "proj_aaaaaaaa1",
  "proj_bbbbbbbb2",
  "proj_cccccccc3",
  "proj_integrationtestref01",
  "proj_intelligencetestref1",
  "proj_maintestrefabcdefghij",
  "proj_someotherprojectxx",
  "proj_synthetic",
  "proj_unapprovedtestref01",
  "proj_unrelatedintegaaaaa",
  "proj_unrelatedintelaaaaa",
  "proj_unrelatedmainaaaaaa",
]);

/** A fixture is recognisably synthetic: a marker word, a letter repeated 8 times, or a sequential digit run. */
const LOOKS_SYNTHETIC = [/test|synthetic|unrelated|other|example|fixture/, /([a-z])\1{7}/, /1234567/] as const;
export const looksSynthetic = (ref: string): boolean => LOOKS_SYNTHETIC.some((pattern) => pattern.test(ref.slice("proj_".length)));

/** Every project-shaped string in `text` that is not an allowed synthetic fixture. */
export function unapprovedProjectRefs(text: string, allowed: readonly string[] = SYNTHETIC_PROJECT_REFS): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PROJECT_REF_SCAN)) {
    // The scan is greedy within the format, so a longer ref is never reported as an allowed prefix of itself.
    if (!allowed.includes(match[0])) found.add(match[0]);
  }
  return [...found].sort();
}

function trackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  // Fail closed: without git the tracked set is unknown, so the guard cannot pass.
  if (result.status !== 0) throw new Error("git ls-files failed; the tracked-file scan cannot run");
  return result.stdout.split("\0").filter((file) => file !== "");
}

// Built at run time so this file's own source never holds an unapproved ref (the repository scan reads it too).
const RANDOM_LOOKING = ["proj_", "qhzvkwmrtbnplxjcydfa"].join("");
const LONGER_THAN_FIXTURE = ["proj_unapprovedtestref01", "x"].join("");

describe("PUSH-01A: no real Trigger.dev project reference is committed", () => {
  it("every tracked file holds only reviewed synthetic project-ref fixtures", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((file) => file.startsWith("tools/perf/"))).toBe(false);
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");
      } catch {
        continue; // A tracked path missing from this checkout (e.g. a sparse checkout) holds nothing to scan.
      }
      if (text.includes("\0")) continue; // Binary.
      // Only the count is reported for an offender, never the value: the report must not republish it.
      const unapproved = unapprovedProjectRefs(text);
      if (unapproved.length > 0) offenders.push(`${file}: ${String(unapproved.length)} project reference(s) not in SYNTHETIC_PROJECT_REFS`);
    }
    expect(offenders).toEqual([]);
  });

  it("every allowed fixture looks synthetic and has the operator's project-ref format", () => {
    for (const ref of SYNTHETIC_PROJECT_REFS) {
      expect(ref, ref).toMatch(/^proj_[a-z0-9]{8,64}$/);
      expect(looksSynthetic(ref), ref).toBe(true);
    }
    expect(new Set(SYNTHETIC_PROJECT_REFS).size).toBe(SYNTHETIC_PROJECT_REFS.length);
  });

  it("refuses a random-looking (real-shaped) ref, in code, prose, URLs and longer forms of an allowed fixture", () => {
    expect(looksSynthetic(RANDOM_LOOKING)).toBe(false);
    expect(unapprovedProjectRefs(`projectRefs: { integration: "${RANDOM_LOOKING}" }`)).toEqual([RANDOM_LOOKING]);
    expect(unapprovedProjectRefs(`the spare project ${RANDOM_LOOKING} was used`)).toEqual([RANDOM_LOOKING]);
    expect(unapprovedProjectRefs(`https://cloud.trigger.dev/orgs/x/projects/y/${RANDOM_LOOKING}/runs`)).toEqual([RANDOM_LOOKING]);
    expect(unapprovedProjectRefs(LONGER_THAN_FIXTURE)).toEqual([LONGER_THAN_FIXTURE]);
    expect(unapprovedProjectRefs(`${RANDOM_LOOKING} and ${RANDOM_LOOKING}`)).toEqual([RANDOM_LOOKING]);
  });

  it("allows the synthetic fixtures and text without a project-shaped string", () => {
    expect(unapprovedProjectRefs('const REFS = { main: "proj_maintestrefabcdefghij", integration: "proj_unapprovedtestref01" };')).toEqual([]);
    expect(unapprovedProjectRefs('project: process.env["TRIGGER_PROJECT_REF"] ?? ""')).toEqual([]);
    expect(unapprovedProjectRefs("proj_short and proj_ alone")).toEqual([]);
  });

  it("states its limit: the format cannot classify a ref — an allow-list entry is a review decision, not detection", () => {
    // A random-looking value is refused even when it is in fact synthetic: unknown means not allowed.
    expect(unapprovedProjectRefs(RANDOM_LOOKING, [])).toEqual([RANDOM_LOOKING]);
    // And the allow-list check refuses to admit a random-looking value as a fixture.
    expect([...SYNTHETIC_PROJECT_REFS, RANDOM_LOOKING].every(looksSynthetic)).toBe(false);
  });
});
