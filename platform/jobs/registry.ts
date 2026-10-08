/**
 * Task registry: every background task is declared once, with its scope, lane, retry policy, keyed
 * concurrency and the subject IDs its payload may carry. The relay, the wrappers and the runtime adapter all
 * read the same declaration, so a task can't be dispatched on the wrong lane, run in the wrong scope, or
 * accept identifiers it didn't declare.
 *
 * System scope is a short, named allowlist (TA §9.3): only the tasks listed in SYSTEM_TASKS may be
 * system-scoped. Every other task is a tenant task bound to exactly one workspace.
 *
 * Every task also declares its execution plane explicitly (Step 7E.4B.3; planes.ts): never inferred from its name,
 * directory or scope. System tasks run in the main plane. The declared plane routes only UNBOUND outbox work (the claim
 * binds it, migration 0011); a bound delivery keeps its persisted plane even if this declaration later changes.
 */
import { LANE_DEFINITIONS, SYSTEM_QUEUE, isLane, type Lane } from "./lanes";
import { isExecutionPlane, type ExecutionPlane } from "./planes";
import type { JobPayload, TenantJobPayload } from "./payload";

export interface RetryPolicy {
  /** Total attempts including the first (1 = no retry). */
  readonly maxAttempts: number;
  readonly factor: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly randomize: boolean;
}

/** Deliberate retry presets (TA §19.1: exponential backoff with jitter; non-retryable classes stop early). */
export const RETRY_POLICIES = {
  transient: { maxAttempts: 4, factor: 2, minDelayMs: 1_000, maxDelayMs: 30_000, randomize: true },
  singleAttempt: { maxAttempts: 1, factor: 1, minDelayMs: 1_000, maxDelayMs: 1_000, randomize: false },
} as const satisfies Record<string, RetryPolicy>;

/** The only tasks that may run in system scope (named, reviewed system jobs). */
export const SYSTEM_TASKS = ["outbox.relay", "outbox.dispatch_sweep", "outbox.outcome_sweep"] as const;
export type SystemTaskName = (typeof SYSTEM_TASKS)[number];

/** Keyed concurrency: none, one key per workspace, or one key per value of a declared subject ID. */
export type ConcurrencyRule = { readonly by: "none" } | { readonly by: "workspace" } | { readonly by: "subject"; readonly subject: string };

export interface TenantTaskDefinition {
  readonly name: string;
  readonly scope: "workspace";
  /** The plane NEW (unbound) work for this task is bound to. */
  readonly executionPlane: ExecutionPlane;
  readonly lane: Lane;
  readonly retry: RetryPolicy;
  readonly concurrency: ConcurrencyRule;
  /** Subject ID names the payload may carry (and must carry, if listed as required). */
  readonly subjects: readonly string[];
}

export interface SystemTaskDefinition {
  readonly name: SystemTaskName;
  readonly scope: "system";
  /** System tasks deliver the outbox from the main plane only. */
  readonly executionPlane: "main";
  readonly retry: RetryPolicy;
  /** Cron schedule for sweepers (declared here, materialized by the runtime deployment). */
  readonly schedule?: { readonly cron: string };
}

export type TaskDefinition = TenantTaskDefinition | SystemTaskDefinition;

export class TaskRegistryError extends Error {
  override readonly name = "TaskRegistryError";
}

const TASK_NAME = /^[a-z][a-z_]{0,40}(\.[a-z][a-z_]{0,40}){1,3}$/;
const SUBJECT_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const CRON = /^(\S+\s+){4}\S+$/;

function validateRetry(name: string, retry: RetryPolicy): void {
  const ok = Number.isInteger(retry.maxAttempts) && retry.maxAttempts >= 1 && retry.maxAttempts <= 10
    && retry.factor >= 1 && retry.minDelayMs >= 100 && retry.maxDelayMs >= retry.minDelayMs && retry.maxDelayMs <= 3_600_000;
  if (!ok) throw new TaskRegistryError(`${name}: retry policy out of bounds`);
}

export interface TaskRegistry {
  readonly tasks: readonly TaskDefinition[];
  get(name: string): TaskDefinition | undefined;
  tenant(name: string): TenantTaskDefinition | undefined;
  system(name: string): SystemTaskDefinition | undefined;
  /**
   * Outbox topic → execution plane for UNBOUND work: every registered tenant task, nothing else. The claim binds a
   * row to this plane; it never overrides a plane already persisted on the row.
   */
  readonly unboundRoutes: Readonly<Record<string, ExecutionPlane>>;
}

/** Builds and validates a registry. Throws TaskRegistryError on any unsafe or ambiguous declaration. */
export function defineTaskRegistry(definitions: readonly TaskDefinition[]): TaskRegistry {
  const byName = new Map<string, TaskDefinition>();
  for (const definition of definitions) {
    if (!TASK_NAME.test(definition.name)) throw new TaskRegistryError(`invalid task name: ${definition.name}`);
    if (byName.has(definition.name)) throw new TaskRegistryError(`duplicate task: ${definition.name}`);
    validateRetry(definition.name, definition.retry);
    // Checked at runtime too: a declaration built outside the type system must not slip through without a plane.
    const plane: unknown = definition.executionPlane;
    if (!isExecutionPlane(plane)) throw new TaskRegistryError(`${definition.name}: missing or unknown execution plane`);
    if (definition.scope === "system") {
      if (plane !== "main") throw new TaskRegistryError(`${definition.name}: system tasks run in the main plane`);
      if (!(SYSTEM_TASKS as readonly string[]).includes(definition.name)) {
        throw new TaskRegistryError(`${definition.name}: only named system tasks may be system-scoped`);
      }
      if (definition.schedule !== undefined && !CRON.test(definition.schedule.cron)) throw new TaskRegistryError(`${definition.name}: invalid cron`);
    } else {
      if ((SYSTEM_TASKS as readonly string[]).includes(definition.name)) throw new TaskRegistryError(`${definition.name}: system task declared as tenant task`);
      if (!isLane(definition.lane)) throw new TaskRegistryError(`${definition.name}: unknown lane`);
      if (new Set(definition.subjects).size !== definition.subjects.length || !definition.subjects.every((subject) => SUBJECT_NAME.test(subject))) {
        throw new TaskRegistryError(`${definition.name}: invalid subjects`);
      }
      if (definition.concurrency.by === "subject" && !definition.subjects.includes(definition.concurrency.subject)) {
        throw new TaskRegistryError(`${definition.name}: concurrency subject is not a declared subject`);
      }
    }
    byName.set(definition.name, definition);
  }
  const frozen = Object.freeze([...definitions]);
  const unboundRoutes: Record<string, ExecutionPlane> = {};
  for (const definition of frozen) if (definition.scope === "workspace") unboundRoutes[definition.name] = definition.executionPlane;
  return {
    tasks: frozen,
    unboundRoutes: Object.freeze(unboundRoutes),
    get: (name) => byName.get(name),
    tenant: (name) => {
      const definition = byName.get(name);
      return definition?.scope === "workspace" ? definition : undefined;
    },
    system: (name) => {
      const definition = byName.get(name);
      return definition?.scope === "system" ? definition : undefined;
    },
  };
}

/** The queue a task runs on: its lane's queue, or the dedicated system queue. Never chosen per call. */
export function queueFor(definition: TaskDefinition): string {
  return definition.scope === "system" ? SYSTEM_QUEUE.queue : LANE_DEFINITIONS[definition.lane].queue;
}

/** The concurrency key for one run (IDs only), or undefined when the task has no keyed concurrency. */
export function concurrencyKeyFor(definition: TaskDefinition, payload: JobPayload): string | undefined {
  if (definition.scope === "system" || payload.scope === "system") return undefined;
  const tenant: TenantJobPayload = payload;
  switch (definition.concurrency.by) {
    case "none":
      return undefined;
    case "workspace":
      return `ws:${tenant.workspaceId}`;
    case "subject": {
      const id = tenant.subjectIds[definition.concurrency.subject];
      return id === undefined ? `ws:${tenant.workspaceId}` : `${definition.concurrency.subject}:${id}`;
    }
  }
}

/** Every subject in the payload must be declared by the task (no undeclared identifiers ride along). */
export function payloadMatchesTask(definition: TenantTaskDefinition, payload: TenantJobPayload): boolean {
  return payload.task === definition.name && Object.keys(payload.subjectIds).every((name) => definition.subjects.includes(name));
}
