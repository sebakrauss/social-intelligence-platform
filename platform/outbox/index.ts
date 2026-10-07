/** Web-safe outbox API: the message contract and the post-commit relay nudge. Delivery (system scope) is
 * imported separately from platform/outbox/delivery by the job runtime only. */
export { OUTBOX_INITIATOR_TYPES, createOutboxMessage, type OutboxInitiatorType, type OutboxMessage, type OutboxNotice, type OutboxWriter } from "./message";
export { RELAY_TASK, nudgeRelay } from "./nudge";
