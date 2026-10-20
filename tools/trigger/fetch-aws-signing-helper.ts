/**
 * Fetches the pinned official AWS IAM Roles Anywhere credential helper builds (jobs/aws-signing-helper.ts) into the
 * git-ignored helper directory, for the INTEGRATION deployment's build extension (Step 7G-H5.6B). Operator tooling, run
 * before `trigger deploy --config trigger.integration.config.ts`:
 *
 *   node tools/trigger/fetch-aws-signing-helper.ts
 *
 * Each build is downloaded over HTTPS from its exact pinned AWS release URL (no redirect followed, bounded size),
 * verified against its pinned SHA-256 BEFORE anything is written, then written as a 0755 file. An existing file with the
 * right digest is kept; a wrong one is replaced only by a verified download. No credential, header or token is sent.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AWS_SIGNING_HELPER_ARTIFACTS, AWS_SIGNING_HELPER_VERSION, awsSigningHelperRelativePath } from "../../jobs/aws-signing-helper.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function current(file: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(file));
  } catch {
    return undefined;
  }
}

for (const artifact of AWS_SIGNING_HELPER_ARTIFACTS) {
  const file = path.join(root, awsSigningHelperRelativePath(artifact));
  if ((await current(file)) === artifact.sha256) {
    console.log(`kept      ${artifact.directory} (${AWS_SIGNING_HELPER_VERSION}, digest verified)`);
    continue;
  }
  const response = await fetch(artifact.url, { redirect: "error" });
  if (!response.ok) throw new Error(`download failed for ${artifact.directory}: HTTP ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error(`download for ${artifact.directory} exceeds ${String(MAX_BYTES)} bytes`);
  if (sha256(bytes) !== artifact.sha256) throw new Error(`digest mismatch for ${artifact.directory}: nothing written`);
  await mkdir(path.dirname(file), { recursive: true });
  const staged = `${file}.download`;
  await writeFile(staged, bytes, { mode: 0o755 });
  await rename(staged, file);
  console.log(`fetched   ${artifact.directory} (${AWS_SIGNING_HELPER_VERSION}, digest verified)`);
}
