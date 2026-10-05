/**
 * Runs the managed database suite only when its local configuration exists. When it doesn't, prints which
 * variables are missing (names only) and exits with code 2: the suite is reported as NOT RUN, never PASS.
 */
import { spawnSync } from "node:child_process";
import { RUNTIME_URL_VARIABLES } from "../../platform/db/connection.ts";
import { loadEnvironment, ROOT, VARIABLES } from "./environment.ts";

const env = loadEnvironment();
const required = [VARIABLES.migration, VARIABLES.projectRef, VARIABLES.sslRootCert, ...Object.values(RUNTIME_URL_VARIABLES)];
const missing = required.filter((name) => (env[name] ?? "") === "");
if (missing.length > 0) {
  console.log(`MANAGED DATABASE SUITE NOT RUN — missing local configuration: ${missing.join(", ")}`);
  console.log("Populate .env.local (see README › Database) and re-run. This is not a pass.");
  process.exit(2);
}
const result = spawnSync("npx", ["vitest", "run", "--config", "vitest.db-managed.config.ts"], { cwd: ROOT, stdio: "inherit" });
process.exit(result.status ?? 1);
