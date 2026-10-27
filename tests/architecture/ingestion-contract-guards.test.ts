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
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INTERACTIONS_OBSERVED_TOPIC } from "@/modules/ingestion";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const MODULES = ["interactions", "conversations", "coverage", "ingestion"] as const;
const DOMAIN_FILES = MODULES.flatMap((m) => sourceFiles([`modules/${m}`]));
const raw = (relative: string): string => readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");
const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "db", "tools"];

describe("the new module domains are pure and inert", () => {
  it("exist with a public index and a domain folder only (no persistence, application or jobs yet)", () => {
    for (const m of MODULES) {
      const files = sourceFiles([`modules/${m}`]);
      expect(files, m).toContain(`modules/${m}/index.ts`);
      expect(files.filter((f) => f !== `modules/${m}/index.ts` && !f.startsWith(`modules/${m}/domain/`)), m).toEqual([]);
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

  it("the provider contract's InteractionTarget is unchanged: `listed` only (the `stored` kind is H6-E's)", () => {
    expect(codeOf("integrations/providers/contract/interaction-target.ts")).toMatch(/export type InteractionTarget = \{ readonly kind: "listed"; readonly listed: InteractionDto \};/);
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

describe("scope of this gate", () => {
  it("adds no migration: the last migration is still 0016", () => {
    const names = readdirSync(path.join(REPOSITORY_ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(names.at(-1)).toBe("0016_capability_replies_not_read.sql");
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
    ]) expect(doc, phrase).toContain(phrase);
  });
});
