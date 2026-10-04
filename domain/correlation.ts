/**
 * Correlation and request identifiers (TA §42.1).
 *
 * One correlation ID follows a user action from request → outbox → job → provider/AI call.
 * This module is pure: it only defines the branded types and validates incoming values.
 * Generation lives in `platform/observability/correlation.ts`.
 */

declare const correlationIdBrand: unique symbol;
declare const requestIdBrand: unique symbol;

export type CorrelationId = string & { readonly [correlationIdBrand]: true };
export type RequestId = string & { readonly [requestIdBrand]: true };

/**
 * Opaque trace identifiers: UUIDs or provider event identities.
 * Letters, digits and `. _ : -` only, so free text, URLs and whitespace can never pass.
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

export function parseCorrelationId(value: unknown): CorrelationId | undefined {
  return isTraceId(value) ? (value as CorrelationId) : undefined;
}

export function parseRequestId(value: unknown): RequestId | undefined {
  return isTraceId(value) ? (value as RequestId) : undefined;
}
