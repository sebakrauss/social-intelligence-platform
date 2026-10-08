/**
 * Static guards for the Step 5A credential crypto boundary (TA §39, ADR-64). Dependency-direction rules live
 * in .dependency-cruiser.cjs (proven by boundaries.test.ts); these check what import graphs can't express.
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_ENVIRONMENT_GUARD, codeOf, codeWithoutForbiddenList, findReferences, sourceFiles } from "../support/source-scan";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "platform/crypto/credentials");
/** Code without comments (documentation may name what the code must not use). */
const read = (file: string): string => codeOf(`platform/crypto/credentials/${file}`);
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const importsOf = (source: string): string[] => [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
const require = createRequire(import.meta.url);
const depcruise = require(path.join(root, ".dependency-cruiser.cjs")) as { forbidden: { name: string; from: { path?: string; pathNot?: string }; to: { path?: string } }[] };
const ruleNamed = (name: string) => depcruise.forbidden.find((rule) => rule.name === name);
/** Any reference to the opening half (opener, local opener, keyring internals). */
const OPENING = /platform\/crypto\/credentials\/(open|local-opener|local-keyring|aead|aws-kms-unwrapper|aws-kms-opener)\b|\bCredentialOpener\b|\bDataKeyUnwrapper\b|\bcreateKmsDataKeyUnwrapper\b|\bKmsDecryptSender\b|\bkmsCredentialOpener\b|\bcomposeCredentialOpener\b/;
const KMS_CAPABILITIES = ["aws-kms-generator.ts", "aws-kms-unwrapper.ts"];
/** Files that may import the KMS SDK: the two capabilities and the single client factory (Step 7D). */
const KMS_SDK_FILES = [...KMS_CAPABILITIES, "aws-kms-client.ts"];
const VERCEL_WEB_IDENTITY_ADAPTER = "server/connections/vercel-aws-identity.ts";
const RUNTIME_ROOTS = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "tools", "proxy.ts", "next.config.ts", "trigger.config.ts", "trigger.integration.config.ts"];

describe("credential crypto boundary", () => {
  it("the sealing side never imports the opening side or decryption", () => {
    for (const file of ["seal.ts", "local-sealer.ts", "aws-kms-generator.ts", "aws-kms-common.ts", "aws-kms-sealer.ts", "aws-kms-client.ts", "aws-kms-config.ts"]) {
      const source = read(file);
      expect(importsOf(source).filter((spec) => /open|local-opener|unwrapper/.test(spec)), file).toEqual([]);
      expect(source, file).not.toMatch(/\bdecrypt\b|unwrapDataKey|\.unwrapper\b|DecryptCommand/i);
    }
  });

  it("uses node:crypto only, except the KMS capabilities and the client factory, which import only the KMS client", () => {
    for (const file of sources) {
      // @/platform/aws/ is the pure AWS identity contract (Step 7E.2), not a package.
      const external = importsOf(read(file)).filter((spec) => !spec.startsWith("./") && !spec.startsWith("@/domain/") && !spec.startsWith("@/platform/aws/"));
      const allowed = KMS_SDK_FILES.includes(file) ? ["@aws-sdk/client-kms"] : ["node:crypto"];
      expect(external.every((spec) => allowed.includes(spec)), `${file}: ${external.join(", ")}`).toBe(true);
    }
  });

  it("never logs and never prints: no console, logger or stdout usage", () => {
    for (const file of sources) expect(read(file), file).not.toMatch(/\bconsole\.|\blogger\b|process\.std(out|err)/);
  });

  it("the local key is never derived, defaulted or generated", () => {
    const source = read("local-keyring.ts");
    expect(source).not.toMatch(/pbkdf2|scrypt|hkdf|createHash|argon/i);
    expect(source).not.toMatch(/randomBytes/);
    expect(source).not.toMatch(/LOCAL_KEYRING_KEY_ENV\]\s*(\?\?|\|\|)/);
    // The only process-environment access is through the explicit `environment` argument.
    for (const file of sources) expect(read(file), file).not.toMatch(/process\.env/);
  });

  it("errors carry fixed codes only (no cause, no interpolated values)", () => {
    const source = read("errors.ts");
    expect(source).not.toMatch(/cause/);
    expect(source).toMatch(/super\(`credential_crypto_\$\{code\.toLowerCase\(\)\}`\)/);
  });

  it("the shared crypto index does not re-export the credential boundary", () => {
    expect(readFileSync(path.join(root, "platform/crypto/index.ts"), "utf8")).not.toMatch(/credentials/);
  });

  it("the AWS KMS SDK is confined to the two keyring capabilities (Step 7C), pinned, and the only AWS package", () => {
    const rule = ruleNamed("aws-kms-sdk-only-in-credential-adapter");
    expect(rule?.from.pathNot).toBe("^(platform/crypto/credentials/aws-kms-(generator|unwrapper|client)\\.ts|tests/unit/platform/aws-kms-(keyring|composition)\\.test\\.ts)$");
    expect(new RegExp(rule?.to.path ?? "^$").test("node_modules/@aws-sdk/client-kms/dist-cjs/index.js")).toBe(true);
    const others = new RegExp(ruleNamed("aws-sdk-only-client-kms")?.to.path ?? "^$");
    for (const pkg of ["@aws-sdk/credential-provider-node", "@aws-sdk/credential-providers", "@aws-sdk/client-sts", "@aws-sdk/core", "@smithy/core"]) {
      expect(others.test(`node_modules/${pkg}/dist-cjs/index.js`), pkg).toBe(true);
    }
    expect(others.test("node_modules/@aws-sdk/client-kms/dist-cjs/index.js")).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all).filter((name) => name.startsWith("@aws-sdk/") || name.startsWith("@smithy/"))).toEqual(["@aws-sdk/client-kms"]);
    expect(manifest.dependencies?.["@aws-sdk/client-kms"]).toBe("3.1146.0");
    expect(sources).not.toContain("aws-kms.ts");
    for (const file of ["aws-kms-common.ts", "aws-kms-config.ts", "aws-kms-sealer.ts", "aws-kms-opener.ts", ...KMS_SDK_FILES]) expect(sources).toContain(file);
  });

  it("each KMS capability can send only its own command: the generator GenerateDataKey, the unwrapper Decrypt", () => {
    const generator = read("aws-kms-generator.ts");
    const unwrapper = read("aws-kms-unwrapper.ts");
    expect(generator).toMatch(/import \{ GenerateDataKeyCommand, type GenerateDataKeyCommandOutput \} from "@aws-sdk\/client-kms";/);
    expect(unwrapper).toMatch(/import \{ DecryptCommand, type DecryptCommandOutput \} from "@aws-sdk\/client-kms";/);
    for (const [file, source] of [["aws-kms-generator.ts", generator], ["aws-kms-unwrapper.ts", unwrapper]] as const) {
      const commands = [...source.matchAll(/\b([A-Z][A-Za-z]+)Command\b/g)].map((m) => m[1]);
      expect(new Set(commands), file).toEqual(new Set([file === "aws-kms-generator.ts" ? "GenerateDataKey" : "Decrypt"]));
    }
    // The unwrapper never names a physical key in its request: no KeyId field is sent to Decrypt.
    expect(unwrapper).not.toMatch(/KeyId\s*:/);
  });

  it("core envelope, context, key-ref and the shared KMS mapping import no package at all", () => {
    for (const file of ["envelope.ts", "context.ts", "key-ref.ts", "aws-kms-common.ts", "aws-kms-config.ts", "aws-kms-sealer.ts", "aws-kms-opener.ts"]) {
      expect(importsOf(read(file)).filter((spec) => !spec.startsWith("./") && !spec.startsWith("@/domain/") && spec !== "@/platform/aws/identity"), file).toEqual([]);
    }
  });

  it("a KMS client is constructed only by the client factory (Step 7D)", () => {
    const runtime = sourceFiles(RUNTIME_ROOTS);
    expect(findReferences(runtime, [/\bKMSClient\b/])).toEqual([["platform/crypto/credentials/aws-kms-client.ts", "\\bKMSClient\\b"]]);
    expect(read("aws-kms-client.ts").match(/new KMSClient\(/g)).toHaveLength(1);
  });

  it("no credential provider, default chain, STS, OIDC or role assumption is used anywhere — except the web's Vercel OIDC adapter (7E.3B)", () => {
    const patterns = [
      /@aws-sdk\/(credential-provider|client-sts)/,
      /@vercel\//,
      /\bCREDENTIAL_KMS_WORKER\w*|BOOTSTRAP_(ACCESS_KEY|SECRET|CREDENTIAL)|WORKER_BOOTSTRAP/i,
      /\b(fromNodeProviderChain|defaultProvider|fromTemporaryCredentials|fromWebToken|fromEnv|fromIni|fromContainerMetadata|fromInstanceMetadata|AssumeRole\w*)\b/,
      /WebIdentity|\bOIDC\b/i,
    ];
    expect(findReferences(sourceFiles(RUNTIME_ROOTS).filter((file) => file !== VERCEL_WEB_IDENTITY_ADAPTER), patterns)).toEqual([]);
    // The adapter's exemption is exactly the Vercel OIDC packages and its request-token header — no AWS provider, chain,
    // STS, worker bootstrap or role assumption (aws-identity-guards.test.ts pins the rest of its shape).
    expect(findReferences([VERCEL_WEB_IDENTITY_ADAPTER], patterns).map(([, pattern]) => pattern)).toEqual([patterns[1]?.source, patterns[4]?.source]);
  });

  it("only the credential-crypto composition boundary reads the KMS keyring configuration", () => {
    const readers = findReferences(sourceFiles(RUNTIME_ROOTS), [/\bCREDENTIAL_(CONTEXT_ENV|KMS_KEY_ARN|KMS_ALLOWED_KEY_ARNS)\b/]).map(([file]) => file);
    expect(readers).toEqual(["server/connections/environment.ts"]);
    expect(codeOf("server/connections/environment.ts")).not.toMatch(/process\.env/);
  });

  it("the web role ARN is read only at the web identity seam, never by the job runtime (Step 7E.2)", () => {
    const readers = findReferences(sourceFiles(RUNTIME_ROOTS), [/\bCREDENTIAL_KMS_WEB_ROLE_ARN\b/]).map(([file]) => file);
    expect(readers).toEqual(["server/connections/web-identity.ts"]);
    expect(codeOf("server/connections/web-identity.ts")).not.toMatch(/process\.env/);
    expect(findReferences(sourceFiles(["jobs"]), [/web-identity|WebAwsIdentity|composeWebAwsCredentials/])).toEqual([]);
    expect(findReferences(sourceFiles(RUNTIME_ROOTS), [/\bCREDENTIAL_KMS_[A-Z_]+\b/]).map(([, p]) => p).length).toBeGreaterThan(0);
    // The only CREDENTIAL_KMS_* names in runtime code are the three keyring values and the web role ARN.
    for (const [file] of findReferences(sourceFiles(RUNTIME_ROOTS), [/\bCREDENTIAL_KMS_(?!KEY_ARN\b|ALLOWED_KEY_ARNS\b|WEB_ROLE_ARN\b)[A-Z_]+\b/])) {
      throw new Error(`${file}: unexpected CREDENTIAL_KMS_* name`);
    }
  });

  it("no static AWS credential or region variable is read by runtime code (only named in the hosted-web refusal list)", () => {
    const pattern = /\bAWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION|DEFAULT_REGION|PROFILE|ROLE_ARN|WEB_IDENTITY_TOKEN_FILE)\b/;
    expect(findReferences(sourceFiles(RUNTIME_ROOTS).filter((file) => file !== WEB_ENVIRONMENT_GUARD), [pattern])).toEqual([]);
    expect(pattern.test(codeWithoutForbiddenList(WEB_ENVIRONMENT_GUARD))).toBe(false);
  });

  // ── Step 7B ──────────────────────────────────────────────────────────────────────────────────
  it("the logical keyRef domain imports nothing (no AWS or provider dependency)", () => {
    expect(importsOf(read("key-ref.ts"))).toEqual([]);
    expect(read("key-ref.ts")).not.toMatch(/@aws-sdk|require\(/);
  });

  it("the opening rules keep their exact shape: web never opens; within jobs only the integration composition does", () => {
    expect(ruleNamed("credential-opening-job-runtime-only")?.from.pathNot).toBe("^(jobs|tests|platform/crypto/credentials)/");
    expect(ruleNamed("credential-opening-job-runtime-only")?.to.path).toBe("^platform/crypto/credentials/(open|local-opener|local-keyring|aead|aws-kms-unwrapper|aws-kms-opener)\\.ts$");
    const narrow = ruleNamed("credential-opening-integration-composition-only");
    expect(narrow?.from).toEqual({ path: "^jobs/", pathNot: "^jobs/connections\\.ts$" });
    expect(narrow?.to.path).toBe("^platform/crypto/credentials/(open|local-opener|aws-kms-unwrapper|aws-kms-opener)\\.ts$");
  });

  it("no web code references the opening half, not even its types", () => {
    expect(findReferences(sourceFiles(["app", "ui", "server", "proxy.ts"]), [OPENING])).toEqual([]);
  });

  it("system, migration and database tooling never reference the opening half; in jobs/ only the integration composition does", () => {
    expect(findReferences(sourceFiles(["tools", "db", "platform/db", "platform/outbox", "platform/jobs", "jobs/trigger"]), [OPENING])).toEqual([]);
    expect(findReferences(sourceFiles(["jobs"]), [OPENING]).map(([file]) => file).filter((file, i, all) => all.indexOf(file) === i)).toEqual(["jobs/connections.ts"]);
  });
});
