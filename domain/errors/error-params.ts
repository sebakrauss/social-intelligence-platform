/**
 * Message parameters allowed per error code, enforced at compile time AND at runtime.
 *
 * Parameters exist only to fill placeholders in localized messages. They are tokens, stable
 * identifiers or counts, never personal or customer content: no comment text, author names or
 * handles, Brand Context, reply text, credentials, URLs or provider payloads (TA §38.11).
 * Teammate display names (e.g. for STALE_STATE) are resolved by the UI from its own view model,
 * not carried in the error.
 */
import { isPlatformKey, type PlatformKey } from "../platforms";
import { looksLikeSecret } from "../secret-patterns";
import type { ErrorCode } from "./error-codes";

export type SafeParamValue = string | number;

/** No parameters: only an empty object is accepted. */
type NoParams = { readonly [key: string]: never };

/** Platform identity token, never caller-provided prose (display name resolved from `PLATFORM_DISPLAY_NAMES`). */
type PlatformParam = { readonly platform: PlatformKey };

export interface ErrorParamsByCode {
  readonly PERMISSION_DENIED: NoParams;
  readonly NOT_FOUND: NoParams;
  readonly MODE_BLOCKED: NoParams;
  readonly CAPABILITY_UNSUPPORTED: PlatformParam;
  readonly CAPABILITY_UNKNOWN: PlatformParam;
  readonly CONNECTION_PROBLEM: PlatformParam;
  readonly PROVIDER_RATE_LIMITED: PlatformParam;
  readonly PROVIDER_TRANSIENT: PlatformParam;
  readonly PROVIDER_PERMANENT: PlatformParam;
  readonly OUTCOME_UNKNOWN: PlatformParam;
  /** `field` is a stable field identifier (e.g. "brandContext.contactChannel"), never a value or label. */
  readonly INVALID_INPUT: { readonly field?: string };
  readonly CONFLICT: NoParams;
  readonly STALE_STATE: NoParams;
  readonly PROTECTION_VETO: { readonly excludedCount: number };
  readonly AI_INVALID_OUTPUT: NoParams;
  readonly AI_UNAVAILABLE: NoParams;
  readonly AI_REFUSED: NoParams;
  readonly AI_BUDGET_EXCEEDED: NoParams;
  readonly JOB_FAILED: NoParams;
}

interface ParamSpec {
  readonly required: boolean;
  readonly isValid: (value: unknown) => boolean;
}

/** Stable field identifier: dotted lowerCamel segments, e.g. "brandContext.contactChannel". */
const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z][A-Za-z0-9]{0,31}){0,3}$/;

const isFieldKey = (value: unknown): boolean =>
  typeof value === "string" && FIELD_KEY.test(value) && !looksLikeSecret(value);

const isCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const platform: ParamSpec = { required: true, isValid: isPlatformKey };

/** Runtime specification of every code's parameters; the compiler keeps it in sync with `ErrorParamsByCode`. */
const ERROR_PARAM_SPECS = {
  PERMISSION_DENIED: {},
  NOT_FOUND: {},
  MODE_BLOCKED: {},
  CAPABILITY_UNSUPPORTED: { platform },
  CAPABILITY_UNKNOWN: { platform },
  CONNECTION_PROBLEM: { platform },
  PROVIDER_RATE_LIMITED: { platform },
  PROVIDER_TRANSIENT: { platform },
  PROVIDER_PERMANENT: { platform },
  OUTCOME_UNKNOWN: { platform },
  INVALID_INPUT: { field: { required: false, isValid: isFieldKey } },
  CONFLICT: {},
  STALE_STATE: {},
  PROTECTION_VETO: { excludedCount: { required: true, isValid: isCount } },
  AI_INVALID_OUTPUT: {},
  AI_UNAVAILABLE: {},
  AI_REFUSED: {},
  AI_BUDGET_EXCEEDED: {},
  JOB_FAILED: {},
} as const satisfies { readonly [C in ErrorCode]: { readonly [K in keyof ErrorParamsByCode[C]]-?: ParamSpec } };

/** Declared parameter names per code. */
export const ERROR_PARAM_NAMES = Object.fromEntries(
  Object.entries(ERROR_PARAM_SPECS).map(([code, spec]) => [code, Object.freeze(Object.keys(spec))]),
) as { readonly [C in ErrorCode]: readonly string[] };

/**
 * Throws a programming error when params are unsafe: undeclared keys, missing required keys or
 * values outside the declared token/identifier/count shapes. The message names the code and the
 * declared parameter, never the offending value or an undeclared key.
 */
export function assertSafeErrorParams(code: ErrorCode, params: unknown): void {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError(`AppError(${code}): params must be a plain object`);
  }
  const spec: Readonly<Record<string, ParamSpec>> = ERROR_PARAM_SPECS[code];
  const values = params as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(spec, key)) {
      throw new TypeError(`AppError(${code}): undeclared parameter`);
    }
  }
  for (const [name, { required, isValid }] of Object.entries(spec)) {
    const value = values[name];
    if (value === undefined) {
      if (required) {
        throw new TypeError(`AppError(${code}): missing parameter '${name}'`);
      }
    } else if (!isValid(value)) {
      throw new TypeError(`AppError(${code}): unsafe value for parameter '${name}'`);
    }
  }
}
