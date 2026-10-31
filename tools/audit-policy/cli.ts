/**
 * CI dependency audit (Step H7-D1b-sec1): runs the FULL `npm audit --json` (all dependencies) and the production
 * cross-check `npm audit --omit=dev --json`, reads package-lock.json and applies `policy.ts` with the exact temporary
 * exceptions of `exceptions.ts`. Exits 0 only on PASS / PASS_WITH_TEMPORARY_EXCEPTION; any other outcome — another
 * advisory, a production finding, an expired or stale exception, unparseable output, an unexpected npm exit — exits 1.
 * Prints advisory ids, severities, packages and node paths only. Run: `node tools/audit-policy/cli.ts`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AUDIT_EXCEPTIONS } from "./exceptions.ts";
import { evaluateAuditPolicy } from "./policy.ts";

/** `npm audit` exits 0 (no findings) or 1 (findings); anything else, or output that isn't JSON, is a failure. */
function audit(args: readonly string[]): unknown {
  const run = spawnSync("npm", ["audit", "--json", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error !== undefined || (run.status !== 0 && run.status !== 1)) return undefined;
  try {
    return JSON.parse(run.stdout) as unknown;
  } catch {
    return undefined;
  }
}

const full = audit([]);
const production = audit(["--omit=dev"]);
let lockfile: unknown;
try {
  lockfile = JSON.parse(readFileSync("package-lock.json", "utf8")) as unknown;
} catch {
  lockfile = undefined;
}

const result = evaluateAuditPolicy({ full, production, lockfile, today: new Date().toISOString().slice(0, 10), exceptions: AUDIT_EXCEPTIONS });

console.log("audit-policy: full npm audit (all dependencies) + production cross-check (--omit=dev)");
for (const advisory of result.advisories) {
  const exception = result.appliedExceptions.find((e) => e.advisory === advisory.advisory);
  const note = exception === undefined ? "NOT COVERED" : `TEMPORARY EXCEPTION (dev-only, expires ${exception.expiresOn})`;
  console.log(`audit-policy: ${advisory.advisory} ${advisory.severity} ${advisory.package} [${advisory.nodes.join(", ")}] — ${note}`);
}
if (result.nodes.length > 0) console.log(`audit-policy: ${String(result.nodes.length)} flagged node(s): ${result.nodes.join(", ")}`);
for (const reason of result.reasons) console.error(`audit-policy: FAIL ${reason}`);
console.log(`audit-policy: ${result.verdict}`);
process.exitCode = result.verdict === "FAIL" ? 1 : 0;
