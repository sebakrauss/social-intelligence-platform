/**
 * The derived accounting state of every provider-call intent (Step H7-D1e2b; migration 0026). Pure: one read-only SQL
 * statement and its row type, shared by the operator CLI (tools/db/ai-call-reconciliation.ts) and the database tests.
 * Nothing is stored: an intent is never updated, so its state is derived each time.
 *
 *   RECORDED                  its ai_attempts row exists (final outcome and usage known)
 *   IN_FLIGHT                 no attempt row yet, the request is still AI_RUNNING at that generation and the intent is
 *                             younger than the stale threshold
 *   UNKNOWN_PROVIDER_OUTCOME  no attempt row, and the generation moved on or the intent is stale — the call may have
 *                             happened and been billed; it is never treated as "not called"
 *
 * Output is identifiers, enums, counts and times only: never social text, a prompt, a response or a secret.
 */

export const CALL_ACCOUNTING_STATES = ["RECORDED", "IN_FLIGHT", "UNKNOWN_PROVIDER_OUTCOME"] as const;
export type CallAccountingState = (typeof CALL_ACCOUNTING_STATES)[number];

export interface CallAccountingRow {
  readonly intent_id: string;
  readonly workspace_id: string;
  readonly understanding_request_id: string;
  readonly dispatch_generation: number;
  readonly attempt_number: number;
  readonly attempt_kind: string;
  readonly intent_created_at: Date;
  readonly request_state: string;
  readonly request_generation: number | null;
  readonly attempt_outcome: string | null;
  readonly accounting_state: CallAccountingState;
}

/** $1 = the stale threshold instant (intents created before it can no longer be IN_FLIGHT). Read-only. */
export const CALL_ACCOUNTING_SQL = `
  select i.id as intent_id, i.workspace_id, i.understanding_request_id, i.dispatch_generation, i.attempt_number, i.attempt_kind,
         i.created_at as intent_created_at, r.state as request_state, r.ai_generation as request_generation, a.outcome as attempt_outcome,
         case
           when a.id is not null then 'RECORDED'
           when r.state = 'AI_RUNNING' and r.ai_generation = i.dispatch_generation and i.created_at >= $1 then 'IN_FLIGHT'
           else 'UNKNOWN_PROVIDER_OUTCOME'
         end as accounting_state
    from classification.ai_call_intents i
    join classification.understanding_requests r on r.workspace_id = i.workspace_id and r.id = i.understanding_request_id
    left join classification.ai_attempts a on a.workspace_id = i.workspace_id and a.understanding_request_id = i.understanding_request_id
                                          and a.dispatch_generation = i.dispatch_generation and a.attempt_number = i.attempt_number
   order by i.created_at, i.dispatch_generation, i.attempt_number, i.id`;

export function summarizeCallAccounting(rows: readonly CallAccountingRow[]): Readonly<Record<CallAccountingState, number>> {
  const counts: Record<CallAccountingState, number> = { RECORDED: 0, IN_FLIGHT: 0, UNKNOWN_PROVIDER_OUTCOME: 0 };
  for (const row of rows) counts[row.accounting_state] += 1;
  return Object.freeze(counts);
}
