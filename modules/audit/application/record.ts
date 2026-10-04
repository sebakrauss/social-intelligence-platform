import { createAuditEvent, type AuditEvent } from "../domain/audit-event";
import type { AuditLog } from "./ports";

/** Validates and appends one audit event. Invalid metadata throws instead of being recorded. */
export async function recordAuditEvent(log: AuditLog, input: unknown): Promise<AuditEvent> {
  const event = createAuditEvent(input);
  await log.append(event);
  return event;
}
