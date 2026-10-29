/**
 * Step H7-D0 — the operator credential boundary of the live evaluation. A key is read from the operator's process
 * environment or the git-ignored `.env.local`, handed ONLY to an SDK client constructor, and never printed, logged,
 * hashed, measured or written anywhere. The only thing ever reported is PRESENT / ABSENT per variable NAME.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const CREDENTIAL_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

const ROOT = path.resolve(import.meta.dirname, "../../../..");

function localFile(): Readonly<Record<string, string | undefined>> {
  const file = path.join(ROOT, ".env.local");
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

/** The key, or undefined (the caller passes it straight to an SDK client). */
export function readCredential(name: CredentialName): string | undefined {
  const value = process.env[name] ?? localFile()[name];
  return value === undefined || value === "" ? undefined : value;
}

export const credentialPresence = (name: CredentialName): "PRESENT" | "ABSENT" => (readCredential(name) === undefined ? "ABSENT" : "PRESENT");
