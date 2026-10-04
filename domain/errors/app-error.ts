/**
 * Typed application error carrying a stable code, a localized message key, safe parameters,
 * a retry classification and, where known, the correlation ID (TA §44).
 *
 * Parameters are validated at runtime as well as by the compiler: unsafe params (undeclared keys,
 * free text, URLs, credential-shaped values) throw a programming error instead of being carried.
 *
 * `message` is the stable code, never prose: user-facing text comes from the message key,
 * and internal details belong in logs keyed by correlation ID. `cause` is kept for local
 * debugging but is never serialized.
 */
import type { CorrelationId } from "../correlation";
import type { MessageKey } from "../i18n/message-keys";
import { ERROR_DEFINITIONS, type ErrorCode, type RetryClass } from "./error-codes";
import { assertSafeErrorParams, type ErrorParamsByCode } from "./error-params";

export interface AppErrorOptions {
  readonly correlationId?: CorrelationId;
  readonly cause?: unknown;
}

export interface SerializedAppError<C extends ErrorCode = ErrorCode> {
  readonly code: C;
  readonly messageKey: MessageKey;
  readonly params: ErrorParamsByCode[C];
  readonly retry: RetryClass;
  readonly correlationId?: CorrelationId;
}

export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  override readonly name = "AppError";
  readonly code: C;
  readonly messageKey: MessageKey;
  readonly retry: RetryClass;
  readonly params: ErrorParamsByCode[C];
  readonly correlationId: CorrelationId | undefined;

  constructor(code: C, params: ErrorParamsByCode[C], options: AppErrorOptions = {}) {
    assertSafeErrorParams(code, params);
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    const definition = ERROR_DEFINITIONS[code];
    this.code = code;
    this.messageKey = definition.messageKey;
    this.retry = definition.retry;
    // A frozen copy: callers keep their object, the error stays immutable.
    this.params = Object.freeze({ ...params }) as ErrorParamsByCode[C];
    this.correlationId = options.correlationId;
  }

  /** Returns a copy associated with a correlation ID (e.g. when the error crosses the action pipeline). */
  withCorrelationId(correlationId: CorrelationId): AppError<C> {
    return new AppError(this.code, this.params, { correlationId, cause: this.cause });
  }

  /** Safe serialization: no stack, no cause, no free text. */
  toJSON(): SerializedAppError<C> {
    return {
      code: this.code,
      messageKey: this.messageKey,
      params: this.params,
      retry: this.retry,
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** The normalized code of an error, or undefined for errors outside the taxonomy. Safe to log. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
  return isAppError(error) ? error.code : undefined;
}
