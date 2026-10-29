/**
 * Step H7-D0 — operator CLI of the real-model classification bake-off (tests/eval/classification/live.eval.ts):
 *
 *   npm run eval:classification:live -- --candidates <id,id,…>                                       PLAN: no call
 *   npm run eval:classification:live -- --candidates <id,id,…> --run --confirm-real-model-calls <phrase>   REAL CALLS
 *
 * Refuses in CI (CI / GITHUB_ACTIONS / VERCEL / TRIGGER_* set) and on any unexpected argument, before anything runs.
 * It never reads, prints or forwards a credential: the runner reads the operator's own environment itself.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONFIRMATION = "send-synthetic-corpus-to-real-models-h7-d0";
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
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  if (flag === "--candidates" && candidates === undefined) candidates = args[++i];
  else if (flag === "--run" && !run) run = true;
  else if (flag === "--confirm-real-model-calls" && phrase === undefined) phrase = args[++i];
  else refuse(`unknown or repeated argument: ${flag ?? ""}`);
}
const ids = (candidates ?? "").split(",").filter((id) => id !== "");
if (ids.length === 0 || new Set(ids).size !== ids.length || !ids.every((id) => CANDIDATES.includes(id))) refuse(`--candidates must be distinct ids from ${CANDIDATES.join(", ")}`);
if (run && phrase !== CONFIRMATION) refuse("--run needs --confirm-real-model-calls with the exact phrase");
if (!run && phrase !== undefined) refuse("--confirm-real-model-calls is only valid with --run");

const result = spawnSync(path.join(ROOT, "node_modules/.bin/vitest"), ["run", "--config", "vitest.eval-live.config.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, WRENKIND_LIVE_EVAL_MODE: run ? "run" : "plan", WRENKIND_LIVE_EVAL_CANDIDATES: ids.join(","), WRENKIND_LIVE_EVAL_CONFIRMATION: run ? CONFIRMATION : "" },
});
process.exit(result.status ?? 1);
