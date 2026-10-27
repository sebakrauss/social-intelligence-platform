/**
 * H6 closeout — the final record keeps its evidence classes honest: LIVE vs simulator vs limitation vs deferred, the
 * overlap-idempotency reservation, the removal limitation and the read/write distinction can't silently disappear.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT } from "../support/source-scan";

const closeout = readFileSync(path.join(REPOSITORY_ROOT, "design/h6-ingestion/CLOSEOUT.md"), "utf8");
const section = (heading: string): string => {
  const from = closeout.indexOf(heading);
  expect(from, heading).toBeGreaterThanOrEqual(0);
  const next = closeout.indexOf("\n## ", from + heading.length);
  return next === -1 ? closeout.slice(from) : closeout.slice(from, next);
};

describe("H6 closeout record", () => {
  it("keeps the four evidence classes and never promotes simulator evidence to LIVE", () => {
    for (const label of ["PROVEN LIVE", "PROVEN BY SIMULATOR", "KNOWN LIMITATION", "DEFERRED"]) expect(closeout).toContain(`**${label}**`);
    expect(section("### Not proven LIVE")).toMatch(/Overlap idempotency: NOT PROVEN LIVE\. PROVEN BY SIMULATOR/);
  });

  it("freezes the removal limitation and the read/write capability distinction", () => {
    expect(closeout).toMatch(/\*\*Absence from a listing is not removal authority\.\*\*/);
    expect(closeout).toMatch(/Absence-as-not-removal: not exercised LIVE/);
    expect(closeout).toMatch(/It says nothing about a future `create_reply`/);
  });

  it("freezes the capability matrix, the budgets and the final authority", () => {
    expect(closeout).toMatch(/\| Instagram · `post\/unknown` \| SUPPORTED \| AVAILABLE_WITH_LIMITATION \| read \| \*\*`REPLIES_NOT_READ`\*\* \| YES \(H6-D2\) \|/);
    expect(closeout).toMatch(/\| Facebook · `post\/unknown` \| SUPPORTED \| SUPPORTED \| read \| read \| YES \(H6-D1\) \|/);
    expect(section("## Budget model")).toMatch(/\| \*\*40\*\* \| \*\*8\*\* \|/);
    expect(section("## Final authority (closeout)")).toMatch(/`20261027\.4 @da86455`, 6 tasks[\s\S]*`20261027\.4 @da86455`, 8 tasks/);
  });

  it("lists every deferred item as deferred, not complete", () => {
    const deferred = section("## Deferred (not complete)");
    for (const item of [/Direct removal confirmation/, /Webhook signal ingestion/, /Recurring scheduler and fan-out/, /Provider write capabilities/, /Full audit provenance hardening/, /content scope not validated/]) {
      expect(deferred).toMatch(item);
    }
  });
});
