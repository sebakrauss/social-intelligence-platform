/**
 * Managed job-runtime suite (T-27 managed leg): Trigger.dev DEVELOPMENT environment + the Supabase
 * development project. Run: `npm run test:jobs:managed`.
 *
 *   - Missing configuration → prints the missing variable NAMES and exits 2: NOT RUN, never a pass.
 *   - Refuses any Trigger.dev key that isn't a DEVELOPMENT key (tr_dev_…). Never production.
 *   - Starts the Trigger.dev CLI as a PINNED, EPHEMERAL tool (`npx trigger.dev@<pinned>`), outside the
 *     repository dependency tree, with trigger.managed-test.config.ts (test tasks only, no schedules). The
 *     CLI uses the operator's own CLI login (`npx trigger.dev@<pinned> login`); this script never handles it.
 *   - The dev worker gets ONLY the worker runtime URL and the CA path, through a 0600 temp file that is
 *     deleted afterwards. All CLI output is redacted before display; secrets are never printed.
 *   - The dev session is stopped at the end, so no test task keeps running.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNTIME_URL_VARIABLES } from "../../platform/db/connection.ts";
import { loadEnvironment, ROOT, VARIABLES } from "../db/environment.ts";

export const TRIGGER_CLI = "trigger.dev@4.7.2";
const READY_TIMEOUT_MS = 180_000;

const env = loadEnvironment();
const triggerVariables = ["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_REF"] as const;
const required = [...triggerVariables, VARIABLES.migration, VARIABLES.projectRef, VARIABLES.sslRootCert, ...Object.values(RUNTIME_URL_VARIABLES)];
const missing = required.filter((name) => (env[name] ?? "") === "");
if (missing.length > 0) {
  console.log(`MANAGED JOB SUITE NOT RUN — missing local configuration: ${missing.join(", ")}`);
  console.log("Set them in .env.local (names in .env.example; never paste values into chat) and re-run. This is not a pass.");
  process.exit(2);
}
const secretKey = env["TRIGGER_SECRET_KEY"] ?? "";
const projectRef = env["TRIGGER_PROJECT_REF"] ?? "";
if (!secretKey.startsWith("tr_dev_")) {
  console.log("REFUSED: TRIGGER_SECRET_KEY is not a DEVELOPMENT environment key (tr_dev_…). Nothing was contacted.");
  process.exit(1);
}
if (!/^proj_[A-Za-z0-9]+$/.test(projectRef)) {
  console.log("REFUSED: TRIGGER_PROJECT_REF is not a project reference (proj_…). Nothing was contacted.");
  process.exit(1);
}

const workerUrl = env[RUNTIME_URL_VARIABLES.worker] ?? "";
const secrets = [secretKey, projectRef, workerUrl, ...Object.values(RUNTIME_URL_VARIABLES).map((name) => env[name] ?? ""), env[VARIABLES.migration] ?? ""]
  .filter((value) => value.length >= 6)
  .sort((a, b) => b.length - a.length);
const redact = (text: string): string => {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out
    .replace(/postgres(ql)?:\/\/\S+/g, "<redacted-url>")
    .replace(/tr_(dev|prod|stg|pat)_[A-Za-z0-9]+/g, "<redacted-key>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\x1b\[[0-9;]*m/g, "");
};

const scratch = mkdtempSync(path.join(os.tmpdir(), "sip-jobs-managed-"));
const envFile = path.join(scratch, "worker.env");
writeFileSync(
  envFile,
  `${RUNTIME_URL_VARIABLES.worker}=${workerUrl}\n${VARIABLES.sslRootCert}=${path.resolve(ROOT, env[VARIABLES.sslRootCert] ?? "")}\n`,
  { mode: 0o600 },
);

let cli: ChildProcess | undefined;
const running = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;
let exitCode = 1;
try {
  console.log(`Managed job suite — Trigger.dev DEVELOPMENT (project ref present) via ephemeral ${TRIGGER_CLI}`);
  cli = spawn(
    "npx",
    ["--yes", TRIGGER_CLI, "dev", "--config", "trigger.managed-test.config.ts", "--env-file", envFile, "--skip-update-check", "--log-level", "log"],
    { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TRIGGER_SECRET_KEY: secretKey, TRIGGER_PROJECT_REF: projectRef, TRIGGER_TELEMETRY_DISABLED: "1", NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines: string[] = [];
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, READY_TIMEOUT_MS);
    const onData = (data: Buffer): void => {
      const text = redact(data.toString());
      lines.push(text);
      if (/not logged in|login required|unauthori[sz]ed/i.test(text)) {
        clearTimeout(timer);
        resolve(false);
      }
      if (/(local worker ready|worker ready|waiting for runs|ready)/i.test(text)) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    cli?.stdout?.on("data", onData);
    cli?.stderr?.on("data", onData);
    cli?.on("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!ready) {
    console.log("FAILED: the Trigger.dev dev session did not become ready. Redacted CLI output (tail):");
    console.log(lines.join("").split("\n").slice(-25).join("\n"));
    console.log(`If the CLI isn't logged in, run: npx ${TRIGGER_CLI} login   (your own CLI login; never stored in this repository)`);
  } else {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const result = spawnSync("npx", ["vitest", "run", "--config", "vitest.jobs-managed.config.ts"], {
      cwd: ROOT,
      env: { ...process.env, TRIGGER_SECRET_KEY: secretKey },
      encoding: "utf8",
    });
    process.stdout.write(redact(`${result.stdout}${result.stderr}`));
    exitCode = result.status ?? 1;
  }
} finally {
  if (cli !== undefined && running(cli)) {
    cli.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (running(cli)) cli.kill("SIGTERM");
  }
  rmSync(scratch, { recursive: true, force: true });
  console.log("Dev session stopped; temporary worker env file deleted.");
}
process.exit(exitCode);
