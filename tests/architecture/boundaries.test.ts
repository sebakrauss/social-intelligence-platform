/**
 * Proves the dependency-boundary rules are active: the real ruleset (.dependency-cruiser.cjs)
 * is run against fixture trees that mirror the TA §6.2 layout. Forbidden imports must be
 * reported under the expected rule; allowed imports must produce no violations.
 * Fixtures live in tests/architecture/fixtures and are excluded from the application build,
 * typecheck, lint and the repository boundary run.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { cruise, type ICruiseOptions, type ICruiseResult, type IFlattenedRuleSet } from "dependency-cruiser";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const config = require(path.join(root, ".dependency-cruiser.cjs")) as {
  forbidden: NonNullable<IFlattenedRuleSet["forbidden"]>;
};

interface Violation {
  readonly rule: string;
  readonly from: string;
  readonly to: string;
}

async function cruiseFixture(fixture: "violations" | "allowed"): Promise<Violation[]> {
  const baseDir = path.join(root, "tests/architecture/fixtures", fixture);
  const options: ICruiseOptions = {
    baseDir,
    validate: true,
    ruleSet: { forbidden: config.forbidden },
    doNotFollow: { path: "(^|/)node_modules/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  };
  const result = await cruise(["."], options);
  const output = result.output as ICruiseResult;
  return output.summary.violations.map((violation) => ({
    rule: violation.rule.name,
    from: violation.from,
    to: violation.to,
  }));
}

const cache = new Map<string, Promise<Violation[]>>();

function violationsOf(fixture: "violations" | "allowed"): Promise<Violation[]> {
  let result = cache.get(fixture);
  if (result === undefined) {
    result = cruiseFixture(fixture);
    cache.set(fixture, result);
  }
  return result;
}

/** [rule, from, to] — every forbidden edge in the violations fixture and the rule that must reject it. */
const EXPECTED_VIOLATIONS: readonly (readonly [string, string, string])[] = [
  // Pure domain and UI layers (TA §6.3 rules 1, 5)
  ["shared-kernel-pure", "domain/impure.ts", "platform/db/client.ts"],
  ["domain-no-packages", "domain/impure.ts", "../../../../node_modules/next/dist/server/next.js"],
  ["app-ui-no-infrastructure", "app/page.ts", "mutations/executor.ts"],
  ["mutation-execution-jobs-only", "app/page.ts", "mutations/executor.ts"],
  // AI boundary (TA §6.3 rule 4; §7.2)
  ["ai-no-mutations-integrations-or-writers", "ai/tasks/classify.ts", "mutations/executor.ts"],
  ["mutation-execution-jobs-only", "ai/tasks/classify.ts", "mutations/executor.ts"],
  ["modules-no-ai-providers", "modules/classification/application/uses-capability.ts", "ai/providers/vendor.ts"],
  ["modules-no-ai-providers", "modules/topics/application/uses-ai-provider.ts", "ai/providers/vendor.ts"],
  ["ai-gateway-only-for-approved-modules", "modules/topics/application/uses-ai-provider.ts", "ai/providers/vendor.ts"],
  ["ai-gateway-only-for-approved-modules", "modules/automation/application/uses-content.ts", "ai/gateway/index.ts"],
  ["deterministic-modules-no-ai", "modules/automation/application/uses-content.ts", "ai/gateway/index.ts"],
  // TA §7.2 explicit module allowlists
  ["module-allowlist-classification", "modules/classification/application/uses-capability.ts", "modules/capability/index.ts"],
  ["module-allowlist-workflow", "modules/workflow/application/uses-content.ts", "modules/content/index.ts"],
  ["module-allowlist-automation", "modules/automation/application/uses-content.ts", "modules/content/index.ts"],
  ["module-allowlist-moderation", "modules/moderation/application/uses-connections.ts", "modules/connections/index.ts"],
  ["module-allowlist-recommendations", "modules/recommendations/application/uses-workflow.ts", "modules/workflow/index.ts"],
  ["module-allowlist-reports", "modules/reports/application/uses-content-and-workflow.ts", "modules/content/index.ts"],
  ["module-allowlist-reports", "modules/reports/application/uses-content-and-workflow.ts", "modules/workflow/index.ts"],
  ["module-allowlist-attention", "modules/attention/application/uses-content-and-aggregation.ts", "modules/content/index.ts"],
  ["module-allowlist-attention", "modules/attention/application/uses-content-and-aggregation.ts", "modules/aggregation/index.ts"],
  // TA §7.2 layering: upward and same-layer edges (no invented same-layer exceptions)
  ["module-layering-tenancy", "modules/tenancy/application/uses-insights.ts", "modules/insights/index.ts"],
  ["module-layering-tenancy", "modules/tenancy/application/writes-audit.ts", "modules/audit/index.ts"],
  ["module-public-api-only", "modules/workflow/application/deep-import.ts", "modules/classification/domain/internal.ts"],
  // Persistence through ports only
  ["module-core-no-database", "modules/workflow/application/uses-content.ts", "platform/db/client.ts"],
  // Authentication boundary and resolved contexts (Step 1)
  ["supabase-sdk-only-in-platform-auth", "server/uses-supabase-directly.ts", "../../../../node_modules/@supabase/ssr/dist/module/index.js"],
  ["app-ui-no-auth-adapter", "app/uses-auth-adapter.ts", "platform/auth/port.ts"],
  ["modules-no-auth-adapter", "modules/tenancy/application/uses-auth-and-server.ts", "platform/auth/port.ts"],
  ["modules-not-to-upper-layers", "modules/tenancy/application/uses-auth-and-server.ts", "server/handler.ts"],
  ["resolved-context-minted-by-pipeline-only", "server/commands/forges-context.ts", "server/pipeline/context.ts"],
  // Database foundation (Step 2): connections only in platform/db; persistence composed by server/jobs
  ["db-drivers-only-in-persistence", "server/opens-pool.ts", "../../../../node_modules/pg/esm/index.mjs"],
  ["db-connections-only-in-platform-db", "server/opens-pool.ts", "../../../../node_modules/pg/esm/index.mjs"],
  ["db-connections-only-in-platform-db", "modules/tenancy/persistence/connects.ts", "../../../../node_modules/drizzle-orm/node-postgres/index.d.ts"],
  ["module-persistence-composed-by-server", "app/uses-persistence.ts", "modules/tenancy/persistence/index.ts"],
  ["production-not-to-tests-or-tools", "platform/db/uses-tooling.ts", "tools/db/migrate.ts"],
  // Jobs, executor port, adapters (TA §6.3 rules 3, 7; §15)
  ["jobs-no-business-logic", "jobs/run.ts", "modules/insights/domain/rule.ts"],
  ["jobs-are-entry-points", "server/handler.ts", "jobs/run.ts"],
  ["mutation-port-executor-only", "server/handler.ts", "integrations/providers/contract/mutation-port.ts"],
  ["provider-adapter-isolated", "integrations/providers/meta/adapter.ts", "modules/insights/index.ts"],
  // Job runtime boundary (Step 3): SDK and adapter behind the port; no direct enqueue, delivery or system scope
  ["trigger-sdk-only-in-job-runtime-boundary", "server/enqueues-directly.ts", "../../../../node_modules/@trigger.dev/sdk/dist/esm/v3/index.d.ts"],
  ["job-runtime-adapter-composed-only", "server/enqueues-directly.ts", "platform/jobs/trigger-dev.ts"],
  ["outbox-delivery-jobs-only", "server/enqueues-directly.ts", "platform/outbox/delivery.ts"],
  ["system-scope-delivery-only", "server/enqueues-directly.ts", "platform/db/system-scope.ts"],
  ["system-scope-delivery-only", "jobs/uses-system-scope.ts", "platform/db/system-scope.ts"],
  ["product-code-no-job-runtime", "modules/workflow/application/enqueues.ts", "platform/jobs/port.ts"],
  // Provider contract (Step 4): pure contract; adapter mutation implementations reachable only by the executor
  ["provider-contract-pure", "integrations/providers/contract/uses-node.ts", "crypto"],
  ["provider-mutation-implementations-executor-only", "integrations/providers/meta/index.ts", "integrations/providers/meta/mutation-port.ts"],
  ["provider-mutation-implementations-executor-only", "server/obtains-adapter-mutations.ts", "integrations/providers/meta/mutation-port.ts"],
  // Credential crypto (Step 5A): the web seals but never opens; local keyring only at composition roots
  ["credential-opening-job-runtime-only", "server/opens-credentials.ts", "platform/crypto/credentials/open.ts"],
  ["credential-opening-job-runtime-only", "app/opens-credentials.ts", "platform/crypto/credentials/local-opener.ts"],
  ["credential-local-keyring-composed-only", "app/opens-credentials.ts", "platform/crypto/credentials/local-opener.ts"],
  ["credential-local-keyring-composed-only", "modules/connections/application/uses-local-keyring.ts", "platform/crypto/credentials/local-sealer.ts"],
  ["integrations-no-credential-crypto", "integrations/providers/meta/uses-credential-crypto.ts", "platform/crypto/credentials/seal.ts"],
  ["credential-opening-integration-composition-only", "jobs/sweeper-opens-credentials.ts", "platform/crypto/credentials/local-opener.ts"],
  ["credential-opening-integration-composition-only", "jobs/sweeper-opens-credentials.ts", "platform/crypto/credentials/open.ts"],
  // AWS KMS keyring (Step 7C): the SDK only in the two capabilities; the unwrapper is integration-runtime only
  ["credential-opening-integration-composition-only", "jobs/sweeper-opens-credentials.ts", "platform/crypto/credentials/aws-kms-unwrapper.ts"],
  ["credential-opening-job-runtime-only", "server/opens-kms-unwrapper.ts", "platform/crypto/credentials/aws-kms-unwrapper.ts"],
  ["credential-opening-job-runtime-only", "server/opens-kms-opener.ts", "platform/crypto/credentials/aws-kms-opener.ts"],
  ["credential-opening-integration-composition-only", "jobs/sweeper-opens-credentials.ts", "platform/crypto/credentials/aws-kms-opener.ts"],
  ["aws-kms-sdk-only-in-credential-adapter", "platform/crypto/credentials/envelope-uses-kms-sdk.ts", "../../../../node_modules/@aws-sdk/client-kms/dist-es/index.js"],
  ["aws-sdk-only-client-kms", "server/uses-aws-credential-chain.ts", "../../../../node_modules/@aws-sdk/credential-provider-node/dist-es/index.js"],
  ["no-undeclared-package", "server/uses-aws-credential-chain.ts", "../../../../node_modules/@aws-sdk/credential-provider-node/dist-es/index.js"],
  // AWS runtime identity (Step 7E.2): a pure, vendor-neutral contract
  ["aws-identity-contract-pure", "platform/aws/uses-credential-crypto.ts", "platform/crypto/credentials/seal.ts"],
  // Execution planes (Step 7E.4B.3): opener only in the integration plane; main runtime only in the main plane
  ["plane-opener-integration-only", "jobs/moves.ts", "jobs/connections.ts"],
  ["plane-opener-integration-only", "jobs/trigger/main/opens-credentials.ts", "jobs/connections.ts"],
  ["plane-main-runtime-main-only", "jobs/trigger/integration/uses-main-plane.ts", "jobs/main-runtime.ts"],
  ["plane-integration-no-delivery", "jobs/trigger/integration/uses-main-plane.ts", "jobs/trigger/main/delivery.ts"],
  ["plane-task-directories-disjoint", "jobs/trigger/integration/uses-main-plane.ts", "jobs/trigger/main/delivery.ts"],
  // Vercel OIDC web identity (Step 7E.3B): packages only in the adapter, no refresh helpers, composed by the web only
  ["vercel-oidc-only-in-web-identity-adapter", "server/reads-vercel-oidc.ts", "../../../../node_modules/@vercel/oidc/dist/index.js"],
  ["vercel-oidc-only-in-web-identity-adapter", "app/uses-vercel-identity.ts", "../../../../node_modules/@vercel/oidc-aws-credentials-provider/dist/index.js"],
  ["vercel-oidc-refresh-helpers-never", "server/reads-vercel-oidc.ts", "../../../../node_modules/execa/index.d.ts"],
  ["no-undeclared-package", "server/reads-vercel-oidc.ts", "../../../../node_modules/execa/index.d.ts"],
  ["vercel-identity-web-composition-only", "jobs/uses-vercel-identity.ts", "server/connections/vercel-aws-identity.ts"],
  ["vercel-identity-web-composition-only", "app/uses-vercel-identity.ts", "server/connections/vercel-aws-identity.ts"],
  // OAuth secrets (Step 5D, B1): the stateless PKCE derivation key is web-only, composed by server/
  // Capability (Step 5E): evaluated on the server only; the UI renders the result
  ["capability-evaluated-server-side-only", "app/evaluates-capability.ts", "modules/capability/index.ts"],
  ["capability-evaluated-server-side-only", "ui/evaluates-capability.ts", "modules/capability/index.ts"],
  ["oauth-secrets-web-composition-only", "jobs/derives-pkce.ts", "platform/crypto/oauth.ts"],
  ["oauth-secrets-web-composition-only", "modules/connections/application/derives-pkce.ts", "platform/crypto/oauth.ts"],
  ["oauth-secrets-web-composition-only", "integrations/providers/simulator/derives-pkce.ts", "platform/crypto/oauth.ts"],
  // Staging stub (Step 5K): I/O-free, composed only by the job runtime
  ["staging-stub-no-io", "integrations/providers/staging-stub/uses-network.ts", "http"],
  ["staging-stub-jobs-composition-only", "server/composes-staging-stub.ts", "integrations/providers/staging-stub/index.ts"],
];

describe("architecture boundaries", () => {
  it.each(EXPECTED_VIOLATIONS)("rejects %s: %s → %s", async (rule, from, to) => {
    const violations = await violationsOf("violations");
    expect(violations).toContainEqual({ rule, from, to });
  });

  it("reports no violation outside the expected set (fixtures resolve and rules are precise)", async () => {
    const violations = await violationsOf("violations");
    const expected = EXPECTED_VIOLATIONS.map(([rule, from, to]) => ({ rule, from, to }));
    const unexpected = violations.filter(
      (violation) => !expected.some((item) => item.rule === violation.rule && item.from === violation.from && item.to === violation.to),
    );
    expect(unexpected).toEqual([]);
  });

  it("accepts dependencies the architecture allows", async () => {
    expect(await violationsOf("allowed")).toEqual([]);
  });
});
