/**
 * Database TLS CA delivery (Step 5K, K1): the CA reaches a runtime either as PEM CONTENT (DATABASE_SSL_ROOT_CERT_PEM,
 * deployed workers) or as a file PATH (DATABASE_SSL_ROOT_CERT, local development). Verification is never weakened:
 * the driver always gets the CA with rejectUnauthorized (and Node's default host-name check). Synthetic certificate
 * bodies only — nothing here is a real certificate or secret.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConnectionConfigError, createRuntimeDatabaseFromEnv, parseDatabaseUrl } from "@/platform/db";
import { SSL_ROOT_CERT_VARIABLES, parseSslRootCertPem, resolveSslRootCert, tlsFor } from "@/platform/db/pool";

const REF = "abcdefghijklmnopqrst";
const POOLER = "aws-0-sa-east-1.pooler.supabase.com";
const PASSWORD = "synthetic-password-never-echoed";
const WEB_URL = `postgresql://web_login.${REF}:${PASSWORD}@${POOLER}:6543/postgres`;
const BODY_A = ["MIIBszCCAVmgAwIBAgIUSyntheticTestBodyAAAAAAAAAAAAAAAAAAAAAAAAAAA", "U3ludGhldGljQ2VydGlmaWNhdGVCb2R5Rm9yVGVzdHNPbmx5"].join("\n");
const BODY_B = ["MIIBszCCAVmgAwIBAgIUSyntheticTestBodyBBBBBBBBBBBBBBBBBBBBBBBBBBB", "QW5vdGhlclN5bnRoZXRpY0JvZHk="].join("\n");
const PEM_A = `-----BEGIN CERTIFICATE-----\n${BODY_A}\n-----END CERTIFICATE-----\n`;
const PEM_B = `-----BEGIN CERTIFICATE-----\n${BODY_B}\n-----END CERTIFICATE-----\n`;
const MARKER = "SyntheticTestBody";
/** A key-block header built at run time, so this negative fixture never looks like a committed key. */
const KEY = ["PRIVATE", "KEY"].join(" ");
const KEY_BLOCK = `-----BEGIN ${KEY}-----\n${BODY_A}\n-----END ${KEY}-----\n`;

const managed = parseDatabaseUrl(WEB_URL, "DATABASE_WEB_URL");
const scratch = mkdtempSync(path.join(os.tmpdir(), "sip-db-tls-"));
const pemFile = path.join(scratch, "ca.pem");
writeFileSync(pemFile, PEM_B);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Throws, and the error text never carries certificate material or the offending value. */
function refusesQuietly(work: () => unknown, leaked: readonly string[] = [MARKER, "PRIVATE"]): ConnectionConfigError {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConnectionConfigError);
  const text = `${String(caught)} ${JSON.stringify(caught)} ${(caught as Error).stack ?? ""}`;
  for (const fragment of leaked) expect(text).not.toContain(fragment);
  return caught as ConnectionConfigError;
}

describe("PEM-content CA (DATABASE_SSL_ROOT_CERT_PEM)", () => {
  it("accepts multiline, CRLF and single-line \\n-escaped content, all normalizing to the same bundle", () => {
    expect(parseSslRootCertPem(PEM_A)).toBe(PEM_A);
    expect(parseSslRootCertPem(PEM_A.replaceAll("\n", "\r\n"))).toBe(PEM_A);
    expect(parseSslRootCertPem(PEM_A.trimEnd().replaceAll("\n", "\\n"))).toBe(PEM_A);
    expect(parseSslRootCertPem(`\n  ${PEM_A}\n\n`)).toBe(PEM_A);
  });

  it("accepts a bundle of certificates", () => {
    expect(parseSslRootCertPem(`${PEM_A}${PEM_B}`)).toBe(`${PEM_A}${PEM_B}`);
    expect(parseSslRootCertPem(`${PEM_A}\n\n${PEM_B}`)).toBe(`${PEM_A}${PEM_B}`);
  });

  it.each([
    ["an empty bundle", "   "],
    ["arbitrary text", `not a certificate ${MARKER}`],
    ["a private key block", KEY_BLOCK],
    ["a certificate plus a private key", `${PEM_A}${KEY_BLOCK}`],
    ["text around the certificate", `subject=${MARKER}\n${PEM_A}`],
    ["PEM headers inside the block", PEM_A.replace("-----\n", `-----\nProc-Type: 4,ENCRYPTED ${MARKER}\n`)],
    ["non-base64 characters", PEM_A.replace("MIIB", "MI*B")],
    ["an unterminated block", PEM_A.replace("-----END CERTIFICATE-----", "")],
    ["mixed real newlines and \\n escapes", PEM_A.replace(`\n${BODY_A.split("\n")[1] ?? ""}`, `\\n${BODY_A.split("\n")[1] ?? ""}`)],
    ["an oversized value", `${PEM_A}${"A".repeat(70_000)}`],
    ["more than ten certificates", PEM_A.repeat(11)],
  ])("refuses %s, without echoing it", (_label, value) => {
    expect(refusesQuietly(() => parseSslRootCertPem(value)).message).toBe(`${SSL_ROOT_CERT_VARIABLES.pem} is not a PEM CA certificate bundle`);
  });
});

describe("CA resolution and precedence", () => {
  it("path-based CA (local development) is read from the file", () => {
    expect(resolveSslRootCert({ [SSL_ROOT_CERT_VARIABLES.path]: pemFile })).toBe(PEM_B);
  });

  it("PEM content takes precedence over a path; the path is then not even read", () => {
    const missing = path.join(scratch, "does-not-exist.pem");
    expect(resolveSslRootCert({ [SSL_ROOT_CERT_VARIABLES.pem]: PEM_A, [SSL_ROOT_CERT_VARIABLES.path]: pemFile })).toBe(PEM_A);
    expect(resolveSslRootCert({ [SSL_ROOT_CERT_VARIABLES.pem]: PEM_A, [SSL_ROOT_CERT_VARIABLES.path]: missing })).toBe(PEM_A);
    // An empty PEM variable counts as unset: the path applies.
    expect(resolveSslRootCert({ [SSL_ROOT_CERT_VARIABLES.pem]: "", [SSL_ROOT_CERT_VARIABLES.path]: pemFile })).toBe(PEM_B);
  });

  it("a missing or unreadable path fails closed without echoing the path", () => {
    const missing = path.join(scratch, "unreadable-ca.pem");
    const error = refusesQuietly(() => resolveSslRootCert({ [SSL_ROOT_CERT_VARIABLES.path]: missing }), [MARKER, missing, "unreadable-ca"]);
    expect(error.message).toBe(`${SSL_ROOT_CERT_VARIABLES.path} can't be read`);
  });

  it("an invalid PEM fails closed even when a valid path is also configured (no silent fallback)", () => {
    refusesQuietly(() => resolveSslRootCert({ [SSL_ROOT_CERT_VARIABLES.pem]: `junk ${MARKER}`, [SSL_ROOT_CERT_VARIABLES.path]: pemFile }));
  });

  it("neither form configured → no CA, and any managed connection is refused (fail closed)", () => {
    expect(resolveSslRootCert({})).toBeUndefined();
    const error = refusesQuietly(() => createRuntimeDatabaseFromEnv("web", { DATABASE_WEB_URL: WEB_URL }));
    expect(error.message).toMatch(/DATABASE_SSL_ROOT_CERT_PEM or DATABASE_SSL_ROOT_CERT/);
    expect(error.message).not.toContain(PASSWORD);
  });
});

describe("TLS verification is never weakened", () => {
  it("both forms reach the driver as an in-memory CA with certificate (and host-name) verification on", () => {
    expect(tlsFor(managed, PEM_A)).toEqual({ ca: PEM_A, rejectUnauthorized: true });
    for (const env of [{ [SSL_ROOT_CERT_VARIABLES.pem]: PEM_A.replaceAll("\n", "\r\n") }, { [SSL_ROOT_CERT_VARIABLES.path]: pemFile }]) {
      const database = createRuntimeDatabaseFromEnv("web", { DATABASE_WEB_URL: WEB_URL, ...env });
      const ssl = (database.pool as unknown as { options: { ssl: unknown } }).options.ssl as Record<string, unknown>;
      expect(ssl["rejectUnauthorized"]).toBe(true);
      expect(typeof ssl["ca"]).toBe("string");
      expect(ssl).not.toHaveProperty("checkServerIdentity"); // Node's default host-name verification applies
      void database.end();
    }
  });

  it("local endpoints stay TLS-free exactly as before (no CA needed)", () => {
    expect(tlsFor(parseDatabaseUrl("postgresql://web_login:x@127.0.0.1:5432/postgres", "X"), undefined)).toBe(false);
  });
});
