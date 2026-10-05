/**
 * Job payload contract (TA §19.4; CLAUDE.md §10). Payloads carry identifiers only: the workspace (or an
 * explicit system scope), the task, subject IDs, correlation/request IDs and the initiator. Never comment
 * or message text, author handles, tokens, credentials, provider payloads or other content. Workers reload
 * anything they need from PostgreSQL inside the bound tenant scope.
 *
 * The same validator runs when a payload is built (relay) and again when a run starts (wrapper), so a
 * malformed or content-bearing payload fails closed before any database connection is taken.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK = /^[a-z][a-z_]{0,40}(\.[a-z][a-z_]{0,40}){1,3}$/;
const SUBJECT_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_SUBJECTS = 16;

export const JOB_PAYLOAD_VERSION = 1;

export type JobInitiator = { readonly type: "user"; readonly userId: string } | { readonly type: "policy" } | { readonly type: "system" };

export interface TenantJobPayload {
  readonly v: 1;
  readonly scope: "workspace";
  readonly task: string;
  readonly workspaceId: string;
  readonly outboxId: string;
  readonly subjectIds: Readonly<Record<string, string>>;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly initiator: JobInitiator;
}

export interface SystemJobPayload {
  readonly v: 1;
  readonly scope: "system";
  readonly task: string;
  readonly correlationId: string;
  readonly initiator: { readonly type: "system" };
}

export type JobPayload = TenantJobPayload | SystemJobPayload;

export class InvalidJobPayloadError extends Error {
  override readonly name = "InvalidJobPayloadError";
  /** The offending field name (a declared field, or "payload"); never its value. */
  readonly field: string;
  constructor(field: string) {
    super(`job payload rejected: ${field}`);
    this.field = field;
  }
}

function reject(field: string): never {
  throw new InvalidJobPayloadError(field);
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) reject("payload");
  }
  for (const key of required) {
    if (!(key in value)) reject(key);
  }
}

const uuid = (value: unknown, field: string): string => (typeof value === "string" && UUID.test(value) ? value : reject(field));
const trace = (value: unknown, field: string): string => (typeof value === "string" && TRACE_ID.test(value) ? value : reject(field));
const task = (value: unknown): string => (typeof value === "string" && TASK.test(value) ? value : reject("task"));

function initiator(value: unknown): JobInitiator {
  if (!plainObject(value)) reject("initiator");
  if (value["type"] === "user") {
    exactKeys(value, ["type", "userId"]);
    return Object.freeze({ type: "user" as const, userId: uuid(value["userId"], "initiator") });
  }
  if (value["type"] === "policy" || value["type"] === "system") {
    exactKeys(value, ["type"]);
    return Object.freeze({ type: value["type"] });
  }
  return reject("initiator");
}

function subjectIds(value: unknown): Readonly<Record<string, string>> {
  if (!plainObject(value) || Object.keys(value).length > MAX_SUBJECTS) reject("subjectIds");
  const out: Record<string, string> = {};
  for (const [name, id] of Object.entries(value)) {
    if (!SUBJECT_NAME.test(name)) reject("subjectIds");
    out[name] = uuid(id, "subjectIds");
  }
  return Object.freeze(out);
}

/** Validates a tenant job payload: one workspace, identifiers only. Throws InvalidJobPayloadError. */
export function parseTenantJobPayload(value: unknown): TenantJobPayload {
  if (!plainObject(value)) reject("payload");
  exactKeys(value, ["v", "scope", "task", "workspaceId", "outboxId", "subjectIds", "correlationId", "initiator"], ["requestId"]);
  if (value["v"] !== JOB_PAYLOAD_VERSION) reject("v");
  if (value["scope"] !== "workspace") reject("scope");
  const requestId = value["requestId"] === undefined ? undefined : trace(value["requestId"], "requestId");
  return Object.freeze({
    v: 1 as const,
    scope: "workspace" as const,
    task: task(value["task"]),
    workspaceId: uuid(value["workspaceId"], "workspaceId"),
    outboxId: uuid(value["outboxId"], "outboxId"),
    subjectIds: subjectIds(value["subjectIds"]),
    correlationId: trace(value["correlationId"], "correlationId"),
    ...(requestId === undefined ? {} : { requestId }),
    initiator: initiator(value["initiator"]),
  });
}

/** Validates a system job payload: no workspace, no subjects, system initiator only. */
export function parseSystemJobPayload(value: unknown): SystemJobPayload {
  if (!plainObject(value)) reject("payload");
  exactKeys(value, ["v", "scope", "task", "correlationId", "initiator"]);
  if (value["v"] !== JOB_PAYLOAD_VERSION) reject("v");
  if (value["scope"] !== "system") reject("scope");
  const who = initiator(value["initiator"]);
  if (who.type !== "system") reject("initiator");
  return Object.freeze({
    v: 1 as const,
    scope: "system" as const,
    task: task(value["task"]),
    correlationId: trace(value["correlationId"], "correlationId"),
    initiator: Object.freeze({ type: "system" as const }),
  });
}
