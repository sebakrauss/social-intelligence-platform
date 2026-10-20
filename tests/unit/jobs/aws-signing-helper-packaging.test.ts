/**
 * Packaging of the official AWS IAM Roles Anywhere credential helper (Step 7G-H5.6B; enforcement corrected in
 * 7G-H5.6B-C1), offline: the pins, the platform selection and the INTEGRATION build extension
 * (jobs/build/aws-signing-helper-extension.ts).
 *
 * The security property is the IMAGE-BUILD integrity layer, not an exception: the Trigger.dev CLI catches and only logs
 * an `onBuildComplete` throw (and then drops that extension's layers). So these tests prove that the extension registers
 * the layer and never throws, and they EXECUTE the generated commands with /bin/sh in a directory modelling the image's
 * working directory — exactly as the Containerfile's `RUN` steps run them — for correct, missing, mismatched,
 * non-executable and symlinked builds. Synthetic artifacts stand in for the real builds; when the real builds have been
 * fetched locally (git-ignored), they are verified too. Nothing is downloaded, and the helper itself never runs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AWS_SIGNING_HELPER_ARTIFACTS,
  AWS_SIGNING_HELPER_DIRECTORY,
  AWS_SIGNING_HELPER_VERSION,
  awsSigningHelperArtifact,
  awsSigningHelperRelativePath,
  type AwsSigningHelperArtifact,
} from "@/jobs/aws-signing-helper";
import {
  AWS_SIGNING_HELPER_EXTENSION_NAME,
  AWS_SIGNING_HELPER_LAYER_ID,
  awsSigningHelperExtension,
  awsSigningHelperIntegrityCommands,
  stageAwsSigningHelper,
  unverifiedAwsSigningHelperBuilds,
} from "@/jobs/build/aws-signing-helper-extension";

const root = path.resolve(import.meta.dirname, "../../..");
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
/** The only environment the modelled RUN steps get: a PATH to find test/sha256sum — nothing else (as in the image build). */
const SHELL_ENV: NodeJS.ProcessEnv = Object.freeze({ NODE_ENV: "test", PATH: process.env["PATH"] ?? "" });
/** The image runs RUN steps with /bin/sh (Debian: dash) and has coreutils' sha256sum; so must this host to execute them. */
const CAN_EXECUTE = spawnSync("/bin/sh", ["-c", "command -v sha256sum"], { env: SHELL_ENV }).status === 0;

let workingDir = "";
let outputPath = "";
beforeEach(() => {
  workingDir = mkdtempSync(path.join(tmpdir(), "wrenkind-helper-work-"));
  outputPath = mkdtempSync(path.join(tmpdir(), "wrenkind-helper-out-"));
});
afterEach(() => {
  rmSync(workingDir, { recursive: true, force: true });
  rmSync(outputPath, { recursive: true, force: true });
});

/** Synthetic builds with their own digests, written where the fetch tool would put them. */
function syntheticArtifacts(): readonly AwsSigningHelperArtifact[] {
  return AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => {
    const bytes = `synthetic helper build for ${artifact.directory}`;
    const file = path.join(workingDir, awsSigningHelperRelativePath(artifact));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, { mode: 0o600 });
    return { ...artifact, sha256: sha256(bytes) };
  });
}

/** A fake Trigger.dev build context recording the layers, and when (relative to staging) each was added. */
function buildContext(target: string, dir = workingDir) {
  const layers: { readonly id: string; readonly commands: string[]; readonly outputEntriesWhenAdded: number }[] = [];
  return {
    layers,
    context: {
      target,
      workingDir: dir,
      addLayer(layer: { readonly id: string; readonly commands: string[] }) {
        layers.push({ ...layer, outputEntriesWhenAdded: readdirSync(outputPath).length });
      },
    },
  };
}

/** Runs the commands as the Containerfile's RUN steps do: `/bin/sh -c <command>` in the image's working directory. */
function runImageSteps(commands: readonly string[], cwd: string): number[] {
  return commands.map((command) => spawnSync("/bin/sh", ["-c", command], { cwd, env: SHELL_ENV, stdio: "ignore" }).status ?? -1);
}

describe("pins", () => {
  it("one exact version, the two Linux builds, exact AWS release URLs, lower-case SHA-256 digests", () => {
    expect(AWS_SIGNING_HELPER_VERSION).toBe("1.8.5");
    expect(AWS_SIGNING_HELPER_ARTIFACTS.map((artifact) => [artifact.arch, artifact.directory, artifact.url])).toEqual([
      ["x64", "linux-x86_64", "https://rolesanywhere.amazonaws.com/releases/1.8.5/X86_64/Linux/Amzn2023/aws_signing_helper"],
      ["arm64", "linux-aarch64", "https://rolesanywhere.amazonaws.com/releases/1.8.5/Aarch64/Linux/Amzn2023/aws_signing_helper"],
    ]);
    for (const artifact of AWS_SIGNING_HELPER_ARTIFACTS) expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(AWS_SIGNING_HELPER_ARTIFACTS)).toBe(true);
  });

  it("selection is deterministic: Linux x64/arm64 only; any other OS or CPU has no artifact (fail closed)", () => {
    expect(awsSigningHelperArtifact("linux", "x64")?.directory).toBe("linux-x86_64");
    expect(awsSigningHelperArtifact("linux", "arm64")?.directory).toBe("linux-aarch64");
    for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "ia32"], ["linux", "s390x"], ["freebsd", "x64"]]) {
      expect(awsSigningHelperArtifact(platform ?? "", arch ?? ""), `${platform ?? ""}/${arch ?? ""}`).toBeUndefined();
    }
    expect(awsSigningHelperRelativePath(AWS_SIGNING_HELPER_ARTIFACTS[0] as AwsSigningHelperArtifact)).toBe(`${AWS_SIGNING_HELPER_DIRECTORY}/linux-x86_64/aws_signing_helper`);
  });
});

describe("the image-build integrity commands (the enforcement boundary)", () => {
  it("one command per Linux build, derived from the canonical pins: exact path, exact pinned SHA-256, file + not-a-link + executable", () => {
    const commands = awsSigningHelperIntegrityCommands();
    expect(commands).toEqual([
      "test -f vendor/aws-signing-helper/linux-x86_64/aws_signing_helper && test ! -L vendor/aws-signing-helper/linux-x86_64/aws_signing_helper && test -x vendor/aws-signing-helper/linux-x86_64/aws_signing_helper && echo 'beec9ed1c492d93db809890f16713e3556353294b823c2184ad4e891f1b2b54d  vendor/aws-signing-helper/linux-x86_64/aws_signing_helper' | sha256sum -c -",
      "test -f vendor/aws-signing-helper/linux-aarch64/aws_signing_helper && test ! -L vendor/aws-signing-helper/linux-aarch64/aws_signing_helper && test -x vendor/aws-signing-helper/linux-aarch64/aws_signing_helper && echo '3d131aa888cd56da446f9c6bb460b1f0569f6c7edc74eae6193a2fe3928883ba  vendor/aws-signing-helper/linux-aarch64/aws_signing_helper' | sha256sum -c -",
    ]);
    // The digests are the pins themselves (no second copy of the literals to drift).
    for (const [index, artifact] of AWS_SIGNING_HELPER_ARTIFACTS.entries()) {
      expect(commands[index]).toContain(`echo '${artifact.sha256}  ${awsSigningHelperRelativePath(artifact)}' | sha256sum -c -`);
    }
  });

  it("nothing but fixed paths and digests reaches a command: no variable, substitution, secret, environment or network", () => {
    const shape = /^test -f ([\w./-]+) && test ! -L \1 && test -x \1 && echo '[0-9a-f]{64} {2}\1' \| sha256sum -c -$/;
    for (const command of awsSigningHelperIntegrityCommands()) {
      expect(command).toMatch(shape);
      expect(command).not.toMatch(/[$`\\;]|\$\(|>|<|curl|wget|fetch|http|PEM|PRIVATE|KEY|SECRET|TOKEN|INTEGRATION_|AWS_|TRIGGER_/);
    }
  });

  it("a pin that can't be rendered safely is never skipped: it becomes a command that always fails the image build", () => {
    const [first] = AWS_SIGNING_HELPER_ARTIFACTS as readonly [AwsSigningHelperArtifact];
    expect(awsSigningHelperIntegrityCommands([{ ...first, sha256: "NOT-A-DIGEST" }])).toEqual(["false"]);
    expect(awsSigningHelperIntegrityCommands([{ ...first, sha256: `${first.sha256}' ; curl x '` }])).toEqual(["false"]);
    expect(awsSigningHelperIntegrityCommands([{ ...first, directory: "../escape" }])).toEqual(["false"]);
    expect(awsSigningHelperIntegrityCommands([{ ...first, directory: "a b; rm -rf /" }])).toEqual(["false"]);
    expect(awsSigningHelperIntegrityCommands([])).toEqual(["false"]);
  });

  describe.runIf(CAN_EXECUTE)("executed as the image's RUN steps (/bin/sh -c, in the image's working directory)", () => {
    async function stagedImage(): Promise<readonly AwsSigningHelperArtifact[]> {
      const artifacts = syntheticArtifacts();
      const staged = await stageAwsSigningHelper({ target: "deploy", workingDir }, { outputPath }, artifacts);
      expect(staged.unverified).toEqual([]);
      return artifacts;
    }

    it("correct builds pass: every step exits 0", async () => {
      const artifacts = await stagedImage();
      expect(runImageSteps(awsSigningHelperIntegrityCommands(artifacts), outputPath)).toEqual([0, 0]);
    });

    it("a missing build fails its step (non-zero): the image build stops", async () => {
      const artifacts = await stagedImage();
      rmSync(path.join(outputPath, awsSigningHelperRelativePath(artifacts[1] as AwsSigningHelperArtifact)));
      const [x64, arm64] = runImageSteps(awsSigningHelperIntegrityCommands(artifacts), outputPath);
      expect(x64).toBe(0);
      expect(arm64).not.toBe(0);
      // No helper directory at all (e.g. a build context without vendor/): both steps fail.
      rmSync(path.join(outputPath, AWS_SIGNING_HELPER_DIRECTORY), { recursive: true, force: true });
      expect(runImageSteps(awsSigningHelperIntegrityCommands(artifacts), outputPath).every((status) => status !== 0)).toBe(true);
    });

    it("a build whose bytes don't match the pinned SHA-256 fails its step, even when executable", async () => {
      const artifacts = await stagedImage();
      const file = path.join(outputPath, awsSigningHelperRelativePath(artifacts[0] as AwsSigningHelperArtifact));
      writeFileSync(file, "tampered", { mode: 0o755 });
      chmodSync(file, 0o755);
      const [x64, arm64] = runImageSteps(awsSigningHelperIntegrityCommands(artifacts), outputPath);
      expect(x64).not.toBe(0);
      expect(arm64).toBe(0);
    });

    it("a build with the right bytes but no executable bit fails its step", async () => {
      const artifacts = await stagedImage();
      chmodSync(path.join(outputPath, awsSigningHelperRelativePath(artifacts[0] as AwsSigningHelperArtifact)), 0o644);
      const [x64, arm64] = runImageSteps(awsSigningHelperIntegrityCommands(artifacts), outputPath);
      expect(x64).not.toBe(0);
      expect(arm64).toBe(0);
    });

    it("a symbolic link to the right bytes fails its step (the build must be the regular file itself)", async () => {
      const artifacts = await stagedImage();
      const file = path.join(outputPath, awsSigningHelperRelativePath(artifacts[0] as AwsSigningHelperArtifact));
      const elsewhere = path.join(outputPath, "elsewhere");
      writeFileSync(elsewhere, readFileSync(file), { mode: 0o755 });
      rmSync(file);
      symlinkSync(elsewhere, file);
      const [x64, arm64] = runImageSteps(awsSigningHelperIntegrityCommands(artifacts), outputPath);
      expect(x64).not.toBe(0);
      expect(arm64).toBe(0);
    });

    it("the always-failing command for an unrenderable pin fails", () => {
      expect(runImageSteps(awsSigningHelperIntegrityCommands([]), outputPath)).toEqual([1]);
    });
  });
});

describe("the INTEGRATION build extension", () => {
  it("is named and has exactly the build-start preflight and the build-complete layer + staging", () => {
    const extension = awsSigningHelperExtension();
    expect(extension.name).toBe(AWS_SIGNING_HELPER_EXTENSION_NAME);
    expect(Object.keys(extension).sort()).toEqual(["name", "onBuildComplete", "onBuildStart"]);
  });

  it("deploy: registers the integrity layer FIRST (before anything is staged), then copies every verified build as 0755", async () => {
    const artifacts = syntheticArtifacts();
    const { layers, context } = buildContext("deploy");
    await awsSigningHelperExtension(artifacts).onBuildComplete(context, { outputPath });
    expect(layers).toEqual([{ id: AWS_SIGNING_HELPER_LAYER_ID, commands: awsSigningHelperIntegrityCommands(artifacts), outputEntriesWhenAdded: 0 }]);
    for (const artifact of artifacts) {
      const file = path.join(outputPath, awsSigningHelperRelativePath(artifact));
      expect(statSync(file).mode & 0o777).toBe(0o755);
      expect(sha256(readFileSync(file))).toBe(artifact.sha256);
    }
  });

  it("the old throw is NOT the invariant: missing builds → onBuildComplete resolves, nothing is staged, the failing layer is still registered", async () => {
    const { layers, context } = buildContext("deploy", path.join(workingDir, "absent"));
    await expect(awsSigningHelperExtension().onBuildComplete(context, { outputPath })).resolves.toBeUndefined();
    expect(layers.map((layer) => layer.id)).toEqual([AWS_SIGNING_HELPER_LAYER_ID]);
    expect(layers[0]?.commands).toEqual(awsSigningHelperIntegrityCommands());
    expect(existsSync(path.join(outputPath, AWS_SIGNING_HELPER_DIRECTORY))).toBe(false);
  });

  it("a mismatched build is never copied; onBuildComplete still resolves and keeps the layer", async () => {
    const artifacts = syntheticArtifacts().map((artifact, index) => (index === 1 ? { ...artifact, sha256: "0".repeat(64) } : artifact));
    const { layers, context } = buildContext("deploy");
    await expect(awsSigningHelperExtension(artifacts).onBuildComplete(context, { outputPath })).resolves.toBeUndefined();
    expect(layers).toHaveLength(1);
    expect(existsSync(path.join(outputPath, awsSigningHelperRelativePath(artifacts[0] as AwsSigningHelperArtifact)))).toBe(true);
    expect(existsSync(path.join(outputPath, awsSigningHelperRelativePath(artifacts[1] as AwsSigningHelperArtifact)))).toBe(false);
    expect(await stageAwsSigningHelper({ target: "deploy", workingDir }, { outputPath }, artifacts)).toEqual({
      packaged: [awsSigningHelperRelativePath(artifacts[0] as AwsSigningHelperArtifact)],
      unverified: ["linux-aarch64"],
    });
  });

  it("an unwritable output never throws out of onBuildComplete (the layer would be dropped): it is reported as unverified", async () => {
    const artifacts = syntheticArtifacts();
    const blocked = path.join(outputPath, "blocked");
    writeFileSync(blocked, "a file where a directory is needed");
    const { layers, context } = buildContext("deploy");
    await expect(awsSigningHelperExtension(artifacts).onBuildComplete(context, { outputPath: blocked })).resolves.toBeUndefined();
    expect(layers).toHaveLength(1);
    expect((await stageAwsSigningHelper({ target: "deploy", workingDir }, { outputPath: blocked }, artifacts)).unverified).toEqual(["linux-x86_64", "linux-aarch64"]);
  });

  it("onBuildStart (operator-visible preflight, not the enforcement): missing or mismatched builds stop the deploy early with the fetch instruction", async () => {
    await expect(awsSigningHelperExtension().onBuildStart({ target: "deploy", workingDir: path.join(workingDir, "absent") })).rejects.toThrow(
      /aws_signing_helper 1\.8\.5 \(linux-x86_64, linux-aarch64\) is missing or does not match its pinned SHA-256: run node tools\/trigger\/fetch-aws-signing-helper\.ts/,
    );
    const artifacts = syntheticArtifacts();
    await expect(awsSigningHelperExtension(artifacts).onBuildStart({ target: "deploy", workingDir })).resolves.toBeUndefined();
    expect(await unverifiedAwsSigningHelperBuilds(workingDir, artifacts.map((artifact) => ({ ...artifact, sha256: "f".repeat(64) })))).toEqual(["linux-x86_64", "linux-aarch64"]);
  });

  it("dev builds are untouched: no preflight, no layer, nothing read or written", async () => {
    const { layers, context } = buildContext("dev", path.join(workingDir, "absent"));
    const extension = awsSigningHelperExtension();
    await expect(extension.onBuildStart(context)).resolves.toBeUndefined();
    await extension.onBuildComplete(context, { outputPath });
    expect(layers).toEqual([]);
    expect(readdirSync(outputPath)).toEqual([]);
  });

  it.runIf(AWS_SIGNING_HELPER_ARTIFACTS.every((artifact) => existsSync(path.join(root, awsSigningHelperRelativePath(artifact)))))(
    "the real fetched builds (local, git-ignored) stage with their published digests and pass the image steps",
    async () => {
      const { layers, context } = buildContext("deploy", root);
      await awsSigningHelperExtension().onBuildStart(context);
      await awsSigningHelperExtension().onBuildComplete(context, { outputPath });
      expect(layers).toHaveLength(1);
      for (const artifact of AWS_SIGNING_HELPER_ARTIFACTS) expect(sha256(readFileSync(path.join(outputPath, awsSigningHelperRelativePath(artifact))))).toBe(artifact.sha256);
      if (CAN_EXECUTE) expect(runImageSteps(awsSigningHelperIntegrityCommands(), outputPath)).toEqual([0, 0]);
    },
  );
});
