/**
 * Trigger.dev build extension of the INTEGRATION deployment only (trigger.integration.config.ts; Step 7G-H5.6B): it puts
 * the official AWS IAM Roles Anywhere credential helper (jobs/aws-signing-helper.ts) into the deployed image, for both
 * Linux architectures, at `vendor/aws-signing-helper/<arch dir>/aws_signing_helper` relative to the working directory.
 *
 * ENFORCEMENT BOUNDARY (Step 7G-H5.6B-C1): the IMAGE BUILD. On deploy, `onBuildComplete` registers a build layer whose
 * commands (awsSigningHelperIntegrityCommands) the Trigger.dev CLI renders as `RUN` steps of the Containerfile, after
 * the build output has been copied into `/app` (the image's working directory). Each step requires its build to be
 * present, a regular file (not a link), executable and of exactly its pinned SHA-256; any failure exits non-zero, so the
 * image build fails and nothing is deployed. The commands are derived from the pins alone: fixed relative paths, fixed
 * digests, no variable, no secret, no network.
 *
 * Why not a throw: the CLI catches and only LOGS an exception from `onBuildComplete` (and then also drops that
 * extension's layers), so a throw there never stopped a deploy. `onBuildComplete` therefore never throws: it registers
 * the layer FIRST, then copies the verified builds it finds (tools/trigger/fetch-aws-signing-helper.ts put them in the
 * git-ignored helper directory) into the build output as 0755 files — Docker COPY keeps the mode. A build that is
 * missing or doesn't match its pin is not copied, and the layer fails the image build.
 *
 * `onBuildStart` is an early, operator-visible preflight only (the CLI does not catch it): a deploy whose helper builds
 * are missing or wrong stops before bundling, with the fetch instruction. It is not the security property.
 *
 * Supported operator path: `trigger deploy --config trigger.integration.config.ts … --depot-build` (the image context is
 * the local build output). The deployed runtime verifies the digest again before the first use (aws-signing-helper-process.ts).
 * `trigger dev` (local keyring, no KMS, no helper) is untouched. No material of any kind — certificate, key or
 * credential — is ever part of a build.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AWS_SIGNING_HELPER_ARTIFACTS, AWS_SIGNING_HELPER_VERSION, awsSigningHelperRelativePath, type AwsSigningHelperArtifact } from "../aws-signing-helper";

export const AWS_SIGNING_HELPER_EXTENSION_NAME = "wrenkind-aws-signing-helper";
export const AWS_SIGNING_HELPER_LAYER_ID = "wrenkind-aws-signing-helper-integrity";

/** What the extension uses of Trigger.dev's build context and manifest (structural; no vendor type is imported). */
interface HelperBuildLayer {
  readonly id: string;
  readonly commands: string[];
}
interface HelperBuildContext {
  readonly target: string;
  readonly workingDir: string;
  addLayer(layer: HelperBuildLayer): void;
}
interface HelperBuildManifest {
  readonly outputPath: string;
}

/** Only these characters may reach a command: a pinned relative path and a lower-case hex digest. */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A command that always fails the image build (a pin that can't be rendered safely is never skipped). */
const ALWAYS_FAIL = "false";

/**
 * One image-build command per packaged build: present, a regular file and not a symbolic link, executable, and exactly
 * its pinned SHA-256 (`sha256sum -c` exits non-zero on a mismatch or a missing file). Relative to the image's working
 * directory, where the runtime resolves the helper. Derived from the pins only; nothing is interpolated from elsewhere.
 */
export function awsSigningHelperIntegrityCommands(artifacts: readonly AwsSigningHelperArtifact[] = AWS_SIGNING_HELPER_ARTIFACTS): string[] {
  if (artifacts.length === 0) return [ALWAYS_FAIL];
  return artifacts.map((artifact) => {
    const file = awsSigningHelperRelativePath(artifact);
    if (!SAFE_RELATIVE_PATH.test(file) || file.split("/").includes("..") || !SHA256_HEX.test(artifact.sha256)) return ALWAYS_FAIL;
    return `test -f ${file} && test ! -L ${file} && test -x ${file} && echo '${artifact.sha256}  ${file}' | sha256sum -c -`;
  });
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function readVerified(workingDir: string, artifact: AwsSigningHelperArtifact): Promise<Buffer | undefined> {
  try {
    const bytes = await readFile(path.join(workingDir, awsSigningHelperRelativePath(artifact)));
    return sha256(bytes) === artifact.sha256 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Every pinned build that is missing from, or doesn't match its pin in, the fetched helper directory. */
export async function unverifiedAwsSigningHelperBuilds(workingDir: string, artifacts: readonly AwsSigningHelperArtifact[] = AWS_SIGNING_HELPER_ARTIFACTS): Promise<string[]> {
  const unverified: string[] = [];
  for (const artifact of artifacts) if ((await readVerified(workingDir, artifact)) === undefined) unverified.push(artifact.directory);
  return unverified;
}

export interface HelperStagingResult {
  readonly packaged: readonly string[];
  /** Builds NOT copied (missing or mismatched): the image-build layer then fails. */
  readonly unverified: readonly string[];
}

/**
 * Copies every verified pinned build into the deploy output as a 0755 file. Never throws: a build that is missing,
 * mismatched or can't be written is reported and left out, and the integrity layer fails the image build.
 */
export async function stageAwsSigningHelper(
  context: Pick<HelperBuildContext, "target" | "workingDir">,
  manifest: HelperBuildManifest,
  artifacts: readonly AwsSigningHelperArtifact[] = AWS_SIGNING_HELPER_ARTIFACTS,
): Promise<HelperStagingResult> {
  if (context.target !== "deploy") return { packaged: [], unverified: [] };
  const packaged: string[] = [];
  const unverified: string[] = [];
  for (const artifact of artifacts) {
    const relative = awsSigningHelperRelativePath(artifact);
    try {
      const bytes = await readVerified(context.workingDir, artifact);
      if (bytes === undefined) {
        unverified.push(artifact.directory);
        continue;
      }
      const destination = path.join(manifest.outputPath, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o755 });
      await chmod(destination, 0o755);
      packaged.push(relative);
    } catch {
      unverified.push(artifact.directory);
    }
  }
  return { packaged, unverified };
}

function preflightMessage(unverified: readonly string[]): string {
  return `aws_signing_helper ${AWS_SIGNING_HELPER_VERSION} (${unverified.join(", ")}) is missing or does not match its pinned SHA-256: run node tools/trigger/fetch-aws-signing-helper.ts`;
}

export function awsSigningHelperExtension(artifacts: readonly AwsSigningHelperArtifact[] = AWS_SIGNING_HELPER_ARTIFACTS) {
  return {
    name: AWS_SIGNING_HELPER_EXTENSION_NAME,
    /** Early, operator-visible preflight (deploy only). Not the enforcement boundary: the image-build layer is. */
    async onBuildStart(context: Pick<HelperBuildContext, "target" | "workingDir">): Promise<void> {
      if (context.target !== "deploy") return;
      const unverified = await unverifiedAwsSigningHelperBuilds(context.workingDir, artifacts);
      if (unverified.length > 0) throw new Error(preflightMessage(unverified));
    },
    /** Registers the integrity layer FIRST, then stages the verified builds. Never throws (a throw would drop the layer). */
    async onBuildComplete(context: HelperBuildContext, manifest: HelperBuildManifest): Promise<void> {
      if (context.target !== "deploy") return;
      context.addLayer({ id: AWS_SIGNING_HELPER_LAYER_ID, commands: awsSigningHelperIntegrityCommands(artifacts) });
      await stageAwsSigningHelper(context, manifest, artifacts);
    },
  };
}
