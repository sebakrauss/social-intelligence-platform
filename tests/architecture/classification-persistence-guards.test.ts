/**
 * Step H7-A2 — static guards on migration 0024 (classification persistence), run in every CI build without a database:
 *   - VOCABULARY LOCK: every closed list in the SQL equals the pure domain's exported keys (dimensions, taxonomy v1 values
 *     incl. safety.hate_speech, origins, abstentions, confidence levels, risk reason codes, signal kinds, rule kinds and
 *     the versions the CHECKs admit) — SQL can't import TypeScript, so drift fails here;
 *   - scope: no accepted-interpretation / protection / topic / priority / ledger table, no raw model blob, no reasoning,
 *     no copied source text, no watch-term semantic field, no runtime writer of watch terms, no machine write for WEB.
 * The database suite (tests/db/suites/classification-persistence.ts) proves the applied behavior.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ABSTENTIONS,
  AUTHENTICITY_VALUES,
  CONFIDENCE_LEVELS,
  DIMENSIONS,
  INTENT_VALUES,
  RESPONSE_NEED_VALUES,
  RISK_VALUES,
  RULE_ESTABLISHES,
  SAFETY_VALUES,
  SENTIMENT_VALUES,
  SIGNALS_VERSION,
  SIGNAL_KINDS,
  TAXONOMY,
  TAXONOMY_VERSION,
  WATCH_TERM_MATCHER_VERSION,
  type ClosedDimensionDefinition,
} from "@/modules/classification";
import { FUNCTION_EXECUTE, TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { REPOSITORY_ROOT } from "../support/source-scan";

const SQL = readFileSync(path.join(REPOSITORY_ROOT, "db/migrations/0024_classification_persistence.sql"), "utf8");
/** Without `--` comments, whitespace collapsed (keeps quoted literals). */
const CODE = SQL.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
const quoted = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
const checkList = (column: string): string[] => {
  const match = new RegExp(`\\b${column} text(?: not null)? check \\(${column} in \\(([^)]*)\\)\\)`).exec(CODE);
  if (match === null) throw new Error(`no inline CHECK for ${column}`);
  return quoted(match[1] ?? "");
};
/** The literal array a `when '<dimension>' then` branch of the values validator admits. */
const branch = (dimension: string): string => {
  const match = new RegExp(`when '${dimension}' then (.*?)(?= when '| else false)`).exec(CODE);
  if (match === null) throw new Error(`no validator branch for ${dimension}`);
  return match[1] ?? "";
};
const arrayLiteral = (text: string, index = 0): string[] => quoted([...text.matchAll(/array\[([^\]]*)\]/g)][index]?.[1] ?? "");

describe("H7-A2: SQL ↔ domain vocabulary lock (0024)", () => {
  it("dimensions, origins and abstentions", () => {
    expect(checkList("dimension")).toEqual([...DIMENSIONS]);
    expect(checkList("origin")).toEqual(["rule", "ai", "platform_hint", "human"]);
    expect(checkList("abstention")).toEqual([...ABSTENTIONS]);
    expect(checkList("outcome")).toEqual(["values", "abstained"]);
    expect(checkList("language_certainty")).toEqual(["certain", "uncertain"]);
  });

  it("taxonomy v1 values per closed dimension (incl. safety.hate_speech) and the risk reason codes", () => {
    const expected: Readonly<Record<string, readonly string[]>> = { safety: SAFETY_VALUES, authenticity: AUTHENTICITY_VALUES, intent: INTENT_VALUES, sentiment: SENTIMENT_VALUES, risk: RISK_VALUES, response_need: RESPONSE_NEED_VALUES };
    for (const [dimension, values] of Object.entries(expected)) expect(arrayLiteral(branch(dimension)), dimension).toEqual([...values]);
    expect(arrayLiteral(branch("safety"))).toContain("hate_speech");
    expect(arrayLiteral(branch("risk"), 1)).toEqual([...(TAXONOMY.risk as ClosedDimensionDefinition).reasonCodes]);
    for (const dimension of ["safety", "authenticity", "intent", "sentiment", "response_need", "language"]) expect(branch(dimension), dimension).toMatch(/cardinality\(p_reasons\) = 0/);
    // Exclusive values and single cardinality follow the taxonomy.
    expect(branch("safety")).toMatch(/not \('none' = any \(p_keys\)\)/);
    for (const dimension of ["authenticity", "sentiment", "risk", "response_need"]) {
      expect(TAXONOMY[dimension as keyof typeof TAXONOMY].cardinality).toBe("single");
      expect(branch(dimension)).toMatch(/cardinality\(p_keys\) = 1/);
    }
    expect(checkList("taxonomy_version")).toEqual([TAXONOMY_VERSION]);
  });

  it("confidence levels, human authority and the language tag shape", () => {
    expect(CODE).toMatch(new RegExp(`case when p_origin = 'human' then array\\['high'\\] else array\\[${CONFIDENCE_LEVELS.map((l) => `'${l}'`).join(", ")}\\] end`));
    expect(branch("language")).toContain("'^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'");
    expect(branch("language")).toMatch(/cardinality\(p_keys\) <= 4/);
  });

  it("signal kinds and versions; the only rule kind is the narrow malicious-link fact", () => {
    expect(checkList("kind")).toEqual([...SIGNAL_KINDS]);
    expect(checkList("signals_version")).toEqual([SIGNALS_VERSION]);
    expect(checkList("matcher_version")).toEqual([WATCH_TERM_MATCHER_VERSION]);
    expect(checkList("rule_kind")).toEqual(Object.keys(RULE_ESTABLISHES));
    expect(CODE).toMatch(/dimension = 'safety' and rule_kind = 'link_reputation_malicious' and value_keys = array\['malicious_link'\]::text\[\]/);
  });
});

describe("H7-A2: scope of 0024", () => {
  const created = [...CODE.matchAll(/create table ([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]);

  it("creates exactly the five classification tables, all classified", () => {
    expect(created).toEqual(["classification.understanding_requests", "classification.assessments", "classification.watch_term_revisions", "classification.watch_terms", "classification.signals"]);
    for (const table of created) expect(TABLE_CLASSIFICATION[table ?? ""], table).toBeDefined();
    for (const fn of Object.keys(FUNCTION_EXECUTE).filter((name) => name.startsWith("classification."))) expect(CODE, fn).toContain(`create function ${fn.slice(0, fn.indexOf("("))}(`);
  });

  it("no accepted-interpretation, protection, topic, priority/value, ledger or attempt persistence (derived or later-owned)", () => {
    expect(CODE).not.toMatch(/create table [a-z_.]*(accepted|protection|needs_review|topic|priority|value_score|valuable|ledger|attempt|cost)/);
  });

  it("no raw model blob, prompt, reasoning, copied source text or author data", () => {
    const columns = CODE.toLowerCase();
    expect(columns).not.toMatch(/\b(raw_response|raw_request|response_body|request_body|prompt_text|rendered_prompt|reasoning|chain_of_thought|thinking|source_text|comment_text|author_name|handle|username|access_token|api_key)\b/);
  });

  it("watch terms carry no semantic field and have no runtime writer; signals have no semantic column", () => {
    const watch = /create table classification\.watch_terms \((.*?)\);/.exec(CODE)?.[1] ?? "";
    const signals = /create table classification\.signals \((.*?)\); create unique index/.exec(CODE)?.[1] ?? "";
    for (const body of [watch, signals]) expect(body).not.toMatch(/\b(dimension|value_keys|category|priority|intent|safety_value|protection|regex|wildcard|stem|escalat|moderat)\b/);
    expect(CODE).not.toMatch(/(policy \w+ on classification\.watch_term[a-z_]* for (insert|update|delete|all))|(grant [^;]*(insert|update|delete)[^;]* on classification\.watch_term)/);
  });

  it("append-only: no UPDATE or DELETE grant or policy on assessments, signals or watch terms", () => {
    expect(CODE).not.toMatch(/on classification\.(assessments|signals|watch_terms|watch_term_revisions) for (update|delete|all)/);
    expect(CODE).not.toMatch(/grant [^;]*(update|delete)[^;]* on classification\.(assessments|signals|watch_terms|watch_term_revisions)/);
    for (const table of ["classification.assessments", "classification.signals", "classification.watch_terms", "classification.watch_term_revisions"]) {
      expect(TABLE_CLASSIFICATION[table]?.class).toBe("append_only_history");
    }
  });

  it("WEB (authenticated) may only write human corrections, as itself, with workflow.internal roles (D-H7-6; TA §10.3)", () => {
    expect(CODE).toMatch(/create policy member_correct on classification\.assessments for insert to authenticated with check \(workspace_id = \(select app\.current_workspace\(\)\) and origin = 'human' and actor_user_id = \(select auth\.uid\(\)\) and app\.my_workspace_role\(workspace_id\) in \('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER'\)\);/);
    expect(CODE).toMatch(/create policy worker_append on classification\.assessments for insert to app_worker with check \(workspace_id = \(select app\.current_workspace\(\)\) and origin <> 'human'\);/);
    expect([...CODE.matchAll(/to authenticated with check/g)]).toHaveLength(1);
  });

  it("every reference is composite with the workspace (R5), and every table cascades from its workspace", () => {
    for (const fk of CODE.matchAll(/foreign key \(([^)]*)\) references ([a-z_.]+) \(([^)]*)\)/g)) {
      expect(fk[1]?.split(",")[0]?.trim(), fk[0]).toMatch(/^(workspace_id|organization_id)$/);
    }
    expect([...CODE.matchAll(/references tenancy\.workspaces \(organization_id, id\) on delete cascade/g)]).toHaveLength(created.length);
  });
});
