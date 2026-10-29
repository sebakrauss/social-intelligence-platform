/**
 * Classification persistence (Step H7-B; migration 0024). Runs inside the caller's workspace-scoped job transaction as
 * app_worker: RLS binds the workspace, composite foreign keys bind every row to its own interaction's text version, and
 * the 0024 unique keys are the idempotency authority. Writes only `understanding_requests` (insert PENDING, advance
 * state) and `signals` (append). It never writes an assessment, a watch term or any canonical row.
 */
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import { REQUEST_STATES, type ClassificationStore, type RequestState } from "../application/ports";

const TERMINAL: readonly RequestState[] = ["COMPLETED", "AI_FAILED", "DETERMINISTIC_ONLY", "SKIPPED_OWN_BRAND", "SKIPPED_SUPERSEDED"];
const isRequestState = (value: unknown): value is RequestState => typeof value === "string" && (REQUEST_STATES as readonly string[]).includes(value);
const intArray = (values: readonly number[]): string => `{${values.map((v) => String(v)).join(",")}}`;

export function createPostgresClassificationStore(tx: DatabaseTransaction): ClassificationStore {
  return {
    async ensureRequest(request) {
      const inserted = await tx.execute<{ id: string; state: string }>(sql`
        insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state,
                                                           created_at, updated_at)
        values (${request.id}::uuid, ${request.organizationId}::uuid, ${request.workspaceId}::uuid, ${request.interactionId}::uuid, ${request.sourceTextVersionId}::uuid,
                ${request.pipelineVersion}, ${request.arrival}, 'PENDING', ${request.now}, ${request.now})
        on conflict on constraint understanding_requests_once do nothing
        returning id, state`);
      const fresh = inserted.rows[0];
      // Locked either way: a concurrent delivery of the same version waits here, then sees the committed request.
      const locked = await tx.execute<{ id: string; state: string }>(sql`
        select id, state from classification.understanding_requests
         where source_text_version_id = ${request.sourceTextVersionId}::uuid and pipeline_version = ${request.pipelineVersion}
         for update`);
      const row = locked.rows[0];
      if (row === undefined || !isRequestState(row.state)) throw new Error("classification_request_unreadable");
      return { id: row.id, state: row.state, created: fresh !== undefined };
    },

    async advanceRequest(id, from, to, now) {
      const result = await tx.execute(sql`
        update classification.understanding_requests
           set state = ${to}, completed_at = ${TERMINAL.includes(to) ? now : null}, updated_at = greatest(updated_at, ${now})
         where id = ${id}::uuid and state = ${from}`);
      return (result.rowCount ?? 0) === 1;
    },

    async recordSignal(signal) {
      const starts = signal.spans === null ? null : intArray(signal.spans.map((s) => s.start));
      const ends = signal.spans === null ? null : intArray(signal.spans.map((s) => s.end));
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into classification.signals (id, organization_id, workspace_id, interaction_id, source_text_version_id, kind, signals_version, span_starts, span_ends,
                                            truncated, created_at)
        values (${signal.id}::uuid, ${signal.organizationId}::uuid, ${signal.workspaceId}::uuid, ${signal.interactionId}::uuid, ${signal.sourceTextVersionId}::uuid,
                ${signal.kind}, ${signal.signalsVersion}, ${starts}::integer[], ${ends}::integer[], ${signal.truncated}, ${signal.now})
        on conflict do nothing
        returning id`);
      if (inserted.rows[0] !== undefined) return "inserted";
      // The same identity already holds a fact: equivalent (idempotent replay) or a DIFFERENT fact (fail closed).
      const existing = await tx.execute<{ starts: string | null; ends: string | null; truncated: boolean }>(sql`
        select span_starts::text as starts, span_ends::text as ends, truncated from classification.signals
         where source_text_version_id = ${signal.sourceTextVersionId}::uuid and kind = ${signal.kind} and signals_version = ${signal.signalsVersion}
           and matcher_version is null and watch_term_revision_id is null and watch_term_id is null`);
      const row = existing.rows[0];
      if (row === undefined) throw new Error("classification_signal_unreadable");
      return row.starts === starts && row.ends === ends && row.truncated === signal.truncated ? "equivalent" : "conflict";
    },
  };
}
