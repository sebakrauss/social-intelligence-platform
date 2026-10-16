/**
 * Static checks for the Step 7E.10-B hosted web identity artifacts (design/phase-7e/web-identity; DEV/non-prod target
 * design, nothing applied to AWS or Vercel). They parse the JSON, cross-check it against the source contract and
 * evaluate an OFFLINE model of the trust statement's StringEquals conditions. The model documents intent; it never
 * proves AWS behavior (the live proof does, through CloudTrail).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectSecrets } from "@/domain/secret-patterns";
import { AWS_STS_OIDC_AUDIENCE } from "@/platform/aws/identity";
import { WEB_AWS_ROLE_SESSION_NAME } from "@/server/connections/web-identity";
import { REPOSITORY_ROOT, codeOf, findReferences, sourceFiles } from "../support/source-scan";

const DIR = "design/phase-7e/web-identity";
const PROVIDER_FILE = "vercel-oidc-provider.json";
const STATEMENT_FILE = "web-trust-vercel-production-statement.json";
const ISSUER = "https://oidc.vercel.com/social-intelligence";
const ISSUER_HOST_PATH = "oidc.vercel.com/social-intelligence";
const SUBJECT = "owner:social-intelligence:project:social-intelligence-platform:environment:production";
const APPROVED_PLACEHOLDERS = ["<DEV_AWS_PARTITION>", "<DEV_AWS_ACCOUNT_ID>"];
const ADAPTER = "server/connections/vercel-aws-identity.ts";
const RUNTIME_ROOTS = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain", "tools", "proxy.ts", "next.config.ts", "trigger.config.ts", "trigger.integration.config.ts"];

const read = (file: string): string => readFileSync(path.join(REPOSITORY_ROOT, DIR, file), "utf8");
const json = (file: string): Record<string, unknown> => JSON.parse(read(path.join("artifacts", file))) as Record<string, unknown>;

interface Request {
  readonly federatedPrincipal: string;
  readonly action: string;
  readonly aud: string;
  readonly sub: string;
  readonly roleSessionName: string;
}

const PROVIDER_ARN = `arn:<DEV_AWS_PARTITION>:iam::<DEV_AWS_ACCOUNT_ID>:oidc-provider/${ISSUER_HOST_PATH}`;
const GOOD: Request = { federatedPrincipal: PROVIDER_ARN, action: "sts:AssumeRoleWithWebIdentity", aud: AWS_STS_OIDC_AUDIENCE, sub: SUBJECT, roleSessionName: WEB_AWS_ROLE_SESSION_NAME };

/** Offline model of the one trust statement: exact principal, exact action, every StringEquals key exactly equal. */
function admits(statement: Record<string, unknown>, request: Request): boolean {
  const principal = statement["Principal"] as { Federated?: unknown };
  if (statement["Effect"] !== "Allow" || principal.Federated !== request.federatedPrincipal || statement["Action"] !== request.action) return false;
  const conditions = statement["Condition"] as Record<string, Record<string, unknown>>;
  if (Object.keys(conditions).join() !== "StringEquals") throw new Error("model: only StringEquals is modeled");
  const context: Record<string, string> = { [`${ISSUER_HOST_PATH}:aud`]: request.aud, [`${ISSUER_HOST_PATH}:sub`]: request.sub, "sts:RoleSessionName": request.roleSessionName };
  return Object.entries(conditions["StringEquals"] ?? {}).every(([key, value]) => typeof value === "string" && context[key] === value);
}

describe("hosted web identity artifacts — files, JSON and placeholders", () => {
  it("contains exactly the reviewed artifact set and a README (no scripts or infrastructure code)", () => {
    expect(readdirSync(path.join(REPOSITORY_ROOT, DIR)).sort()).toEqual(["README.md", "artifacts"]);
    expect(readdirSync(path.join(REPOSITORY_ROOT, DIR, "artifacts")).sort()).toEqual([PROVIDER_FILE, STATEMENT_FILE].sort());
  });

  it("uses only the two approved placeholders and contains no real account ID, ARN or secret", () => {
    for (const file of ["README.md", `artifacts/${PROVIDER_FILE}`, `artifacts/${STATEMENT_FILE}`]) {
      const content = read(file);
      expect([...content.matchAll(/<[A-Z][A-Z0-9_]*>/g)].map((m) => m[0]).filter((token) => !APPROVED_PLACEHOLDERS.includes(token)), file).toEqual([]);
      expect(content, file).not.toMatch(/\b\d{12}\b|arn:aws(?:-[a-z]+)*:/);
      for (const [index, line] of content.split("\n").entries()) expect(detectSecrets(line), `${file}:${String(index + 1)}`).toEqual([]);
    }
  });

  it("is outside the hosted web upload", () => {
    expect(readFileSync(path.join(REPOSITORY_ROOT, ".vercelignore"), "utf8").split("\n").map((line) => line.trim())).toContain("/design");
  });
});

describe("IAM OIDC provider — the Vercel Team issuer, one client ID", () => {
  it("exact URL and exactly the STS audience; nothing else", () => {
    expect(json(PROVIDER_FILE)).toEqual({ Url: ISSUER, ClientIDList: [AWS_STS_OIDC_AUDIENCE] });
    expect(AWS_STS_OIDC_AUDIENCE).toBe("sts.amazonaws.com");
  });
});

describe("web role trust statement — Vercel Production only (DUAL TRUST addition)", () => {
  const statement = json(STATEMENT_FILE);

  it("one Allow for the exact federated provider, only AssumeRoleWithWebIdentity, three exact StringEquals conditions", () => {
    expect(statement).toEqual({
      Sid: "VercelProductionWebIdentity",
      Effect: "Allow",
      Principal: { Federated: PROVIDER_ARN },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          [`${ISSUER_HOST_PATH}:aud`]: "sts.amazonaws.com",
          [`${ISSUER_HOST_PATH}:sub`]: SUBJECT,
          "sts:RoleSessionName": "wrenkind-vercel-web",
        },
      },
    });
  });

  it("no wildcard, no pattern operator, no set operator anywhere (team, project and environment are exact)", () => {
    const raw = read(`artifacts/${STATEMENT_FILE}`);
    expect(raw).not.toMatch(/[*?]|StringLike|ForAnyValue|ForAllValues|IfExists|NotPrincipal|NotAction/);
  });

  it("matches the source contract: the audience constant, the fixed session name and the exact Production subject", () => {
    const conditions = (statement["Condition"] as { StringEquals: Record<string, string> }).StringEquals;
    expect(conditions[`${ISSUER_HOST_PATH}:aud`]).toBe(AWS_STS_OIDC_AUDIENCE);
    expect(AWS_STS_OIDC_AUDIENCE).toBe("sts.amazonaws.com");
    expect(conditions["sts:RoleSessionName"]).toBe(WEB_AWS_ROLE_SESSION_NAME);
    expect(WEB_AWS_ROLE_SESSION_NAME).toBe("wrenkind-vercel-web");
    expect(conditions[`${ISSUER_HOST_PATH}:sub`]).toBe(SUBJECT);
  });

  it("offline model: the exact Production request is the ONLY admitted request", () => {
    expect(admits(statement, GOOD)).toBe(true);
    const denied: [string, Partial<Request>][] = [
      ["Preview", { sub: "owner:social-intelligence:project:social-intelligence-platform:environment:preview" }],
      ["Development", { sub: "owner:social-intelligence:project:social-intelligence-platform:environment:development" }],
      ["wrong project", { sub: "owner:social-intelligence:project:another-project:environment:production" }],
      ["wrong team", { sub: "owner:another-team:project:social-intelligence-platform:environment:production" }],
      ["subject prefix only", { sub: "owner:social-intelligence:project:social-intelligence-platform" }],
      ["wrong audience: Vercel default", { aud: "https://vercel.com/social-intelligence" }],
      ["wrong audience: URL form", { aud: "https://sts.amazonaws.com" }],
      ["another provider (global issuer)", { federatedPrincipal: "arn:<DEV_AWS_PARTITION>:iam::<DEV_AWS_ACCOUNT_ID>:oidc-provider/oidc.vercel.com" }],
      ["another session name", { roleSessionName: "aws-sdk-js-session-1800000000000" }],
      ["plain AssumeRole", { action: "sts:AssumeRole" }],
    ];
    for (const [label, change] of denied) expect(admits(statement, { ...GOOD, ...change }), label).toBe(false);
  });

  it("the README fixes dual trust, Production-only scope, no KMS policy change and no long-lived AWS keys in Vercel", () => {
    const readme = read("README.md");
    for (const required of ["DUAL TRUST", "verbatim", "break-glass", "Preview", "Production scope only", "The KMS key policy", "AWS_ACCESS_KEY_ID", "CREDENTIAL_KMS_WEB_ROLE_ARN", "Rollback", "PASS_ALIGNED_LIVE_PROVEN_CLEANED", "2026-10-16", "REMOVED AFTER PROOF", "REMOVED FROM VERCEL PRODUCTION", "DELETED AFTER PROOF", "RESTORED_TO_STANDARD_PROTECTION"]) {
      expect(readme, required).toContain(required);
    }
  });
});

describe("Step 7E.10 cleanup — the temporary hosted KMS diagnostic is gone; the permanent identity remains", () => {
  const references = (pattern: RegExp): string[] => [...new Set(findReferences(sourceFiles(RUNTIME_ROOTS), [pattern]).map(([file]) => file))];

  it("A · no versioned route, handler or service for the retired diagnostic (nothing under app/api/internal)", () => {
    expect(existsSync(path.join(REPOSITORY_ROOT, "app/api/internal"))).toBe(false);
    for (const file of ["server/connections/web-kms-diagnostic.ts", "server/connections/web-kms-diagnostic-route.ts"]) expect(existsSync(path.join(REPOSITORY_ROOT, file)), file).toBe(false);
    expect(references(/kms-web-diagnostic|web-kms-diagnostic|\bwebKmsIdentityDiagnostic\b|\brunWebKmsIdentityDiagnostic\b/)).toEqual([]);
  });

  it("B/C · no runtime source reads the retired operator key or carries the retired acknowledgement", () => {
    expect(references(/WEB_KMS_DIAGNOSTIC_OPERATOR_KEY|x-wrenkind-diagnostic-key/)).toEqual([]);
    expect(references(/VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_V1/)).toEqual([]);
  });

  it("D/E/F · the permanent hosted identity remains: the adapter, the seam, the fixed session name and the audience", () => {
    expect(existsSync(path.join(REPOSITORY_ROOT, ADAPTER))).toBe(true);
    expect(codeOf(ADAPTER)).toMatch(/roleSessionName: config\.roleSessionName,/);
    expect(codeOf(ADAPTER)).toMatch(/audience: AWS_STS_OIDC_AUDIENCE,/);
    expect(codeOf("server/connections/web-identity.ts")).toContain(`export const WEB_AWS_ROLE_SESSION_NAME = "wrenkind-vercel-web";`);
    expect(codeOf("server/connections/runtime.ts")).toMatch(/composeCredentialSealer\(environment, composeWebAwsCredentials\(environment, WEB_AWS_IDENTITY\)\);/);
    expect(codeOf("server/connections/runtime.ts")).toMatch(/isLocalSimulatorRuntime\(environment\) \? \{ simulator: localSimulator\(environment\)\.authorization \} : \{\}/);
  });
});
