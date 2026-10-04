import { describe, expect, it } from "vitest";
import { formatFinding, isExcludedPath, isScannableContent, scanText } from "../../../tools/secret-scan/scan.ts";

/** Synthetic credential-shaped values assembled at runtime: this file never contains a literal secret. */
const synthetic = {
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----",
  anthropic: "sk-" + "ant-" + "a".repeat(32),
  github: "gh" + "p_" + "B".repeat(36),
  supabaseSecret: "sb_" + "secret_" + "c".repeat(24),
  trigger: "tr_" + "dev_" + "D".repeat(24),
  jwt: ["eyJ" + "e".repeat(16), "eyJ" + "f".repeat(16), "g".repeat(16)].join("."),
  credentialUrl: "postgres" + "://app:" + "N0tARealPassw0rd" + "@db.example.test/app",
};

const rulesFor = (file: string, text: string): string[] => scanText(file, text).map((finding) => finding.rule);

describe("secret scan", () => {
  it("detects credential-shaped values", () => {
    expect(rulesFor("a.ts", synthetic.privateKey)).toContain("private-key-block");
    expect(rulesFor("a.ts", `const k = "${synthetic.anthropic}";`)).toContain("anthropic-api-key");
    expect(rulesFor("a.ts", synthetic.github)).toContain("github-token");
    expect(rulesFor("a.ts", synthetic.supabaseSecret)).toContain("supabase-secret-key");
    expect(rulesFor("a.ts", synthetic.trigger)).toContain("trigger-dev-secret-key");
    expect(rulesFor("a.ts", synthetic.jwt)).toContain("jwt");
    expect(rulesFor("a.ts", synthetic.credentialUrl)).toContain("credential-url");
  });

  it("ignores templates and placeholders", () => {
    expect(rulesFor("a.ts", "const url = `postgres://user:${password}@127.0.0.1:5432/db`;")).toEqual([]);
    expect(rulesFor("README.md", "postgres://user:<password>@host/db")).toEqual([]);
    expect(rulesFor("README.md", "postgres://user:[YOUR-PASSWORD]@host/db")).toEqual([]);
    expect(rulesFor("a.ts", "https://example.test/path?x=1")).toEqual([]);
  });

  it("accepts value-free .env.example files and flags sensitive values in them", () => {
    expect(rulesFor(".env.example", "API_KEY=\nDATABASE_URL=\n# comment\nPORT=3000")).toEqual([]);
    expect(rulesFor("spikes/x/.env.example", "SUPABASE_SECRET_KEY=abc123")).toEqual(["env-example-value"]);
  });

  it("flags any real environment file that would be tracked", () => {
    expect(rulesFor(".env", "PORT=3000")).toEqual(["env-file-tracked"]);
    expect(rulesFor("spikes/x/.env.local", "")).toEqual(["env-file-tracked"]);
  });

  it("reports location and rule only, never the matched value", () => {
    const findings = scanText("config/app.ts", `line one\nconst k = "${synthetic.anthropic}";`);
    expect(findings).toEqual([{ file: "config/app.ts", line: 2, rule: "anthropic-api-key" }]);
    const printed = findings.map(formatFinding).join("\n");
    expect(printed).toBe("config/app.ts:2 anthropic-api-key");
    expect(printed).not.toContain(synthetic.anthropic);
  });

  it("skips dependencies, build output and preserved validation evidence", () => {
    expect(isExcludedPath("node_modules/x/index.js")).toBe(true);
    expect(isExcludedPath(".next/server/app.js")).toBe(true);
    expect(isExcludedPath("spikes/ta-q-29-rls/evidence/run.txt")).toBe(true);
    expect(isExcludedPath("spikes/ta-q-29-rls/managed/run-managed.mjs")).toBe(false);
    expect(isExcludedPath("domain/errors/app-error.ts")).toBe(false);
  });

  it("skips binary content", () => {
    expect(isScannableContent(new Uint8Array([104, 105]))).toBe(true);
    expect(isScannableContent(new Uint8Array([104, 0, 105]))).toBe(false);
  });
});
