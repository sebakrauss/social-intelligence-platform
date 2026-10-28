/**
 * Step H6-A1 — static guards around the frozen continuous-ingestion contracts:
 *   - the new module domains (interactions, conversations, coverage, ingestion) stay pure: no I/O, network, URL
 *     handling or evaluation of any kind, and no import beyond the shared kernel and their own domain;
 *   - stored provenance can be issued only by the interactions persistence layer (none exists yet) and is not part of
 *     the module's public API; the provider contract's InteractionTarget is still `listed` only (the `stored` target is
 *     H6-E's, not this gate's);
 *   - the source fact names no transport field; the event module carries no text, author or label;
 *   - the event topic and subject format match the outbox's own CHECKs (read from migration 0004);
 *   - this gate adds no migration (the ledger's last is still 0016) and the design document records the six TL decisions.
 *   - H6-C1: still no migration after 0017; the provisional-conversation model is gone from production code; the
 *     TRAVERSAL_INCOMPLETE reason waits for 0018's CHECK.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COVERAGE_REASONS } from "@/modules/coverage";
import { DEFAULT_MAX_OPERATIONS, INGESTION_CONFLICT_CLASSES, INTERACTIONS_OBSERVED_TOPIC, LIVE_ACCEPTANCE_MAX_OPERATIONS, RECONCILIATION_OPERATIONS_CEILING, defaultBudgetSnapshot } from "@/modules/ingestion";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const MODULES = ["interactions", "conversations", "coverage", "ingestion"] as const;
/** The pure parts: each module's domain folder and its public index (persistence/application are governed by depcruise). */
const DOMAIN_FILES = MODULES.flatMap((m) => sourceFiles([`modules/${m}/domain`, `modules/${m}/index.ts`]));
const raw = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "db", "tools"];

describe("the new module domains are pure and inert", () => {
  it("exist with a public index, a pure domain, and (H6-B) only persistence / application layers besides it", () => {
    for (const m of MODULES) {
      const files = sourceFiles([`modules/${m}`]);
      expect(files, m).toContain(`modules/${m}/index.ts`);
      expect(files.filter((f) => f !== `modules/${m}/index.ts` && !/^modules\/[a-z]+\/(domain|persistence|application)\//.test(f)), m).toEqual([]);
    }
  });

  it("import only the shared kernel and their own domain (and their index only their own domain)", () => {
    for (const file of DOMAIN_FILES) {
      const module = file.split("/")[1] ?? "";
      for (const match of codeOf(file).matchAll(/from\s+"([^"]+)"/g)) {
        const target = match[1] ?? "";
        const allowed = target.startsWith("@/domain/") || target.startsWith("./") || (file.endsWith("index.ts") && target.startsWith("./domain/"));
        expect(allowed, `${file} → ${target}`).toBe(true);
      }
      expect(module).not.toBe("");
    }
  });

  it("have no network, URL, fetch, eval, process or file-system code: links in text stay inert, nothing is fetched", () => {
    for (const file of [...DOMAIN_FILES, "domain/instant.ts", "domain/provider-identity.ts"]) {
      expect(codeOf(file), file).not.toMatch(/\bfetch\s*\(|new URL\(|https?:\/\/|\bXMLHttpRequest\b|\beval\s*\(|new Function\(|\bprocess\.|node:|\brequire\(/);
    }
  });

  it("never route, select a task or a tool from interaction text: no code reads the text's content", () => {
    for (const file of DOMAIN_FILES) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/sourceText\s*\.\s*(includes|match|search|startsWith|endsWith|indexOf|split|toLowerCase|replace)\b/);
      expect(code, file).not.toMatch(/sourceText\s*\)\s*\.\s*(match|test)\b|\.test\(\s*[a-zA-Z.]*sourceText/);
    }
  });
});

describe("stored provenance is issued by persistence only", () => {
  it("the issuer is not in the interactions public API", () => {
    expect(codeOf("modules/interactions/index.ts")).not.toMatch(/issueStoredInteractionAuthority/);
  });

  it("no production file other than the module's own domain (and, later, its persistence layer) imports the issuer", () => {
    const importers = sourceFiles(PRODUCTION).filter((file) => /issueStoredInteractionAuthority/.test(codeOf(file)));
    expect(importers.filter((file) => !file.startsWith("modules/interactions/persistence/"))).toEqual(["modules/interactions/domain/stored-authority.ts"]);
  });

  it("H6-E: the provider contract's InteractionTarget is exactly `listed` | `stored` (the stored kind carries the five stored facts)", () => {
    const target = codeOf("integrations/providers/contract/interaction-target.ts");
    expect(target).toMatch(/export type InteractionTarget =\s+\| \{ readonly kind: "listed"; readonly listed: InteractionDto \}\s+\| \{ readonly kind: "stored"; readonly stored: StoredInteractionProvenance \};/);
    expect(target).toMatch(/export type StoredInteractionProvenance = ListedInteractionProvenance;/);
  });
});

describe("no transport in the fact, no text in the event", () => {
  it("the source fact declares no raw payload, cursor, token, header, URL or SDK field", () => {
    const code = codeOf("modules/interactions/domain/source-fact.ts");
    const declared = [...code.matchAll(/readonly\s+([A-Za-z]+)\s*:/g)].map((m) => m[1] ?? "");
    expect(declared.filter((name) => /raw|payload|cursor|token|header|secret|credential|url|graph|response|body/i.test(name))).toEqual([]);
  });

  it("the event module carries no text, author, label, handle or provider id", () => {
    const code = codeOf("modules/ingestion/domain/events.ts");
    const declared = [...code.matchAll(/readonly\s+([A-Za-z]+)\s*:/g)].map((m) => m[1] ?? "");
    expect(declared.filter((name) => /text|author|label|handle|name|provider/i.test(name) && name !== "sourceTextVersionId")).toEqual([]);
    expect(code).not.toMatch(/UntrustedSocialText|sourceText\b/);
  });

  it("the event topic and subject keys match the outbox's own CHECK expressions (migration 0004)", () => {
    const sql = raw("db/migrations/0004_outbox.sql");
    const topic = /topic\s+text not null check \(topic ~ '([^']+)'\)/.exec(sql)?.[1];
    const key = /e\.key !~ '([^']+)'/.exec(sql)?.[1];
    const dispatch = /dispatch_key\s+text not null unique check \(dispatch_key ~ '([^']+)'\)/.exec(sql)?.[1];
    expect([topic, key, dispatch].every((p) => p !== undefined)).toBe(true);
    expect(new RegExp(topic ?? "^$").test(INTERACTIONS_OBSERVED_TOPIC)).toBe(true);
    for (const subject of ["ingestion_event_id", "interaction_id", "conversation_id", "source_text_version_id"]) expect(new RegExp(key ?? "^$").test(subject), subject).toBe(true);
    expect(new RegExp(dispatch ?? "^$").test(`${INTERACTIONS_OBSERVED_TOPIC}:a8a8a8a8-0000-4000-8000-000000000008`)).toBe(true);
  });
});

describe("H6-C3: the reconciliation runtime boundaries", () => {
  const functionBody = (file: string, name: string): string => codeOf(file).split(`export async function ${name}(`)[1]?.split(/\nexport /)[0] ?? "";

  it("28. the interactions.observed terminal consumer reads identifiers only: no text, provider, credential, AI or workflow", () => {
    const consumer = functionBody("modules/ingestion/application/reconciliation.ts", "acceptObservedInteraction");
    expect(consumer.length).toBeGreaterThan(0);
    const handler = functionBody("jobs/reconciliation.ts", "runInteractionsObserved");
    expect(handler.length).toBeGreaterThan(0);
    const authority = codeOf("modules/ingestion/persistence/store.ts").split("async authority(")[1]?.split("\n    },")[0] ?? "";
    expect(authority.length).toBeGreaterThan(0);
    for (const [label, code] of [["consumer", consumer], ["handler", handler], ["event authority read", authority]] as const) {
      // Identifiers (`sourceTextVersionId`, `source_text_version_id`) are allowed; the text itself never is.
      expect(code, label).not.toMatch(/\bsourceText\b|\bsource_text\b|textVersion\(|sourceTextVersions\.|withCredential|providers|access\.|\bai\b|gateway|workflow|enqueue|appendOutbox|\.emit\(/);
    }
    // The consumer's own file never reaches the credential opener, a provider port or the AI gateway.
    expect(codeOf("jobs/reconciliation.ts")).not.toMatch(/from "\.\/connections"|integrations\/providers|@\/ai\//);
  });

  it("the INTEGRATION slice is the only reconciliation code that reaches a provider; the simulator is never composed there", () => {
    expect(codeOf("jobs/reconciliation-slice.ts")).toMatch(/import \{ composeJobProviders \} from "\.\/connections";/);
    expect(codeOf("jobs/reconciliation-slice.ts")).not.toMatch(/simulator|staging-stub/i);
    expect(codeOf("jobs/trigger/integration/ingestion.ts")).toMatch(/"ingestion\.reconcile_slice"/);
    expect(codeOf("jobs/trigger/main/ingestion.ts")).not.toMatch(/reconcile_slice/);
  });

  it("no provider cursor in an outbox row or job payload: the reconciliation subjects are UUIDs only", () => {
    const store = codeOf("modules/ingestion/persistence/reconciliation-store.ts");
    const subjects = [...store.matchAll(/subjectIds: \{([^}]*)\}/g)].map((match) => match[1] ?? "");
    // H6-E: the confirmation request's row names the account and the canonical interaction (UUIDs) — nothing else.
    expect(subjects).toEqual([" connected_account_id: slice.connectedAccountId, reconciliation_slice_id: slice.id ", " connected_account_id: target.connectedAccountId, interaction_id: target.interactionId "]);
    // H6-C3b: the planner row is the request boundary's (0019), with exactly the two UUID subjects and a hard-coded topic.
    const request = raw("db/migrations/0019_reconciliation_request.sql");
    expect([...request.matchAll(/jsonb_build_object\(([^)]*)\)/g)].map((match) => match[1])).toEqual(["'connected_account_id', v_account::text, 'reconciliation_run_id', v_run::text"]);
    expect(request).toMatch(/v_account\s+uuid;/);
    expect(request).toMatch(/v_run\s+uuid := pg_catalog\.gen_random_uuid\(\);/);
    expect(request).toMatch(/values \(v_outbox, 'ingestion\.reconcile_account', /);
  });
});

describe("H6-C3b: the reconciliation request boundary (0019)", () => {
  const request = raw("db/migrations/0019_reconciliation_request.sql");
  const code = request.replace(/--[^\n]*/g, " ");
  const body = code.slice(code.indexOf("create function ingestion.request_reconciliation("), code.indexOf("end $$;"));

  it("one reviewed SECURITY DEFINER with an empty search_path, owned by app_owner, no PUBLIC execute, no dynamic SQL", () => {
    expect(code).toMatch(/set role app_owner;[\s\S]*create function ingestion\.request_reconciliation\([\s\S]*reset role;/);
    expect(body).toMatch(/language plpgsql volatile security definer set search_path = '' as \$\$/);
    expect(body).not.toMatch(/\bexecute\b|\bformat\(|quote_ident|quote_literal|set_config|set role|current_setting/i);
    expect(code).toMatch(/revoke all on function ingestion\.request_reconciliation\(uuid, text, timestamptz, jsonb\) from public;/);
    expect([...code.matchAll(/grant [^;]*;/g)].map((match) => match[0])).toEqual(["grant execute on function ingestion.request_reconciliation(uuid, text, timestamptz, jsonb) to authenticated, app_worker;"]);
    expect([...code.matchAll(/create (?:or replace )?function ([a-z_.]+)\(/g)].map((match) => match[1])).toEqual(["ingestion.request_reconciliation"]);
  });

  it("the workspace and the role are never parameters: sealed context, verified claims and live membership only", () => {
    expect(body).toMatch(/v_workspace\s+uuid := app\.current_workspace\(\);/);
    expect(body).toMatch(/v_user := app_private\.claimed_user\(\);/);
    expect(body).toMatch(/app\.my_workspace_role\(v_workspace\) is distinct from 'OWNER' and app\.my_workspace_role\(v_workspace\) is distinct from 'ADMIN'/);
    expect(body).toMatch(/if p_budget is not null or p_requested_at is not null then\s+raise exception [^;]* using errcode = '42501';/);
    const parameters = code.slice(code.indexOf("ingestion.request_reconciliation("), code.indexOf(")\nlanguage"));
    expect(parameters).not.toMatch(/workspace|organization|role|initiator|user/);
  });

  it("the SQL defaults are the approved budget snapshot (one semantic source; the web path can't diverge)", () => {
    const snapshot = defaultBudgetSnapshot();
    const declared = (name: string): number => Number(new RegExp(`${name}\\s+integer := (\\d+);`).exec(body)?.[1]);
    expect({
      listingPagesPerSlice: declared("v_listing"),
      interactionPagesPerSlice: declared("v_pages"),
      continuationsPerContent: declared("v_continuations"),
      contentItems: declared("v_items"),
      overlapSeconds: declared("v_overlap"),
      maxOperations: declared("v_max"),
    }).toEqual({
      listingPagesPerSlice: snapshot.listingPagesPerSlice,
      interactionPagesPerSlice: snapshot.interactionPagesPerSlice,
      continuationsPerContent: snapshot.continuationsPerContent,
      contentItems: snapshot.contentItems,
      overlapSeconds: snapshot.overlapSeconds,
      maxOperations: DEFAULT_MAX_OPERATIONS,
    });
    expect(code).toMatch(new RegExp(`check \\(max_operations between 1 and ${String(RECONCILIATION_OPERATIONS_CEILING)}\\)`));
    expect(code).toMatch(/check \(operations_used <= max_operations\)/);
    expect(LIVE_ACCEPTANCE_MAX_OPERATIONS).toBeLessThan(DEFAULT_MAX_OPERATIONS);
    // The cap the runtime reserves against is the persisted column, never a constant of the code.
    const store = codeOf("modules/ingestion/persistence/reconciliation-store.ts");
    expect(store).toMatch(/lt\(reconciliationRuns\.operationsUsed, reconciliationRuns\.maxOperations\)/);
    expect(codeOf("modules/ingestion/application/reconciliation.ts")).not.toMatch(/operationsPerRun|maxOperationsPerRun/);
  });

  it("the TypeScript adapter only calls the boundary: no other code creates a run or its planner row", () => {
    const users = sourceFiles(PRODUCTION).filter((file) => /ingestion\.request_reconciliation\(/.test(codeOf(file)));
    // The adapter, and the function registry that pins its EXECUTE grants.
    expect(users).toEqual(["db/schema/classification.ts", "modules/ingestion/persistence/reconciliation-store.ts"]);
    for (const file of sourceFiles(PRODUCTION)) {
      expect(codeOf(file), file).not.toMatch(/insert\(reconciliationRuns\)|insert into ingestion\.reconciliation_runs/);
    }
    expect(sourceFiles(PRODUCTION).filter((file) => /RECONCILE_ACCOUNT_TOPIC/.test(codeOf(file)) && /appendOutbox|subjectIds:/.test(codeOf(file)))).toEqual([]);
  });

  it("27. no removal detection: 0019 and the runtime never turn absence from a listing into removal (H6-E)", () => {
    expect(code.toLowerCase()).not.toMatch(/removed_at_source|tombstone|removal|deleted_at/);
    for (const file of ["modules/ingestion/application/reconciliation.ts", "modules/ingestion/persistence/reconciliation-store.ts", "jobs/reconciliation.ts", "jobs/reconciliation-slice.ts"]) {
      expect(codeOf(file), file).not.toMatch(/removedAtSource|removed_at_source|tombstone|markRemoved/);
    }
  });
});

describe("scope of this gate", () => {
  it("H6-A1 and H6-C1 added no migration; H6-B adds exactly 0017; 22. H6-C2 adds exactly 0018; H6-C3b exactly 0019; H6-C3d exactly 0020", () => {
    const names = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(names.slice(-5)).toEqual(["0016_capability_replies_not_read.sql", "0017_canonical_source_model.sql", "0018_reconciliation_runtime.sql", "0019_reconciliation_request.sql", "0020_audit_command_provenance.sql"]);
  });

  it("21. 0018 is reconciliation persistence only: no provider-event inbox, raw webhook body, subscription or receipt", () => {
    const sql = raw("db/migrations/0018_reconciliation_runtime.sql").replace(/--[^\n]*/g, " ").toLowerCase();
    expect(sql).not.toMatch(/webhook|inbox|subscription|receipt|raw_body|payload/);
    const created = [...sql.matchAll(/create table ([a-z_]+\.[a-z_]+)/g)].map((match) => match[1]);
    expect(created).toEqual(["ingestion.reconciliation_runs", "ingestion.reconciliation_slices", "ingestion.reconciliation_watermarks", "ingestion.authority_conflicts"]);
    // 0017's canonical model is untouched: no ALTER of a content, interactions or conversations table.
    expect(sql).not.toMatch(/alter table (content|interactions|conversations)\./);
  });

  it("H6-C1 supersedes the provisional conversation: no placeholder anchor, no re-anchoring conflict, no anchor-observed path", () => {
    for (const file of sourceFiles(PRODUCTION)) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/THREAD_ANCHOR_CONFLICT|markAnchorObserved|parentObserved|existingThreadConversation/);
      expect(code, file).not.toMatch(/anchorObserved:\s*false/);
    }
    // A reply never creates a conversation: the only `create` plan is for a top-level comment.
    const plan = codeOf("modules/conversations/domain/conversation.ts");
    expect(plan.match(/kind: "create"/g)?.length).toBe(2); // the type member and the top-level branch
    expect(plan).toMatch(/if \(input\.parentConversation !== null\) return \{ kind: "join"/);
  });

  it("17. 0018's coverage reason CHECK is 0017's plus exactly TRAVERSAL_INCOMPLETE — the domain vocabulary, in order", () => {
    const values = (sql: string, pattern: RegExp): string[] => [...(pattern.exec(sql)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
    const before = values(raw("db/migrations/0017_canonical_source_model.sql"), /reason\s+text not null check \(reason in \(([^)]*)\)\)/);
    const after = values(raw("db/migrations/0018_reconciliation_runtime.sql"), /add constraint coverage_records_reason_check check \(reason in \(([^)]*)\)\)/);
    expect(after).toEqual([...before, "TRAVERSAL_INCOMPLETE"]);
    expect(after).toEqual([...COVERAGE_REASONS]);
  });

  it("16. the conflict vocabulary is the canonical one (identity conflicts + ingestion conflicts), with no THREAD_ANCHOR_CONFLICT", () => {
    const listed = [...(/conflict_class\s+text not null check \(conflict_class in \(([^)]*)\)\)/.exec(raw("db/migrations/0018_reconciliation_runtime.sql"))?.[1] ?? "").matchAll(/'([^']*)'/g)].map((match) => match[1]);
    expect(listed).toEqual([...INGESTION_CONFLICT_CLASSES]);
    expect(listed).not.toContain("THREAD_ANCHOR_CONFLICT");
  });

  it("the H6 design document records the six TL decisions and the ingestion principle", () => {
    const doc = raw("design/h6-ingestion/README.md");
    for (const phrase of [
      "`webhook = signal` · `provider re-read = authority` · `reconciliation = completeness`",
      "| 1 | Persistent `stored` interaction provenance |",
      "| 2 | Author data |",
      "| 3 | Raw webhook inbox retention | **7 days**",
      "| 4 | Coverage is part of H6 |",
      "| 5 | Conversation initial workflow state | `OPEN`",
      "| 6 | Initial historical import |",
      "Social interaction text is untrusted data",
      "No migration in H6-A1",
      "## H6-C1 — deferred conversations (supersedes the H6-B provisional conversation)",
      "A placeholder never anchors a Conversation",
      "`ingestion.reconcile_slice:{slice id}`",
    ]) expect(doc, phrase).toContain(phrase);
  });
});
