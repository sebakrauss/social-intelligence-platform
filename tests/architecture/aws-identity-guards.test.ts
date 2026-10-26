/**
 * Static guards for the AWS runtime-identity contract (Step 7E.2). Import graphs are enforced by
 * .dependency-cruiser.cjs (aws-identity-contract-pure; Step 7E.3B: vercel-oidc-*, vercel-identity-web-composition-only);
 * these check what import graphs can't express.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeOf, findReferences, sourceFiles } from "../support/source-scan";

const root = path.resolve(import.meta.dirname, "../..");
const identityFiles = readdirSync(path.join(root, "platform/aws")).filter((file) => file.endsWith(".ts")).map((file) => `platform/aws/${file}`);
const VERCEL_ADAPTER = "server/connections/vercel-aws-identity.ts";
const WORKER_ADAPTER = "jobs/integration-aws-identity.ts";
const RUNTIME_ROOTS = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "tools", "proxy.ts", "next.config.ts", "trigger.config.ts", "trigger.integration.config.ts"];

describe("AWS runtime-identity contract", () => {
  it("is self-contained: no import at all (no Vercel, STS, KMS, crypto or any package)", () => {
    expect(identityFiles).toContain("platform/aws/identity.ts");
    for (const file of identityFiles) {
      const code = codeOf(file);
      expect([...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]), file).toEqual([]);
      expect(code, file).not.toMatch(/process\.env|console\.|KMS|kms|Vercel|vercel|Trigger|STS(?!_OIDC)|AssumeRole/);
    }
  });

  it("the STS audience has exactly one definition, and its literal appears nowhere else in runtime code", () => {
    const definitions = findReferences(sourceFiles(RUNTIME_ROOTS), [/\bAWS_STS_OIDC_AUDIENCE\s*=/]).map(([file]) => file);
    expect(definitions).toEqual(["platform/aws/identity.ts"]);
    const literals = findReferences(sourceFiles(RUNTIME_ROOTS), [/["'`](?:https:\/\/)?sts\.amazonaws\.com["'`]/]).map(([file]) => file);
    expect(literals).toEqual(["platform/aws/identity.ts"]);
  });

  it("no first-party code calls STS (Step 7G-H5.6B): the worker's identity is Roles Anywhere through the official helper", () => {
    expect(findReferences(sourceFiles(RUNTIME_ROOTS), [/AssumeRole/, /client-sts/, /STSClient/])).toEqual([]);
    expect(findReferences(sourceFiles(RUNTIME_ROOTS), [/credential-provider-web-identity/, /\bfromWebToken\b|\bfromTokenFile\b|\bfromProcess\b/, /AssumeRoleWith(WebIdentity|SAML)/, /GetCallerIdentity|GetSessionToken|GetFederationToken|GetAccessKeyInfo/])).toEqual([]);
    const adapter = codeOf(WORKER_ADAPTER);
    expect(adapter).not.toMatch(/process\.env\.|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|REGION|DEFAULT_REGION|ROLE_ARN)\b|BOOTSTRAP|@aws-sdk/);
  });

  it("the credential helper runs with exactly credential-process, paths and non-secret identifiers — no endpoint, TLS, proxy or session-name override", () => {
    const adapter = codeOf(WORKER_ADAPTER);
    expect(adapter).toMatch(/"credential-process",\n {4}"--certificate", files\.certificate,\n {4}"--private-key", files\.privateKey,\n {4}"--trust-anchor-arn", identity\.trustAnchorArn,\n {4}"--profile-arn", identity\.profileArn,\n {4}"--role-arn", identity\.roleArn,\n {4}"--region", identity\.region,\n {4}"--session-duration", String\(INTEGRATION_WORKER_SESSION_SECONDS\),\n {2}\]/);
    expect(adapter).not.toMatch(/--endpoint|--no-verify-ssl|--with-proxy|--role-session-name|--intermediates|--pkcs11|serve\b|update\b"/);
    // The private key never travels as an argument or a log field: only the file path the adapter wrote.
    expect(adapter).not.toMatch(/console\.|logger|\.log\(|privateKeyPem\s*\]/);
  });

  it("starting a process happens in exactly one module, without a shell and with an empty environment", () => {
    const users = findReferences(sourceFiles(RUNTIME_ROOTS).filter((file) => !file.startsWith("tools/")), [/child_process/, /\bexecFile\b|\bexecSync\b|\bspawnSync\b|\bfork\(/]).map(([file]) => file);
    expect([...new Set(users)]).toEqual(["jobs/aws-signing-helper-process.ts"]);
    const runner = codeOf("jobs/aws-signing-helper-process.ts");
    expect(runner).toMatch(/spawn\(executable, \[\.\.\.args\], \{ shell: false, env: EMPTY_ENVIRONMENT, stdio: \["ignore", "pipe", "pipe"\], windowsHide: true \}\)/);
    expect(runner).toMatch(/const EMPTY_ENVIRONMENT = Object\.freeze\(\{\}\) as NodeJS\.ProcessEnv;/);
    expect(runner).not.toMatch(/process\.env|shell: true|exec\(/);
  });

  it("the helper is the pinned official AWS build: exact version, exact AWS release URLs, SHA-256 per Linux architecture", () => {
    const pins = codeOf("jobs/aws-signing-helper.ts");
    expect(pins).toMatch(/export const AWS_SIGNING_HELPER_VERSION = "1\.8\.5";/);
    expect([...pins.matchAll(/sha256: "([0-9a-f]+)"/g)].map((match) => match[1]?.length)).toEqual([64, 64]);
    expect([...pins.matchAll(/url: `\$\{RELEASES\}\/([^`]+)`/g)].map((match) => match[1])).toEqual(["X86_64/Linux/Amzn2023/aws_signing_helper", "Aarch64/Linux/Amzn2023/aws_signing_helper"]);
    expect(pins).toMatch(/const RELEASES = `https:\/\/rolesanywhere\.amazonaws\.com\/releases\/\$\{AWS_SIGNING_HELPER_VERSION\}`;/);
    expect(pins).not.toMatch(/latest|http:\/\//i);
    expect(pins).not.toMatch(/^import /m);
  });

  it("the audience exchange, the official provider and the request-token header live only in the Vercel identity adapter", () => {
    const hits = findReferences(sourceFiles(RUNTIME_ROOTS), [/@vercel\//, /\bawsCredentialsProvider\b/, /x-vercel-oidc-token/i, /\bVERCEL_OIDC_TOKEN\b/]);
    expect([...new Set(hits.map(([file]) => file))]).toEqual([VERCEL_ADAPTER]);
    expect(hits.map(([, pattern]) => pattern)).toHaveLength(4);
  });
});

describe("Vercel OIDC web identity adapter (Step 7E.3B)", () => {
  const adapter = codeOf(VERCEL_ADAPTER);
  const raw = readFileSync(path.join(root, VERCEL_ADAPTER), "utf8");

  it("imports exactly getContext from @vercel/oidc, awsCredentialsProvider from the official provider, the identity contract and the seam type", () => {
    const imports = [...adapter.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["'];$/gm)].map((m) => [m[3], (m[2] ?? "").split(",").map((name) => name.trim()).filter(Boolean)]);
    expect(imports).toEqual([
      ["@vercel/oidc", ["getContext"]],
      ["@vercel/oidc-aws-credentials-provider", ["awsCredentialsProvider"]],
      ["@/platform/aws/identity", ["AWS_STS_OIDC_AUDIENCE", "AwsIdentityError", "type AwsCredentialProvider", "type AwsIdentityFailure"]],
      ["./web-identity", ["WebAwsIdentityFactory"]],
    ]);
    expect([...adapter.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]).toHaveLength(4);
    expect(adapter).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  });

  it("neither refresh-capable token API (getVercelOidcToken, getVercelOidcTokenSync) nor the exchange or refresh internals appear in first-party runtime code", () => {
    expect(findReferences(sourceFiles(RUNTIME_ROOTS), [/\bgetVercelOidcToken\b/, /\bgetVercelOidcTokenSync\b/, /\bexchangeVercelOidcToken\b/, /\brefreshToken\b/, /@vercel\/cli-(exec|config)|\bexeca\b/])).toEqual([]);
  });

  it("no lint suppression anywhere in first-party code (no-deprecated is never silenced)", () => {
    const suppressed = sourceFiles([...RUNTIME_ROOTS, "tests", "eslint.config.mjs"]).filter((file) => !file.startsWith("tests/architecture/fixtures/") && file !== "tests/architecture/aws-identity-guards.test.ts").filter((file) => /eslint-disable/.test(readFileSync(path.join(root, file), "utf8")));
    expect(suppressed).toEqual([]);
    expect(readFileSync(path.join(root, "eslint.config.mjs"), "utf8")).not.toMatch(/no-deprecated["']?\s*:\s*["']?(off|0|warn)/);
  });

  it("reads the token without side effects: no env write, no file, CLI, subprocess, network or .vercel access, no module-level token state", () => {
    expect(adapter).not.toMatch(/process\.env(\.\w+|\[[^\]]+\])\s*(=(?!=)|\?\?=|\|\|=)|delete\s+process\.env|Object\.assign\(\s*process\.env|Reflect\.(set|deleteProperty)\(\s*process\.env/);
    expect(adapter).not.toMatch(/\.vercel\b|node:fs|child_process|\bspawn|\bexec\(|\bfetch\(|https?:\/\/|node:https?/);
    expect(adapter).not.toMatch(/^(?:export\s+)?(?:let|var)\s/m);
    expect(adapter.match(/process\.env/g)).toHaveLength(1);
    expect(adapter).toMatch(/getContext\(\)\.headers\?\.\[OIDC_TOKEN_HEADER\] \?\? process\.env\[OIDC_TOKEN_ENV\]/);
  });

  it("knows nothing about KMS, sealing, opening or static AWS credentials", () => {
    expect(adapter).not.toMatch(/KMS|Kms|kms|Sealer|sealer|Opener|opener|Decrypt|GenerateDataKey|crypto\/credentials/);
    expect(adapter).not.toMatch(/\bAWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION|DEFAULT_REGION|PROFILE|ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|ENDPOINT_URL\w*)\b/);
  });

  it("enters the official provider only after the preflight, with the fixed audience and session name, the KMS key's region and endpoint overrides ignored", () => {
    const preflight = adapter.indexOf("preflightVercelOidcToken(token, dependencies.nowSeconds())");
    const official = adapter.indexOf("dependencies.officialProvider(");
    expect(preflight).toBeGreaterThan(0);
    expect(official).toBeGreaterThan(preflight);
    expect(adapter.match(/dependencies\.officialProvider\(/g)).toHaveLength(1);
    expect(adapter).toMatch(/audience: AWS_STS_OIDC_AUDIENCE,/);
    expect(adapter).toMatch(/roleSessionName: config\.roleSessionName,/);
    expect(adapter).toMatch(/clientConfig: \{ region: config\.stsRegion, ignoreConfiguredEndpointUrls: true \}/);
    expect(raw).toMatch(/export const VERCEL_OIDC_PREFLIGHT_MIN_TTL_SECONDS = 120;/);
    expect(raw).toMatch(/export const VERCEL_WEB_SESSION_SECONDS = 3600;/);
  });

  it("is composed only by the web's connection runtime; no worker, job, app, ui or client module references it", () => {
    const users = findReferences(sourceFiles(RUNTIME_ROOTS), [/vercel-aws-identity|\bvercelAwsIdentity\b|\bcreateVercelAwsIdentity\b/]).map(([file]) => file);
    expect(users).toEqual(["server/connections/runtime.ts", VERCEL_ADAPTER]);
    const clientModules = sourceFiles(["app", "ui", "server"]).filter((file) => /^\s*["']use client["']/m.test(readFileSync(path.join(root, file), "utf8")));
    expect(findReferences(clientModules, [/connections\/runtime|vercel-aws-identity|@vercel\/oidc/])).toEqual([]);
  });

  it("pins the two approved packages exactly and adopts none of the forbidden ones directly", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(manifest.dependencies?.["@vercel/oidc"]).toBe("3.8.10");
    expect(manifest.dependencies?.["@vercel/oidc-aws-credentials-provider"]).toBe("3.3.10");
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const pkg of ["@aws-sdk/credential-provider-web-identity", "@aws-sdk/credential-providers", "@vercel/cli-exec", "@vercel/cli-config", "execa"]) expect(all[pkg], pkg).toBeUndefined();
    // Step 7E.4C: the one other AWS client, pinned exactly to the KMS client's version.
    expect(manifest.dependencies?.["@aws-sdk/client-sts"]).toBe(manifest.dependencies?.["@aws-sdk/client-kms"]);
  });

  it("the Vercel upload boundary still excludes local .vercel metadata", () => {
    expect(readFileSync(path.join(root, ".vercelignore"), "utf8").split("\n").map((line) => line.trim())).toContain("/.vercel");
  });
});

describe("AWS runtime-identity seam", () => {
  it("the web identity seam composes a provider only (no opener) and never resolves credentials itself", () => {
    const seam = codeOf("server/connections/web-identity.ts");
    expect(seam).not.toMatch(/opener|Opener|unwrap|Decrypt/);
    // The factory is called to build the provider; the provider itself is never invoked here.
    expect(seam).not.toMatch(/factory\(config\)\(\)|await\s+factory/);
  });
});

describe("diagnostic-scoped AWS attempt bound (Step 7E.7-B-R1): explicit argument, diagnostic only, never environment or global", () => {
  const KMS_CLIENT = "platform/crypto/credentials/aws-kms-client.ts";
  const COMPOSITION = "jobs/connections.ts";
  const DIAGNOSTIC = "jobs/integration-kms-diagnostic.ts";
  const DIAGNOSTIC_TASK = "jobs/trigger/integration/kms-worker-auth-diagnostic.ts";
  /** Step 7G-H5.5-P5-B: the read_content validation diagnostic also opts in (one KMS attempt), through the composition. */
  const READ_DIAGNOSTIC = "jobs/integration-read-content-validation.ts";
  const READ_DIAGNOSTIC_TASK = "jobs/trigger/integration/read-content-validation.ts";
  /** Step 7G-H5.5-P12-B2: the read_interactions validation diagnostic opts in the same way, through a delegating composition. */
  const INTERACTIONS_DIAGNOSTIC = "jobs/integration-read-interactions-validation.ts";
  const INTERACTIONS_DIAGNOSTIC_TASK = "jobs/trigger/integration/read-interactions-validation.ts";
  const SEAL_COMPOSITION = "server/connections/credential-crypto.ts";
  const runtime = sourceFiles(RUNTIME_ROOTS);
  const users = (pattern: RegExp): string[] => findReferences(runtime, [pattern]).map(([file]) => file).sort();
  const count = (file: string, pattern: RegExp): number => codeOf(file).match(new RegExp(pattern.source, "g"))?.length ?? 0;

  it("one option type, one field, only the literal 1 — it can remove SDK retries, never add capability", () => {
    expect(users(/\binterface AwsSingleAttempt\b/)).toEqual([KMS_CLIENT]);
    expect(codeOf(KMS_CLIENT)).toMatch(/export interface AwsSingleAttempt \{\n {2}readonly maxAttempts: 1;\n\}/);
    // Each factory adds exactly `maxAttempts: 1`, and only when the option is present; nothing else is configurable.
    expect(count(KMS_CLIENT, /\.\.\.\(attempts === undefined \? \{\} : \{ maxAttempts: 1 \}\),/)).toBe(1);
    expect(codeOf(KMS_CLIENT)).not.toMatch(/attempts\.maxAttempts|\.\.\.attempts\b|\.\.\.options\b|retryStrategy|retryMode|requestHandler/);
    // Step 7G-H5.6B: the worker identity adapter has no attempt option at all — it never retries.
    expect(codeOf(WORKER_ADAPTER)).not.toMatch(/attempts|maxAttempts|AwsSingleAttempt|retry\(/);
    expect(codeOf(KMS_CLIENT)).toMatch(/new KMSClient\(\{\n {4}region,\n {4}credentials,\n {4}ignoreConfiguredEndpointUrls: true,\n {4}\.\.\.\(attempts === undefined \? \{\} : \{ maxAttempts: 1 \}\),\n {2}\}\);/);
  });

  it("only the diagnostics opt in; the product compositions (open and seal) never pass the option", () => {
    expect(users(/\bKMS_DIAGNOSTIC_AWS_ATTEMPTS\b/)).toEqual([DIAGNOSTIC]);
    expect(users(/\bREAD_CONTENT_VALIDATION_AWS_ATTEMPTS\b/)).toEqual([READ_DIAGNOSTIC]);
    expect(users(/\{\s*maxAttempts:\s*1\s*\}/)).toEqual([DIAGNOSTIC, DIAGNOSTIC_TASK, KMS_CLIENT, READ_DIAGNOSTIC, READ_DIAGNOSTIC_TASK, INTERACTIONS_DIAGNOSTIC, INTERACTIONS_DIAGNOSTIC_TASK].sort());
    expect(users(/\bREAD_INTERACTIONS_VALIDATION_AWS_ATTEMPTS\b/)).toEqual([INTERACTIONS_DIAGNOSTIC]);
    expect(codeOf(INTERACTIONS_DIAGNOSTIC_TASK)).toMatch(/retry: \{ maxAttempts: 1 \},/);
    expect(codeOf(INTERACTIONS_DIAGNOSTIC)).toMatch(/export const READ_INTERACTIONS_VALIDATION_AWS_ATTEMPTS = Object\.freeze\(\{ maxAttempts: 1 \} as const\);/);
    expect(count(INTERACTIONS_DIAGNOSTIC, /composeReadInteractionsValidation\(environment, READ_INTERACTIONS_VALIDATION_AWS_ATTEMPTS\)/)).toBe(1);
    expect(users(/\bcomposeReadInteractionsValidation\(/)).toEqual([COMPOSITION, INTERACTIONS_DIAGNOSTIC].sort());
    // It delegates to the read_content composition: the opener is still composed in exactly one place.
    expect(codeOf(COMPOSITION)).toMatch(/export function composeReadInteractionsValidation\(environment: Environment, attempts: AwsSingleAttempt\)/);
    expect(count(COMPOSITION, /\n {2}return composeReadContentValidation\(environment, attempts\);\n\}/)).toBe(1);
    expect(codeOf(READ_DIAGNOSTIC_TASK)).toMatch(/retry: \{ maxAttempts: 1 \},/);
    expect(codeOf(READ_DIAGNOSTIC)).toMatch(/export const READ_CONTENT_VALIDATION_AWS_ATTEMPTS = Object\.freeze\(\{ maxAttempts: 1 \} as const\);/);
    expect(count(READ_DIAGNOSTIC, /composeReadContentValidation\(environment, READ_CONTENT_VALIDATION_AWS_ATTEMPTS\)/)).toBe(1);
    expect(users(/\bcomposeReadContentValidation\(/)).toEqual([COMPOSITION, READ_DIAGNOSTIC].sort());
    expect(count(COMPOSITION, /composeCredentialOpener\(environment, integrationWorkerAwsCredentials\(environment\), attempts\)/)).toBe(1);
    expect(codeOf(DIAGNOSTIC_TASK)).toMatch(/retry: \{ maxAttempts: 1 \},/); // the Trigger.dev task retry: a separate control
    expect(codeOf(DIAGNOSTIC)).toMatch(/export const KMS_DIAGNOSTIC_AWS_ATTEMPTS = Object\.freeze\(\{ maxAttempts: 1 \} as const\);/);
    expect(count(DIAGNOSTIC, /composeCredentialOpener\(environment, integrationWorkerAwsCredentials\(environment\), KMS_DIAGNOSTIC_AWS_ATTEMPTS\)/)).toBe(1);

    // Exact call sites of every factory on the path.
    expect(users(/\bcreateKmsClient\(/)).toEqual([KMS_CLIENT, SEAL_COMPOSITION, COMPOSITION].sort());
    expect(count(SEAL_COMPOSITION, /createKmsClient\(selection\.config, awsCredentials\)/)).toBe(1);
    expect(count(COMPOSITION, /createKmsClient\(/)).toBe(1);
    expect(count(COMPOSITION, /createKmsClient\(selection\.config, awsCredentials, attempts\)/)).toBe(1);
    expect(users(/\bintegrationWorkerAwsCredentials\(/)).toEqual([COMPOSITION, DIAGNOSTIC].sort());
    expect(users(/\bcomposeCredentialOpener\(/)).toEqual([COMPOSITION, DIAGNOSTIC].sort());
    expect(users(/\bcreateIntegrationWorkerAwsCredentials\(/)).toEqual([COMPOSITION, WORKER_ADAPTER].sort());
    expect(count(COMPOSITION, /createIntegrationWorkerAwsCredentials\(kms\)/)).toBe(1);
    // The product task composition: no bound at all.
    const product = codeOf(COMPOSITION).split("export function composeJobProviders(")[1]?.split(/\nexport /)[0] ?? "";
    expect(product).toMatch(/composeCredentialOpener\(environment, integrationWorkerAwsCredentials\(environment\)\);/);
    expect(product).not.toMatch(/attempts|maxAttempts|KMS_DIAGNOSTIC/);
    // The composition only forwards the option; it never constructs one.
    expect(codeOf(COMPOSITION)).not.toMatch(/maxAttempts/);
  });

  it("no environment variable, shared configuration or global mutable state drives AWS retries", () => {
    expect(findReferences(runtime, [/AWS_MAX_ATTEMPTS|AWS_RETRY_MODE|\bmax_attempts\b|\bretry_mode\b|\bretryMode\b|\bretryStrategy\b|\bStandardRetryStrategy\b|\bConfiguredRetryStrategy\b/])).toEqual([]);
    // Module-level mutable state: none, except the pre-existing lazy product composition cache in jobs/connections.ts.
    expect(codeOf(COMPOSITION).match(/^(?:export\s+)?(?:let|var)\s.*$/gm)).toEqual(["let composition: JobComposition | undefined;"]);
    for (const file of [KMS_CLIENT, WORKER_ADAPTER, COMPOSITION, DIAGNOSTIC, READ_DIAGNOSTIC]) {
      if (file !== COMPOSITION) expect(codeOf(file), file).not.toMatch(/^(?:export\s+)?(?:let|var)\s/m);
      expect(codeOf(file), file).not.toMatch(/process\.env(\.\w+|\[[^\]]+\])\s*(=(?!=)|\?\?=|\|\|=)|delete\s+process\.env|Object\.assign\(\s*process\.env/);
    }
    expect(codeOf(KMS_CLIENT)).not.toMatch(/process\.env/);
    expect(codeOf(DIAGNOSTIC)).not.toMatch(/process\.env/);
    expect(codeOf(READ_DIAGNOSTIC)).not.toMatch(/process\.env/);
  });
});

