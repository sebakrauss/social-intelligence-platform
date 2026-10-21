/**
 * The ONE way a capability evaluation is requested (Step 7G-H5.5; TA §16.1 "evaluated on connect, on permission
 * change, on observed errors, and periodically"). Provider-neutral: a Connected Account and the reason it needs
 * evaluating, as a durable outbox row — identifiers only (the account), never a credential, a token or provider data.
 * The worker (capability.evaluate_account, integration plane) re-reads every authority from the database and alone
 * opens the credential; the web only appends this row inside the activation's own transaction.
 *
 * Deterministic dispatch keys — the domain idempotency of the REQUEST (the evaluation itself is a stale-safe write
 * of derived state, so a repeat is harmless, but never needed):
 *
 *   activation       capability.evaluate_account:{account}:{activation}  — {activation} is the id of the LINKED /
 *                    MOVED_IN account event the activation wrote in the same transaction: exactly one request per
 *                    activation transition; an unchanged save, a deselection or a retained account writes none.
 *   unrecorded       capability.evaluate_account:{account}:initial       — an ACTIVE account with no recorded
 *                    activation event (rows that predate the event history).
 *   catalog change   capability.evaluate_account:{account}:{catalog}.r{revision} — a profile resting on another
 *                    catalog or an older revision: one request per (account, target catalog revision).
 *   re-evaluation    capability.evaluate_account:{account}:reeval.{event} — an Owner/Admin's explicit recovery request
 *                    (Step 7G-H5.5-P2-B1): {event} is the id of the REEVALUATION_REQUESTED account event written in the
 *                    same transaction, so every accepted request is a NEW authority under a NEW key; a consumed one
 *                    (any run outcome) is never re-armed or reused. At most 27 + 1 + 36 + 1 + 7 + 36 = 108 characters,
 *                    inside system.outbox's dispatch_key contract (^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$).
 *
 * Reconciliation recomputes the activation key from the account's latest activation event, so it and the activation
 * can never request the same evaluation twice: the second writer finds the key taken.
 */
import { isUuid } from "@/domain/ids";
import type { OutboxMessage } from "@/platform/outbox";
import { CAPABILITY_EVALUATION_TOPIC } from "../domain/model";

export type EvaluationReason =
  | { readonly kind: "activation"; readonly activationId: string }
  | { readonly kind: "unrecorded" }
  | { readonly kind: "catalog"; readonly catalogId: string; readonly catalogRevision: number }
  /** An explicit recovery request: `eventId` is its REEVALUATION_REQUESTED account event (a UUID). */
  | { readonly kind: "reevaluation"; readonly eventId: string };

function reasonRef(reason: EvaluationReason): string {
  switch (reason.kind) {
    case "activation":
      return reason.activationId;
    case "unrecorded":
      return "initial";
    case "catalog":
      return `${reason.catalogId}.r${String(reason.catalogRevision)}`;
    case "reevaluation":
      // Fail closed: only an event id (canonical UUID) can name a recovery authority.
      if (!isUuid(reason.eventId)) throw new TypeError("reevaluation eventId must be a UUID");
      return `reeval.${reason.eventId}`;
  }
}

export function capabilityEvaluationDispatchKey(connectedAccountId: string, reason: EvaluationReason): string {
  return `${CAPABILITY_EVALUATION_TOPIC}:${connectedAccountId}:${reasonRef(reason)}`;
}

export function capabilityEvaluationRequest(input: {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  readonly reason: EvaluationReason;
  readonly correlationId: string;
  readonly initiator: OutboxMessage["initiator"];
  readonly createdAt: Date;
}): OutboxMessage {
  return {
    id: input.id,
    topic: CAPABILITY_EVALUATION_TOPIC,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    subjectIds: { connected_account_id: input.connectedAccountId },
    correlationId: input.correlationId,
    initiator: input.initiator,
    dispatchKey: capabilityEvaluationDispatchKey(input.connectedAccountId, input.reason),
    createdAt: input.createdAt,
  };
}
