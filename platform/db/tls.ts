/**
 * The strict PEM CA parser shared by every runtime (pool.ts) and the database tooling (tools/db/environment.ts), so a
 * CA the tooling accepts is exactly one the deployed runtime accepts. Pure: no I/O; the value is never echoed.
 *
 * Imported by Node tooling directly, so this file uses relative imports and Node built-ins only.
 */
import { ConnectionConfigError } from "./connection.ts";

/** The two ways a runtime receives the managed database's CA certificate (precedence: pool.ts header). */
export const SSL_ROOT_CERT_VARIABLES = { pem: "DATABASE_SSL_ROOT_CERT_PEM", path: "DATABASE_SSL_ROOT_CERT" } as const;

const PEM_MAX_LENGTH = 65_536;
const PEM_MAX_CERTIFICATES = 10;
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\n((?:[A-Za-z0-9+/]{1,76}\n)*[A-Za-z0-9+/]{1,76}={0,2}\n)-----END CERTIFICATE-----$/;

/**
 * Strict PEM CA content: one or more `CERTIFICATE` blocks of base64 lines, nothing else (no keys, no headers, no
 * other text). Real newlines (LF or CRLF) are accepted; so are literal `\n` escapes, but only when the value holds
 * no real newline at all (single-line environment-variable tooling). Returns the normalized bundle; throws a
 * non-sensitive ConnectionConfigError otherwise (the value is never echoed).
 */
export function parseSslRootCertPem(value: string): string {
  const invalid = (): never => {
    throw new ConnectionConfigError(`${SSL_ROOT_CERT_VARIABLES.pem} is not a PEM CA certificate bundle`);
  };
  if (value.length > PEM_MAX_LENGTH) invalid();
  const unescaped = /\r?\n/.test(value) ? value : value.replaceAll("\\n", "\n");
  const text = unescaped.replaceAll("\r\n", "\n").trim();
  const blocks = text.split(/(?<=-----END CERTIFICATE-----)\n*/).filter((block) => block !== "");
  if (blocks.length === 0 || blocks.length > PEM_MAX_CERTIFICATES) invalid();
  for (const block of blocks) {
    if (!PEM_CERTIFICATE.test(block)) invalid();
  }
  return `${blocks.join("\n")}\n`;
}
