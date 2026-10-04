/**
 * Correlation/request ID generation (TA §42.1). IDs are created at the edge, or taken from a
 * trusted incoming value, and then carried explicitly: request → outbox row → job → provider/AI
 * call → audit event. No tracing vendor is involved.
 */
import {
  parseCorrelationId,
  parseRequestId,
  type CorrelationId,
  type RequestId,
} from "@/domain/correlation";

export function newCorrelationId(): CorrelationId {
  return globalThis.crypto.randomUUID() as CorrelationId;
}

export function newRequestId(): RequestId {
  return globalThis.crypto.randomUUID() as RequestId;
}

/** Keeps a well-formed incoming correlation ID (e.g. from an outbox row or job payload); otherwise starts a new one. */
export function continueOrStartCorrelation(incoming: unknown): CorrelationId {
  return parseCorrelationId(incoming) ?? newCorrelationId();
}

/** Same for request IDs. */
export function continueOrStartRequest(incoming: unknown): RequestId {
  return parseRequestId(incoming) ?? newRequestId();
}
