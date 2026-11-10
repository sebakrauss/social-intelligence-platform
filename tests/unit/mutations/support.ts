/**
 * In-memory ports of the executor for offline tests: stores that behave like the 0027 tables (one intent per
 * idempotency key, append-only history, one reply per intent), configurable guards, and a recorder of every outcome
 * event. No database, no network; the provider side is the simulator's real mutation port.
 */
import type { ExecutorStores, IntentOutcomeEvent } from "@/mutations/executor/execute";
import type { IntentOutcomeCode, IntentStatus, IntentTransition, MutationIntent } from "@/mutations/domain/intent";
import type { ExecutionGuards, MutationClock, OutboundReply, ReplyTarget } from "@/mutations/ports";

export const WORKSPACE = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
export const OTHER_WORKSPACE = "9b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
export const ORGANIZATION = "2b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
export const ACCOUNT = "3b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
export const TARGET = "4b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
export const USER = "5b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
export const CORRELATION = "7b1-test-correlation-0001";

/** The baseline simulator's Facebook page and one audience comment on it. */
export const SIM_ASSET = "fb_page_aurora";
export const SIM_COMMENT = "fb_c_010";

export function fixedClock(start = "2026-11-09T10:00:00.000Z"): MutationClock & { readonly ids: string[] } {
  let t = Date.parse(start);
  let n = 0;
  const ids: string[] = [];
  return {
    ids,
    now: () => new Date((t += 1000)),
    newId: () => {
      const id = `${(++n).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      ids.push(id);
      return id;
    },
  };
}

export function replyTarget(overrides: Partial<ReplyTarget> = {}): ReplyTarget {
  return {
    interactionId: TARGET,
    workspaceId: WORKSPACE,
    connectedAccountId: ACCOUNT,
    platform: "facebook",
    providerInteractionId: SIM_COMMENT,
    providerAssetId: SIM_ASSET,
    providerContentId: "fb_post_boosted_02",
    contentItemId: "6b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
    contentKind: "post",
    reportedSource: "mixed",
    parentProviderInteractionId: null,
    kind: "comment",
    observed: true,
    presence: "present",
    ownAccount: false,
    ...overrides,
  };
}

export interface GuardState {
  role: string | undefined;
  mode: "STANDARD" | "MONITOR_ONLY" | undefined;
  switchEnabled: boolean;
  capability: "AVAILABLE" | "AVAILABLE_WITH_LIMITATION" | "UNAVAILABLE" | "TEMPORARILY_UNAVAILABLE";
  account: Awaited<ReturnType<ExecutionGuards["account"]>>;
}

export function guardState(overrides: Partial<GuardState> = {}): GuardState {
  return {
    role: "RESPONDER",
    mode: "STANDARD",
    switchEnabled: true,
    capability: "AVAILABLE",
    account: { status: "ACTIVE", platform: "facebook", provider: "simulator", providerAssetId: SIM_ASSET, connectionStatus: "ACTIVE", credentialId: "cred-1" },
    ...overrides,
  };
}

export function pendingIntent(clock: MutationClock, overrides: Partial<MutationIntent> = {}): MutationIntent {
  const now = clock.now();
  return {
    id: clock.newId(),
    organizationId: ORGANIZATION,
    workspaceId: WORKSPACE,
    kind: "reply_public",
    requestType: "human",
    targetInteractionId: TARGET,
    connectedAccountId: ACCOUNT,
    initiatorUserId: USER,
    idempotencyKey: "form-render-0001",
    status: "PENDING",
    attempt: 0,
    runReference: null,
    outcomeCode: null,
    capabilityCatalogId: "simulator",
    capabilityCatalogRevision: 2,
    correlationId: CORRELATION,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export interface MemoryStores extends ExecutorStores {
  readonly intentRows: Map<string, MutationIntent>;
  readonly history: (IntentTransition & { readonly intentId: string })[];
  readonly replyRows: Map<string, OutboundReply>;
  readonly events: IntentOutcomeEvent[];
  readonly guardState: GuardState;
  readonly targetRows: Map<string, ReplyTarget>;
  readonly calls: string[];
}

export function memoryStores(state: GuardState = guardState(), targets: readonly ReplyTarget[] = [replyTarget()]): MemoryStores {
  const intentRows = new Map<string, MutationIntent>();
  const history: (IntentTransition & { readonly intentId: string })[] = [];
  const replyRows = new Map<string, OutboundReply>();
  const events: IntentOutcomeEvent[] = [];
  const targetRows = new Map(targets.map((target) => [target.interactionId, target] as const));
  const calls: string[] = [];
  const key = (workspaceId: string, id: string): string => `${workspaceId}:${id}`;
  return {
    intentRows,
    history,
    replyRows,
    events,
    guardState: state,
    targetRows,
    calls,
    intents: {
      insert: (intent) => {
        if ([...intentRows.values()].some((row) => row.workspaceId === intent.workspaceId && row.idempotencyKey === intent.idempotencyKey)) return Promise.reject(new Error("duplicate idempotency key"));
        intentRows.set(key(intent.workspaceId, intent.id), intent);
        return Promise.resolve();
      },
      findByIdempotencyKey: (workspaceId, idempotencyKey) => Promise.resolve([...intentRows.values()].find((row) => row.workspaceId === workspaceId && row.idempotencyKey === idempotencyKey)),
      get: (workspaceId, id) => Promise.resolve(intentRows.get(key(workspaceId, id))),
      lock: (workspaceId, id) => {
        calls.push(`lock:${id}`);
        return Promise.resolve(intentRows.get(key(workspaceId, id)));
      },
      transition: (workspaceId, id, next) => {
        const row = intentRows.get(key(workspaceId, id));
        if (row === undefined) return Promise.reject(new Error("missing intent"));
        intentRows.set(key(workspaceId, id), { ...row, status: next.status, attempt: next.attempt, runReference: next.runReference, outcomeCode: next.outcomeCode, updatedAt: next.at });
        calls.push(`transition:${next.status}`);
        return Promise.resolve();
      },
      competitorsFor: (workspaceId, intent) =>
        Promise.resolve(
          [...intentRows.values()]
            .filter((row) => row.workspaceId === workspaceId && row.id !== intent.id && row.connectedAccountId === intent.connectedAccountId && row.targetInteractionId === intent.targetInteractionId)
            .map((row) => ({ id: row.id, status: row.status, hasProviderIdentity: (replyRows.get(key(workspaceId, row.id))?.providerReplyId ?? null) !== null })),
        ),
      appendHistory: (_workspaceId, intentId, transition) => {
        history.push({ ...transition, intentId });
        return Promise.resolve();
      },
    },
    replies: {
      insert: (reply) => {
        replyRows.set(key(reply.workspaceId, reply.intentId), reply);
        return Promise.resolve();
      },
      getByIntent: (workspaceId, intentId) => Promise.resolve(replyRows.get(key(workspaceId, intentId))),
      listForParents: (workspaceId, parents) =>
        Promise.resolve(
          [...replyRows.values()]
            .filter((row) => row.workspaceId === workspaceId && parents.includes(row.parentInteractionId))
            .map((row) => {
              const intent = intentRows.get(key(workspaceId, row.intentId));
              return { intentId: row.intentId, parentInteractionId: row.parentInteractionId, connectedAccountId: row.connectedAccountId, platform: row.platform, text: row.text, status: intent?.status ?? "PENDING", outcomeCode: intent?.outcomeCode ?? null, providerReplyId: row.providerReplyId, initiatorUserId: intent?.initiatorUserId ?? "", createdAt: row.createdAt, confirmedAt: row.confirmedAt };
            }),
        ),
      linkedIntent: (workspaceId, platform, providerReplyId) =>
        Promise.resolve([...replyRows.values()].find((row) => row.workspaceId === workspaceId && row.platform === platform && row.providerReplyId === providerReplyId)?.intentId),
      confirm: (workspaceId, intentId, providerReplyId, confirmedAt) => {
        const row = replyRows.get(key(workspaceId, intentId));
        if (row === undefined) return Promise.reject(new Error("missing reply"));
        replyRows.set(key(workspaceId, intentId), { ...row, providerReplyId, confirmedAt });
        return Promise.resolve();
      },
    },
    targets: { load: (interactionId) => Promise.resolve(targetRows.get(interactionId)) },
    guards: {
      initiatorRole: () => Promise.resolve(state.role),
      workspaceMode: () => Promise.resolve(state.mode),
      providerActionAllowed: (platform, action) => {
        calls.push(`switch:${platform}:${action}`);
        return Promise.resolve(state.switchEnabled ? "allowed" : "paused");
      },
      replyCapability: (_accountId, scope) => {
        calls.push(`capability:${scope.contentKind}/${scope.reportedSource}`);
        return Promise.resolve({ state: state.capability, catalogId: "simulator", catalogRevision: 2 });
      },
      account: () => Promise.resolve(state.account),
    },
    record: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

export const codesOf = (stores: MemoryStores): (IntentOutcomeCode | null)[] => stores.history.map((row) => row.code);
export const statusesOf = (stores: MemoryStores): (IntentStatus | null)[] => stores.history.map((row) => row.to);
