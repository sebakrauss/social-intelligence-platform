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

  it("STS is never called directly: no AssumeRole(WithWebIdentity), STS client or web-identity provider package", () => {
    expect(findReferences(sourceFiles(RUNTIME_ROOTS), [/AssumeRole/, /client-sts/, /credential-provider-web-identity/, /\bfromWebToken\b|\bfromTokenFile\b/])).toEqual([]);
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

  it("enters the official provider only after the preflight, with the fixed audience, the KMS key's region and endpoint overrides ignored", () => {
    const preflight = adapter.indexOf("preflightVercelOidcToken(token, dependencies.nowSeconds())");
    const official = adapter.indexOf("dependencies.officialProvider(");
    expect(preflight).toBeGreaterThan(0);
    expect(official).toBeGreaterThan(preflight);
    expect(adapter.match(/dependencies\.officialProvider\(/g)).toHaveLength(1);
    expect(adapter).toMatch(/audience: AWS_STS_OIDC_AUDIENCE,/);
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
    for (const pkg of ["@aws-sdk/client-sts", "@aws-sdk/credential-provider-web-identity", "@aws-sdk/credential-providers", "@vercel/cli-exec", "@vercel/cli-config", "execa"]) expect(all[pkg], pkg).toBeUndefined();
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
