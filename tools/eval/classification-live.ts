/**
 * Step H7-D0 — operator CLI of the real-model classification bake-off (tests/eval/classification/live.eval.ts):
 *
 *   npm run eval:classification:live -- --candidates <id,id,…>                                       PLAN: no call
 *   npm run eval:classification:live -- --candidates <id,id,…> --run --confirm-real-model-calls <phrase>   REAL CALLS
 *   … --stability-only --parent <evidence.json> --parent-sha256 <hex> [--run --confirm-real-model-calls <phrase>]
 *                                            (H7-D0v2d) stability-only PLAN / RUN of the BAR_B-eligible candidates
 *   … --stability-replay --parent <f> --parent-sha256 <hex> --stability <f> --stability-sha256 <hex>
 *                                            (H7-D0v2g) OFFLINE replay under the current stability policy: no call
 *
 * Refuses in CI (CI / GITHUB_ACTIONS / VERCEL / TRIGGER_* set) and on any unexpected argument, before anything runs.
 * It never reads, prints or forwards a credential: the runner reads the operator's own environment itself.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONFIRMATION = "send-synthetic-corpus-to-real-models-h7-d0";
const STABILITY_CONFIRMATION = "send-synthetic-critical-cases-to-real-models-h7-d0-stability";
const CANDIDATES = ["gpt-6-luna", "gpt-6.1-terra", "claude-sonnet-5-5"];

const refuse = (message: string, code = 2): never => {
  console.log(`live eval REFUSED (nothing ran): ${message}`);
  process.exit(code);
};

if (["CI", "GITHUB_ACTIONS", "VERCEL", "TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"].some((name) => process.env[name] !== undefined)) refuse("CI / deployed environment", 1);
const args = process.argv.slice(2);
let candidates: string | undefined;
let run = false;
let phrase: string | undefined;
let stabilityOnly = false;
let parent: string | undefined;
let parentSha: string | undefined;
let stabilityReplay = false;
let stabilityFile: string | undefined;
let stabilitySha: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  if (flag === "--candidates" && candidates === undefined) candidates = args[++i];
  else if (flag === "--run" && !run) run = true;
  else if (flag === "--confirm-real-model-calls" && phrase === undefined) phrase = args[++i];
  else if (flag === "--stability-only" && !stabilityOnly) stabilityOnly = true;
  else if (flag === "--parent" && parent === undefined) parent = args[++i];
  else if (flag === "--parent-sha256" && parentSha === undefined) parentSha = args[++i];
  else if (flag === "--stability-replay" && !stabilityReplay) stabilityReplay = true;
  else if (flag === "--stability" && stabilityFile === undefined) stabilityFile = args[++i];
  else if (flag === "--stability-sha256" && stabilitySha === undefined) stabilitySha = args[++i];
  else refuse(`unknown or repeated argument: ${flag ?? ""}`);
}
const ids = (candidates ?? "").split(",").filter((id) => id !== "");
if (ids.length === 0 || new Set(ids).size !== ids.length || !ids.every((id) => CANDIDATES.includes(id))) refuse(`--candidates must be distinct ids from ${CANDIDATES.join(", ")}`);
const expectedPhrase = stabilityOnly ? STABILITY_CONFIRMATION : CONFIRMATION;
if (run && phrase !== expectedPhrase) refuse("--run needs --confirm-real-model-calls with the exact phrase");
if (stabilityOnly && (parent === undefined || parentSha === undefined || !/^[0-9a-f]{64}$/.test(parentSha))) refuse("--stability-only needs --parent <evidence.json> and --parent-sha256 <64 hex>");
if (stabilityReplay && (run || phrase !== undefined || stabilityOnly)) refuse("--stability-replay is offline: no --run, no confirmation, no --stability-only");
if (stabilityReplay && (parent === undefined || !/^[0-9a-f]{64}$/.test(parentSha ?? "") || stabilityFile === undefined || !/^[0-9a-f]{64}$/.test(stabilitySha ?? ""))) refuse("--stability-replay needs --parent, --parent-sha256, --stability and --stability-sha256");
if (!stabilityOnly && !stabilityReplay && (parent !== undefined || parentSha !== undefined)) refuse("--parent / --parent-sha256 are only valid with --stability-only or --stability-replay");
if (!stabilityReplay && (stabilityFile !== undefined || stabilitySha !== undefined)) refuse("--stability / --stability-sha256 are only valid with --stability-replay");
if (!run && phrase !== undefined) refuse("--confirm-real-model-calls is only valid with --run");

const result = spawnSync(path.join(ROOT, "node_modules/.bin/vitest"), ["run", "--config", "vitest.eval-live.config.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    WRENKIND_LIVE_EVAL_MODE: stabilityReplay ? "stability-replay" : stabilityOnly ? (run ? "stability-run" : "stability-plan") : run ? "run" : "plan",
    WRENKIND_LIVE_EVAL_CANDIDATES: ids.join(","),
    WRENKIND_LIVE_EVAL_CONFIRMATION: run ? expectedPhrase : "",
    WRENKIND_LIVE_EVAL_PARENT: parent ?? "",
    WRENKIND_LIVE_EVAL_PARENT_SHA256: parentSha ?? "",
    WRENKIND_LIVE_EVAL_STABILITY: stabilityFile ?? "",
    WRENKIND_LIVE_EVAL_STABILITY_SHA256: stabilitySha ?? "",
  },
});
process.exit(result.status ?? 1);
