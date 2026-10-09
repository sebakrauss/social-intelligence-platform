/**
 * Static checks for the Step 7E.5 AWS authorization artifacts (design/phase-7e/aws-authorization; DEV/non-prod target
 * design, nothing applied to AWS). They read the materialized JSON and documents, cross-check them against the source
 * contract, and evaluate an OFFLINE model of the policy conditions. The model encodes the AWS evaluation semantics the
 * design relies on — explicit Deny wins; C1_STRICT AssumeRole needs trust, identity and boundary Allows; a same-account
 * resource grant to a user ARN is not limited by the boundary's implicit deny; the worker role has no boundary — and
 * refuses any operator it does not model. It documents intent; it never proves AWS behavior (live validation is 7F).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isUuid } from "@/domain/ids";
import { detectSecrets } from "@/domain/secret-patterns";
import { KMS_CONTEXT_ENVS } from "@/platform/crypto/credentials/aws-kms-config";
import { CREDENTIAL_CONTEXT_APP, CREDENTIAL_CONTEXT_FIELDS, CREDENTIAL_CONTEXT_VERSION, CREDENTIAL_PURPOSES } from "@/platform/crypto/credentials/context";
import { REPOSITORY_ROOT, codeOf } from "../support/source-scan";

const DIR = "design/phase-7e/aws-authorization";

const APPROVED_PLACEHOLDERS = [
  "<DEV_AWS_ACCOUNT_ID>",
  "<DEV_AWS_PARTITION>",
  "<DEV_KMS_REGION>",
  "<DEV_KMS_KEY_ARN>",
  "<DEV_BOOTSTRAP_USER_NAME>",
  "<DEV_BOOTSTRAP_USER_ARN>",
  "<DEV_BOOTSTRAP_BOUNDARY_POLICY_ARN>",
  "<DEV_WORKER_ROLE_NAME>",
  "<DEV_WORKER_ROLE_ARN>",
  "<DEV_WEB_ROLE_ARN>",
  "<DEV_OPERATOR_ROLE_ARN>",
  "<DEV_GUARD_POLICY_NAME>",
  "<REVOCATION_CUTOFF_UTC>",
];
/** Allowed in documents only: runbook key labels and the 7F-calibrated alert threshold. Never in a policy. */
const DOCUMENT_ONLY_LABELS = ["<BOOTSTRAP_KEY_A_ID>", "<BOOTSTRAP_KEY_B_ID>", "<DECRYPT_HOURLY_CEILING>"];

const WORKER_ROLE = "<DEV_WORKER_ROLE_ARN>";
const BOOTSTRAP_USER = "<DEV_BOOTSTRAP_USER_ARN>";
const KEY = "<DEV_KMS_KEY_ARN>";
const WEB_ROLE = "<DEV_WEB_ROLE_ARN>";

const ARTIFACT = {
  identity: "bootstrap-identity-policy.json",
  boundary: "bootstrap-permissions-boundary.json",
  trust: "worker-trust-policy.json",
  guard: "worker-deny-guard.json",
  workerKms: "kms-worker-decrypt-statement.json",
  dataKeyDeny: "kms-deny-data-keys-except-web.json",
  emergency: "emergency-deny-all.json",
  revocation: "revoke-older-sessions.json",
} as const;
/** Key-policy fragments are single statements; the rest are full policy documents. */
const FRAGMENTS: readonly string[] = [ARTIFACT.workerKms, ARTIFACT.dataKeyDeny];

// ── Loading and shape validation ──────────────────────────────────────────────────────────────────────────────────

type ConditionValue = string | readonly string[];
type Conditions = Readonly<Record<string, Readonly<Record<string, ConditionValue>>>>;

interface Statement {
  readonly Sid: string;
  readonly Effect: "Allow" | "Deny";
  readonly Principal?: "*" | { readonly AWS: string };
  readonly Action?: readonly string[];
  readonly NotAction?: readonly string[];
  readonly Resource?: readonly string[];
  readonly NotResource?: readonly string[];
  readonly Condition?: Conditions;
}

const STATEMENT_FIELDS = ["Sid", "Effect", "Principal", "Action", "NotAction", "Resource", "NotResource", "Condition"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

function stringList(value: unknown, what: string): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) return value;
  throw new Error(`${what}: expected a string or a non-empty string array`);
}

function conditionsOf(value: unknown, what: string): Conditions {
  if (!isRecord(value)) throw new Error(`${what}: Condition must be an object`);
  const out: Record<string, Record<string, ConditionValue>> = {};
  for (const [operator, block] of Object.entries(value)) {
    if (!isRecord(block)) throw new Error(`${what}: ${operator} must be an object`);
    const keys: Record<string, ConditionValue> = {};
    for (const [key, raw] of Object.entries(block)) keys[key] = typeof raw === "string" ? raw : stringList(raw, `${what}: ${operator}.${key}`);
    out[operator] = keys;
  }
  return out;
}

function principalOf(value: unknown, what: string): "*" | { readonly AWS: string } {
  if (value === "*") return "*";
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value["AWS"] === "string") return { AWS: value["AWS"] };
  throw new Error(`${what}: Principal must be "*" or { AWS: <one ARN> }`);
}

function statementOf(value: unknown, what: string): Statement {
  if (!isRecord(value)) throw new Error(`${what}: statement must be an object`);
  const unknownFields = Object.keys(value).filter((key) => !STATEMENT_FIELDS.includes(key));
  if (unknownFields.length > 0) throw new Error(`${what}: unexpected fields ${unknownFields.join(", ")}`);
  const sid = value["Sid"];
  const effect = value["Effect"];
  if (typeof sid !== "string" || !/^[A-Za-z0-9]+$/.test(sid)) throw new Error(`${what}: Sid must be alphanumeric`);
  if (effect !== "Allow" && effect !== "Deny") throw new Error(`${what}: Effect must be Allow or Deny`);
  if (("Action" in value) === ("NotAction" in value)) throw new Error(`${what}: exactly one of Action / NotAction`);
  if ("Resource" in value && "NotResource" in value) throw new Error(`${what}: Resource and NotResource together`);
  return {
    Sid: sid,
    Effect: effect,
    ...("Principal" in value ? { Principal: principalOf(value["Principal"], what) } : {}),
    ...("Action" in value ? { Action: stringList(value["Action"], `${what}: Action`) } : {}),
    ...("NotAction" in value ? { NotAction: stringList(value["NotAction"], `${what}: NotAction`) } : {}),
    ...("Resource" in value ? { Resource: stringList(value["Resource"], `${what}: Resource`) } : {}),
    ...("NotResource" in value ? { NotResource: stringList(value["NotResource"], `${what}: NotResource`) } : {}),
    ...("Condition" in value ? { Condition: conditionsOf(value["Condition"], what) } : {}),
  };
}

const rawArtifact = (file: string): string => readFileSync(path.join(REPOSITORY_ROOT, DIR, "artifacts", file), "utf8");

function parsed(file: string): unknown {
  const value: unknown = JSON.parse(rawArtifact(file));
  return value;
}

/** A full policy document: Version 2012-10-17 and a non-empty Statement array of well-formed statements. */
function policy(file: string): readonly Statement[] {
  const value = parsed(file);
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "Statement,Version") throw new Error(`${file}: expected exactly Version and Statement`);
  if (value["Version"] !== "2012-10-17") throw new Error(`${file}: Version must be 2012-10-17`);
  const statements = value["Statement"];
  if (!Array.isArray(statements) || statements.length === 0) throw new Error(`${file}: Statement must be a non-empty array`);
  const out = statements.map((statement, index) => statementOf(statement, `${file}#${String(index)}`));
  if (new Set(out.map((s) => s.Sid)).size !== out.length) throw new Error(`${file}: duplicate Sid`);
  return out;
}

/** A single key-policy statement (fragment of the DEV key policy). */
const fragment = (file: string): Statement => statementOf(parsed(file), file);

const identity = policy(ARTIFACT.identity);
const boundary = policy(ARTIFACT.boundary);
const trust = policy(ARTIFACT.trust);
const guard = policy(ARTIFACT.guard);
const emergency = policy(ARTIFACT.emergency);
const revocation = policy(ARTIFACT.revocation);
const workerKms = fragment(ARTIFACT.workerKms);
const dataKeyDeny = fragment(ARTIFACT.dataKeyDeny);
const allStatements: readonly Statement[] = [...identity, ...boundary, ...trust, ...guard, ...emergency, ...revocation, workerKms, dataKeyDeny];

function filesUnder(relative: string): string[] {
  const absolute = path.join(REPOSITORY_ROOT, relative);
  if (statSync(absolute).isFile()) return [relative];
  return readdirSync(absolute).flatMap((entry) => filesUnder(path.join(relative, entry)));
}
const designFiles = filesUnder(DIR).sort();
const doc = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, DIR, relative), "utf8");

// ── Offline condition model ───────────────────────────────────────────────────────────────────────────────────────

type Verdict = "ALLOW" | "DENY";

interface Request {
  readonly action: string;
  readonly resource: string;
  readonly principalArn: string;
  /** Request-context condition keys (aws:TokenIssueTime, sts:RoleSessionName, kms:EncryptionContext:*, ...). */
  readonly keys?: Readonly<Record<string, ConditionValue>>;
}

/** IAM wildcard match: `*` any run, `?` exactly one character. */
function wildcard(pattern: string, value: string, ignoreCase: boolean): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "").test(value);
}

/** Condition-key NAMES are case-insensitive in AWS (values are compared per operator). */
function lookup(request: Request, key: string): ConditionValue | undefined {
  const context: Record<string, ConditionValue> = { "aws:PrincipalArn": request.principalArn, ...request.keys };
  const found = Object.keys(context).filter((name) => name.toLowerCase() === key.toLowerCase());
  if (found.length > 1) throw new Error(`ambiguous condition key ${key}`);
  const name = found[0];
  return name === undefined ? undefined : context[name];
}

const single = (value: ConditionValue): string => {
  if (typeof value !== "string") throw new Error("single-valued key expected");
  return value;
};

function conditionHolds(operator: string, key: string, expected: ConditionValue, request: Request): boolean {
  const actual = lookup(request, key);
  const allowed = typeof expected === "string" ? [expected] : expected;
  switch (operator) {
    case "StringEquals":
      return actual !== undefined && allowed.includes(single(actual));
    case "StringNotEquals":
      return actual === undefined || !allowed.includes(single(actual));
    case "StringLike":
      return actual !== undefined && allowed.some((pattern) => wildcard(pattern, single(actual), false));
    case "Null":
      if (typeof expected !== "string" || !["true", "false"].includes(expected)) throw new Error("Null takes \"true\" or \"false\"");
      return expected === "true" ? actual === undefined : actual !== undefined;
    case "ForAllValues:StringEquals":
      if (actual === undefined) return true; // vacuous: the reason every required key is also pinned individually
      if (typeof actual === "string") throw new Error("ForAllValues needs a multi-valued key");
      return actual.every((item) => allowed.includes(item));
    case "DateLessThan": {
      if (actual === undefined) return false;
      const [left, right] = [Date.parse(single(actual)), Date.parse(single(expected))];
      if (Number.isNaN(left) || Number.isNaN(right)) throw new Error("DateLessThan needs ISO-8601 dates");
      return left < right;
    }
    default:
      throw new Error(`operator not modeled: ${operator}`);
  }
}

function applies(statement: Statement, request: Request): boolean {
  if (statement.Principal !== undefined && statement.Principal !== "*" && statement.Principal.AWS !== request.principalArn) return false;
  const actionMatches = (list: readonly string[]): boolean => list.some((pattern) => wildcard(pattern, request.action, true));
  if (statement.Action !== undefined && !actionMatches(statement.Action)) return false;
  if (statement.NotAction !== undefined && actionMatches(statement.NotAction)) return false;
  const resourceMatches = (list: readonly string[]): boolean => list.some((pattern) => wildcard(pattern, request.resource, false));
  if (statement.Resource !== undefined && !resourceMatches(statement.Resource)) return false;
  if (statement.NotResource !== undefined && resourceMatches(statement.NotResource)) return false;
  for (const [operator, block] of Object.entries(statement.Condition ?? {})) {
    for (const [key, expected] of Object.entries(block)) if (!conditionHolds(operator, key, expected, request)) return false;
  }
  return true;
}

const denies = (statements: readonly Statement[], request: Request): boolean => statements.some((s) => s.Effect === "Deny" && applies(s, request));
const allows = (statements: readonly Statement[], request: Request): boolean => statements.some((s) => s.Effect === "Allow" && applies(s, request));

interface BootstrapOptions {
  /** A future accidental identity-policy statement on the bootstrap user. */
  readonly extraIdentity?: readonly Statement[];
  /** A resource-based policy on the target resource (another role's trust, a bucket or secret policy, ...). */
  readonly resourcePolicy?: readonly Statement[];
  readonly emergencyDenyAll?: boolean;
  readonly withoutBoundary?: boolean;
}

/** The bootstrap user under C1_STRICT (identity policy + permissions boundary + worker trust). */
function bootstrap(request: Request, options: BootstrapOptions = {}): Verdict {
  const identityPolicies = [...identity, ...(options.extraIdentity ?? []), ...(options.emergencyDenyAll === true ? emergency : [])];
  const boundaryPolicies = options.withoutBoundary === true ? [] : boundary;
  const targetTrust = request.action === "sts:AssumeRole" && request.resource === WORKER_ROLE ? trust : [];
  const resourcePolicies = [...targetTrust, ...(options.resourcePolicy ?? [])];
  if ([identityPolicies, boundaryPolicies, resourcePolicies].some((statements) => denies(statements, request))) return "DENY";
  const identityAllowed = allows(identityPolicies, request) && (options.withoutBoundary === true || allows(boundaryPolicies, request));
  // C1_STRICT: assuming a role requires the trust AND the identity policy AND the boundary to allow it.
  if (request.action === "sts:AssumeRole") return allows(resourcePolicies, request) && identityAllowed ? "ALLOW" : "DENY";
  // Same account: a resource grant naming the user ARN is not limited by the boundary's IMPLICIT deny (explicit Denies apply above).
  return identityAllowed || allows(resourcePolicies, request) ? "ALLOW" : "DENY";
}

/** A worker role session: inline guard (+ optional revocation) and, for the DEV key only, the key-policy target fragments. */
function workerSession(request: Request, options: { readonly revoked?: boolean } = {}): Verdict {
  const identityPolicies = [...guard, ...(options.revoked === true ? revocation : [])];
  // A key policy governs only its own key; its "Resource": "*" means "this key".
  const keyPolicy = request.resource === KEY ? [workerKms, dataKeyDeny] : [];
  if (denies(identityPolicies, request) || denies(keyPolicy, request)) return "DENY";
  // No permissions boundary and no session policy on the worker role: identity and key-policy Allows are a union.
  return allows(identityPolicies, request) || allows(keyPolicy, request) ? "ALLOW" : "DENY";
}

// ── Synthetic request builders ────────────────────────────────────────────────────────────────────────────────────

const WORKSPACE = "6f1c2b7e-3d4a-4f8e-9b2c-1a2b3c4d5e6f";
const CREDENTIAL = "0b5d8e2a-7c41-4a9f-8e63-2d4f6a8b0c1e";
const LONG_TERM = {};
const TEMPORARY = { "aws:TokenIssueTime": "2026-10-09T12:00:00Z" };

const contextFor = (overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string> => {
  const base: Record<string, string | undefined> = {
    app: CREDENTIAL_CONTEXT_APP,
    purpose: CREDENTIAL_PURPOSES[0],
    env: "dev",
    v: CREDENTIAL_CONTEXT_VERSION,
    workspace_id: WORKSPACE,
    credential_id: CREDENTIAL,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined));
};

function encryptionContextKeys(context: Readonly<Record<string, string>>): Record<string, ConditionValue> {
  const keys: Record<string, ConditionValue> = { "kms:EncryptionContextKeys": Object.keys(context) };
  for (const [name, value] of Object.entries(context)) keys[`kms:EncryptionContext:${name}`] = value;
  return keys;
}

const decrypt = (context: Readonly<Record<string, string>>, resource = KEY, principalArn = WORKER_ROLE): Request => ({
  action: "kms:Decrypt",
  resource,
  principalArn,
  keys: encryptionContextKeys(context),
});

const assumeRole = (resource: string, sessionName: string, credentials: Readonly<Record<string, string>> = LONG_TERM): Request => ({
  action: "sts:AssumeRole",
  resource,
  principalArn: BOOTSTRAP_USER,
  keys: { "sts:RoleSessionName": sessionName, ...credentials },
});

const asBootstrap = (action: string, resource = "*", credentials: Readonly<Record<string, string>> = LONG_TERM): Request => ({ action, resource, principalArn: BOOTSTRAP_USER, keys: credentials });
const asWorker = (action: string, resource = KEY): Request => ({ action, resource, principalArn: WORKER_ROLE, keys: encryptionContextKeys(contextFor()) });

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("AWS authorization artifacts — files, JSON and placeholders", () => {
  it("contains exactly the reviewed artifact set, documents and runbooks (no scripts or infrastructure code)", () => {
    expect(readdirSync(path.join(REPOSITORY_ROOT, DIR, "artifacts")).sort()).toEqual(Object.values(ARTIFACT).sort());
    expect(designFiles.every((file) => /\.(json|md)$/.test(file)), designFiles.join(", ")).toBe(true);
    for (const required of ["README.md", "kms-key-policy-diff.md", "cloudtrail-alerting.md", "live-recapture-checklist.md", "threat-model.md", "runbooks/bootstrap-key-rotation.md", "runbooks/bootstrap-compromise.md"]) {
      expect(designFiles).toContain(path.join(DIR, required));
    }
  });

  it("every artifact parses; documents carry Version 2012-10-17; statements are well-formed with unique alphanumeric Sids", () => {
    for (const file of Object.values(ARTIFACT)) {
      if (FRAGMENTS.includes(file)) expect(() => fragment(file), file).not.toThrow();
      else expect(policy(file).length, file).toBeGreaterThan(0);
    }
    expect(allStatements).toHaveLength(12);
  });

  it("artifacts use only approved placeholders; runbook labels and thresholds never appear in a policy", () => {
    for (const file of Object.values(ARTIFACT)) {
      const tokens = rawArtifact(file).match(/<[^<>"\s]+>/g) ?? [];
      expect(tokens.filter((token) => !APPROVED_PLACEHOLDERS.includes(token)), file).toEqual([]);
    }
  });

  it("documents use only the canonical vocabulary (no alternative spellings), and the README defines all of it", () => {
    for (const file of designFiles.filter((f) => f.endsWith(".md"))) {
      const tokens = readFileSync(path.join(REPOSITORY_ROOT, file), "utf8").match(/<[A-Z][A-Z0-9_]*>/g) ?? [];
      expect(tokens.filter((token) => ![...APPROVED_PLACEHOLDERS, ...DOCUMENT_ONLY_LABELS].includes(token)), file).toEqual([]);
    }
    const readme = doc("README.md");
    for (const token of [...APPROVED_PLACEHOLDERS, ...DOCUMENT_ONLY_LABELS]) expect(readme, token).toContain(`\`${token}\``);
  });

  it("no real account ID, ARN, access-key ID, Trigger.dev identifier or secret anywhere in the directory", () => {
    for (const file of designFiles) {
      const text = readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");
      expect(text, file).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
      expect(text, file).not.toMatch(/\barn:/i);
      expect(text, file).not.toMatch(/\b(?:AKIA|ASIA|AIDA|AROA|ANPA)[A-Z0-9]{12,}\b/);
      expect(text, file).not.toMatch(/\bproj_[a-z0-9]{8,}|\btr_(?:dev|prod|stg|pat|preview)_/i);
      text.split("\n").forEach((line, index) => {
        expect(detectSecrets(line), `${file}:${String(index + 1)}`).toEqual([]);
      });
    }
  });

  it("is outside the hosted web upload and outside every runtime composition", () => {
    const vercelIgnore = readFileSync(path.join(REPOSITORY_ROOT, ".vercelignore"), "utf8").split("\n").map((line) => line.trim());
    expect(vercelIgnore).toContain("/design");
    const scripts = (JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(/design\/|\baws\s+(iam|kms|sts|cloudtrail)\b|terraform|\bcdk\b|cloudformation/i);
    }
  });
});

describe("bootstrap user — C1_STRICT artifacts", () => {
  it("identity policy: exactly one Allow, only sts:AssumeRole, only the exact worker role", () => {
    expect(identity).toEqual([{ Sid: "AllowBootstrapAssumeWorkerRole", Effect: "Allow", Action: ["sts:AssumeRole"], Resource: [WORKER_ROLE] }]);
  });

  it("boundary: the exact Allow plus the three explicit Deny guards, nothing else", () => {
    expect(boundary).toEqual([
      { Sid: "AllowExactWorkerRole", Effect: "Allow", Action: ["sts:AssumeRole"], Resource: [WORKER_ROLE] },
      { Sid: "DenyEverythingExceptAssumeRole", Effect: "Deny", NotAction: ["sts:AssumeRole"], Resource: ["*"] },
      { Sid: "DenyAssumeRoleExceptWorkerRole", Effect: "Deny", Action: ["sts:AssumeRole"], NotResource: [WORKER_ROLE] },
      { Sid: "DenyAllTemporaryUserCredentials", Effect: "Deny", Action: ["*"], Resource: ["*"], Condition: { Null: { "aws:TokenIssueTime": "false" } } },
    ]);
  });

  it("worker trust: exact user principal, only AssumeRole, exact session name, long-term credentials only — nothing else", () => {
    expect(trust).toEqual([
      {
        Sid: "BootstrapUserAssumesWorkerRole",
        Effect: "Allow",
        Principal: { AWS: BOOTSTRAP_USER },
        Action: ["sts:AssumeRole"],
        Condition: { StringEquals: { "sts:RoleSessionName": "integration-worker" }, Null: { "aws:TokenIssueTime": "true" } },
      },
    ]);
    const text = rawArtifact(ARTIFACT.trust);
    expect(text).not.toMatch(/:root|"\*"|PrincipalArn|ExternalId|SourceIdentity|TagSession|SetSourceIdentity|RequestTag|TransitiveTagKeys|SourceIp|MultiFactor/);
  });

  it("the trust's session name is the one the source requests (static contract: the adapter's import graph is confined to jobs/connections.ts)", () => {
    const adapter = codeOf("jobs/integration-aws-identity.ts");
    expect(adapter).toMatch(/export const INTEGRATION_WORKER_ROLE_SESSION_NAME = "integration-worker";/);
    expect(adapter).toMatch(/export const INTEGRATION_WORKER_SESSION_SECONDS = 900;/);
    expect(adapter).toMatch(/export const INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS = 120;/);
  });

  it("long-term key: AssumeRole of the exact worker role with the source session name is the ONLY allowed request", () => {
    expect(bootstrap(assumeRole(WORKER_ROLE, "integration-worker"))).toBe("ALLOW");
    expect(bootstrap(assumeRole(WORKER_ROLE, "integration-worker-2"))).toBe("DENY");
    expect(bootstrap(assumeRole(WORKER_ROLE, "Integration-Worker"))).toBe("DENY");
    expect(bootstrap(assumeRole("other-role", "integration-worker"))).toBe("DENY");
    for (const action of ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt", "kms:ReEncryptTo", "kms:CreateGrant", "s3:ListAllMyBuckets", "s3:GetObject", "iam:ListUsers", "iam:CreateAccessKey", "secretsmanager:GetSecretValue", "sts:GetFederationToken", "sts:TagSession"]) {
      expect(bootstrap(asBootstrap(action, action.startsWith("kms:") ? KEY : "*")), action).toBe("DENY");
    }
  });

  it("future accidental grants cannot widen it: identity Allow, resource-based Allow and another role's trust all lose to the boundary", () => {
    const wide: Statement = { Sid: "AccidentalAdmin", Effect: "Allow", Action: ["*"], Resource: ["*"] };
    expect(bootstrap(asBootstrap("secretsmanager:GetSecretValue"), { extraIdentity: [wide] })).toBe("DENY");
    expect(bootstrap(asBootstrap("s3:GetObject"), { extraIdentity: [wide] })).toBe("DENY");
    const grantToUser: Statement = { Sid: "ResourceGrant", Effect: "Allow", Principal: { AWS: BOOTSTRAP_USER }, Action: ["secretsmanager:GetSecretValue", "s3:GetObject"], Resource: ["*"] };
    expect(bootstrap(asBootstrap("secretsmanager:GetSecretValue"), { resourcePolicy: [grantToUser] })).toBe("DENY");
    expect(bootstrap(asBootstrap("s3:GetObject"), { resourcePolicy: [grantToUser] })).toBe("DENY");
    const otherTrust: Statement = { Sid: "OtherRoleTrust", Effect: "Allow", Principal: { AWS: BOOTSTRAP_USER }, Action: ["sts:AssumeRole"] };
    expect(bootstrap(assumeRole("other-role", "integration-worker"), { resourcePolicy: [otherTrust], extraIdentity: [wide] })).toBe("DENY");
  });

  it("the explicit Denies are what make it hold: without the boundary, a resource grant to the user would succeed (model sanity)", () => {
    const grantToUser: Statement = { Sid: "ResourceGrant", Effect: "Allow", Principal: { AWS: BOOTSTRAP_USER }, Action: ["secretsmanager:GetSecretValue"], Resource: ["*"] };
    expect(bootstrap(asBootstrap("secretsmanager:GetSecretValue"), { resourcePolicy: [grantToUser], withoutBoundary: true })).toBe("ALLOW");
  });
});

describe("derived temporary user credentials (AWS_DOCUMENTATION_CONFLICT — ASSUME_WORST_CASE)", () => {
  it("layer 1 — the boundary denies every request made with temporary user credentials", () => {
    expect(denies(boundary, assumeRole(WORKER_ROLE, "integration-worker", TEMPORARY))).toBe(true);
    expect(bootstrap(assumeRole(WORKER_ROLE, "integration-worker", TEMPORARY))).toBe("DENY");
    expect(denies(boundary, assumeRole(WORKER_ROLE, "integration-worker"))).toBe(false);
  });

  it("layer 2 — the trust alone refuses temporary user credentials (holds even if the boundary were detached)", () => {
    expect(allows(trust, assumeRole(WORKER_ROLE, "integration-worker", TEMPORARY))).toBe(false);
    expect(bootstrap(assumeRole(WORKER_ROLE, "integration-worker", TEMPORARY), { withoutBoundary: true })).toBe("DENY");
    expect(allows(trust, assumeRole(WORKER_ROLE, "integration-worker"))).toBe(true);
  });

  it("layer 3 — EmergencyDenyAll is a full Deny that blocks the long-term key and derived credentials alike", () => {
    expect(emergency).toEqual([{ Sid: "EmergencyDenyAll", Effect: "Deny", Action: ["*"], Resource: ["*"] }]);
    expect(bootstrap(assumeRole(WORKER_ROLE, "integration-worker"), { emergencyDenyAll: true })).toBe("DENY");
    expect(bootstrap(assumeRole(WORKER_ROLE, "integration-worker", TEMPORARY), { emergencyDenyAll: true, withoutBoundary: true })).toBe("DENY");
  });
});

describe("integration worker role — Decrypt only", () => {
  it("inline guard: no Allow; Deny everything but Decrypt; Deny Decrypt outside the exact credential key", () => {
    expect(guard).toEqual([
      { Sid: "DenyEverythingButDecrypt", Effect: "Deny", NotAction: ["kms:Decrypt"], Resource: ["*"] },
      { Sid: "DenyDecryptOutsideCredentialKey", Effect: "Deny", Action: ["kms:Decrypt"], NotResource: [KEY] },
    ]);
  });

  it("key-policy statement: only kms:Decrypt for the exact worker role; static context values come from the source contract", () => {
    expect(workerKms.Sid).toBe("WorkerDecryptOnly");
    expect(workerKms.Effect).toBe("Allow");
    expect(workerKms.Principal).toEqual({ AWS: WORKER_ROLE });
    expect(workerKms.Action).toEqual(["kms:Decrypt"]);
    expect(workerKms.Resource).toEqual(["*"]);
    expect(Object.keys(workerKms.Condition ?? {}).sort()).toEqual(["ForAllValues:StringEquals", "StringEquals", "StringLike"]);
    expect(KMS_CONTEXT_ENVS).toEqual(["dev"]);
    expect(CREDENTIAL_PURPOSES).toEqual(["provider-credential"]);
    expect(workerKms.Condition?.["StringEquals"]).toEqual({
      "kms:EncryptionContext:app": CREDENTIAL_CONTEXT_APP,
      "kms:EncryptionContext:purpose": CREDENTIAL_PURPOSES[0],
      "kms:EncryptionContext:env": KMS_CONTEXT_ENVS[0],
      "kms:EncryptionContext:v": CREDENTIAL_CONTEXT_VERSION,
    });
    expect(workerKms.Condition?.["StringLike"]).toEqual({
      "kms:EncryptionContext:workspace_id": "????????-????-????-????-????????????",
      "kms:EncryptionContext:credential_id": "????????-????-????-????-????????????",
    });
  });

  it("exact key set: the six source fields, in ForAllValues:StringEquals only — never a set operator on a single-valued key", () => {
    expect(workerKms.Condition?.["ForAllValues:StringEquals"]).toEqual({ "kms:EncryptionContextKeys": [...CREDENTIAL_CONTEXT_FIELDS] });
    expect(JSON.stringify(workerKms.Condition)).not.toMatch(/ForAnyValue|ForAllValues:String(?!Equals)/);
    for (const [operator, block] of Object.entries(workerKms.Condition ?? {})) {
      if (operator.startsWith("ForAllValues")) expect(Object.keys(block)).toEqual(["kms:EncryptionContextKeys"]);
      else expect(Object.keys(block).every((key) => key.startsWith("kms:EncryptionContext:")), operator).toBe(true);
    }
  });

  it("context matrix (offline model): exact six allowed; every deviation refused", () => {
    expect(workerSession(decrypt(contextFor()))).toBe("ALLOW");
    for (const field of CREDENTIAL_CONTEXT_FIELDS) expect(workerSession(decrypt(contextFor({ [field]: undefined }))), `missing ${field}`).toBe("DENY");
    expect(workerSession(decrypt({ ...contextFor(), note: "synthetic-extra-key" })), "seventh key").toBe("DENY");
    for (const [field, wrong] of [["app", "other-app"], ["purpose", "pkce"], ["env", "prod"], ["env", "local"], ["v", "2"]] as const) {
      expect(workerSession(decrypt(contextFor({ [field]: wrong }))), `${field}=${wrong}`).toBe("DENY");
    }
    expect(workerSession(decrypt(contextFor({ workspace_id: "" }))), "empty workspace_id").toBe("DENY");
    expect(workerSession(decrypt(contextFor({ credential_id: "" }))), "empty credential_id").toBe("DENY");
    expect(workerSession(decrypt(contextFor({ workspace_id: "workspace-of-someone" }))), "free-form value").toBe("DENY");
    expect(workerSession(decrypt({})), "no context").toBe("DENY");
    // A differently-cased key: condition-key NAMES are case-insensitive, so `App` satisfies the StringEquals pin —
    // the exact key-set contract (case-sensitive ForAllValues:StringEquals) is what refuses it.
    const rest = Object.fromEntries(Object.entries(contextFor()).filter(([name]) => name !== "app"));
    expect(allows([workerKms], decrypt({ ...rest, App: CREDENTIAL_CONTEXT_APP }))).toBe(false);
    expect(conditionHolds("StringEquals", "kms:EncryptionContext:app", CREDENTIAL_CONTEXT_APP, decrypt({ ...rest, App: CREDENTIAL_CONTEXT_APP }))).toBe(true);
  });

  it("UUID-SHAPED IDENTIFIER CONDITION — IAM does NOT validate canonical UUIDs (the application does)", () => {
    const nonHex = "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz";
    const upper = "6F1C2B7E-3D4A-4F8E-9B2C-1A2B3C4D5E6F";
    const badVersion = "6f1c2b7e-3d4a-0f8e-0b2c-1a2b3c4d5e6f";
    for (const shaped of [nonHex, upper, badVersion]) {
      // The policy shape may permit it…
      expect(workerSession(decrypt(contextFor({ workspace_id: shaped }))), shaped).toBe("ALLOW");
      // …the source contract refuses it before any KMS call.
      expect(isUuid(shaped), shaped).toBe(false);
    }
    // An unrelated but well-formed UUID also satisfies the policy: dynamic identifiers are not an authorization
    // boundary; KMS's cryptographic context binding decides whether the ciphertext opens.
    expect(workerSession(decrypt(contextFor({ workspace_id: "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d" })))).toBe("ALLOW");
  });

  it("capability: only Decrypt on the DEV key; data keys, Encrypt, ReEncrypt, grants, role chaining and other services denied", () => {
    expect(workerSession(asWorker("kms:Decrypt"))).toBe("ALLOW");
    expect(workerSession(asWorker("kms:Decrypt", "other-kms-key"))).toBe("DENY");
    for (const action of ["kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:Encrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:CreateGrant", "kms:DescribeKey", "kms:PutKeyPolicy"]) {
      expect(workerSession(asWorker(action)), action).toBe("DENY");
    }
    for (const [action, resource] of [["sts:AssumeRole", WORKER_ROLE], ["sts:AssumeRole", "other-role"], ["s3:GetObject", "*"], ["iam:ListUsers", "*"], ["secretsmanager:GetSecretValue", "*"]] as const) {
      expect(workerSession(asWorker(action, resource)), action).toBe("DENY");
    }
  });

  it("session revocation template: Deny all for sessions issued before the unresolved cutoff", () => {
    expect(revocation).toEqual([
      { Sid: "RevokeOlderSessions", Effect: "Deny", Action: ["*"], Resource: ["*"], Condition: { DateLessThan: { "aws:TokenIssueTime": "<REVOCATION_CUTOFF_UTC>" } } },
    ]);
    const rendered = revocation.map((s) => ({ ...s, Condition: { DateLessThan: { "aws:TokenIssueTime": "2026-10-09T12:00:30Z" } } }));
    const session = (issued: string): Request => ({ ...decrypt(contextFor()), keys: { ...encryptionContextKeys(contextFor()), "aws:TokenIssueTime": issued } });
    const evaluate = (request: Request): Verdict => (denies(rendered, request) ? "DENY" : workerSession(request));
    expect(evaluate(session("2026-10-09T12:00:00Z"))).toBe("DENY");
    expect(evaluate(session("2026-10-09T12:05:00Z"))).toBe("ALLOW");
  });
});

describe("KMS target diff and web regression contract", () => {
  it("DenyDataKeysExceptWeb: data keys and Encrypt denied to everyone except the web role — the worker is no longer exempt", () => {
    expect(dataKeyDeny).toEqual({
      Sid: "DenyDataKeysExceptWeb",
      Effect: "Deny",
      Principal: "*",
      Action: ["kms:GenerateDataKey*", "kms:Encrypt"],
      Resource: ["*"],
      Condition: { StringNotEquals: { "aws:PrincipalArn": WEB_ROLE } },
    });
    const dataKey = (principalArn: string): Request => ({ action: "kms:GenerateDataKey", resource: KEY, principalArn });
    expect(denies([dataKeyDeny], dataKey(WEB_ROLE))).toBe(false);
    expect(denies([dataKeyDeny], dataKey(WORKER_ROLE))).toBe(true);
    expect(denies([dataKeyDeny], dataKey(BOOTSTRAP_USER))).toBe(true);
    expect(denies([dataKeyDeny], { action: "kms:Encrypt", resource: KEY, principalArn: WORKER_ROLE })).toBe(true);
  });

  it("no artifact grants web anything, or anyone GenerateDataKey, Encrypt, ReEncrypt, CreateGrant or administration", () => {
    const allowsOf = allStatements.filter((s) => s.Effect === "Allow");
    expect(allowsOf.filter((s) => s.Principal !== undefined && s.Principal !== "*" && s.Principal.AWS === WEB_ROLE)).toEqual([]);
    expect(allowsOf.flatMap((s) => s.Action ?? []).sort()).toEqual(["kms:Decrypt", "sts:AssumeRole", "sts:AssumeRole", "sts:AssumeRole"]);
    expect(allowsOf.filter((s) => s.NotAction !== undefined)).toEqual([]);
  });

  it("the diff document is target-only, gated on a live read-only recapture, and names every affected statement", () => {
    const diff = doc("kms-key-policy-diff.md");
    expect(diff).toContain("LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE");
    expect(diff).toContain("2026-10-06");
    expect(diff).toMatch(/\*\*not\*\*\s*>?\s*authorization to mutate the live key/);
    for (const sid of ["WorkerDecryptAndSeal", "WorkerDecryptOnly", "DenyDataKeysExceptWebAndWorker", "DenyDataKeysExceptWeb", "KeyAdministrationNoCrypto", "WebEncryptOnly", "DenyDecryptExceptWorker", "DenyReEncryptToEveryone", "DenyGrantsToEveryone", "DenyAdministrationToRuntimePrincipals"]) {
      expect(diff, sid).toContain(`\`${sid}\``);
    }
  });
});

describe("documents — required statements", () => {
  it("README: authority model, no secrets, placeholders resolved from fresh state, production unresolved, artifacts referenced", () => {
    const readme = doc("README.md");
    for (const phrase of ["## State separation", "**UNVERIFIED UNTIL READ-ONLY RECAPTURE**", "never authorizes a live mutation", "## Authority model", "No artifact in this directory is a secret", "resolved from fresh read-only AWS state before any apply", "LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE", "UNRESOLVED", "**No permissions boundary**", "required by our design"]) {
      expect(readme, phrase).toContain(phrase);
    }
    for (const file of Object.values(ARTIFACT)) expect(readme, file).toContain(`artifacts/${file}`);
    expect(readme).not.toMatch(/"Statement"/);
  });

  it("live recapture checklist: hard prerequisite, every required item, STOP on drift", () => {
    const checklist = doc("live-recapture-checklist.md");
    expect(checklist).toContain("LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE");
    expect(checklist).toMatch(/If any drift exists: STOP before mutation and reconcile/);
    for (const item of ["KMS key policy", "worker role trust", "web role trust", "inline policies", "managed (attached) policies", "permissions boundaries", "IAM users", "access-key metadata", "KMS grants", "keys B and C", "aliases", "CloudTrail trails, event selectors"]) {
      expect(checklist, item).toContain(item);
    }
  });

  it("threat model: worst-case derived credentials, UUID-shaped terminology, honest session lifetime", () => {
    const threat = doc("threat-model.md");
    expect(threat).toContain("AWS_DOCUMENTATION_CONFLICT — ASSUME_WORST_CASE");
    expect(threat).toContain("UUID-SHAPED IDENTIFIER CONDITION");
    expect(threat).toMatch(/`\?` matches \*\*any one character\*\*/);
    expect(threat).toContain("**900 seconds is not an infrastructure-enforced maximum.**");
    expect(threat).toMatch(/\| Role `MaxSessionDuration` \| 3600 \|/);
    expect(threat).toMatch(/No `sts:DurationSeconds` condition key applies to `AssumeRole`/);
    for (const file of designFiles.filter((f) => f.endsWith(".md"))) {
      expect(readFileSync(path.join(REPOSITORY_ROOT, file), "utf8"), file).not.toMatch(/UUID validation|validates? (canonical )?UUIDs? in IAM/i);
    }
  });

  it("rotation runbook: lifecycle limits, our-own 30-day control, no transfer commands, atomicity open item", () => {
    const rotation = doc("runbooks/bootstrap-key-rotation.md");
    for (const phrase of ["at most **24 hours**", "up to **7 days**", "**30 days**", "**atomically**", "fail closed", "7E.6/7E.7"]) {
      expect(rotation, phrase).toContain(phrase);
    }
    expect(rotation).toMatch(/It is not an AWS\s+universal requirement/);
    // No secret-transfer or AWS commands: those belong to 7E.6/7E.7 once the mechanism is selected.
    expect(rotation).not.toMatch(/\baws\s+(iam|sts)\b|\bnpx\s+trigger|\bvercel\s+env\b|`[^`]*(create-access-key|update-access-key)[^`]*`/i);
  });

  it("compromise runbook: U1 never restored, worst-case derived credentials, explicit CLI/API cleanup before DeleteUser", () => {
    const compromise = doc("runbooks/bootstrap-compromise.md");
    for (const phrase of ["AWS_DOCUMENTATION_CONFLICT — ASSUME_WORST_CASE", "**U1 is never restored.**", "Never remove `EmergencyDenyAll` while U1 exists", "T2 + 36 hours + a safety margin", "iam:PutRolePolicy", "Create a NEW user U2", "Intentionally rewrite the worker trust"]) {
      expect(compromise, phrase).toContain(phrase);
    }
    for (const api of ["DeleteAccessKey", "DeleteUserPolicy", "DetachUserPolicy", "RemoveUserFromGroup", "DeleteLoginProfile", "DeleteSigningCertificate", "DeleteSSHPublicKey", "DeleteServiceSpecificCredential", "DeactivateMFADevice", "DeleteUserPermissionsBoundary", "DeleteUser"]) {
      expect(compromise, api).toContain(`\`${api}\``);
    }
    expect(compromise).toMatch(/Programmatic `DeleteUser` does \*\*not\*\* remove subordinate items/);
    expect(compromise).not.toMatch(/automatically (remove|delete)s?/i);
  });

  it("CloudTrail spec: KMS read events kept, durable retention, sensitive responseElements never forwarded, classified alerts", () => {
    const trail = doc("cloudtrail-alerting.md");
    // Historical vs live (7E.5B-R1): the 2026-10-06 evidence is labeled historical; live trail state is never asserted.
    expect(trail).toMatch(/\*\*Historical evidence:\*\* the TA-Q-07b evidence captured on 2026-10-06 found no CloudTrail\s+trail/);
    expect(trail).toContain("**UNVERIFIED UNTIL READ-ONLY RECAPTURE**");
    expect(trail).toContain("LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE");
    expect(trail).toMatch(/must exist \*\*before the first bootstrap access key is\s+issued\*\*/);
    expect(trail).not.toMatch(/No CloudTrail trail exists today|\bexists today\b/);
    for (const phrase of ["**multi-Region**", "**Read and Write**", "**Do not exclude `kms.amazonaws.com`.**", "integrity validation", "**distinct from** the provider-credential KMS key", "≥ 365 days", "S3 lifecycle", "**Event History alone is insufficient.**", "**SessionToken**", "`SecretAccessKey`", "must **never** forward complete raw `responseElements`", "### HIGH SIGNAL", "### ANOMALY / BASELINE", "### COMPLIANCE", "`<DECRYPT_HOURLY_CEILING>`", "Source IP is **detection only**"]) {
      expect(trail, phrase).toContain(phrase);
    }
    for (const signal of ["`GetCallerIdentity`", "`GetSessionToken`", "Two **active** bootstrap access keys for more than 24 hours", "temporary (`ASIA…`) credentials", "older than 30 days"]) {
      expect(trail, signal).toContain(signal);
    }
  });
});
