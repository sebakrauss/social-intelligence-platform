/**
 * The official AWS IAM Roles Anywhere credential helper (`aws_signing_helper`) as the INTEGRATION worker packages it
 * (Step 7G-H5.6B). Pure pins: one exact released version, its exact AWS release URLs and their AWS-published SHA-256
 * digests, per Linux architecture. Nothing here downloads, executes or reads a file.
 *
 *   source     https://rolesanywhere.amazonaws.com/releases/<version>/<arch>/Linux/Amzn2023/aws_signing_helper — the
 *              download table of the AWS IAM Roles Anywhere User Guide ("Get temporary security credentials"); the
 *              digests below are the ones that table publishes and were re-verified on download (2026-10-20)
 *   runtime    the Trigger.dev deployed image (Debian bookworm, glibc 2.36); both builds are dynamically linked and need
 *              only libc and libresolv at GLIBC_2.34 or older
 *   packaging  fetched once with tools/trigger/fetch-aws-signing-helper.ts into the git-ignored AWS_SIGNING_HELPER_DIRECTORY,
 *              staged into the INTEGRATION deployment only by jobs/build/aws-signing-helper-extension.ts, whose image-build
 *              integrity layer fails the image build unless each build is present, executable and of its pinned digest
 *              (the fetch tool verifies too); the runtime verifies the digest again before the first use and selects the build for
 *              `process.arch` — never a download at runtime, never a "latest" URL
 *
 * The image platform is chosen by Trigger.dev per deployment, so BOTH Linux architectures are packaged; anything else
 * (another OS or CPU) has no artifact and fails closed.
 */

export const AWS_SIGNING_HELPER_VERSION = "1.8.5";

/** Relative to the project root locally and to the deployed working directory (`/app`). Git-ignored. */
export const AWS_SIGNING_HELPER_DIRECTORY = "vendor/aws-signing-helper";

export const AWS_SIGNING_HELPER_EXECUTABLE = "aws_signing_helper";

export interface AwsSigningHelperArtifact {
  /** Node's `process.arch` this build runs on (Linux only). */
  readonly arch: "x64" | "arm64";
  /** Directory under AWS_SIGNING_HELPER_DIRECTORY. */
  readonly directory: string;
  readonly url: string;
  /** Lower-case hex SHA-256 of the executable, as AWS publishes it. */
  readonly sha256: string;
}

const RELEASES = `https://rolesanywhere.amazonaws.com/releases/${AWS_SIGNING_HELPER_VERSION}`;

export const AWS_SIGNING_HELPER_ARTIFACTS: readonly AwsSigningHelperArtifact[] = Object.freeze([
  Object.freeze({
    arch: "x64",
    directory: "linux-x86_64",
    url: `${RELEASES}/X86_64/Linux/Amzn2023/aws_signing_helper`,
    sha256: "beec9ed1c492d93db809890f16713e3556353294b823c2184ad4e891f1b2b54d",
  }),
  Object.freeze({
    arch: "arm64",
    directory: "linux-aarch64",
    url: `${RELEASES}/Aarch64/Linux/Amzn2023/aws_signing_helper`,
    sha256: "3d131aa888cd56da446f9c6bb460b1f0569f6c7edc74eae6193a2fe3928883ba",
  }),
]);

/** The packaged build for this OS and CPU, or undefined (fail closed: no other platform is supported). */
export function awsSigningHelperArtifact(platform: string, arch: string): AwsSigningHelperArtifact | undefined {
  if (platform !== "linux") return undefined;
  return AWS_SIGNING_HELPER_ARTIFACTS.find((artifact) => artifact.arch === arch);
}

/** `vendor/aws-signing-helper/<directory>/aws_signing_helper` (POSIX separators). */
export function awsSigningHelperRelativePath(artifact: AwsSigningHelperArtifact): string {
  return `${AWS_SIGNING_HELPER_DIRECTORY}/${artifact.directory}/${AWS_SIGNING_HELPER_EXECUTABLE}`;
}
