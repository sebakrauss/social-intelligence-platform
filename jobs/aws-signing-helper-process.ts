/**
 * The ONLY place a process is started in the jobs runtime (Step 7G-H5.6B): the packaged, digest-verified AWS IAM Roles
 * Anywhere credential helper, for the integration worker's identity adapter (jobs/integration-aws-identity.ts).
 *
 *   verifiedAwsSigningHelper   the packaged build for this OS/CPU (jobs/aws-signing-helper.ts), a regular executable file
 *                              whose SHA-256 equals the pinned digest — checked once per path per process (only a
 *                              success is remembered). Missing, unsupported, not executable or mismatched → IDENTITY_MISCONFIGURED.
 *   nodeSigningHelperProcess   `spawn` with an explicit argument array and `shell: false`, an EMPTY environment (no AWS_*,
 *                              proxy, provider or database variable reaches the helper), stdin closed, stdout/stderr
 *                              captured up to a bound, a hard timeout (SIGKILL). It reports what happened; it never
 *                              logs, interprets or forwards the output — the adapter classifies it and drops it.
 *
 * Secret material never appears in an argument: the adapter passes file paths only.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { AwsIdentityError } from "@/platform/aws/identity";
import { AWS_SIGNING_HELPER_DIRECTORY, AWS_SIGNING_HELPER_EXECUTABLE, awsSigningHelperArtifact } from "./aws-signing-helper";

export interface SigningHelperRun {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Killed by our timeout. */
  readonly timedOut: boolean;
  /** Killed because an output stream exceeded the bound. */
  readonly overflow: boolean;
  /** The process could not be started at all. */
  readonly spawnFailure: "not_found" | "permission" | "other" | null;
}

export interface SigningHelperProcess {
  run(executable: string, args: readonly string[], options: { readonly timeoutMs: number; readonly maxOutputBytes: number }): Promise<SigningHelperRun>;
}

/** The helper's ENTIRE environment: nothing. (The repository's ProcessEnv typing requires NODE_ENV; the child gets none.) */
const EMPTY_ENVIRONMENT = Object.freeze({}) as NodeJS.ProcessEnv;

const misconfigured = (): never => {
  throw new AwsIdentityError("IDENTITY_MISCONFIGURED");
};

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const verified = new Map<string, Promise<string>>();

/** The digest-verified packaged helper for this platform under `baseDirectory` (the helper directory), or IDENTITY_MISCONFIGURED. */
export function verifiedAwsSigningHelper(baseDirectory: string, platform: string, arch: string): Promise<string> {
  const artifact = awsSigningHelperArtifact(platform, arch);
  if (artifact === undefined) return Promise.reject(new AwsIdentityError("IDENTITY_MISCONFIGURED"));
  const executable = path.join(baseDirectory, artifact.directory, AWS_SIGNING_HELPER_EXECUTABLE);
  const known = verified.get(executable);
  if (known !== undefined) return known;
  const check = (async () => {
    try {
      const info = await stat(executable);
      if (!info.isFile()) return misconfigured();
      await access(executable, constants.X_OK);
      if ((await sha256Of(executable)) !== artifact.sha256) return misconfigured();
      return executable;
    } catch {
      return misconfigured();
    }
  })();
  verified.set(executable, check);
  // Only a success is remembered: a later resolution re-checks after a failure.
  check.catch(() => verified.delete(executable));
  return check;
}

/** The packaged helper directory of the running deployment: `<working directory>/vendor/aws-signing-helper`. */
export function deployedAwsSigningHelper(): Promise<string> {
  return verifiedAwsSigningHelper(path.join(process.cwd(), AWS_SIGNING_HELPER_DIRECTORY), process.platform, process.arch);
}

export const nodeSigningHelperProcess: SigningHelperProcess = Object.freeze({
  run(executable: string, args: readonly string[], options: { readonly timeoutMs: number; readonly maxOutputBytes: number }): Promise<SigningHelperRun> {
    return new Promise<SigningHelperRun>((resolve) => {
      let settled = false;
      let timedOut = false;
      let overflow = false;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      const finish = (run: SigningHelperRun): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(run);
      };
      const child = spawn(executable, [...args], { shell: false, env: EMPTY_ENVIRONMENT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      const collect = (chunks: Buffer[], add: (n: number) => number) => (chunk: Buffer) => {
        if (add(chunk.byteLength) > options.maxOutputBytes) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", collect(out, (n) => (outBytes += n)));
      child.stderr.on("data", collect(err, (n) => (errBytes += n)));
      child.on("error", (error: NodeJS.ErrnoException) => {
        const spawnFailure = error.code === "ENOENT" ? "not_found" : error.code === "EACCES" ? "permission" : "other";
        finish({ exitCode: null, signal: null, stdout: "", stderr: "", timedOut, overflow, spawnFailure });
      });
      child.on("close", (exitCode, signal) => {
        finish({ exitCode, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, overflow, spawnFailure: null });
      });
    });
  },
});
