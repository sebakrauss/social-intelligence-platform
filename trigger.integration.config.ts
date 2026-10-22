/**
 * Trigger.dev deployment configuration for the jobs unit's INTEGRATION execution plane (Step 7E.4B.3): ONLY the tasks
 * that open a provider credential (connections.discover_assets, capability.evaluate_account). A separate Trigger.dev
 * project, so its environment — and later its AWS worker identity — never reaches a main-plane task. No Vercel
 * integration and no automatic pull-request previews for this project. Used only by the Trigger.dev CLI, through the
 * paired release `npm run trigger:release` (tools/trigger/deploy-release-pair.ts), which deploys this plane FIRST and
 * then the main plane, both with the same `--external-id`. The project reference is never committed.
 *
 * Step 7G-H5.6B: the ONLY build that packages the AWS IAM Roles Anywhere credential helper (the worker's AWS identity),
 * through jobs/build/aws-signing-helper-extension.ts — pinned, fetched beforehand with
 * tools/trigger/fetch-aws-signing-helper.ts, and enforced by an image-build integrity layer (a missing or altered build
 * fails the image build). The paired release deploys it with `--depot-build` (the image context is the local build output).
 */
import { defineConfig } from "@trigger.dev/sdk";
import { awsSigningHelperExtension } from "./jobs/build/aws-signing-helper-extension";
import { RETRY_POLICIES } from "./platform/jobs/registry";

export default defineConfig({
  // Node 22 like .nvmrc and package.json engines; never the CLI's implicit "current LTS" default.
  runtime: "node-22",
  project: process.env["TRIGGER_INTEGRATION_PROJECT_REF"] ?? "",
  dirs: ["./jobs/trigger/integration"],
  maxDuration: 300,
  build: {
    extensions: [awsSigningHelperExtension()],
  },
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: RETRY_POLICIES.transient.maxAttempts,
      factor: RETRY_POLICIES.transient.factor,
      minTimeoutInMs: RETRY_POLICIES.transient.minDelayMs,
      maxTimeoutInMs: RETRY_POLICIES.transient.maxDelayMs,
      randomize: RETRY_POLICIES.transient.randomize,
    },
  },
});
