/**
 * WORKFLOW-WF-2C — the reconciliation CLI's arguments and target fence (pure): DRY RUN unless --apply; the database URL
 * comes from a NAMED environment variable; in this gate only a loopback host passes; nothing unexpected is accepted;
 * a refusal never echoes the URL.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRuntimeDatabase } from "@/platform/db/pool";
import { DEV_RECONCILE_CONFIRMATION, describeReconcileTarget, parseReconcileCommand, reconcileTargetProblems } from "@/tools/ops/workflow-reconcile-command";

const WS = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

describe("workflow reconciliation CLI", () => {
  it("defaults: a dry run, batches of 100, from the start, until the end", () => {
    expect(parseReconcileCommand(["--database-url-env", "LOCAL_WORKER_URL", "--workspace", WS])).toEqual({
      ok: true,
      command: { databaseUrlEnv: "LOCAL_WORKER_URL", workspaceId: WS, target: "loopback", apply: false, batchSize: 100, after: null, maxBatches: undefined, runCorrelationId: undefined },
    });
    const resumed = parseReconcileCommand(["--database-url-env", "LOCAL_WORKER_URL", "--workspace", WS, "--batch", "25", "--after", WS, "--max-batches", "3", "--run", "workflow-reconcile.abc-123", "--apply"]);
    expect(resumed.ok && resumed.command).toMatchObject({ apply: true, batchSize: 25, after: WS, maxBatches: 3, runCorrelationId: "workflow-reconcile.abc-123" });
  });

  it("refuses anything unexpected before connecting", () => {
    for (const args of [
      [],
      ["--workspace", WS],
      ["--database-url-env", "local_url", "--workspace", WS],
      ["--database-url-env", "LOCAL_URL", "--workspace", "WS"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS.toUpperCase()],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--batch", "0"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--batch", "501"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--after", "x"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--max-batches", "0"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--run", "other.123456"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--apply", "--apply"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--target", "production"],
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--force"],
      ["--database-url-env", "--workspace", WS],
    ]) expect(parseReconcileCommand(args).ok, args.join(" ")).toBe(false);
  });

  it("without --target, only a loopback database passes the fence (unchanged since WF-2C); the refusal never contains the URL", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(reconcileTargetProblems(`postgres://worker:secret@${host}:5432/app`), host).toEqual([]);
    for (const url of [
      "postgres://worker:secret@aws-0-sa-east-1.pooler.supabase.com:6543/postgres",
      "postgres://worker:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
      "postgres://worker:secret@10.0.0.5:5432/app",
      "postgres://worker:secret@127.0.0.1.example.com:5432/app",
    ]) {
      const problems = reconcileTargetProblems(url);
      expect(problems.length, url).toBe(1);
      expect(problems.join(" ")).not.toMatch(/secret|supabase|10\.0\.0\.5|example/);
    }
    expect(reconcileTargetProblems(undefined)).toEqual(["the named environment variable is not set"]);
    expect(reconcileTargetProblems("not a url")).toEqual(["the named environment variable is not a PostgreSQL URL"]);
  });

  // ── RELEASE-TOOLING-01: the explicit development target ───────────────────────────────────────────────────────────
  // Synthetic identities only: a made-up 20-character project reference whose digest is INJECTED as the pin, so the
  // real development reference is never needed (nor committed), and the real pin is proven NOT to match it.
  const DEV_REF = "syntheticdevref00001";
  const OTHER_REF = "syntheticprodref0002";
  const PIN = createHash("sha256").update(DEV_REF, "utf8").digest("hex");
  const PASSWORD = "s3cret-Passw0rd";
  const devUrl = (over: { readonly user?: string; readonly host?: string; readonly port?: number; readonly database?: string; readonly query?: string } = {}) =>
    `postgres://${over.user ?? `worker_login.${DEV_REF}`}:${PASSWORD}@${over.host ?? "aws-0-sa-east-1.pooler.supabase.com"}:${String(over.port ?? 6543)}/${over.database ?? "postgres"}${over.query ?? ""}`;
  const CA = { DATABASE_SSL_ROOT_CERT_PEM: "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n" };
  const dev = (url: string | undefined, env: Readonly<Record<string, string | undefined>> = CA, pin: string = PIN) => reconcileTargetProblems(url, "development", env, pin);
  const devArgs = ["--target", "development", "--database-url-env", "DATABASE_WORKER_URL", "--workspace", WS];

  it("the development target is chosen explicitly; there is no production or other remote target", () => {
    const parsed = parseReconcileCommand(devArgs);
    expect(parsed.ok && parsed.command).toMatchObject({ target: "development", apply: false, databaseUrlEnv: "DATABASE_WORKER_URL" });
    expect(parseReconcileCommand([...devArgs.slice(2), "--target", "loopback"]).ok).toBe(true);
    for (const target of ["production", "staging", "preview", "remote", "DEVELOPMENT", "dev"]) {
      const refused = parseReconcileCommand(["--target", target, ...devArgs.slice(2)]);
      expect(refused.ok, target).toBe(false);
      expect(!refused.ok && refused.problem).toMatch(/no production or other remote target/);
    }
    expect(parseReconcileCommand([...devArgs, "--target", "development"]).ok).toBe(false); // repeated
    expect(parseReconcileCommand([...devArgs.slice(2), "--allow-remote"]).ok).toBe(false);
  });

  it("writing to the development target needs --apply AND the exact confirmation phrase; a dry run is the default", () => {
    expect(parseReconcileCommand(devArgs)).toMatchObject({ ok: true, command: { apply: false } });
    expect(parseReconcileCommand([...devArgs, "--apply", "--confirm-dev-reconcile", DEV_RECONCILE_CONFIRMATION])).toMatchObject({ ok: true, command: { apply: true, target: "development" } });
    for (const args of [
      [...devArgs, "--apply"], // no phrase
      [...devArgs, "--apply", "--confirm-dev-reconcile", `${DEV_RECONCILE_CONFIRMATION}x`], // typo
      [...devArgs, "--apply", "--confirm-dev-reconcile", "yes"],
      [...devArgs, "--confirm-dev-reconcile", DEV_RECONCILE_CONFIRMATION], // a dry run carrying the phrase
      ["--database-url-env", "LOCAL_URL", "--workspace", WS, "--apply", "--confirm-dev-reconcile", DEV_RECONCILE_CONFIRMATION], // loopback
      [...devArgs, "--apply", "--confirm-dev-reconcile"], // phrase missing
    ]) expect(parseReconcileCommand(args).ok, args.join(" ")).toBe(false);
    // The loopback target keeps its WF-2C behaviour: --apply alone writes to a disposable local cluster.
    expect(parseReconcileCommand(["--database-url-env", "LOCAL_URL", "--workspace", WS, "--apply"])).toMatchObject({ ok: true, command: { apply: true, target: "loopback" } });
  });

  it("the development fence accepts exactly the pinned project's worker login through the sa-east-1 transaction pooler, with a CA", () => {
    expect(dev(devUrl())).toEqual([]);
    expect(dev(devUrl({ host: "aws-1-sa-east-1.pooler.supabase.com" }))).toEqual([]);
    expect(dev(devUrl(), { DATABASE_SSL_ROOT_CERT: "/path/to/ca.pem" })).toEqual([]);
    // A declared identity is honoured when it is the development one.
    expect(dev(devUrl(), { ...CA, DATABASE_ENVIRONMENT_CLASS: "development", DATABASE_EXPECTED_PROJECT_REF: DEV_REF, DATABASE_EXPECTED_REGION: "sa-east-1" })).toEqual([]);
  });

  it("the development fence refuses every mismatched or ambiguous identity, before anything connects", () => {
    const cases: readonly (readonly [string, readonly string[], RegExp])[] = [
      ["another project (e.g. production)", dev(devUrl({ user: `worker_login.${OTHER_REF}` })), /pinned social-intelligence-dev-v2/],
      ["the committed pin never matches a synthetic project", reconcileTargetProblems(devUrl(), "development", CA), /pinned social-intelligence-dev-v2/],
      ["session pooler (5432)", dev(devUrl({ port: 5432 })), /transaction pooler/],
      ["direct host", dev(devUrl({ user: "worker_login", host: `db.${DEV_REF}.supabase.co`, port: 5432 })), /transaction pooler/],
      ["another region", dev(devUrl({ host: "aws-0-us-east-1.pooler.supabase.com" })), /development region/],
      ["privileged login", dev(devUrl({ user: `postgres.${DEV_REF}` })), /worker_login runtime login/],
      ["another runtime's login", dev(devUrl({ user: `web_login.${DEV_REF}` })), /worker_login runtime login/],
      ["service role", dev(devUrl({ user: `service_role.${DEV_REF}` })), /worker_login runtime login/],
      ["another database", dev(devUrl({ database: "other" })), /database must be postgres/],
      ["an unknown host", dev(devUrl({ host: "db.example.com" })), /transaction pooler/],
      ["a pooler look-alike", dev(devUrl({ host: "aws-0-sa-east-1.pooler.supabase.com.example.com" })), /transaction pooler/],
      ["a user without a project reference", dev(devUrl({ user: "worker_login" })), /pinned social-intelligence-dev-v2/],
      ["a local database", dev("postgres://worker_login:secret@127.0.0.1:5432/postgres"), /not the development target/],
      ["no CA", dev(devUrl(), {}), /CA certificate/],
      ["an empty CA", dev(devUrl(), { DATABASE_SSL_ROOT_CERT_PEM: "  ", DATABASE_SSL_ROOT_CERT: "" }), /CA certificate/],
      ["a declared production identity", dev(devUrl(), { ...CA, DATABASE_ENVIRONMENT_CLASS: "production", DATABASE_EXPECTED_PROJECT_REF: OTHER_REF, DATABASE_EXPECTED_REGION: "sa-east-1" }), /non-development database identity/],
      ["production naming the development project", dev(devUrl(), { ...CA, DATABASE_ENVIRONMENT_CLASS: "production", DATABASE_EXPECTED_PROJECT_REF: DEV_REF }), /incomplete or invalid/],
      ["a partial identity", dev(devUrl(), { ...CA, DATABASE_EXPECTED_PROJECT_REF: DEV_REF }), /incomplete or invalid/],
      ["a development identity naming another project", dev(devUrl(), { ...CA, DATABASE_ENVIRONMENT_CLASS: "development", DATABASE_EXPECTED_PROJECT_REF: OTHER_REF }), /does not belong to the expected development database project/],
      ["no variable", dev(undefined), /not set/],
      ["not a URL", dev("worker_login@somewhere"), /not a PostgreSQL URL/],
    ];
    for (const [label, problems, expected] of cases) {
      expect(problems.length, label).toBeGreaterThan(0);
      expect(problems.join(" | "), label).toMatch(expected);
      // A refusal never echoes the password, a project reference, a host or the URL.
      expect(problems.join(" "), label).not.toMatch(new RegExp(`${PASSWORD}|${DEV_REF}|${OTHER_REF}|pooler\\.supabase|example\\.com|127\\.0\\.0\\.1|postgres://`));
    }
    // Without --target the development URL is still refused (no inference from the URL).
    expect(reconcileTargetProblems(devUrl())).toEqual(["only a loopback (local, disposable) database is allowed without --target development; the target was refused"]);
  });

  it("the printed target names the project label and login only — never a URL, host, reference or credential", () => {
    const parsed = parseReconcileCommand(devArgs);
    if (!parsed.ok) throw new Error(parsed.problem);
    const line = describeReconcileTarget(parsed.command);
    expect(line).toBe("development — social-intelligence-dev-v2 via the transaction pooler as worker_login, sa-east-1 (from DATABASE_WORKER_URL)");
    expect(line).not.toMatch(/postgres:|supabase\.com|syntheticdev/);
  });

  it("TLS is enforced by construction: URL options cannot turn it off; the runtime pool verifies the CA (rejectUnauthorized)", async () => {
    const worker = createRuntimeDatabase("worker", devUrl({ query: "?sslmode=disable&options=-c%20role%3Dpostgres" }), { max: 1, sslRootCert: CA.DATABASE_SSL_ROOT_CERT_PEM });
    try {
      const options = (worker.pool as unknown as { readonly options: { readonly ssl: unknown; readonly user: string; readonly database: string } }).options;
      expect(options.ssl).toEqual({ ca: CA.DATABASE_SSL_ROOT_CERT_PEM, rejectUnauthorized: true });
      expect(options.user).toBe(`worker_login.${DEV_REF}`);
      expect(options).not.toHaveProperty("options");
    } finally {
      await worker.end(); // never connected: a pg pool connects lazily
    }
    expect(() => createRuntimeDatabase("worker", devUrl(), { max: 1 })).toThrow(/CA certificate/);
  });
});
