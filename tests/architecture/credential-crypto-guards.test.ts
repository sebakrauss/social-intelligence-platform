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
const OPENING = /platform\/crypto\/credentials\/(open|local-opener|local-keyring|aead)\b|\bCredentialOpener\b|\bDataKeyUnwrapper\b/;

describe("credential crypto boundary", () => {
  it("the sealing side never imports the opening side or decryption", () => {
    for (const file of ["seal.ts", "local-sealer.ts"]) {
      const source = read(file);
      expect(importsOf(source).filter((spec) => /open|local-opener/.test(spec)), file).toEqual([]);
      expect(source, file).not.toMatch(/\bdecrypt\b|unwrapDataKey|\.unwrapper\b/);
    }
  });

  it("uses node:crypto only: no provider or AWS SDK, no third-party crypto package", () => {
    for (const file of sources) {
      const external = importsOf(read(file)).filter((spec) => !spec.startsWith("./") && !spec.startsWith("@/domain/"));
      expect(external.every((spec) => spec === "node:crypto"), `${file}: ${external.join(", ")}`).toBe(true);
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

  it("the future AWS KMS SDK is confined to its adapter file, and not adopted yet", () => {
    const rule = ruleNamed("aws-kms-sdk-only-in-credential-adapter");
    expect(rule?.from.pathNot).toBe("^platform/crypto/credentials/aws-kms\\.ts$");
    expect(new RegExp(rule?.to.path ?? "^$").test("node_modules/@aws-sdk/client-kms/dist-cjs/index.js")).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names.filter((name) => name.startsWith("@aws-sdk/"))).toEqual([]);
    expect(sources).not.toContain("aws-kms.ts");
  });

  // ── Step 7B ──────────────────────────────────────────────────────────────────────────────────
  it("the logical keyRef domain imports nothing (no AWS or provider dependency)", () => {
    expect(importsOf(read("key-ref.ts"))).toEqual([]);
    expect(read("key-ref.ts")).not.toMatch(/@aws-sdk|require\(/);
  });

  it("the opening rules keep their exact shape: web never opens; within jobs only the integration composition does", () => {
    expect(ruleNamed("credential-opening-job-runtime-only")?.from.pathNot).toBe("^(jobs|tests|platform/crypto/credentials)/");
    expect(ruleNamed("credential-opening-job-runtime-only")?.to.path).toBe("^platform/crypto/credentials/(open|local-opener|local-keyring|aead)\\.ts$");
    const narrow = ruleNamed("credential-opening-integration-composition-only");
    expect(narrow?.from).toEqual({ path: "^jobs/", pathNot: "^jobs/connections\\.ts$" });
    expect(narrow?.to.path).toBe("^platform/crypto/credentials/(open|local-opener)\\.ts$");
  });

  it("no web code references the opening half, not even its types", () => {
    expect(findReferences(sourceFiles(["app", "ui", "server", "proxy.ts"]), [OPENING])).toEqual([]);
  });

  it("system, migration and database tooling never reference the opening half; in jobs/ only the integration composition does", () => {
    expect(findReferences(sourceFiles(["tools", "db", "platform/db", "platform/outbox", "platform/jobs", "jobs/trigger"]), [OPENING])).toEqual([]);
    expect(findReferences(sourceFiles(["jobs"]), [OPENING]).map(([file]) => file).filter((file, i, all) => all.indexOf(file) === i)).toEqual(["jobs/connections.ts"]);
  });
});
