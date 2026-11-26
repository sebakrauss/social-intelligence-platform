/**
 * Sanitization of UNEXPECTED errors (W12-SEC-01 L-1/L-2; TA §38.11, §42.1). An error that is not a normalized
 * AppError can carry values in its message, stack, `cause` or own properties: a driver error can echo a key value
 * or a query's parameters, an adapter error can echo request data. Nothing of it may reach a log line, the hosted
 * runtime's error output or the job vendor's run record.
 *
 * `describeUnexpectedError` reads only the error's shape (its `code` and `name` strings, compared against closed
 * lists, and its built-in class), following `cause` a bounded number of levels. It never reads `message`, `stack`
 * or any other property, never copies a value it did not validate, and fails closed to "unknown" on any surprise
 * (throwing getters, proxies). The sanitized error classes carry ONLY a fixed name and a message built from the
 * description: no cause, no original stack frames, no extra enumerable properties.
 */
import { types } from "node:util";
import { AppError, isErrorCode } from "@/domain/errors";

/** Closed vocabulary of unexpected-failure kinds. A log field and part of the sanitized message. */
export const ERROR_KINDS = ["database", "network", "timeout", "aborted", "type_error", "unknown"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface UnexpectedErrorDescription {
  readonly errorKind: ErrorKind;
  /** A validated PostgreSQL SQLSTATE (5 characters, known class), only for `database`. */
  readonly sqlState?: string;
}

/** SQLSTATE classes defined by PostgreSQL (Appendix A). A 5-character code outside them is not a SQLSTATE. */
const SQLSTATE_CLASSES: ReadonlySet<string> = new Set([
  "00", "01", "02", "03", "08", "09", "0A", "0B", "0F", "0L", "0P", "0Z", "20", "21", "22", "23", "24", "25", "26",
  "27", "28", "2B", "2D", "2F", "34", "38", "39", "3B", "3D", "3F", "40", "42", "44", "53", "54", "55", "57", "58",
  "72", "F0", "HV", "P0", "XX",
]);

/**
 * True only for a well-formed PostgreSQL SQLSTATE of a known class. Deliberately a boolean, not a type predicate: a
 * string that is not a SQLSTATE is still a string (e.g. a socket error code).
 */
export function isSqlState(value: unknown): boolean {
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) && SQLSTATE_CLASSES.has(value.slice(0, 2));
}

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
const ABORT_CODES: ReadonlySet<string> = new Set(["ABORT_ERR", "UND_ERR_ABORTED"]);
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
]);

/** How many `cause` levels are inspected (query builders and fetch wrap the driver or socket error). */
const MAX_CAUSE_DEPTH = 5;

function stringProperty(value: object, key: "code" | "name"): string | undefined {
  const raw: unknown = (value as Readonly<Record<string, unknown>>)[key];
  return typeof raw === "string" ? raw : undefined;
}

function kindOfLevel(level: object): UnexpectedErrorDescription | undefined {
  const code = stringProperty(level, "code");
  if (code !== undefined && isSqlState(code)) return { errorKind: "database", sqlState: code };
  const name = stringProperty(level, "name");
  if (name === "TimeoutError" || (code !== undefined && TIMEOUT_CODES.has(code))) return { errorKind: "timeout" };
  if (name === "AbortError" || (code !== undefined && ABORT_CODES.has(code))) return { errorKind: "aborted" };
  if (code !== undefined && NETWORK_CODES.has(code)) return { errorKind: "network" };
  return undefined;
}

/**
 * The safe description of an unexpected error: its kind (closed vocabulary) and, for a database error, its
 * validated SQLSTATE. Never derived from message, stack or detail text.
 */
export function describeUnexpectedError(error: unknown): UnexpectedErrorDescription {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
      const described = kindOfLevel(current);
      if (described !== undefined) return described;
      current = (current as { readonly cause?: unknown }).cause;
    }
    return error instanceof TypeError ? { errorKind: "type_error" } : { errorKind: "unknown" };
  } catch {
    return { errorKind: "unknown" };
  }
}

function sanitizedMessage(description: UnexpectedErrorDescription): string {
  const kind = (ERROR_KINDS as readonly unknown[]).includes(description.errorKind) ? description.errorKind : "unknown";
  const sqlState = description.sqlState;
  return kind === "database" && sqlState !== undefined && isSqlState(sqlState) ? `unexpected_error:${kind}:${sqlState}` : `unexpected_error:${kind}`;
}

/** Shared shape: fixed name, message from the description only, a stack without frames, no cause. */
function seal(error: Error, name: string): void {
  Object.defineProperty(error, "name", { value: name, enumerable: false, writable: false, configurable: false });
  Object.defineProperty(error, "stack", { value: `${name}: ${error.message}`, enumerable: false, writable: false, configurable: false });
}

/** What the web action pipeline throws instead of an unexpected error (L-1). */
export class UnexpectedServerError extends Error {
  constructor(description: UnexpectedErrorDescription) {
    super(sanitizedMessage(description));
    seal(this, "UnexpectedServerError");
  }
}

/** What a job hands the vendor instead of an unexpected error (L-2). Not an abort: the vendor still retries it. */
export class UnexpectedJobError extends Error {
  constructor(description: UnexpectedErrorDescription) {
    super(sanitizedMessage(description));
    seal(this, "UnexpectedJobError");
  }
}

/** The own enumerable fields a genuinely constructed AppError has (domain/errors/app-error.ts). */
const APP_ERROR_OWN_FIELDS: ReadonlySet<string> = new Set(["name", "code", "messageKey", "retry", "params", "correlationId"]);

/**
 * W12-LOG-HARDEN-03 F-2: whether a value is an AppError as the AppError constructor builds it, and not merely an
 * object whose prototype chain reaches AppError.prototype (`Object.create`, `setPrototypeOf`) or a mutated one: its
 * name is "AppError", its code is a known ErrorCode, its message is exactly that code, and it carries no own
 * enumerable field the constructor does not set. Never throws: any surprise (proxy, throwing getter) is `false`, so
 * the caller sanitizes the value instead of passing it through.
 */
export function isTrustedAppError(value: unknown): value is AppError {
  try {
    if (types.isProxy(value) || !(value instanceof AppError)) return false;
    const name: unknown = value.name;
    if (name !== "AppError" || !isErrorCode(value.code) || value.message !== value.code) return false;
    return Object.keys(value).every((field) => APP_ERROR_OWN_FIELDS.has(field));
  } catch {
    return false;
  }
}
