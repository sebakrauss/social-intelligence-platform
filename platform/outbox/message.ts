/**
 * Transactional outbox messages (TA §10.6 step 8; CLAUDE.md §10). A message is appended in the same
 * transaction as the state change it follows up and names the async work by identifiers only: topic,
 * tenant IDs, subject IDs, correlation ID and initiator. Never content, personal data, credentials,
 * secrets or request payloads. Delivery (relay, dispatch, retries, sweepers) is Step 3.
 */

export const OUTBOX_INITIATOR_TYPES = ["user", "policy", "system"] as const;
export type OutboxInitiatorType = (typeof OUTBOX_INITIATOR_TYPES)[number];

export interface OutboxMessage {
  readonly id: string;
  /** Stable, dotted, lowercase topic, e.g. "tenancy.workspace_mode_changed". */
  readonly topic: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  /** Snake_case name → UUID. Identifiers only, by construction. */
  readonly subjectIds: Readonly<Record<string, string>>;
  readonly correlationId: string;
  readonly initiator: { readonly type: "user"; readonly userId: string } | { readonly type: "policy" | "system" };
  /** Domain idempotency key for dispatch (unique). */
  readonly dispatchKey: string;
  readonly createdAt: Date;
}

/** What a post-commit relay wake-up needs to know about a committed outbox row: identifiers only. */
export interface OutboxNotice {
  readonly id: string;
  readonly correlationId: string;
}

export interface OutboxWriter {
  append(message: OutboxMessage): Promise<void>;
  /**
   * Reports a row THIS transaction inserted through a reviewed definer function (e.g. connections.route_move_step),
   * so it gets the same post-commit relay wake-up as an appended one. Writes nothing.
   */
  routed(notice: OutboxNotice): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOPIC = /^[a-z][a-z_]{0,40}(\.[a-z][a-z_]{0,40}){1,3}$/;
const SUBJECT_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_SUBJECTS = 16;
const DECLARED = new Set(["id", "topic", "organizationId", "workspaceId", "subjectIds", "correlationId", "initiator", "dispatchKey", "createdAt"]);

function reject(field: string): never {
  throw new TypeError(`OutboxMessage: invalid or undeclared field '${field}'`);
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function uuid(value: unknown, field: string): string {
  return typeof value === "string" && UUID.test(value) ? value : reject(field);
}

/** Validates an outbox message built from untrusted-shaped input; undeclared or non-identifier data throws. */
export function createOutboxMessage(input: unknown): OutboxMessage {
  if (!plainObject(input)) reject("message");
  for (const key of Object.keys(input)) {
    if (!DECLARED.has(key)) throw new TypeError("OutboxMessage: undeclared field");
  }
  const topic = typeof input["topic"] === "string" && TOPIC.test(input["topic"]) ? input["topic"] : reject("topic");
  const correlationId = typeof input["correlationId"] === "string" && TRACE_ID.test(input["correlationId"]) ? input["correlationId"] : reject("correlationId");
  const dispatchKey = typeof input["dispatchKey"] === "string" && TRACE_ID.test(input["dispatchKey"]) ? input["dispatchKey"] : reject("dispatchKey");
  const createdAt = input["createdAt"] instanceof Date && !Number.isNaN(input["createdAt"].getTime()) ? input["createdAt"] : reject("createdAt");

  const rawSubjects = input["subjectIds"];
  if (!plainObject(rawSubjects) || Object.keys(rawSubjects).length > MAX_SUBJECTS) reject("subjectIds");
  const subjectIds: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawSubjects)) {
    if (!SUBJECT_NAME.test(name)) reject("subjectIds");
    subjectIds[name] = uuid(value, "subjectIds");
  }

  const rawInitiator = input["initiator"];
  if (!plainObject(rawInitiator)) reject("initiator");
  let initiator: OutboxMessage["initiator"];
  if (rawInitiator["type"] === "user" && Object.keys(rawInitiator).length === 2) {
    initiator = Object.freeze({ type: "user" as const, userId: uuid(rawInitiator["userId"], "initiator") });
  } else if ((rawInitiator["type"] === "policy" || rawInitiator["type"] === "system") && Object.keys(rawInitiator).length === 1) {
    initiator = Object.freeze({ type: rawInitiator["type"] });
  } else {
    reject("initiator");
  }

  const organizationId = input["organizationId"] === undefined ? undefined : uuid(input["organizationId"], "organizationId");
  const workspaceId = input["workspaceId"] === undefined ? undefined : uuid(input["workspaceId"], "workspaceId");

  return Object.freeze({
    id: uuid(input["id"], "id"),
    topic,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    subjectIds: Object.freeze(subjectIds),
    correlationId,
    initiator,
    dispatchKey,
    createdAt,
  });
}
