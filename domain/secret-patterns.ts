/**
 * Patterns for credential-like strings. Pure shared-kernel code used by AppError parameter
 * validation, the structured-log sanitizer and the repository secret scan (`tools/secret-scan`).
 * Self-contained on purpose: no imports, so the scan can run directly under Node without the
 * application's path aliases.
 *
 * Patterns target recognizable credential shapes (prefixes, key blocks, URLs with an inline
 * password) rather than raw entropy, to keep findings credible and noise low.
 */

export interface SecretPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: "private-key-block", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "stripe-secret-key", pattern: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai-api-key", pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "supabase-secret-key", pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { id: "trigger-dev-secret-key", pattern: /\btr_(?:dev|prod|stg|pat)_[A-Za-z0-9]{16,}/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
];

/** `scheme://user:password@host` with a literal password (template expressions and placeholders excluded). */
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:([^\s@/'"`]+)@/gi;
const PASSWORD_PLACEHOLDER = /^(?:\$\{[^}]*\}|<[^>]*>|\[[^\]]*\]|\{\{[^}]*\}\}|\*+|x+|\.{3}|password|pass|changeme|secret)$/i;

export function containsCredentialUrl(text: string): boolean {
  for (const match of text.matchAll(CREDENTIAL_URL)) {
    const password = match[1] ?? "";
    if (!password.startsWith("${") && !PASSWORD_PLACEHOLDER.test(password)) {
      return true;
    }
  }
  return false;
}

/** Ids of the secret patterns found in `text` (never the matched values). */
export function detectSecrets(text: string): readonly string[] {
  const found = SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
  return containsCredentialUrl(text) ? [...found, "credential-url"] : found;
}

export function looksLikeSecret(text: string): boolean {
  return detectSecrets(text).length > 0;
}
