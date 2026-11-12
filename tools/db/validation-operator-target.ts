/**
 * The validation operator's database identity fence (Step 7B-14I2; hardened in Step 7B-14I3H, H3), checked BEFORE any
 * connection, and the endpoint check right AFTER it. Development only: the pinned social-intelligence-dev-v2 authority
 * (the database tooling's own), and ONE connection URL — DATABASE_VALIDATION_OPERATOR_URL in `.env.local` — whose login
 * must be a dedicated validation_operator_<handle> login (never the migration role).
 *
 * Positive identity of the destination, never inferred from "it is local":
 *   - the endpoint is a Supabase endpoint of the pinned project ONLY: the session pooler of the pinned region (the
 *     project is the Supavisor tenant named in the login, `<role>.<project-ref>` — the pooler routes by it), or the
 *     direct host `db.<project-ref>.supabase.co`. A local endpoint (localhost, 127.0.0.1, ::1 — where a tunnel or a port
 *     forward may lead anywhere), an IP literal, any other host name or alias, and the transaction pooler are REFUSED:
 *     the real operator tool has no local or development bypass. (Local disposable PostgreSQL is reached only by the
 *     database test suites, through their own support code, never through this fence.)
 *   - TLS is verify-full: the project CA (SUPABASE_SSL_ROOT_CERT, strictly parsed) and the host name the certificate must
 *     name; after connecting, verifyOperatorEndpoint re-checks that the socket really is an authorized TLS session whose
 *     peer certificate names that host — before any statement is sent.
 * The URL, its password and the project reference are never printed (role, endpoint, region and a masked reference only).
 */
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import pg from "pg";
import { parseDatabaseUrl, type ConnectionTarget } from "../../platform/db/connection.ts";
import { checkCa, MIGRATION_ROLES, resolveTargetAuthority, type Environment } from "./environment.ts";

/** A dedicated validation operator login (0029): never the migration role, never a runtime login. */
export const OPERATOR_LOGIN = /^validation_operator_[a-z0-9_]{2,40}$/;

export const VALIDATION_OPERATOR_URL = "DATABASE_VALIDATION_OPERATOR_URL";

/** The only endpoint classes that carry a verifiable project identity (never "local", "other" or the transaction pooler). */
const OPERATOR_ENDPOINTS: readonly string[] = ["direct", "session_pooler"];

export interface ValidationOperatorFence {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly target?: ConnectionTarget;
}

const mask = (ref: string | undefined): string => (ref === undefined ? "none" : `${ref.slice(0, 4)}…`);
/** A login that still carries a `.<tenant>` suffix (an endpoint that is not the pooler) never prints the tenant in full. */
const maskRole = (role: string): string => {
  const dot = role.indexOf(".");
  return dot < 0 ? role : `${role.slice(0, dot)}.${mask(role.slice(dot + 1))}`;
};

/** Verifies the configuration without connecting. */
export function checkValidationOperatorTarget(env: Environment, developmentPin?: string): ValidationOperatorFence {
  const authority = developmentPin === undefined ? resolveTargetAuthority("development", env) : resolveTargetAuthority("development", env, developmentPin);
  const problems: string[] = [...authority.problems];
  const lines: string[] = [`  target                   development (${authority.label}) region=${authority.expectedRegion ?? "unset"} ref=${mask(authority.expectedProjectRef)}`];
  const raw = env[VALIDATION_OPERATOR_URL];
  let target: ConnectionTarget | undefined;
  if (raw === undefined || raw.trim() === "") {
    problems.push(`${VALIDATION_OPERATOR_URL} is absent (a dedicated validation operator login is provisioned by a separately authorized gate)`);
  } else {
    try {
      target = parseDatabaseUrl(raw, VALIDATION_OPERATOR_URL);
      lines.push(`  ${VALIDATION_OPERATOR_URL.padEnd(24)} role=${maskRole(target.role)} endpoint=${target.endpoint} region=${target.region ?? "n/a"} ref=${mask(target.projectRef)}`);
      problems.push(...operatorEndpointProblems(target, authority.expectedProjectRef, authority.expectedRegion));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${VALIDATION_OPERATOR_URL} is invalid`);
    }
  }
  for (const problem of problems) lines.push(`  PROBLEM: ${problem}`);
  return { ok: problems.length === 0, lines, ...(target === undefined ? {} : { target }) };
}

/** Every reason the parsed target is not a positively identified endpoint of the pinned project (empty: it is). */
export function operatorEndpointProblems(target: ConnectionTarget, expectedProjectRef: string | undefined, expectedRegion: string | undefined): readonly string[] {
  const problems: string[] = [];
  if (MIGRATION_ROLES.includes(target.role) || !OPERATOR_LOGIN.test(target.role)) problems.push(`${VALIDATION_OPERATOR_URL} must use a validation_operator_<handle> login (never the migration role)`);
  if (target.endpoint === "local") {
    problems.push(`${VALIDATION_OPERATOR_URL} is a local endpoint (localhost / loopback): a tunnel or port forward proves no project identity — refused`);
    return problems;
  }
  if (!OPERATOR_ENDPOINTS.includes(target.endpoint)) {
    problems.push(`${VALIDATION_OPERATOR_URL} must use the pinned project's direct host or its session pooler (no IP literal, alias or transaction pooler)`);
    return problems;
  }
  if (expectedProjectRef === undefined || target.projectRef !== expectedProjectRef) problems.push(`${VALIDATION_OPERATOR_URL} does not point at the pinned development project`);
  if (target.endpoint === "direct" && target.host !== `db.${expectedProjectRef ?? "-"}.supabase.co`) problems.push(`${VALIDATION_OPERATOR_URL} direct host is not the pinned project's`);
  if (target.endpoint === "session_pooler" && (expectedRegion === undefined || target.region !== expectedRegion)) problems.push(`${VALIDATION_OPERATOR_URL} is not in ${expectedRegion ?? "the expected region"}`);
  return problems;
}

/** A client for the operator login: verify-full TLS against the project CA, for a positively identified endpoint only. */
export function validationOperatorClient(target: ConnectionTarget, env: Environment, root?: string): { readonly client: pg.Client } | { readonly problem: string } {
  if (!OPERATOR_ENDPOINTS.includes(target.endpoint)) return { problem: `${VALIDATION_OPERATOR_URL} has no verifiable project identity (refused before connecting)` };
  const checked = root === undefined ? checkCa(env) : checkCa(env, root);
  if ("problem" in checked) return { problem: checked.problem };
  return {
    client: new pg.Client({
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
      // verify-full: the project CA, and the certificate must name exactly this host (never an IP literal: refused above).
      ssl: { ca: checked.ca, rejectUnauthorized: true, servername: target.host, checkServerIdentity: (host: string, cert: PeerCertificate) => checkServerIdentity(host, cert) },
      application_name: "validation-operator",
    }),
  };
}

/** The connected socket as verifyOperatorEndpoint inspects it (a node TLSSocket satisfies it; tests pass a fake). */
export interface ConnectedSocket {
  readonly encrypted?: boolean;
  readonly authorized?: boolean;
  getPeerCertificate?(): PeerCertificate | Record<string, never>;
}

/**
 * Right after connect, BEFORE any statement: the session is an authorized TLS session (verified against the project CA)
 * whose peer certificate names the expected host. Answers the problems (empty: verified). Never prints the certificate.
 */
export function verifyOperatorEndpoint(socket: ConnectedSocket | undefined, target: ConnectionTarget): readonly string[] {
  if (socket === undefined || socket.encrypted !== true || typeof socket.getPeerCertificate !== "function") return ["the operator session is not a TLS session"];
  if (socket.authorized !== true) return ["the operator session's certificate was not verified against the project CA"];
  const certificate = socket.getPeerCertificate();
  if (!("subject" in certificate) || checkServerIdentity(target.host, certificate as PeerCertificate) !== undefined) return ["the operator session's certificate does not name the expected host"];
  return [];
}

/** The socket of a connected pg client (internal to node-postgres; absent → the check refuses). */
export function connectedSocket(client: pg.Client): ConnectedSocket | undefined {
  return (client as unknown as { connection?: { stream?: ConnectedSocket } }).connection?.stream;
}
