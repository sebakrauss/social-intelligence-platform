/**
 * Static guards for the Step 5A credential crypto boundary (TA §39, ADR-64). Dependency-direction rules live
 * in .dependency-cruiser.cjs (proven by boundaries.test.ts); these check what import graphs can't express.
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeOf, findReferences, sourceFiles } from "../support/source-scan";

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
const OPENING = /platform\/crypto\/credentials\/(open|local-opener|local-keyring|aead|aws-kms-unwrapper)\b|\bCredentialOpener\b|\bDataKeyUnwrapper\b|\bcreateKmsDataKeyUnwrapper\b|\bKmsDecryptSender\b/;
const KMS_CAPABILITIES = ["aws-kms-generator.ts", "aws-kms-unwrapper.ts"];

describe("credential crypto boundary", () => {
  it("the sealing side never imports the opening side or decryption", () => {
    for (const file of ["seal.ts", "local-sealer.ts", "aws-kms-generator.ts", "aws-kms-common.ts"]) {
      const source = read(file);
      expect(importsOf(source).filter((spec) => /open|local-opener|unwrapper/.test(spec)), file).toEqual([]);
      expect(source, file).not.toMatch(/\bdecrypt\b|unwrapDataKey|\.unwrapper\b|DecryptCommand/i);
    }
  });

  it("uses node:crypto only, except the two KMS capabilities, which import only the KMS client", () => {
    for (const file of sources) {
      const external = importsOf(read(file)).filter((spec) => !spec.startsWith("./") && !spec.startsWith("@/domain/"));
      const allowed = KMS_CAPABILITIES.includes(file) ? ["@aws-sdk/client-kms"] : ["node:crypto"];
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
    expect(rule?.from.pathNot).toBe("^(platform/crypto/credentials/aws-kms-(generator|unwrapper)\\.ts|tests/unit/platform/aws-kms-keyring\\.test\\.ts)$");
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
    for (const file of ["aws-kms-common.ts", ...KMS_CAPABILITIES]) expect(sources).toContain(file);
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
    for (const file of ["envelope.ts", "context.ts", "key-ref.ts", "aws-kms-common.ts"]) {
      expect(importsOf(read(file)).filter((spec) => !spec.startsWith("./") && !spec.startsWith("@/domain/")), file).toEqual([]);
    }
  });

  it("no KMS client is constructed and no credential provider, default chain or STS is used anywhere yet (7D/7E)", () => {
    const runtime = sourceFiles(["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "tools", "proxy.ts", "next.config.ts", "trigger.config.ts"]);
    expect(findReferences(runtime, [/\bKMSClient\b/, /@aws-sdk\/(credential-provider|client-sts)/, /\b(fromNodeProviderChain|defaultProvider|fromTemporaryCredentials|fromWebToken|fromEnv|fromIni|AssumeRole\w*)\b/])).toEqual([]);
  });

  // ── Step 7B ──────────────────────────────────────────────────────────────────────────────────
  it("the logical keyRef domain imports nothing (no AWS or provider dependency)", () => {
    expect(importsOf(read("key-ref.ts"))).toEqual([]);
    expect(read("key-ref.ts")).not.toMatch(/@aws-sdk|require\(/);
  });

  it("the opening rules keep their exact shape: web never opens; within jobs only the integration composition does", () => {
    expect(ruleNamed("credential-opening-job-runtime-only")?.from.pathNot).toBe("^(jobs|tests|platform/crypto/credentials)/");
    expect(ruleNamed("credential-opening-job-runtime-only")?.to.path).toBe("^platform/crypto/credentials/(open|local-opener|local-keyring|aead|aws-kms-unwrapper)\\.ts$");
    const narrow = ruleNamed("credential-opening-integration-composition-only");
    expect(narrow?.from).toEqual({ path: "^jobs/", pathNot: "^jobs/connections\\.ts$" });
    expect(narrow?.to.path).toBe("^platform/crypto/credentials/(open|local-opener|aws-kms-unwrapper)\\.ts$");
  });

  it("no web code references the opening half, not even its types", () => {
    expect(findReferences(sourceFiles(["app", "ui", "server", "proxy.ts"]), [OPENING])).toEqual([]);
  });

  it("system, migration and database tooling never reference the opening half; in jobs/ only the integration composition does", () => {
    expect(findReferences(sourceFiles(["tools", "db", "platform/db", "platform/outbox", "platform/jobs", "jobs/trigger"]), [OPENING])).toEqual([]);
    expect(findReferences(sourceFiles(["jobs"]), [OPENING]).map(([file]) => file).filter((file, i, all) => all.indexOf(file) === i)).toEqual(["jobs/connections.ts"]);
  });
});
