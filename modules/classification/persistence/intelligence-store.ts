/**
 * Intelligence persistence (Step H7-D1d; migration 0025). Runs inside the caller's workspace-scoped job transaction as
 * app_worker: RLS binds the workspace, the composite foreign keys bind every ledger / result / assessment row to its
 * own request, text version and pipeline, and the 0025 keys are the idempotency authority:
 *
 *   understanding_requests   generation-aware transitions only (state, ai_generation, ai_failure_class); the 0025
 *                            guard trigger refuses a decreasing generation, a changed failure class, a terminal move
 *   ai_attempts              append-only; `ai_attempts_once` absorbs a replayed (request, generation, attempt)
 *   ai_results               append-only, SHADOW only (`ai_results_shadow_only`); `ai_results_once` = one per request
 *   assessments              AI rows SHADOW only, naming their result (`assessments_ai_shadow_only`); never accepting
 *   ai_budget_reservations   only through classification.reserve_ai_budget() (bound workspace, atomic caps)
 *   system.outbox            the IDs-only `classification.understand_ai` row (the relay binds the intelligence plane)
 *
 * Never written: a prompt, a model input, a provider response, reasoning, copied social text, a credential.
 */
import { sql } from "drizzle-orm";
import { appendOutboxOnce, type DatabaseTransaction } from "@/platform/db";
import type { OutboxNotice } from "@/platform/outbox";
import { REQUEST_STATES, ARRIVALS, type Arrival, type IntelligenceRequestRecord, type IntelligenceStore, type RequestState } from "../application/ports";
import { createAssessment, type Assessment } from "../domain/assessment";
import { UNDERSTAND_AI_TOPIC, understandAiDispatchKey, understandAiSubjectIds } from "../domain/intelligence-routing";
import { parseInstant } from "@/domain/instant";

const TERMINAL: readonly RequestState[] = ["COMPLETED", "AI_FAILED", "DETERMINISTIC_ONLY", "SKIPPED_OWN_BRAND", "SKIPPED_SUPERSEDED"];
const isRequestState = (value: unknown): value is RequestState => typeof value === "string" && (REQUEST_STATES as readonly string[]).includes(value);
const isArrival = (value: unknown): value is Arrival => typeof value === "string" && (ARRIVALS as readonly string[]).includes(value);

/** A PostgreSQL array literal of closed tokens (quoted, escaped); null for none. */
const textArray = (values: readonly string[]): string => `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
const numericArray = (values: readonly (number | null)[]): string => `{${values.map((v) => (v === null ? "NULL" : String(v))).join(",")}}`;
const intArray = (values: readonly number[]): string => `{${values.map((v) => String(v)).join(",")}}`;

type RequestRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  interaction_id: string;
  source_text_version_id: string;
  pipeline_version: string;
  arrival: string;
  state: string;
  ai_generation: number | null;
  updated_at: Date;
};

function toRequest(row: RequestRow): IntelligenceRequestRecord {
  if (!isRequestState(row.state) || !isArrival(row.arrival)) throw new Error("classification_request_unreadable");
  return Object.freeze({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    interactionId: row.interaction_id,
    sourceTextVersionId: row.source_text_version_id,
    pipelineVersion: row.pipeline_version,
    arrival: row.arrival,
    state: row.state,
    aiGeneration: row.ai_generation,
    updatedAt: new Date(row.updated_at),
  });
}

const REQUEST_COLUMNS = sql`id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state, ai_generation, updated_at`;

/** `noteAppended` reports each appended outbox row for the post-commit relay wake-up (the job scope's `noteOutbox`). */
export function createPostgresIntelligenceStore(tx: DatabaseTransaction, noteAppended: (notice: OutboxNotice) => void): IntelligenceStore {
  return {
    async lockRequest(id) {
      const rows = await tx.execute<RequestRow>(sql`select ${REQUEST_COLUMNS} from classification.understanding_requests where id = ${id}::uuid for update`);
      const row = rows.rows[0];
      return row === undefined ? undefined : toRequest(row);
    },

    async transition(t) {
      const result = await tx.execute(sql`
        update classification.understanding_requests
           set state = ${t.to}, ai_generation = ${t.generation}, ai_failure_class = ${t.to === "AI_FAILED" ? t.failureClass : null},
               completed_at = ${TERMINAL.includes(t.to) ? t.now : null}, updated_at = greatest(updated_at, ${t.now})
         where id = ${t.id}::uuid and state = ${t.from} and ai_generation is not distinct from ${t.fromGeneration}::integer`);
      return (result.rowCount ?? 0) === 1;
    },

    async appendDispatch({ request, generation, correlationId, outboxId, now }) {
      const message = {
        id: outboxId,
        topic: UNDERSTAND_AI_TOPIC,
        organizationId: request.organizationId,
        workspaceId: request.workspaceId,
        subjectIds: understandAiSubjectIds({
          workspaceId: request.workspaceId, interactionId: request.interactionId, sourceTextVersionId: request.sourceTextVersionId, understandingRequestId: request.id, correlationId,
        }),
        correlationId,
        initiator: { type: "system" as const },
        dispatchKey: understandAiDispatchKey(request.id, generation),
        createdAt: now,
      };
      const appended = await appendOutboxOnce(tx, message);
      if (appended === "appended") noteAppended({ id: message.id, correlationId });
      return appended;
    },

    async recordAttempts(rows) {
      let inserted = 0;
      for (const a of rows) {
        const result = await tx.execute(sql`
          insert into classification.ai_attempts (id, organization_id, workspace_id, understanding_request_id, interaction_id, source_text_version_id, pipeline_version,
                                                  dispatch_generation, attempt_number, attempt_kind, task_id, task_version, prompt_version, prompt_hash, output_schema_version,
                                                  transport_schema_version, taxonomy_version, confidence_policy_version, language_policy_version, input_contract_version, provider,
                                                  model_requested, model_reported, started_at, completed_at, latency_ms, input_chars, input_tokens, output_tokens,
                                                  cached_input_tokens, cost_estimate_usd, pricing_table_version, outcome, failure_class, issue_codes, correlation_id,
                                                  trigger_run_id, created_at)
          values (${a.id}::uuid, ${a.organizationId}::uuid, ${a.workspaceId}::uuid, ${a.understandingRequestId}::uuid, ${a.interactionId}::uuid, ${a.sourceTextVersionId}::uuid,
                  ${a.pipelineVersion}, ${a.dispatchGeneration}, ${a.attemptNumber}, ${a.attemptKind}, ${a.taskId}, ${a.taskVersion}, ${a.promptVersion}, ${a.promptHash},
                  ${a.outputSchemaVersion}, ${a.transportSchemaVersion}, ${a.taxonomyVersion}, ${a.confidencePolicyVersion}, ${a.languagePolicyVersion}, ${a.inputContractVersion},
                  ${a.provider}, ${a.modelRequested}, ${a.modelReported}, ${a.startedAt}, ${a.completedAt}, ${a.latencyMs}, ${a.inputChars}, ${a.inputTokens}, ${a.outputTokens},
                  ${a.cachedInputTokens}, ${a.costEstimateUsd}::numeric, ${a.pricingTableVersion}, ${a.outcome}, ${a.failureClass}, ${textArray(a.issueCodes)}::text[],
                  ${a.correlationId}, ${a.triggerRunId}, ${a.createdAt})
          on conflict on constraint ai_attempts_once do nothing`);
        inserted += result.rowCount ?? 0;
      }
      return inserted;
    },

    async recordResult(r) {
      const evidence = r.evidence.length === 0 ? null : r.evidence;
      const result = await tx.execute(sql`
        insert into classification.ai_results (id, organization_id, workspace_id, understanding_request_id, interaction_id, source_text_version_id, pipeline_version,
                                               dispatch_generation, attempt_id, acceptance_mode, provider, model_requested, model_reported, route_fingerprint, task_id,
                                               task_version, prompt_version, prompt_hash, output_schema_version, transport_schema_version, taxonomy_version,
                                               confidence_policy_version, language_policy_version, input_contract_version, summary, evidence_starts, evidence_ends,
                                               correlation_id, trigger_run_id, created_at)
        values (${r.id}::uuid, ${r.organizationId}::uuid, ${r.workspaceId}::uuid, ${r.understandingRequestId}::uuid, ${r.interactionId}::uuid, ${r.sourceTextVersionId}::uuid,
                ${r.pipelineVersion}, ${r.dispatchGeneration}, ${r.attemptId}::uuid, ${r.acceptanceMode}, ${r.provider}, ${r.modelRequested}, ${r.modelReported},
                ${r.routeFingerprint}, ${r.taskId}, ${r.taskVersion}, ${r.promptVersion}, ${r.promptHash}, ${r.outputSchemaVersion}, ${r.transportSchemaVersion},
                ${r.taxonomyVersion}, ${r.confidencePolicyVersion}, ${r.languagePolicyVersion}, ${r.inputContractVersion}, ${r.summary},
                ${evidence === null ? null : intArray(evidence.map((s) => s.start))}::integer[], ${evidence === null ? null : intArray(evidence.map((s) => s.end))}::integer[],
                ${r.correlationId}, ${r.triggerRunId}, ${r.createdAt})
        on conflict on constraint ai_results_once do nothing`);
      return (result.rowCount ?? 0) === 1 ? "inserted" : "exists";
    },

    async recordShadowAssessments(rows) {
      let inserted = 0;
      for (const row of rows) {
        const { assessment: a } = row;
        if (a.method.kind !== "ai") throw new TypeError("shadow_assessment_not_ai");
        const m = a.method;
        const values = a.content.kind === "values" ? a.content.values : null;
        const result = await tx.execute(sql`
          insert into classification.assessments (id, organization_id, workspace_id, interaction_id, source_text_version_id, dimension, origin, outcome, value_keys,
                                                  confidence_levels, confidence_scores, reason_codes, abstention, language_certainty, taxonomy_version, provider, model,
                                                  model_version, task_id, task_version, prompt_version, prompt_hash, schema_version, confidence_policy_version, assessed_at,
                                                  created_at, acceptance_mode, pipeline_version, language_policy_version, ai_result_id)
          values (${a.ref}::uuid, ${row.organizationId}::uuid, ${a.target.workspaceId}::uuid, ${a.target.interactionId}::uuid, ${a.target.sourceTextVersionId}::uuid,
                  ${a.dimension}, 'ai', ${a.content.kind === "values" ? "values" : "abstained"},
                  ${values === null ? null : textArray(values.map((v) => v.key))}::text[],
                  ${values === null ? null : textArray(values.map((v) => v.confidence.level))}::text[],
                  ${values === null ? null : numericArray(values.map((v) => v.confidence.score))}::numeric[],
                  ${textArray(a.content.kind === "values" ? a.content.reasonCodes : [])}::text[],
                  ${a.content.kind === "abstained" ? a.content.abstention : null}, ${a.languageCertainty}, ${a.taxonomyVersion},
                  ${m.provider}, ${m.model}, ${m.modelVersion}, ${m.taskId}, ${m.taskVersion}, ${m.promptVersion}, ${m.promptHash}, ${m.schemaVersion}, ${m.confidencePolicyVersion},
                  ${a.assessedAt}::timestamptz, ${row.createdAt}, 'shadow', ${row.pipelineVersion}, ${row.languagePolicyVersion}, ${row.aiResultId}::uuid)`);
        inserted += result.rowCount ?? 0;
      }
      return inserted;
    },

    async ruleAssessments(target) {
      const rows = await tx.execute<{ id: string; dimension: string; rule_kind: string; rule_version: string; value_keys: string[]; confidence_levels: string[];
        confidence_scores: (string | null)[]; reason_codes: string[]; assessed_at: Date }>(sql`
        select id, dimension, rule_kind, rule_version, value_keys, confidence_levels, confidence_scores::text[] as confidence_scores, reason_codes, assessed_at
          from classification.assessments
         where source_text_version_id = ${target.sourceTextVersionId}::uuid and interaction_id = ${target.interactionId}::uuid and origin = 'rule'
         order by created_at, id`);
      const out: Assessment[] = [];
      for (const row of rows.rows) {
        const assessedAt = parseInstant(new Date(row.assessed_at).toISOString());
        const created = createAssessment({
          ref: row.id,
          target: target as Assessment["target"],
          dimension: row.dimension,
          method: { kind: "rule", rule: row.rule_kind as "link_reputation_malicious", ruleVersion: row.rule_version },
          content: {
            kind: "values",
            values: row.value_keys.map((key, i) => ({ key, confidence: { level: row.confidence_levels[i] as "low" | "medium" | "high", score: row.confidence_scores[i] === null || row.confidence_scores[i] === undefined ? null : Number(row.confidence_scores[i]) } })),
            reasonCodes: row.reason_codes,
          },
          assessedAt,
        });
        // A stored rule row the domain refuses is an impossible invariant (the 0024 checks mirror the domain): fail closed.
        if (!created.ok) throw new Error("classification_rule_assessment_unreadable");
        out.push(created.assessment);
      }
      return Object.freeze(out);
    },

    async staleInFlight(before, limit) {
      const rows = await tx.execute<RequestRow>(sql`
        select ${REQUEST_COLUMNS} from classification.understanding_requests
         where state in ('AI_PENDING', 'AI_RUNNING') and pipeline_version = 'classification.intelligence.v1' and updated_at < ${before}
         order by updated_at, id
         limit ${limit}
         for update skip locked`);
      return Object.freeze(rows.rows.map(toRequest));
    },

    async reserveBudget(r) {
      const rows = await tx.execute<{ reserved: boolean }>(sql`
        select classification.reserve_ai_budget(${r.taskId}, ${r.day}::date, ${r.calls}::integer, ${r.inputChars}::bigint, ${r.maxCalls}::integer, ${r.maxInputChars}::bigint) as reserved`);
      // Anything but an explicit true denies (fail closed).
      return rows.rows[0]?.reserved === true;
    },
  };
}
