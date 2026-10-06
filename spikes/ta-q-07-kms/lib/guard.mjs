/**
 * Output guard. Every console line and every evidence file passes through here:
 *   - registered secrets (SSO token, client secret, session credentials) must never appear;
 *   - repository secret patterns (domain/secret-patterns.ts) must never match;
 *   - long base64 runs (ciphertext blobs, keys, tokens) are refused outright;
 *   - binary values (DEKs, plaintext, envelopes) can't be serialized as evidence at all;
 *   - the account ID and the operator's user name are redacted.
 * A guard violation aborts the run: nothing is printed or written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectSecrets } from "../../../domain/secret-patterns.ts";

export class GuardError extends Error {
  constructor(where, rule) {
    super(`output guard refused ${where} (${rule})`);
    this.name = "GuardError";
  }
}

const registry = new Set();
const LONG_OPAQUE = /[A-Za-z0-9+/]{40,}={0,2}/g;
/** Exact, reviewed, purely alphabetic constants (policy statement IDs) exempt from the long-opaque rule. */
const allowedTokens = new Set();

/**
 * Exempts exact known constants from the long-opaque rule only. Tokens must be purely alphabetic (a secret,
 * key, token or hash virtually always carries digits or base64 symbols); a longer run that merely contains an
 * allowed token is still refused. Registered secrets and credential patterns are checked regardless.
 */
export function allowExactTokens(tokens) {
  for (const token of tokens) {
    if (typeof token !== "string" || !/^[A-Za-z]{40,128}$/.test(token)) throw new GuardError("allowlist", "token-not-alphabetic-constant");
    allowedTokens.add(token);
  }
}
let accountId = null;
let operatorUser = null;

/** Registers an in-memory secret so that it can never reach output. */
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) registry.add(value);
}

export function setRedactions({ account, operator }) {
  if (account) accountId = account;
  if (operator) operatorUser = operator;
}

export function redact(text) {
  let out = text;
  if (accountId) out = out.split(accountId).join("<ACCOUNT>");
  if (operatorUser) out = out.split(`/${operatorUser}`).join("/<operator>");
  return out;
}

export function assertSafe(text, where) {
  for (const secret of registry) if (text.includes(secret)) throw new GuardError(where, "registered-secret");
  const found = detectSecrets(text);
  if (found.length > 0) throw new GuardError(where, found.join(","));
  for (const match of text.matchAll(LONG_OPAQUE)) {
    if (!allowedTokens.has(match[0])) throw new GuardError(where, "long-opaque-value");
  }
  if (accountId && text.includes(accountId)) throw new GuardError(where, "account-id");
}

export function log(...parts) {
  const line = redact(parts.map(String).join(" "));
  assertSafe(line, "console");
  console.log(line);
}

function rejectBinary(value, trail = "$") {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || Buffer.isBuffer(value)) {
    throw new GuardError(`evidence ${trail}`, "binary-value");
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) rejectBinary(inner, `${trail}.${key}`);
  }
}

/** Writes one evidence file (never overwrites). Only plain, guard-clean JSON is accepted. */
export function writeEvidence(dir, name, value) {
  rejectBinary(value);
  const text = redact(JSON.stringify(value, null, 2));
  assertSafe(text, `evidence ${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), `${text}\n`, { flag: "wx" });
}

export function writeEvidenceText(dir, name, text) {
  const safe = redact(text);
  assertSafe(safe, `evidence ${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), safe.endsWith("\n") ? safe : `${safe}\n`, { flag: "wx" });
}

const SPIKE_ROOT = path.resolve(import.meta.dirname, "..");

function safeLocation(raw) {
  let file = raw.replace(/^file:\/\//, "");
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep as is
  }
  const nodeModules = file.lastIndexOf("/node_modules/");
  if (nodeModules >= 0) return file.slice(nodeModules + 1);
  if (file.startsWith(`${SPIKE_ROOT}/`)) return path.relative(SPIKE_ROOT, file);
  if (file.startsWith("node:")) return file;
  return path.basename(file); // never an absolute path (it would carry the local user name)
}

/**
 * Redacted diagnostic for an unexpected exception: type, guarded message and up to 8 frames as
 * { fn, file, line }. Paths are spike-relative (or package-relative under node_modules); a message the
 * output guard refuses is withheld. Contains no values from the failing call.
 */
export function safeStack(error, maxFrames = 8) {
  const type = error?.name ?? error?.constructor?.name ?? typeof error;
  let message = redact(String(error?.message ?? ""));
  try {
    assertSafe(message, "diagnostic message");
  } catch {
    message = "[message withheld by output guard]";
  }
  const frames = [];
  for (const line of String(error?.stack ?? "").split("\n").slice(1)) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (!match) continue;
    frames.push({ fn: match[1] ?? "<anonymous>", file: safeLocation(match[2]), line: Number(match[3]) });
    if (frames.length >= maxFrames) break;
  }
  return { type, message, frames };
}

/** Error name and HTTP status only; SDK messages can carry ARNs and are never printed. */
export function describeError(error) {
  const status = error?.$metadata?.httpStatusCode;
  return `${error?.name ?? "Error"}${status ? ` (HTTP ${status})` : ""}`;
}
