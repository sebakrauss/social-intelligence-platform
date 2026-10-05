/**
 * Static database guards that run in every CI build without a database (TA §64–§65; R1, R4, R8; F-S6).
 *
 *   migration lint     — no destructive statements, no session-level context, no passwords, every table
 *                        classified with RLS enabled AND forced, every SECURITY DEFINER pinned to an
 *                        empty search_path, nothing granted to anon/service_role/PUBLIC/login roles;
 *   F-S6 role guard    — no file in the repository drops, renames or terminates pooled login roles;
 *   credential guard   — no service-role key anywhere in runtime configuration, and the privileged
 *                        migration URL is read only by migration/provisioning tooling and tests.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { readMigrations } from "@/tools/db/migrations";

const root = path.resolve(import.meta.dirname, "../..");
const FIXTURE = "tests/db/support/t26-fixture.sql";

function repositoryFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((file) => file !== "" && !file.startsWith("spikes/") && !file.startsWith("docs/") && !/\.(zip|png|jpg|ico|woff2?)$/.test(file));
}

function read(file: string): string {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return "";
  }
}

/** SQL without comments, lowercased, whitespace collapsed. */
const normalize = (text: string): string =>
  text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();

const sqlSources = (): { name: string; sql: string }[] => [
  ...readMigrations().map((migration) => ({ name: migration.name, sql: normalize(migration.sql) })),
  { name: FIXTURE, sql: normalize(read(FIXTURE)) },
];

describe("migration lint", () => {
  it("contains no destructive or lifecycle-unsafe statements", () => {
    const forbidden: [RegExp, string][] = [
      [/\bdrop\s+(table|column|schema|role|user|owned|database|function|policy|trigger|index|view|type)\b/, "DROP"],
      [/\btruncate\b/, "TRUNCATE"],
      [/\brename\s+(to|column)\b/, "RENAME"],
      [/\balter\s+table\s+\S+\s+(alter\s+column\s+\S+\s+type|drop)\b/, "column narrowing"],
      [/\bdisable\s+row\s+level\s+security\b|\bno\s+force\s+row\s+level\s+security\b/, "RLS weakening"],
      [/\bbypassrls\b(?![^;]*\bnobypassrls\b)/, "BYPASSRLS grant"],
      [/\bpassword\b/, "password in SQL"],
      [/set_config\([^)]*,\s*false\s*\)/, "session-level set_config"],
      [/(^|;|\$\$|then|begin)\s*set\s+(?!local\b|role\s+app_owner\b|search_path)/, "session-level SET"],
      [/(^|;)\s*(begin|commit|rollback)\s*;/, "transaction control (the runner owns transactions)"],
      [/\bpg_terminate_backend\b/, "backend termination"],
    ];
    for (const source of sqlSources()) {
      for (const [pattern, label] of forbidden) {
        expect(pattern.test(source.sql), `${source.name}: ${label}`).toBe(false);
      }
    }
  });

  it("grants nothing to anon, service_role, PUBLIC or the login roles", () => {
    for (const source of sqlSources()) {
      const grants = source.sql.match(/\bgrant\b[^;]*;/g) ?? [];
      for (const grant of grants) {
        const recipients = grant.replace(/^.*\bto\b/, "");
        expect(/\b(anon|service_role|public|web_login|worker_login|system_login|postgres)\b/.test(recipients), `${source.name}: ${grant}`).toBe(false);
      }
    }
  });

  it("classifies every created table and enables AND forces RLS on it", () => {
    for (const source of sqlSources()) {
      for (const match of source.sql.matchAll(/create table (?:if not exists )?([a-z_]+\.[a-z_]+)/g)) {
        const table = match[1] ?? "";
        expect(Object.keys(TABLE_CLASSIFICATION), `${source.name}: ${table} is unclassified`).toContain(table);
        expect(source.sql.includes(`alter table ${table} enable row level security`), `${source.name}: ${table} RLS not enabled`).toBe(true);
        expect(source.sql.includes(`alter table ${table} force row level security`), `${source.name}: ${table} RLS not forced`).toBe(true);
      }
    }
  });

  it("pins every SECURITY DEFINER function to an empty search_path", () => {
    for (const source of sqlSources()) {
      for (const match of source.sql.matchAll(/create function ([a-z_]+\.[a-z_]+)\(.*?\bas \$\$/g)) {
        const header = match[0];
        if (header.includes("security definer")) expect(header, `${source.name}: ${match[1] ?? ""}`).toContain("set search_path = ''");
      }
    }
  });

  it("switches roles only to fixed literals", () => {
    for (const source of sqlSources()) {
      for (const match of source.sql.matchAll(/set (?:local )?role ([^;']+)/g)) {
        expect(["app_owner"], `${source.name}: set role ${match[1] ?? ""}`).toContain((match[1] ?? "").trim());
      }
    }
    const scopes = read("platform/db/scopes.ts") + read("platform/db/system-scope.ts");
    const switches = [...scopes.matchAll(/set local role ([a-z_]+)/g)].map((match) => match[1]);
    expect(switches.sort()).toEqual(["app_system", "app_worker", "authenticated"]);
    expect(scopes).not.toMatch(/set local role \$\{/);
  });
});

describe("F-S6 / R8 guard: pooled login roles are never torn down", () => {
  // Built from parts so this file does not match itself.
  const drop = ["dr", "op"].join("");
  const patterns: [RegExp, string][] = [
    [new RegExp(`\\b${drop}\\s+(role|user)\\b`, "i"), "role drop"],
    [new RegExp(`\\b${drop}\\s+owned\\b`, "i"), "drop owned"],
    [new RegExp(`\\breassign\\s+owned\\b`, "i"), "reassign owned"],
    [new RegExp(`\\balter\\s+(role|user)\\s+\\S+\\s+rename\\b`, "i"), "role rename"],
    [new RegExp(["pg_", "terminate_backend"].join(""), "i"), "backend termination"],
    [new RegExp(`\\b${drop}Role\\b|\\bteardownRoles?\\b`, "i"), "role teardown helper"],
  ];

  it("no script, migration, test or tool contains role teardown", () => {
    const self = path.relative(root, import.meta.filename);
    for (const file of repositoryFiles()) {
      if (file === self || !/\.(ts|tsx|js|mjs|cjs|sql|json|ya?ml|sh)$/.test(file)) continue;
      const text = read(file);
      for (const [pattern, label] of patterns) {
        expect(pattern.test(text), `${file}: ${label}`).toBe(false);
      }
    }
  });
});

describe("database test runs report failures", () => {
  // embedded-postgres installs an exit hook that calls process.exit(0) on `beforeExit`, which masks a failing
  // Vitest run's exit code. It may only be loaded by the cluster child process, never by a test process.
  it("only the local cluster child process loads embedded-postgres", () => {
    const self = path.relative(root, import.meta.filename);
    const sources = repositoryFiles().filter((file) => file !== self);
    const loaders = sources.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && /from\s+["']embedded-postgres["']/.test(read(file)));
    expect(loaders).toEqual(["tests/db/support/local-cluster.ts"]);
    const clusterImporters = sources.filter((file) => /\.(ts|tsx)$/.test(file) && /from\s+["']\.\/local-cluster(\.ts)?["']|support\/local-cluster/.test(read(file)));
    expect(clusterImporters).toEqual(["tests/db/support/cluster-process.ts"]);
  });
});

describe("privileged credentials stay out of runtime", () => {
  const files = repositoryFiles();
  const runtime = files.filter((file) => /^(app|ui|server|domain|modules|platform|db|jobs|integrations|ai|mutations)\//.test(file) || file === "proxy.ts");

  it("no service-role key is configured or referenced anywhere outside guards and docs", () => {
    const serviceKey = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
    for (const file of [...runtime, ".env.example", ...files.filter((name) => name.startsWith(".github/") || name.startsWith("tools/"))]) {
      expect(read(file).includes(serviceKey), file).toBe(false);
    }
  });

  it("the migration URL is read only by migration/provisioning tooling and database tests", () => {
    const variable = ["DATABASE", "MIGRATION", "URL"].join("_");
    const readers = files.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && read(file).includes(variable));
    for (const file of readers) {
      expect(/^(tools\/db|tests)\//.test(file), file).toBe(true);
    }
    for (const file of runtime) expect(read(file).includes(variable), file).toBe(false);
  });

  it("runtime code never connects as a privileged role and creates pools only in platform/db", () => {
    for (const file of runtime.filter((name) => /\.(ts|tsx)$/.test(name))) {
      const text = read(file);
      if (!file.startsWith("platform/db/")) {
        expect(/new\s+(pg\.)?(Pool|Client)\s*\(/.test(text), `${file}: constructs a database client`).toBe(false);
        expect(/from\s+["']pg["']/.test(text), `${file}: imports the pg driver`).toBe(false);
        expect(/drizzle-orm\/node-postgres/.test(text), `${file}: imports the Drizzle connection constructor`).toBe(false);
      }
    }
  });

  it(".env.example lists variable names only", () => {
    for (const line of read(".env.example").split("\n")) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      expect(line, "value present in .env.example").toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
  });
});
