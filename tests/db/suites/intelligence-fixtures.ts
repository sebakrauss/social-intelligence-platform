/**
 * Step H7-D1c — synthetic intelligence-persistence rows for the database suites (0025): one understanding request of the
 * `classification.intelligence.v1` pipeline in an AI state, one accepted attempt and one validated result for a text
 * version. Written by the privileged test login (no runtime writer exists yet); identifiers and versions only.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export const INTELLIGENCE_PIPELINE = "classification.intelligence.v1";
export const LANGUAGE_POLICY = "language-policy.v1";
const HASH = "c177c6f36c77337645d2cc9f45628f80bd2fbeddd8f5ac2a418ac97ae2c9b7bf";
const FINGERPRINT = "76e0ca1f5478239fe0cb11df2994071f1a20825c12fc90c3c82e6d53f1d4b53b";

export interface AiTarget {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly interaction: string;
  readonly version: string;
}

export interface AiChain {
  readonly requestId: string;
  readonly attemptId: string;
  readonly resultId: string;
}

/** The attempt row's columns in insert order (values for one accepted initial attempt). */
export const attemptColumns = (t: AiTarget, requestId: string, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  id: randomUUID(), organization_id: t.organizationId, workspace_id: t.workspaceId, understanding_request_id: requestId, interaction_id: t.interaction,
  source_text_version_id: t.version, pipeline_version: INTELLIGENCE_PIPELINE, dispatch_generation: 1, attempt_number: 1, attempt_kind: "initial",
  task_id: "classification.understanding", task_version: "understanding-task.v2", prompt_version: "understanding-prompt.v2", prompt_hash: HASH,
  output_schema_version: "understanding-output.v1", transport_schema_version: "anthropic-transport-schema.v2", taxonomy_version: "taxonomy.v1",
  confidence_policy_version: "confidence.v1", language_policy_version: LANGUAGE_POLICY, input_contract_version: "understanding-input.v1",
  provider: "anthropic", model_requested: "claude-sonnet-5-5", model_reported: "claude-sonnet-5-5", started_at: "2026-10-31T12:00:00Z",
  completed_at: "2026-10-31T12:00:01Z", latency_ms: 1000, input_chars: 4200, input_tokens: 1300, output_tokens: 220, cached_input_tokens: 0,
  cost_estimate_usd: null, pricing_table_version: null, outcome: "accepted", failure_class: null, issue_codes: [], correlation_id: "corr-h7-d1c-fixture",
  trigger_run_id: "run_h7d1c_fixture", created_at: "2026-10-31T12:00:01Z", ...overrides,
});

export const resultColumns = (t: AiTarget, requestId: string, attemptId: string, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  id: randomUUID(), organization_id: t.organizationId, workspace_id: t.workspaceId, understanding_request_id: requestId, interaction_id: t.interaction,
  source_text_version_id: t.version, pipeline_version: INTELLIGENCE_PIPELINE, dispatch_generation: 1, attempt_id: attemptId, acceptance_mode: "shadow",
  provider: "anthropic", model_requested: "claude-sonnet-5-5", model_reported: "claude-sonnet-5-5", route_fingerprint: FINGERPRINT,
  task_id: "classification.understanding", task_version: "understanding-task.v2", prompt_version: "understanding-prompt.v2", prompt_hash: HASH,
  output_schema_version: "understanding-output.v1", transport_schema_version: "anthropic-transport-schema.v2", taxonomy_version: "taxonomy.v1",
  confidence_policy_version: "confidence.v1", language_policy_version: LANGUAGE_POLICY, input_contract_version: "understanding-input.v1",
  summary: "Queja por el precio.", evidence_starts: [0], evidence_ends: [5], correlation_id: "corr-h7-d1c-fixture", trigger_run_id: "run_h7d1c_fixture",
  created_at: "2026-10-31T12:00:02Z", ...overrides,
});

/** A parameterized INSERT of one row (column order from the object). */
export function insertRow(table: string, row: Readonly<Record<string, unknown>>): { readonly text: string; readonly values: unknown[] } {
  const columns = Object.keys(row);
  return { text: `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${String(i + 1)}`).join(", ")}) returning id`, values: Object.values(row) };
}

/** An AI_RUNNING intelligence request (generation 1) for the version. */
export async function insertAiRequest(privileged: pg.Pool, t: AiTarget, state = "AI_RUNNING"): Promise<string> {
  const id = randomUUID();
  await privileged.query(
    `insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state, ai_generation,
                                                       ai_failure_class, created_at, updated_at, completed_at)
     values ($1, $2, $3, $4, $5, $6, 'realtime', $7, 1, $8, now(), now(), $9)`,
    [id, t.organizationId, t.workspaceId, t.interaction, t.version, INTELLIGENCE_PIPELINE, state, state === "AI_FAILED" ? "AI_UNAVAILABLE" : null, ["COMPLETED", "AI_FAILED"].includes(state) ? new Date() : null]);
  return id;
}

/** Request → accepted attempt → validated (shadow) result for one text version. */
export async function insertAiChain(privileged: pg.Pool, t: AiTarget): Promise<AiChain> {
  const requestId = await insertAiRequest(privileged, t);
  const attempt = insertRow("classification.ai_attempts", attemptColumns(t, requestId));
  const attemptId = (await privileged.query<{ id: string }>(attempt.text, attempt.values)).rows[0]?.id ?? "";
  const result = insertRow("classification.ai_results", resultColumns(t, requestId, attemptId));
  const resultId = (await privileged.query<{ id: string }>(result.text, result.values)).rows[0]?.id ?? "";
  return { requestId, attemptId, resultId };
}
