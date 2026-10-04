/**
 * Repository secret scan: pure scanning logic (CLI in `cli.ts`).
 * Findings carry file, line and rule id only. Matched values are never returned or printed.
 */
import { detectSecrets } from "../../domain/secret-patterns.ts";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

/** Paths not scanned: dependencies, build output, and preserved validation evidence (write-once audit logs). */
const EXCLUDED_PATHS: readonly RegExp[] = [
  /(^|\/)node_modules\//,
  /^\.next\//,
  /^out\//,
  /^coverage\//,
  /^spikes\/[^/]+\/evidence\//,
];

const MAX_BYTES = 2 * 1024 * 1024;

const ENV_FILE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;
const ENV_EXAMPLE = /(^|\/)\.env\.example$/;
const SENSITIVE_ENV_KEY = /(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|DATABASE_URL|DB_URL|BOOTSTRAP_URL)/i;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function isExcludedPath(file: string): boolean {
  return EXCLUDED_PATHS.some((pattern) => pattern.test(file));
}

export function isScannableContent(bytes: Uint8Array): boolean {
  return bytes.byteLength <= MAX_BYTES && !bytes.includes(0);
}

function scanEnvFile(file: string, lines: readonly string[]): Finding[] {
  if (!ENV_EXAMPLE.test(file)) {
    // A real environment file must never be tracked, whatever its content.
    return [{ file, line: 1, rule: "env-file-tracked" }];
  }
  const findings: Finding[] = [];
  lines.forEach((text, index) => {
    const match = ENV_ASSIGNMENT.exec(text);
    const key = match?.[1];
    const value = (match?.[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key !== undefined && SENSITIVE_ENV_KEY.test(key) && value !== "") {
      findings.push({ file, line: index + 1, rule: "env-example-value" });
    }
  });
  return findings;
}

export function scanText(file: string, text: string): Finding[] {
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = ENV_FILE.test(file) ? scanEnvFile(file, lines) : [];
  lines.forEach((line, index) => {
    for (const rule of detectSecrets(line)) {
      findings.push({ file, line: index + 1, rule });
    }
  });
  return findings;
}

export function formatFinding(finding: Finding): string {
  return `${finding.file}:${String(finding.line)} ${finding.rule}`;
}
