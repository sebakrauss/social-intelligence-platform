/**
 * Step H7-D0a — sanitized TRANSPORT diagnostics of provider adapters (operator / evaluation metadata only). A closed
 * vocabulary of normalized codes, derived only from the `code` / `name` fields of an error's cause chain (never its
 * message, URL, host, IP, headers, body or stack). It refines AI_UNAVAILABLE for diagnosis and for the live runner's
 * fail-fast; it is NOT a product failure class and never crosses the gateway port (adapters hand it to an optional
 * operator callback; the gateway, attempt records and product runtime never see it).
 */

export const TRANSPORT_DIAGNOSTIC_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "socket_closed",
  "request_timeout",
  "request_aborted",
  "http_429",
  "http_5xx",
  "unknown_connection_error",
] as const;
export type TransportDiagnosticCode = (typeof TRANSPORT_DIAGNOSTIC_CODES)[number];

/** One adapter call's diagnostic, reported to an optional operator sink (reference + attempt identify the call). */
export interface TransportDiagnostic {
  readonly reference: string;
  readonly attempt: 1 | 2;
  readonly code: TransportDiagnosticCode;
}
export type TransportDiagnosticSink = (diagnostic: TransportDiagnostic) => void;

/** Low-level codes kept as themselves (Node / undici `code` values). */
const KEPT: readonly string[] = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"];
/** Low-level codes that all mean "the socket went away". */
const SOCKET_CLOSED: readonly string[] = ["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ERR_SOCKET_CLOSED", "ECONNABORTED"];
const MAX_DEPTH = 6;

const fieldOf = (value: unknown, key: "code" | "name" | "cause"): unknown =>
  typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;

/** The normalized cause of a connection-level failure: the first recognized code in the cause chain, else unknown. */
export function normalizeConnectionCause(error: unknown): TransportDiagnosticCode {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && current !== null; depth += 1) {
    const code = fieldOf(current, "code");
    if (typeof code === "string") {
      if (KEPT.includes(code)) return code as TransportDiagnosticCode;
      if (SOCKET_CLOSED.includes(code)) return "socket_closed";
    }
    if (fieldOf(current, "name") === "AbortError") return "request_aborted";
    current = fieldOf(current, "cause");
  }
  return "unknown_connection_error";
}

export const isTransportDiagnosticCode = (value: unknown): value is TransportDiagnosticCode => typeof value === "string" && (TRANSPORT_DIAGNOSTIC_CODES as readonly string[]).includes(value);
