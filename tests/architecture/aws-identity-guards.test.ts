/**
 * Static guards for the AWS runtime-identity contract (Step 7E.2). Import graphs are enforced by
 * .dependency-cruiser.cjs (aws-identity-contract-pure); these check what import graphs can't express.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeOf, findReferences, sourceFiles } from "../support/source-scan";

const root = path.resolve(import.meta.dirname, "../..");
const identityFiles = readdirSync(path.join(root, "platform/aws")).filter((file) => file.endsWith(".ts")).map((file) => `platform/aws/${file}`);
const RUNTIME_ROOTS = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "tools", "proxy.ts", "next.config.ts", "trigger.config.ts"];

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

  it("no identity exchange is implemented yet: no AssumeRole(WithWebIdentity), STS client, OIDC package or worker bootstrap", () => {
    expect(findReferences(sourceFiles(RUNTIME_ROOTS), [/AssumeRole/, /client-sts/, /@vercel\//, /\bgetVercelOidcToken\b|\bawsCredentialsProvider\b/, /x-vercel-oidc-token/i])).toEqual([]);
  });

  it("the web identity seam composes a provider only (no opener) and never resolves credentials itself", () => {
    const seam = codeOf("server/connections/web-identity.ts");
    expect(seam).not.toMatch(/opener|Opener|unwrap|Decrypt/);
    // The factory is called to build the provider; the provider itself is never invoked here.
    expect(seam).not.toMatch(/factory\(config\)\(\)|await\s+factory/);
  });
});
