/**
 * TA-Q-07b constants. Every resource name is scoped to the development prefix; the region is fixed.
 * Configuration (.env.local) carries no credentials: only the access-portal URL and the expected account ID.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const SPIKE_DIR = path.resolve(import.meta.dirname, "..");
export const EVIDENCE_DIR = path.join(SPIKE_DIR, "evidence");

export const REGION = "sa-east-1";
export const PREFIX = "social-intelligence-platform-dev";
export const PERMISSION_SET = "SIP-Dev-Administrator";
export const SESSION_PREFIX = "taq07b";

export const ROLE_NAMES = Object.freeze({
  web: `${PREFIX}-web-encrypt`,
  worker: `${PREFIX}-integration-worker`,
  rotation: `${PREFIX}-kms-rotation-test`,
});
export const FORBIDDEN_USER = `${PREFIX}-trigger-worker`;
export const GUARD_POLICY_NAME = `${PREFIX}-guard`;

export const KEY_SLOTS = Object.freeze({
  A: { alias: `alias/${PREFIX}-provider-credentials`, policyId: `${PREFIX}-provider-credentials`, rotation: true },
  B: { alias: `alias/${PREFIX}-provider-credentials-next`, policyId: `${PREFIX}-provider-credentials-next`, rotation: false },
  C: { alias: `alias/${PREFIX}-decoy`, policyId: `${PREFIX}-decoy`, rotation: false },
});
export const ROTATION_PERIOD_DAYS = 365;

export const BASE_TAGS = Object.freeze({
  Project: "social-intelligence-platform",
  Environment: "dev",
  Validation: "TA-Q-07b",
  DataClass: "synthetic-only",
});

/** Fixed, non-secret encryption-context members (TA-Q-07 approved shape). */
export const CONTEXT_CONSTANTS = Object.freeze({
  app: "social-intelligence-platform",
  purpose: "provider-credential",
  env: "dev",
  v: "1",
});
export const CONTEXT_KEYS = Object.freeze(["app", "purpose", "env", "v", "workspace_id", "credential_id"]);
export const UUID_LIKE = "????????-????-????-????-????????????";

/** Synthetic literals used only by negative tests; the audit accepts them as declared, never as data. */
export const NEGATIVE_LITERALS = Object.freeze({
  extraKey: "note",
  extraValue: "synthetic-extra-key",
  invalidWorkspace: "not-a-uuid",
  wrongEnv: "prod",
});

export function loadConfig() {
  const file = path.join(SPIKE_DIR, ".env.local");
  if (!existsSync(file)) return { ok: false, reason: "spikes/ta-q-07-kms/.env.local is missing" };
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  const startUrl = values.TAQ07_SSO_START_URL ?? "";
  const accountId = values.TAQ07_EXPECTED_ACCOUNT_ID ?? "";
  // IPv4 portal (https://<id-or-alias>.awsapps.com/start) or dual-stack portal (https://ssoins-<id>.portal.<region>.app.aws).
  const ipv4Portal = /^https:\/\/[a-z0-9-]+\.awsapps\.com\/start\/?(#.*)?$/;
  const dualStackPortal = new RegExp(`^https://ssoins-[a-z0-9]+\\.portal\\.${REGION}\\.app\\.aws/?(#.*)?$`);
  if (!ipv4Portal.test(startUrl) && !dualStackPortal.test(startUrl)) {
    return { ok: false, reason: "TAQ07_SSO_START_URL is empty or not an AWS access-portal URL" };
  }
  if (!/^\d{12}$/.test(accountId)) return { ok: false, reason: "TAQ07_EXPECTED_ACCOUNT_ID is empty or not 12 digits" };
  return { ok: true, startUrl: startUrl.replace(/#.*$/, "").replace(/\/$/, ""), accountId };
}
