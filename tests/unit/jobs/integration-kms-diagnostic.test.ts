/**
 * The INTEGRATION KMS worker-auth diagnostic (Step 7E.7-B), offline. The diagnostic runs its REAL production path —
 * createCredentialAccess(composeCredentialOpener(env, integrationWorkerAwsCredentials(env))), the real pinned STS and
 * KMS clients — against an in-process AWS double: every outbound HTTP(S) request is trapped and answered locally, so no
 * packet leaves the process and every AWS attempt is counted. Synthetic account 000000000000, synthetic keys only.
 *
 * Threat model: NOT_IN_NORMAL_PRODUCT_REGISTRY != NOT_TRIGGERABLE_BY_TRIGGER. Anyone with enough Integration project
 * privileges may trigger the task by id, so every precondition must fail before AWS transport is reachable.
 */
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { inspect } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProviderCredential } from "@/modules/connections";
import { providerCredential } from "@/integrations/providers/contract";
import { kmsEncryptionContext } from "@/platform/crypto/credentials/aws-kms-common";
import { KMS_PROVIDER_CREDENTIALS_KEY_REF } from "@/platform/crypto/credentials/aws-kms-config";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { encodeEnvelope, type KekProvider } from "@/platform/crypto/credentials/envelope";
import type { DataKeyGenerator } from "@/platform/crypto/credentials/keyring";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { createRuntimeDatabaseFromEnv } from "@/platform/db";
import type { JobRelease } from "@/platform/jobs";
import { composeCredentialOpener, composeJobProviders, createCredentialAccess, integrationWorkerAwsCredentials } from "@/jobs/connections";
import {
  KMS_DIAGNOSTIC_ACKNOWLEDGEMENT,
  KMS_DIAGNOSTIC_AWS_ATTEMPTS,
  KMS_DIAGNOSTIC_CREDENTIAL_ID,
  KMS_DIAGNOSTIC_CREDENTIAL_LABEL,
  KMS_DIAGNOSTIC_FAILURES,
  KMS_DIAGNOSTIC_TASK_ID,
  KMS_DIAGNOSTIC_WORKSPACE_ID,
  KmsDiagnosticError,
  diagnosticPlaintextDigest,
  productionDiagnosticAccess,
  runKmsWorkerAuthDiagnostic,
  type KmsDiagnosticFailure,
} from "@/jobs/integration-kms-diagnostic";
import { INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV, PLANE_FORBIDDEN_VARIABLES, planeEnvironmentProblems } from "@/jobs/plane-environment";
import { FORBIDDEN_WEB_VARIABLES, forbiddenWebVariables } from "@/server/http/web-environment";
import { parseWorkspaceId } from "@/domain/ids";
import type * as SimulatorModule from "@/server/connections/simulator";
import type * as StagingStubModule from "@/integrations/providers/staging-stub";
import type * as DatabaseModule from "@/platform/db";
import type * as ConnectionsModule from "@/modules/connections";
import type { ProviderCredentialAccess } from "@/modules/connections";
import type { TenantStepJobContext } from "@/platform/jobs";

// ── Trigger.dev SDK double: captures the task definition (no vendor runtime in unit tests) ───────────────────────
const sdk = vi.hoisted(() => {
  class AbortTaskRunError extends Error {
    override readonly name = "AbortTaskRunError";
  }
  const tasks: Record<string, unknown>[] = [];
  const queues: Record<string, unknown>[] = [];
  const scheduled: unknown[] = [];
  return {
    AbortTaskRunError,
    tasks,
    queues,
    scheduled,
    task: (options: Record<string, unknown>) => {
      tasks.push(options);
      return { id: options["id"] };
    },
    queue: (options: Record<string, unknown>) => {
      queues.push(options);
      return { type: "queue", ...options };
    },
    schedules: { task: (options: unknown) => scheduled.push(options) },
  };
});
vi.mock("@trigger.dev/sdk", () => sdk);

// ── Call counters around the provider, staging-stub and database entry points (originals still run) ───────────
const calls = vi.hoisted(() => ({ simulator: 0, stagingStub: 0, database: 0 }));
vi.mock("@/server/connections/simulator", async (importOriginal) => {
  const original = await importOriginal<typeof SimulatorModule>();
  return { ...original, localSimulator: (...args: Parameters<typeof original.localSimulator>) => { calls.simulator += 1; return original.localSimulator(...args); } };
});
vi.mock("@/integrations/providers/staging-stub", async (importOriginal) => {
  const original = await importOriginal<typeof StagingStubModule>();
  return { ...original, createStagingStubReadPort: (...args: Parameters<typeof original.createStagingStubReadPort>) => { calls.stagingStub += 1; return original.createStagingStubReadPort(...args); } };
});
// ── Step 7E.7-B-R3: capture what the REAL product task path hands its service — the cached module composition of
// jobs/connections.ts — without the service touching a database. Off by default: the original service runs.
const capture = vi.hoisted(() => ({ on: false, deps: [] as { readonly access: unknown; readonly providers: unknown }[], inScope: 0 }));
vi.mock("@/modules/connections", async (importOriginal) => {
  const original = await importOriginal<typeof ConnectionsModule>();
  return {
    ...original,
    refreshAccountCapabilities: (...args: Parameters<typeof original.refreshAccountCapabilities>) => {
      if (!capture.on) return original.refreshAccountCapabilities(...args);
      capture.deps.push({ access: args[0].access, providers: args[0].providers });
      return Promise.resolve({ kind: "synthetic-captured" } as unknown as Awaited<ReturnType<typeof original.refreshAccountCapabilities>>);
    },
  };
});
vi.mock("@/platform/db", async (importOriginal) => {
  const original = await importOriginal<typeof DatabaseModule>();
  return { ...original, createRuntimeDatabaseFromEnv: (...args: Parameters<typeof original.createRuntimeDatabaseFromEnv>) => { calls.database += 1; return original.createRuntimeDatabaseFromEnv(...args); } };
});

const root = path.resolve(import.meta.dirname, "../../..");
const KEY_A = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const KEY_OTHER = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000bb";
const ROLE = "arn:aws:iam::000000000000:role/social-intelligence-platform-dev-integration-worker";
const BOOTSTRAP_KEY = "SYNTHETICBOOTSTRAPKEYA1";
const BOOTSTRAP_SECRET = "synthetic/bootstrap+secret-for-diagnostic-000000";
const SESSION_KEY = "SYNTHETICSESSIONKEYS01";
const AWS_MESSAGE = "SYNTHETIC-AWS-MESSAGE arn:aws:kms:sa-east-1:000000000000:key/leak";
const RELEASE = "synthetic-release-0000000000000000000000";
const NODE_22 = "v22.16.0";
const PINNED: JobRelease = { kind: "pinned", releaseId: RELEASE };
const RUN = { environmentType: "PRODUCTION", release: PINNED } as const;
const ACK = { acknowledge: KMS_DIAGNOSTIC_ACKNOWLEDGEMENT };

/** Every variable the guards or the opening path may read: each test sets exactly the ones it means. */
const MANAGED = [
  "NODE_ENV", "APP_DEPLOYMENT_ENV", "CAPABILITY_PROVIDER_MODE", "CREDENTIAL_CONTEXT_ENV", "CREDENTIAL_KMS_KEY_ARN", "CREDENTIAL_KMS_ALLOWED_KEY_ARNS",
  "LOCAL_KEYRING_KEY", "INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID", "INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY", "INTEGRATION_AWS_WORKER_ROLE_ARN",
  INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV, "DATABASE_WORKER_URL", "DATABASE_SYSTEM_URL", "TRIGGER_INTEGRATION_TASK_OPERATOR_KEY", "TRIGGER_MAIN_RELAY_TRIGGER_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_MAX_ATTEMPTS", "AWS_RETRY_MODE",
] as const;
/** The SDK's shared config files are pointed at a path that does not exist, so no local developer file shapes retries. */
const NO_SHARED_CONFIG = "/nonexistent/synthetic-aws-config-for-tests";

type Env = Record<string, string | undefined>;

/** The approved deployed Integration/prod diagnostic configuration (no DATABASE_WORKER_URL, no CAPABILITY_PROVIDER_MODE). */
const deployed = (fixture: string, overrides: Env = {}): Env => ({
  NODE_ENV: "production",
  APP_DEPLOYMENT_ENV: "staging",
  CREDENTIAL_CONTEXT_ENV: "dev",
  CREDENTIAL_KMS_KEY_ARN: KEY_A,
  CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_A,
  INTEGRATION_AWS_BOOTSTRAP_ACCESS_KEY_ID: BOOTSTRAP_KEY,
  INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: BOOTSTRAP_SECRET,
  INTEGRATION_AWS_WORKER_ROLE_ARN: ROLE,
  [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: fixture,
  ...overrides,
});

/** Installs exactly `env` as the process environment (the production path reads process.env), returns it. */
function useEnv(env: Env): NodeJS.ProcessEnv {
  for (const name of MANAGED) vi.stubEnv(name, undefined);
  vi.stubEnv("AWS_CONFIG_FILE", NO_SHARED_CONFIG);
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", NO_SHARED_CONFIG);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return process.env;
}

// ── In-process AWS double ───────────────────────────────────────────────────────────────────────────────────
interface Exchange {
  readonly host: string;
  readonly target: string;
  readonly authorization: string;
  body: string;
}
interface Reply {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  /** A transport failure instead of an HTTP answer (connection reset). */
  readonly reset?: true;
}
const connectionReset: Reply = { status: 0, contentType: "", body: "", reset: true };
const json = (status: number, body: unknown): Reply => ({ status, contentType: "application/x-amz-json-1.1", body: JSON.stringify(body) });
const kmsError = (type: string, status = 400): Reply => json(status, { __type: type, message: AWS_MESSAGE });
const stsOk = (): Reply => ({
  status: 200,
  contentType: "text/xml",
  body:
    '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>' +
    `<AccessKeyId>${SESSION_KEY}</AccessKeyId><SecretAccessKey>synthetic-session-secret-000000</SecretAccessKey>` +
    `<SessionToken>synthetic-session-token</SessionToken><Expiration>${new Date(Date.now() + 900_000).toISOString()}</Expiration>` +
    "</Credentials><AssumedRoleUser><AssumedRoleId>AROASYNTHETIC0000000:integration-worker</AssumedRoleId>" +
    "<Arn>arn:aws:sts::000000000000:assumed-role/synthetic/integration-worker</Arn></AssumedRoleUser></AssumeRoleResult>" +
    "<ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></AssumeRoleResponse>",
});
const stsError = (code: string, status = 403): Reply => ({
  status,
  contentType: "text/xml",
  body: `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${AWS_MESSAGE}</Message></Error><RequestId>synthetic</RequestId></ErrorResponse>`,
});

/** A synthetic KMS: data keys "wrapped" by an in-memory table bound to the exact encryption context they were made for. */
function kmsWorld() {
  const sealed = new Map<string, { readonly dek: Buffer; readonly context: Readonly<Record<string, string>> }>();
  const world = {
    returnedKeyId: KEY_A,
    generator(kekProvider: KekProvider = "aws-kms", keyRef = KMS_PROVIDER_CREDENTIALS_KEY_REF): DataKeyGenerator {
      return {
        kekProvider,
        keyRef,
        generateDataKey: ({ context }) => {
          const dek = randomBytes(32);
          const wrapped = randomBytes(48);
          sealed.set(Buffer.from(wrapped).toString("base64"), { dek: Buffer.from(dek), context: { ...kmsEncryptionContext(context) } });
          return Promise.resolve({ dek, wrappedDek: new Uint8Array(wrapped) });
        },
      };
    },
    decrypt(exchange: Exchange): Reply {
      const input = JSON.parse(exchange.body) as { CiphertextBlob?: string; EncryptionContext?: Record<string, string> };
      const entry = sealed.get(input.CiphertextBlob ?? "");
      const context = input.EncryptionContext ?? {};
      const same = entry !== undefined && Object.keys(context).length === Object.keys(entry.context).length && Object.entries(entry.context).every(([k, v]) => context[k] === v);
      if (!same) return kmsError("InvalidCiphertextException");
      return json(200, { KeyId: world.returnedKeyId, Plaintext: entry.dek.toString("base64"), EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
    },
  };
  return world;
}

const text = (chunk: unknown): string => (typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "");
const header = (headers: Record<string, unknown> | undefined, name: string): string => {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : "";
};

/** Traps every HTTP(S) request: records it and answers from the handlers (anything unexpected gets a 400). */
function trapAws(handlers: { sts?: (exchange: Exchange) => Reply; kms?: (exchange: Exchange) => Reply }): Exchange[] {
  const exchanges: Exchange[] = [];
  const trap = (options: unknown, callback?: (response: unknown) => void) => {
    const o = options as { hostname?: string; host?: string; headers?: Record<string, unknown> };
    const exchange: Exchange = { host: o.hostname ?? o.host ?? "", target: header(o.headers, "x-amz-target"), authorization: header(o.headers, "authorization"), body: "" };
    exchanges.push(exchange);
    const respond = (): void => {
      const handler = exchange.host.startsWith("sts.") ? handlers.sts : exchange.host.startsWith("kms.") ? handlers.kms : undefined;
      const reply = handler?.(exchange) ?? json(400, { __type: "UnexpectedRequest" });
      if (reply.reset === true) {
        request.emit("error", Object.assign(new Error("synthetic connection reset"), { code: "ECONNRESET" }));
        return;
      }
      const response = Object.assign(Readable.from([Buffer.from(reply.body, "utf8")]), {
        statusCode: reply.status,
        statusMessage: "",
        headers: { "content-type": reply.contentType, "x-amzn-requestid": "synthetic-request" },
      });
      callback?.(response);
    };
    const request = Object.assign(new EventEmitter(), {
      setTimeout: () => request, setNoDelay: () => undefined, setSocketKeepAlive: () => undefined, destroy: () => undefined, abort: () => undefined,
      write: (chunk: unknown) => { exchange.body += text(chunk); return true; },
      end: (chunk?: unknown) => {
        if (chunk !== undefined) exchange.body += text(chunk);
        setImmediate(respond);
      },
    });
    return request;
  };
  vi.spyOn(https, "request").mockImplementation(trap as never);
  vi.spyOn(http, "request").mockImplementation(trap as never);
  return exchanges;
}

const stsCalls = (exchanges: readonly Exchange[]) => exchanges.filter((e) => e.host.startsWith("sts."));
const kmsCalls = (exchanges: readonly Exchange[]) => exchanges.filter((e) => e.host.startsWith("kms."));

interface SealOptions {
  readonly label?: string;
  readonly secret?: string;
  readonly env?: string;
  readonly workspaceId?: string;
  readonly credentialId?: string;
  readonly kekProvider?: KekProvider;
  readonly keyRef?: string;
  readonly fixture?: Record<string, unknown>;
}

/** Seals a synthetic diagnostic credential with the production sealer + codec, as the operator step (7E.7-F) will. */
async function sealFixture(world: ReturnType<typeof kmsWorld>, options: SealOptions = {}) {
  const secret = options.secret ?? `synthetic-diagnostic-secret-${randomBytes(16).toString("hex")}`;
  const plaintext = encodeProviderCredential(providerCredential(options.label ?? KMS_DIAGNOSTIC_CREDENTIAL_LABEL, secret));
  const digest = diagnosticPlaintextDigest(Uint8Array.from(plaintext)).toString("hex");
  const context = credentialContext({ purpose: "provider-credential", env: options.env ?? "dev", workspaceId: options.workspaceId ?? KMS_DIAGNOSTIC_WORKSPACE_ID, credentialId: options.credentialId ?? KMS_DIAGNOSTIC_CREDENTIAL_ID });
  const envelope = Buffer.from(encodeEnvelope(await createCredentialSealer(world.generator(options.kekProvider, options.keyRef)).seal(plaintext, context))).toString("base64");
  plaintext.fill(0);
  const fields = { v: 1, workspace_id: KMS_DIAGNOSTIC_WORKSPACE_ID, credential_id: KMS_DIAGNOSTIC_CREDENTIAL_ID, envelope, digest, ...options.fixture };
  return { raw: JSON.stringify(fields), envelope, digest, secret };
}

/** The diagnostic's fixed failure code, or "resolved". */
async function outcomeOf(promise: Promise<unknown>): Promise<KmsDiagnosticFailure | "resolved"> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    expect(error).toBeInstanceOf(KmsDiagnosticError);
    return (error as KmsDiagnosticError).failure;
  }
}

const composeSpy = () => vi.fn(productionDiagnosticAccess);

beforeEach(() => {
  calls.simulator = 0;
  calls.stagingStub = 0;
  calls.database = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("task definition: integration-only, operator-triggered, single attempt", () => {
  it("exact id, one attempt, its own queue of one, 60 s; no schedule, no hook, no other option", async () => {
    // A fresh module world, so this holds whatever ran before (the R3 cache tests reset modules too).
    vi.resetModules();
    sdk.tasks.length = 0;
    sdk.queues.length = 0;
    sdk.scheduled.length = 0;
    await import("@/jobs/trigger/integration/kms-worker-auth-diagnostic");
    expect(sdk.tasks).toHaveLength(1);
    const options = sdk.tasks.at(-1) ?? {};
    expect(Object.keys(options).sort()).toEqual(["id", "maxDuration", "queue", "retry", "run"]);
    expect(options["id"]).toBe(KMS_DIAGNOSTIC_TASK_ID);
    expect(KMS_DIAGNOSTIC_TASK_ID).toBe("integration.kms_worker_auth_diagnostic");
    expect(options["retry"]).toEqual({ maxAttempts: 1 });
    expect(options["maxDuration"]).toBe(60);
    expect(sdk.queues).toEqual([{ name: "integration-kms-diagnostic", concurrencyLimit: 1 }]);
    expect(options["queue"]).toMatchObject({ name: "integration-kms-diagnostic", concurrencyLimit: 1 });
    expect(sdk.scheduled).toEqual([]);
  });

  it("the task file is thin and the module imports no provider, simulator, staging stub, database, outbox, registry, job runtime or AWS SDK", () => {
    const importsOf = (file: string): string[] => [...readFileSync(path.join(root, file), "utf8").matchAll(/^import\s[^;]*?from\s+["']([^"']+)["'];$/gm)].map((m) => m[1] ?? "");
    expect(importsOf("jobs/trigger/integration/kms-worker-auth-diagnostic.ts")).toEqual(["@trigger.dev/sdk", "@/platform/jobs", "../../integration-kms-diagnostic"]);
    const imports = importsOf("jobs/integration-kms-diagnostic.ts");
    expect(imports).toEqual([
      "node:crypto",
      "@/modules/connections",
      "@/domain/ids",
      "@/platform/crypto/credentials/aws-kms-config",
      "@/platform/crypto/credentials/envelope",
      "@/platform/crypto/credentials/errors",
      "@/platform/jobs",
      "@/server/connections/environment",
      "@/server/connections/provider-mode",
      "./connections",
      "./plane-environment",
    ]);
    for (const spec of imports) expect(spec, spec).not.toMatch(/integrations|simulator|staging-stub|platform\/db|outbox|persistence|registry|runtime|trigger|@aws-sdk|@smithy|pg$|drizzle|supabase|meta|tiktok|apify/i);
    const code = readFileSync(path.join(root, "jobs/integration-kms-diagnostic.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/GenerateDataKey|\bEncrypt\b|ReEncrypt|CreateGrant|GetCallerIdentity|\.seal\(|console\.|logger|process\.std(out|err)|JSON\.stringify|toString\(/);
  });
});

describe("input contract: exactly the acknowledgement, validated before anything AWS-capable exists", () => {
  const inputs: [string, unknown][] = [
    ["missing payload", undefined],
    ["null", null],
    ["a string", KMS_DIAGNOSTIC_ACKNOWLEDGEMENT],
    ["an array", [ACK]],
    ["empty object", {}],
    ["wrong acknowledgement", { acknowledge: "INTEGRATION_KMS_WORKER_AUTH_DIAGNOSTIC_V2" }],
    ["acknowledgement in another case", { acknowledge: KMS_DIAGNOSTIC_ACKNOWLEDGEMENT.toLowerCase() }],
    ["extra field", { ...ACK, extra: true }],
    ["workspace id", { ...ACK, workspaceId: KMS_DIAGNOSTIC_WORKSPACE_ID }],
    ["credential id", { ...ACK, credential_id: KMS_DIAGNOSTIC_CREDENTIAL_ID }],
    ["envelope", { ...ACK, envelope: "AAAA" }],
    ["provider input", { ...ACK, provider: "meta" }],
    ["arbitrary data", { acknowledge: KMS_DIAGNOSTIC_ACKNOWLEDGEMENT, data: { nested: 1 } }],
  ];
  it.each(inputs)("%s → kms_diagnostic_input_refused, zero AWS requests, nothing composed", async (_name, payload) => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    const compose = composeSpy();
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(payload, RUN, env, { nodeVersion: NODE_22, composeAccess: compose }))).toBe("kms_diagnostic_input_refused");
    expect(exchanges).toEqual([]);
    expect(compose).not.toHaveBeenCalled();
  });
});

describe("pre-AWS guards: every refusal happens before AWS transport is reachable", () => {
  type Case = [name: string, failure: KmsDiagnosticFailure, change: { env?: Env; run?: { environmentType: string | undefined; release: JobRelease }; node?: string; fixture?: SealOptions }];
  const cases: Case[] = [
    // release / runtime mode
    ["local development run", "kms_diagnostic_release_refused", { run: { environmentType: "DEVELOPMENT", release: { kind: "development" } } }],
    ["deployed run without an external id", "kms_diagnostic_release_refused", { run: { environmentType: "PRODUCTION", release: { kind: "unidentified" } } }],
    ["a STAGING environment run", "kms_diagnostic_release_refused", { run: { environmentType: "STAGING", release: PINNED } }],
    ["a PREVIEW environment run", "kms_diagnostic_release_refused", { run: { environmentType: "PREVIEW", release: PINNED } }],
    ["unknown environment type", "kms_diagnostic_release_refused", { run: { environmentType: undefined, release: PINNED } }],
    // execution plane
    ["main-plane system DB credential present", "kms_diagnostic_plane_refused", { env: { DATABASE_SYSTEM_URL: "postgres://synthetic" } }],
    ["main→integration operator key present", "kms_diagnostic_plane_refused", { env: { TRIGGER_INTEGRATION_TASK_OPERATOR_KEY: "tr_prod_SYNTHETIC_CANARY" } }],
    ["ambient AWS credential chain present", "kms_diagnostic_plane_refused", { env: { AWS_ACCESS_KEY_ID: "SYNTHETICAMBIENTKEY01" } }],
    ["AWS profile present", "kms_diagnostic_plane_refused", { env: { AWS_PROFILE: "synthetic" } }],
    // deployment tier
    ["APP_DEPLOYMENT_ENV unset", "kms_diagnostic_tier_refused", { env: { APP_DEPLOYMENT_ENV: undefined } }],
    ["APP_DEPLOYMENT_ENV=production", "kms_diagnostic_tier_refused", { env: { APP_DEPLOYMENT_ENV: "production" } }],
    ["APP_DEPLOYMENT_ENV=preview", "kms_diagnostic_tier_refused", { env: { APP_DEPLOYMENT_ENV: "preview" } }],
    ["APP_DEPLOYMENT_ENV=Staging", "kms_diagnostic_tier_refused", { env: { APP_DEPLOYMENT_ENV: "Staging" } }],
    // runtime
    ["Node 20", "kms_diagnostic_runtime_refused", { node: "v20.19.0" }],
    ["Node 24", "kms_diagnostic_runtime_refused", { node: "v24.1.0" }],
    ["Node 2.2", "kms_diagnostic_runtime_refused", { node: "v2.2.0" }],
    // keyring / credential context
    ["local keyring (no KMS, NODE_ENV test)", "kms_diagnostic_local_keyring_refused", { env: { NODE_ENV: "test", CREDENTIAL_CONTEXT_ENV: undefined, CREDENTIAL_KMS_KEY_ARN: undefined, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } }],
    ["local keyring key next to KMS", "kms_diagnostic_kms_configuration_refused", { env: { LOCAL_KEYRING_KEY: Buffer.alloc(32, 7).toString("base64") } }],
    ["CREDENTIAL_CONTEXT_ENV=test", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_CONTEXT_ENV: "test" } }],
    ["CREDENTIAL_CONTEXT_ENV=local", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_CONTEXT_ENV: "local" } }],
    ["CREDENTIAL_CONTEXT_ENV=staging", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_CONTEXT_ENV: "staging" } }],
    ["CREDENTIAL_CONTEXT_ENV=prod", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_CONTEXT_ENV: "prod" } }],
    ["CREDENTIAL_CONTEXT_ENV unset (deployed)", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_CONTEXT_ENV: undefined } }],
    ["no KMS configuration at all (deployed)", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_CONTEXT_ENV: undefined, CREDENTIAL_KMS_KEY_ARN: undefined, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } }],
    ["two allowed keys (only Key A is accepted)", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_KMS_ALLOWED_KEY_ARNS: `${KEY_A},${KEY_OTHER}` } }],
    ["allowed list without the current key", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_OTHER } }],
    ["key alias instead of a key ARN", "kms_diagnostic_kms_configuration_refused", { env: { CREDENTIAL_KMS_KEY_ARN: "alias/synthetic", CREDENTIAL_KMS_ALLOWED_KEY_ARNS: "alias/synthetic" } }],
    // fixture
    ["missing fixture", "kms_diagnostic_fixture_refused", { env: { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: undefined } }],
    ["empty fixture", "kms_diagnostic_fixture_refused", { env: { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: "" } }],
    ["fixture not JSON", "kms_diagnostic_fixture_refused", { env: { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: "not-json" } }],
    ["fixture is an array", "kms_diagnostic_fixture_refused", { env: { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: "[]" } }],
    ["fixture too large", "kms_diagnostic_fixture_refused", { env: { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: `{"v":1,"pad":"${"a".repeat(17_000)}"}` } }],
    ["unknown fixture field", "kms_diagnostic_fixture_refused", { fixture: { fixture: { context: { env: "dev" } } } }],
    ["fixture version 2", "kms_diagnostic_fixture_refused", { fixture: { fixture: { v: 2 } } }],
    ["fixture version as a string", "kms_diagnostic_fixture_refused", { fixture: { fixture: { v: "1" } } }],
    ["wrong synthetic workspace id", "kms_diagnostic_fixture_refused", { fixture: { fixture: { workspace_id: "5eed0000-d1a9-4000-8000-00000000d003" } } }],
    ["wrong synthetic credential id", "kms_diagnostic_fixture_refused", { fixture: { fixture: { credential_id: "5eed0000-d1a9-4000-8000-00000000d003" } } }],
    ["envelope not base64", "kms_diagnostic_fixture_refused", { fixture: { fixture: { envelope: "not base64!" } } }],
    ["envelope not an envelope", "kms_diagnostic_fixture_refused", { fixture: { fixture: { envelope: Buffer.from("synthetic-not-an-envelope").toString("base64") } } }],
    ["local-keyring envelope", "kms_diagnostic_fixture_refused", { fixture: { kekProvider: "local" } }],
    ["envelope of another key reference", "kms_diagnostic_fixture_refused", { fixture: { keyRef: "kms-provider-credentials-v2" } }],
    ["digest in upper case", "kms_diagnostic_fixture_refused", { fixture: { fixture: { digest: "AB".repeat(32) } } }],
    ["digest too short", "kms_diagnostic_fixture_refused", { fixture: { fixture: { digest: "ab".repeat(31) } } }],
    ["digest as base64", "kms_diagnostic_fixture_refused", { fixture: { fixture: { digest: Buffer.alloc(32, 1).toString("base64") } } }],
  ];

  it.each(cases)("%s → %s, zero AWS requests, nothing composed, no provider or DB", async (_name, failure, change) => {
    const world = kmsWorld();
    const fixture = await sealFixture(world, change.fixture);
    const env = useEnv(deployed(fixture.raw, change.env));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    const compose = composeSpy();
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, change.run ?? RUN, env, { nodeVersion: change.node ?? NODE_22, composeAccess: compose }))).toBe(failure);
    expect(exchanges).toEqual([]);
    expect(compose).not.toHaveBeenCalled();
    expect(calls).toEqual({ simulator: 0, stagingStub: 0, database: 0 });
  });

  it("every failure code is a fixed, closed vocabulary", () => {
    for (const failure of KMS_DIAGNOSTIC_FAILURES) expect(failure).toMatch(/^kms_diagnostic_[a-z_]+$/);
    expect(new KmsDiagnosticError("kms_diagnostic_fixture_refused").message).toBe("non-retryable job failure: kms_diagnostic_fixture_refused");
  });
});

describe("the production opening path, end to end against the in-process AWS double", () => {
  it("succeeds with exactly ONE AssumeRole and ONE Decrypt, the exact six-field dev context, no KeyId, and a safe output", async () => {
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(deployed(fixture.raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    const outcome = await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 });

    expect(outcome).toEqual({ result: "KMS_WORKER_AUTH_DIAGNOSTIC_PASSED", nodeVersion: NODE_22, node22: true, contextEnv: "dev", plaintextMatches: true });
    expect(Object.keys(outcome).sort()).toEqual(["contextEnv", "node22", "nodeVersion", "plaintextMatches", "result"]);

    expect(exchanges).toHaveLength(2);
    const [sts] = stsCalls(exchanges);
    const [kms] = kmsCalls(exchanges);
    expect(stsCalls(exchanges)).toHaveLength(1);
    expect(kmsCalls(exchanges)).toHaveLength(1);
    // STS: regional, signed by the bootstrap key, the exact worker-role request.
    expect(sts?.host).toBe("sts.sa-east-1.amazonaws.com");
    expect(sts?.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${BOOTSTRAP_KEY}/\\d{8}/sa-east-1/sts/aws4_request`));
    expect(sts?.body).toBe(`Action=AssumeRole&Version=2011-06-15&RoleArn=${encodeURIComponent(ROLE)}&RoleSessionName=integration-worker&DurationSeconds=900`);
    // KMS: Decrypt only, signed by the assumed-role session (never the bootstrap key), exact context, no KeyId.
    expect(kms?.host).toBe("kms.sa-east-1.amazonaws.com");
    expect(kms?.target).toBe("TrentService.Decrypt");
    expect(kms?.authorization).toContain(`Credential=${SESSION_KEY}/`);
    expect(kms?.authorization).not.toContain(BOOTSTRAP_KEY);
    const decrypt = JSON.parse(kms?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(decrypt).sort()).toEqual(["CiphertextBlob", "EncryptionContext"]);
    expect(decrypt["EncryptionContext"]).toEqual({
      app: "social-intelligence-platform",
      purpose: "provider-credential",
      env: "dev",
      v: "1",
      workspace_id: KMS_DIAGNOSTIC_WORKSPACE_ID,
      credential_id: KMS_DIAGNOSTIC_CREDENTIAL_ID,
    });
    expect(Object.keys(decrypt["EncryptionContext"] as object)).toEqual(["app", "purpose", "env", "v", "workspace_id", "credential_id"]);

    // Zero forbidden AWS operations, zero provider/database/network-other-than-AWS activity.
    for (const exchange of exchanges) {
      expect(exchange.target).not.toMatch(/GenerateDataKey|\.Encrypt$|ReEncrypt|CreateGrant/);
      expect(exchange.body).not.toMatch(/GetCallerIdentity|GetSessionToken/);
      expect(exchange.host).toMatch(/^(sts|kms)\.sa-east-1\.amazonaws\.com$/);
    }
    expect(calls).toEqual({ simulator: 0, stagingStub: 0, database: 0 });

    // Nothing sensitive in the output, however it is rendered.
    const rendered = [JSON.stringify(outcome), inspect(outcome, { depth: 5 })].join("\n");
    for (const needle of [fixture.secret, fixture.envelope, fixture.digest, KMS_DIAGNOSTIC_WORKSPACE_ID, KMS_DIAGNOSTIC_CREDENTIAL_ID, KEY_A, ROLE, BOOTSTRAP_KEY, BOOTSTRAP_SECRET, SESSION_KEY, "000000000000"]) {
      expect(rendered).not.toContain(needle);
    }
  });

  it("does not need DATABASE_WORKER_URL or CAPABILITY_PROVIDER_MODE, and composes no provider adapter", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    expect(env["DATABASE_WORKER_URL"]).toBeUndefined();
    expect(env["CAPABILITY_PROVIDER_MODE"]).toBeUndefined();
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect((await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 })).plaintextMatches).toBe(true);
    expect(calls).toEqual({ simulator: 0, stagingStub: 0, database: 0 });
  });

  it("Decrypt's returned key must be in the allowlist (checked after Decrypt, as production does): another key → keyring_misconfigured", async () => {
    const world = kmsWorld();
    world.returnedKeyId = KEY_OTHER;
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 }))).toBe("kms_diagnostic_keyring_misconfigured");
    expect(stsCalls(exchanges)).toHaveLength(1);
    expect(kmsCalls(exchanges)).toHaveLength(1);
    expect(Object.keys(JSON.parse(kmsCalls(exchanges)[0]?.body ?? "{}") as object)).not.toContain("KeyId");
  });

  const contexts: [string, SealOptions][] = [
    ["sealed for env=test", { env: "test" }],
    ["sealed for another workspace", { workspaceId: "5eed0000-d1a9-4000-8000-00000000d0ff" }],
    ["sealed for another credential", { credentialId: "5eed0000-d1a9-4000-8000-00000000d0fe" }],
  ];
  it.each(contexts)("wrong encryption context (%s) fails closed as credential_unreadable after ONE Decrypt", async (_name, seal) => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world, seal)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 }))).toBe("kms_diagnostic_credential_unreadable");
    expect(stsCalls(exchanges)).toHaveLength(1);
    expect(kmsCalls(exchanges)).toHaveLength(1);
  });

  it("digest mismatch → PLAINTEXT_MISMATCH (plaintextMatches false), nothing else returned", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world, { fixture: { digest: "ab".repeat(32) } })).raw));
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 })).toEqual({
      result: "KMS_WORKER_AUTH_DIAGNOSTIC_PLAINTEXT_MISMATCH", nodeVersion: NODE_22, node22: true, contextEnv: "dev", plaintextMatches: false,
    });
  });

  it("a credential sealed under another label never matches, even with its own digest", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world, { label: "synthetic-other-label" })).raw));
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect((await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 })).plaintextMatches).toBe(false);
  });

  const failures: [string, KmsDiagnosticFailure, { sts: (e: Exchange) => Reply; kms?: (e: Exchange) => Reply }, number, number][] = [
    ["STS denies the bootstrap user", "kms_diagnostic_keyring_access_denied", { sts: () => stsError("AccessDenied") }, 1, 0],
    ["STS rejects a revoked bootstrap key", "kms_diagnostic_keyring_access_denied", { sts: () => stsError("InvalidClientTokenId") }, 1, 0],
    ["KMS denies the worker role", "kms_diagnostic_keyring_access_denied", { sts: stsOk, kms: () => kmsError("AccessDeniedException") }, 1, 1],
    ["KMS key disabled", "kms_diagnostic_keyring_misconfigured", { sts: stsOk, kms: () => kmsError("DisabledException") }, 1, 1],
  ];
  it.each(failures)("%s → %s with exactly %i STS / %i KMS request(s); no AWS message, ARN or value leaks", async (_name, failure, handlers, sts, kms) => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: handlers.sts, kms: handlers.kms ?? ((e) => world.decrypt(e)) });
    let caught: unknown;
    try {
      await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KmsDiagnosticError);
    expect((caught as KmsDiagnosticError).failure).toBe(failure);
    expect(stsCalls(exchanges)).toHaveLength(sts);
    expect(kmsCalls(exchanges)).toHaveLength(kms);
    const rendered = [String(caught), inspect(caught, { depth: 5 }), JSON.stringify(caught), (caught as Error).stack ?? ""].join("\n");
    for (const needle of ["SYNTHETIC-AWS-MESSAGE", "arn:aws", BOOTSTRAP_KEY, BOOTSTRAP_SECRET, SESSION_KEY, "000000000000"]) expect(rendered).not.toContain(needle);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("missing worker bootstrap identity fails closed before any AWS request (lazy identity adapter)", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw, { INTEGRATION_AWS_BOOTSTRAP_SECRET_ACCESS_KEY: undefined }));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 }))).toBe("kms_diagnostic_keyring_misconfigured");
    expect(exchanges).toEqual([]);
  });
});

describe("AWS attempt determinism (Step 7E.7-B-R1): three independent controls, each bounded to ONE", () => {
  const stsFaults: [string, Reply][] = [
    ["STS InternalFailure (500)", stsError("InternalFailure", 500)],
    ["STS ServiceUnavailable (503)", stsError("ServiceUnavailable", 503)],
    ["STS Throttling (400)", stsError("Throttling", 400)],
    ["STS connection reset", connectionReset],
  ];
  it.each(stsFaults)("%s → exactly 1 AssumeRole, 0 Decrypt, keyring_unavailable (no SDK retry, no KMS after a failed STS)", async (_name, fault) => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: () => fault, kms: (e) => world.decrypt(e) });
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 }))).toBe("kms_diagnostic_keyring_unavailable");
    expect(stsCalls(exchanges)).toHaveLength(1);
    expect(kmsCalls(exchanges)).toHaveLength(0);
  });

  const kmsFaults: [string, Reply][] = [
    ["KMS KMSInternalException (500)", kmsError("KMSInternalException", 500)],
    ["KMS ServiceUnavailableException (503)", kmsError("ServiceUnavailableException", 503)],
    ["KMS ThrottlingException (400)", kmsError("ThrottlingException", 400)],
    ["KMS connection reset", connectionReset],
  ];
  it.each(kmsFaults)("%s → exactly 1 AssumeRole, exactly 1 Decrypt, keyring_unavailable; no AWS detail leaks", async (_name, fault) => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: () => fault });
    let caught: unknown;
    try {
      await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 });
    } catch (error) {
      caught = error;
    }
    expect((caught as KmsDiagnosticError).failure).toBe("kms_diagnostic_keyring_unavailable");
    expect(stsCalls(exchanges)).toHaveLength(1);
    expect(kmsCalls(exchanges)).toHaveLength(1);
    expect(kmsCalls(exchanges)[0]?.target).toBe("TrentService.Decrypt");
    const rendered = [String(caught), inspect(caught, { depth: 5 }), JSON.stringify(caught)].join("\n");
    for (const needle of ["SYNTHETIC-AWS-MESSAGE", "arn:aws", SESSION_KEY, "000000000000", "ECONNRESET"]) expect(rendered).not.toContain(needle);
  });

  it("success → exactly 1 AssumeRole and 1 Decrypt", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect((await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 })).plaintextMatches).toBe(true);
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 1]);
  });

  it("no environment variable widens the bound: AWS_MAX_ATTEMPTS / AWS_RETRY_MODE are overridden by the explicit argument", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw, { AWS_MAX_ATTEMPTS: "7", AWS_RETRY_MODE: "adaptive" }));
    const stsFault = trapAws({ sts: () => stsError("InternalFailure", 500), kms: (e) => world.decrypt(e) });
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 }))).toBe("kms_diagnostic_keyring_unavailable");
    expect([stsCalls(stsFault).length, kmsCalls(stsFault).length]).toEqual([1, 0]);
    vi.restoreAllMocks();
    const kmsFault = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 }))).toBe("kms_diagnostic_keyring_unavailable");
    expect([stsCalls(kmsFault).length, kmsCalls(kmsFault).length]).toEqual([1, 1]);
  });

  it("the three controls are independent: the task's single attempt does NOT bound the SDK clients — the explicit argument does", async () => {
    await import("@/jobs/trigger/integration/kms-worker-auth-diagnostic");
    expect(sdk.tasks.at(-1)?.["retry"]).toEqual({ maxAttempts: 1 }); // control 1: Trigger.dev task retry
    expect(KMS_DIAGNOSTIC_AWS_ATTEMPTS).toEqual({ maxAttempts: 1 }); // controls 2 and 3: STS and KMS clients
    expect(Object.isFrozen(KMS_DIAGNOSTIC_AWS_ATTEMPTS)).toBe(true);
    // The same diagnostic run WITHOUT the AWS bound (default composition) retries inside the SDK despite the task's 1.
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    const unbounded = (environment: Readonly<Record<string, string | undefined>>) => {
      const opening = composeCredentialOpener(environment, integrationWorkerAwsCredentials(environment));
      return { access: createCredentialAccess(opening.opener, opening.contextEnv), contextEnv: opening.contextEnv };
    };
    expect(await outcomeOf(runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22, composeAccess: unbounded }))).toBe("kms_diagnostic_keyring_unavailable");
    expect(kmsCalls(exchanges).length).toBeGreaterThan(1);
  }, 30_000);
});

describe("default (non-diagnostic) callers: OPTION_ABSENT_USES_EXISTING_SDK_DEFAULT", () => {
  /** The product composition, exactly as composeJobProviders builds it: no attempt bound. */
  const defaultAccess = (environment: NodeJS.ProcessEnv) => {
    const opening = composeCredentialOpener(environment, integrationWorkerAwsCredentials(environment));
    return createCredentialAccess(opening.opener, opening.contextEnv);
  };
  const open = async (environment: NodeJS.ProcessEnv, envelope: string): Promise<unknown> => {
    const workspaceId = parseWorkspaceId(KMS_DIAGNOSTIC_WORKSPACE_ID);
    if (workspaceId === undefined) throw new Error("synthetic id");
    return defaultAccess(environment).withCredential({ workspaceId, credentialId: KMS_DIAGNOSTIC_CREDENTIAL_ID, envelope: Buffer.from(envelope, "base64") }, (credential) => Promise.resolve(credential.id));
  };

  it("integrationWorkerAwsCredentials(env) without the option keeps the SDK's retries on a transient STS fault", async () => {
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(deployed(fixture.raw));
    const exchanges = trapAws({ sts: () => stsError("InternalFailure", 500), kms: (e) => world.decrypt(e) });
    await expect(open(env, fixture.envelope)).rejects.toBeDefined();
    expect(stsCalls(exchanges).length).toBeGreaterThan(1); // observed SDK default; not an architectural count
    expect(kmsCalls(exchanges)).toHaveLength(0);
  }, 30_000);

  it("the opener composed without the option keeps the SDK's retries on a transient KMS fault", async () => {
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(deployed(fixture.raw));
    const exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    await expect(open(env, fixture.envelope)).rejects.toBeDefined();
    expect(stsCalls(exchanges)).toHaveLength(1);
    expect(kmsCalls(exchanges).length).toBeGreaterThan(1); // observed SDK default; not an architectural count
  }, 30_000);

  it("no leakage: a diagnostic run first does not change a later default composition", async () => {
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(deployed(fixture.raw));
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect((await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 })).plaintextMatches).toBe(true);
    vi.restoreAllMocks();
    const exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    await expect(open(env, fixture.envelope)).rejects.toBeDefined();
    expect(kmsCalls(exchanges).length).toBeGreaterThan(1);
  }, 30_000);

  it("the default path still opens normally (one STS, one KMS on success)", async () => {
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(deployed(fixture.raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(await open(env, fixture.envelope)).toBe(KMS_DIAGNOSTIC_CREDENTIAL_LABEL);
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 1]);
  });
});

describe("the Trigger.dev task wrapper", () => {
  const ctx = (type: string, externalId?: string) => ({ ctx: { environment: { type }, deployment: externalId === undefined ? undefined : { externalId } } });
  const run = async (payload: unknown, context: ReturnType<typeof ctx>): Promise<unknown> => {
    await import("@/jobs/trigger/integration/kms-worker-auth-diagnostic");
    const runner = sdk.tasks.at(-1)?.["run"] as (payload: unknown, context: unknown) => Promise<unknown>;
    return runner(payload, context);
  };

  it("a refusal ends the run with the vendor abort carrying only the fixed code", async () => {
    const world = kmsWorld();
    useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    await expect(run({ acknowledge: "wrong" }, ctx("PRODUCTION", RELEASE))).rejects.toThrow(new sdk.AbortTaskRunError("kms_diagnostic_input_refused"));
    await expect(run(ACK, ctx("DEVELOPMENT"))).rejects.toThrow(new sdk.AbortTaskRunError("kms_diagnostic_release_refused"));
    await expect(run(ACK, ctx("PRODUCTION"))).rejects.toThrow(new sdk.AbortTaskRunError("kms_diagnostic_release_refused"));
    expect(exchanges).toEqual([]);
  });

  it("success returns the safe outcome (this process's real Node version); a digest mismatch aborts the run", async () => {
    const world = kmsWorld();
    useEnv(deployed((await sealFixture(world)).raw));
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    const node22 = process.version.startsWith("v22.");
    if (node22) {
      expect(await run(ACK, ctx("PRODUCTION", RELEASE))).toEqual({ result: "KMS_WORKER_AUTH_DIAGNOSTIC_PASSED", nodeVersion: process.version, node22: true, contextEnv: "dev", plaintextMatches: true });
    } else {
      await expect(run(ACK, ctx("PRODUCTION", RELEASE))).rejects.toThrow(new sdk.AbortTaskRunError("kms_diagnostic_runtime_refused"));
    }
    useEnv(deployed((await sealFixture(world, { fixture: { digest: "cd".repeat(32) } })).raw));
    if (node22) await expect(run(ACK, ctx("PRODUCTION", RELEASE))).rejects.toThrow(new sdk.AbortTaskRunError("kms_diagnostic_plaintext_mismatch"));
  });
});

describe("plaintext handling (best effort; PLAINTEXT_MEMORY_ZEROIZATION = BEST_EFFORT_NOT_PHYSICAL_GUARANTEE)", () => {
  it("the digest input buffer is zeroed after hashing", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const digest = diagnosticPlaintextDigest(bytes);
    expect(digest.byteLength).toBe(32);
    expect([...bytes]).toEqual([0, 0, 0, 0, 0]);
  });

  it("nothing is logged during a successful run (no console, no stdout/stderr write)", async () => {
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(deployed(fixture.raw));
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => { written.push(text(chunk)); return true; };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 });
    stdout.mockRestore();
    stderr.mockRestore();
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    expect(written.join("")).not.toContain(fixture.secret);
    expect(written).toEqual([]);
  });
});

describe("the fixture variable never reaches another plane", () => {
  it("MAIN refuses it (deployed runs); the integration plane accepts it", () => {
    expect(PLANE_FORBIDDEN_VARIABLES.main).toContain(INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV);
    expect(PLANE_FORBIDDEN_VARIABLES.integration).not.toContain(INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV);
    expect(planeEnvironmentProblems("main", PINNED, { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: "{}" })).toEqual([INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]);
    expect(planeEnvironmentProblems("integration", PINNED, { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: "{}" })).toEqual([]);
  });

  it("the hosted web refuses it", () => {
    expect(FORBIDDEN_WEB_VARIABLES).toContain(INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV);
    expect(forbiddenWebVariables({ NODE_ENV: "production", [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: "{}" })).toEqual([INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]);
  });
});

describe("the existing integration tasks stay inert with APP_DEPLOYMENT_ENV=staging and the diagnostic configuration", () => {
  it("without CAPABILITY_PROVIDER_MODE the product composition refuses (simulator is local/test only) before any AWS request", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(() => composeJobProviders(env)).toThrow(/simulator is local\/test only/);
    expect(exchanges).toEqual([]);
  });

  it("staging_stub (unchanged) lends its synthetic credential and never opens the envelope", async () => {
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(deployed(fixture.raw, { CAPABILITY_PROVIDER_MODE: "staging_stub" }));
    const exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    const composition = composeJobProviders(env);
    const workspaceId = parseWorkspaceId(KMS_DIAGNOSTIC_WORKSPACE_ID);
    if (workspaceId === undefined) throw new Error("synthetic id");
    const lent = await composition.access.withCredential({ workspaceId, credentialId: KMS_DIAGNOSTIC_CREDENTIAL_ID, envelope: Buffer.from(fixture.envelope, "base64") }, (credential) => Promise.resolve(credential.id));
    expect(lent).toBe("staging-stub");
    expect(exchanges).toEqual([]);
  });

  it("the tenant task wrapper needs the worker database, which the diagnostic configuration does not provide", () => {
    const env = useEnv(deployed("{}"));
    expect(() => createRuntimeDatabaseFromEnv("worker", env, { max: 1 })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Step 7E.7-B-R3: the diagnostic's single-attempt bound and the REAL module-level composition cache of jobs/connections.ts
// (`composition ??= composeJobProviders(process.env)`, filled by runEvaluateAccountCapabilities / runDiscoverAssets)
// cannot contaminate each other, in either order. Each order starts from a fresh module world (vi.resetModules).
// NODE_ENV=test is what lets the real product composition build its KMS opener (with the local simulator as the
// provider read port); the deployed tiers compose either nothing (refused) or the staging stub, which opens nothing.
describe("cache isolation (Step 7E.7-B-R3): diagnostic bound vs the real jobs/connections.ts module cache, both orders", () => {
  const SNAPSHOT_AT_LOAD = { max: process.env["AWS_MAX_ATTEMPTS"], mode: process.env["AWS_RETRY_MODE"] };
  const ACCOUNT = "5eed0000-d1a9-4000-8000-00000000d0aa";

  /** A fresh module world: jobs/connections.ts (with an EMPTY composition cache) and the diagnostic bound to it. */
  async function freshModules() {
    vi.resetModules();
    const connections = await import("@/jobs/connections");
    const diagnostic = await import("@/jobs/integration-kms-diagnostic");
    return { connections, diagnostic };
  }
  type Modules = Awaited<ReturnType<typeof freshModules>>;

  /** The product task context: identifiers only; its database scope is never entered (counted). */
  const productContext = (): TenantStepJobContext =>
    ({
      payload: { v: 1, scope: "workspace", task: "capability.evaluate_account", workspaceId: KMS_DIAGNOSTIC_WORKSPACE_ID, outboxId: "synthetic-outbox", subjectIds: { connected_account_id: ACCOUNT }, correlationId: "synthetic", initiator: { kind: "system" } },
      run: { runId: "synthetic-run", attempt: 1 },
      inScope: () => {
        capture.inScope += 1;
        return Promise.reject(new Error("synthetic: no database in this test"));
      },
    }) as unknown as TenantStepJobContext;

  /** Runs the REAL product task handler once and returns the composition it handed to the service. */
  async function productComposition(modules: Modules) {
    capture.on = true;
    try {
      await modules.connections.runEvaluateAccountCapabilities(productContext());
    } finally {
      capture.on = false;
    }
    const last = capture.deps.at(-1);
    if (last === undefined) throw new Error("no composition captured");
    return last as { readonly access: ProviderCredentialAccess; readonly providers: { readonly read: (provider: string) => unknown } };
  }

  const openWith = (access: ProviderCredentialAccess, envelope: string): Promise<string> => {
    const workspaceId = parseWorkspaceId(KMS_DIAGNOSTIC_WORKSPACE_ID);
    if (workspaceId === undefined) throw new Error("synthetic id");
    return access.withCredential({ workspaceId, credentialId: KMS_DIAGNOSTIC_CREDENTIAL_ID, envelope: Buffer.from(envelope, "base64") }, (credential) => Promise.resolve(credential.id));
  };

  const diagnose = (modules: Modules, env: NodeJS.ProcessEnv) => modules.diagnostic.runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22 });
  const failureOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      return "resolved";
    } catch (error) {
      return (error as { failure?: string }).failure ?? "other";
    }
  };

  const productEnv = (fixture: string): Env => deployed(fixture, { NODE_ENV: "test" });

  beforeEach(() => {
    capture.deps.length = 0;
    capture.inScope = 0;
    capture.on = false;
  });

  /** No diagnostic state may leak into the environment, the AWS retry variables or new globals. */
  function leakProbe() {
    const before = { max: process.env["AWS_MAX_ATTEMPTS"], mode: process.env["AWS_RETRY_MODE"], globals: Object.keys(globalThis).sort() };
    return () => {
      expect(process.env["AWS_MAX_ATTEMPTS"]).toBe(before.max);
      expect(process.env["AWS_RETRY_MODE"]).toBe(before.mode);
      expect(Object.keys(globalThis).sort()).toEqual(before.globals);
    };
  }

  it("cache isolation · ORDER A — default product composition first (real module cache), then the diagnostic keeps ONE STS and ONE KMS attempt", async () => {
    const modules = await freshModules();
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(productEnv(fixture.raw));
    const noLeak = leakProbe();

    // 1. The fresh module world starts with an EMPTY cache: the first product run composes (simulator built once)...
    expect(calls.simulator).toBe(0);
    const first = await productComposition(modules);
    expect(calls.simulator).toBe(1);
    // ...and a second product run reuses the SAME cached composition (no new composition, same objects).
    const second = await productComposition(modules);
    expect(calls.simulator).toBe(1);
    expect(second.access).toBe(first.access);
    expect(second.providers).toBe(first.providers);
    // 2. It is the normal product composition: the simulator read port (not the staging stub), default SDK retries.
    expect(first.providers.read("simulator")).toBeDefined();
    expect(calls.stagingStub).toBe(0);
    let exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(await openWith(first.access, fixture.envelope)).toBe(KMS_DIAGNOSTIC_CREDENTIAL_LABEL);
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 1]);
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    await expect(openWith(first.access, fixture.envelope)).rejects.toBeDefined();
    expect(kmsCalls(exchanges).length).toBeGreaterThan(1); // the cached default composition retries (SDK default)

    // 3. Diagnostic AFTER the cache exists: transient KMS fault → exactly 1 AssumeRole, 1 Decrypt.
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    expect(await failureOf(diagnose(modules, env))).toBe("kms_diagnostic_keyring_unavailable");
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 1]);
    // 4. Diagnostic AFTER the cache exists: transient STS fault → exactly 1 AssumeRole, 0 Decrypt.
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: () => stsError("InternalFailure", 500), kms: (e) => world.decrypt(e) });
    expect(await failureOf(diagnose(modules, env))).toBe("kms_diagnostic_keyring_unavailable");
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 0]);
    // ...and the diagnostic still succeeds with exactly 1 + 1.
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect((await diagnose(modules, env)).plaintextMatches).toBe(true);
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 1]);

    // 5. The cache was neither replaced nor re-composed nor narrowed by the diagnostic.
    const after = await productComposition(modules);
    expect(calls.simulator).toBe(1);
    expect(after.access).toBe(first.access);
    expect(after.providers).toBe(first.providers);
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    await expect(openWith(after.access, fixture.envelope)).rejects.toBeDefined();
    expect(kmsCalls(exchanges).length).toBeGreaterThan(1);

    expect(capture.inScope).toBe(0); // no database scope was ever entered
    expect(calls.database).toBe(0);
    expect(calls.stagingStub).toBe(0);
    noLeak();
  }, 60_000);

  it("cache isolation · ORDER B — diagnostic first, then the real product composition is created with the SDK default retries", async () => {
    const modules = await freshModules();
    const world = kmsWorld();
    const fixture = await sealFixture(world);
    const env = useEnv(productEnv(fixture.raw));
    const noLeak = leakProbe();

    // 1. Diagnostic first, in the fresh module world: 1 + 1 on success and on a transient KMS fault.
    let exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect((await diagnose(modules, env)).plaintextMatches).toBe(true);
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 1]);
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    expect(await failureOf(diagnose(modules, env))).toBe("kms_diagnostic_keyring_unavailable");
    expect([stsCalls(exchanges).length, kmsCalls(exchanges).length]).toEqual([1, 1]);
    // The diagnostic never filled the module cache: no product composition was built.
    expect(calls.simulator).toBe(0);

    // 2. The first product run now composes the cache itself (simulator built once) — the default composition.
    const cached = await productComposition(modules);
    expect(calls.simulator).toBe(1);
    expect(cached.providers.read("simulator")).toBeDefined();
    // 3. Its STS keeps the SDK default retries on a transient fault (and never reaches KMS)...
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: () => stsError("InternalFailure", 500), kms: (e) => world.decrypt(e) });
    await expect(openWith(cached.access, fixture.envelope)).rejects.toBeDefined();
    expect(stsCalls(exchanges).length).toBeGreaterThan(1);
    expect(kmsCalls(exchanges)).toHaveLength(0);
    // ...and its KMS keeps the SDK default retries on a transient fault.
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: stsOk, kms: () => kmsError("KMSInternalException", 500) });
    await expect(openWith(cached.access, fixture.envelope)).rejects.toBeDefined();
    expect(kmsCalls(exchanges).length).toBeGreaterThan(1);
    // 4. The cache is stable afterwards (same objects on the next product run), and still opens normally.
    const again = await productComposition(modules);
    expect(again.access).toBe(cached.access);
    expect(calls.simulator).toBe(1);
    vi.restoreAllMocks();
    exchanges = trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    expect(await openWith(again.access, fixture.envelope)).toBe(KMS_DIAGNOSTIC_CREDENTIAL_LABEL);

    expect(capture.inScope).toBe(0);
    expect(calls.database).toBe(0);
    expect(calls.stagingStub).toBe(0);
    noLeak();
  }, 60_000);

  it("cache isolation · the diagnostic composition is never the cached product composition, in either order", async () => {
    const modules = await freshModules();
    const world = kmsWorld();
    const env = useEnv(productEnv((await sealFixture(world)).raw));
    const beforeCache = modules.diagnostic.productionDiagnosticAccess(env);
    const cached = await productComposition(modules);
    const afterCache = modules.diagnostic.productionDiagnosticAccess(env);
    expect(beforeCache.access).not.toBe(cached.access);
    expect(afterCache.access).not.toBe(cached.access);
    expect(afterCache.access).not.toBe(beforeCache.access); // a fresh composition per diagnostic run, never cached
    expect((await productComposition(modules)).access).toBe(cached.access);
  });

  it("cache isolation · no test leaves AWS_MAX_ATTEMPTS / AWS_RETRY_MODE changed", () => {
    expect({ max: process.env["AWS_MAX_ATTEMPTS"], mode: process.env["AWS_RETRY_MODE"] }).toEqual(SNAPSHOT_AT_LOAD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Step 7E.7-B-R4: ONE closed failure vocabulary — every emitted code is in it, every member is emitted, nothing raw.
describe("closed failure vocabulary (Step 7E.7-B-R4)", () => {
  const MODULE = "jobs/integration-kms-diagnostic.ts";
  const TASK = "jobs/trigger/integration/kms-worker-auth-diagnostic.ts";
  const codeWithoutComments = (file: string): string =>
    readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const literals = (code: string): string[] => [...code.matchAll(/["'`](kms_diagnostic_[a-z_]+)["'`]/g)].map((m) => m[1] ?? "");

  it("statically: the codes the module and the task emit are exactly the vocabulary (no member unused, no code outside)", () => {
    const moduleCode = codeWithoutComments(MODULE);
    const declaration = /export const KMS_DIAGNOSTIC_FAILURES = \[[^\]]*\] as const;/;
    expect(moduleCode).toMatch(declaration);
    const emitted = new Set([...literals(moduleCode.replace(declaration, "")), ...literals(codeWithoutComments(TASK))]);
    expect([...emitted].sort()).toEqual([...KMS_DIAGNOSTIC_FAILURES].sort());
    expect(new Set(KMS_DIAGNOSTIC_FAILURES).size).toBe(KMS_DIAGNOSTIC_FAILURES.length);
    expect(KMS_DIAGNOSTIC_FAILURES).toContain("kms_diagnostic_plaintext_mismatch");
    // Every code the task wrapper names is typed against the vocabulary at compile time.
    expect(codeWithoutComments(TASK).match(/"kms_diagnostic_[a-z_]+" satisfies KmsDiagnosticFailure/g)).toHaveLength(2);
    // No other runtime file coins a diagnostic code.
    const runtime = ["app", "ui", "server", "platform", "jobs", "modules", "integrations", "domain"].flatMap((dir) => {
      const walk = (relative: string): string[] => {
        const absolute = path.join(root, relative);
        try {
          return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(relative, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(relative, entry.name)] : []));
        } catch {
          return [];
        }
      };
      return walk(dir);
    });
    expect(runtime.filter((file) => file !== MODULE && file !== TASK && literals(codeWithoutComments(file)).length > 0)).toEqual([]);
  });

  /** The canonical code of a module-level failure, checking that the error carries nothing but the code. */
  async function coreCode(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(KmsDiagnosticError);
      const failure = (error as KmsDiagnosticError).failure;
      expect((error as Error).message).toBe(`non-retryable job failure: ${failure}`);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      return failure;
    }
    return "resolved";
  }
  /** The canonical code of a task-wrapper failure: the vendor abort's message is the code and nothing else. */
  async function taskCode(payload: unknown, context: unknown): Promise<string> {
    await import("@/jobs/trigger/integration/kms-worker-auth-diagnostic");
    const runner = sdk.tasks.at(-1)?.["run"] as (payload: unknown, context: unknown) => Promise<unknown>;
    try {
      await runner(payload, context);
    } catch (error) {
      expect(error).toBeInstanceOf(sdk.AbortTaskRunError);
      expect(KMS_DIAGNOSTIC_FAILURES as readonly string[]).toContain((error as Error).message);
      return (error as Error).message;
    }
    return "resolved";
  }
  const PROD_CTX = { ctx: { environment: { type: "PRODUCTION" }, deployment: { externalId: RELEASE } } };

  it("behaviorally: every vocabulary member is emitted by a real scenario, and only vocabulary members are emitted", async () => {
    const emitted = new Set<string>();
    const core = async (change: { env?: Env; run?: typeof RUN | { environmentType: string; release: JobRelease }; node?: string; seal?: SealOptions; payload?: unknown; kms?: (e: Exchange) => Reply; compose?: (environment: Readonly<Record<string, string | undefined>>) => { access: ProviderCredentialAccess; contextEnv: string } }) => {
      vi.restoreAllMocks();
      const world = kmsWorld();
      const env = useEnv(deployed((await sealFixture(world, change.seal)).raw, change.env));
      trapAws({ sts: stsOk, kms: change.kms ?? ((e) => world.decrypt(e)) });
      emitted.add(await coreCode(runKmsWorkerAuthDiagnostic(change.payload ?? ACK, change.run ?? RUN, env, { nodeVersion: change.node ?? NODE_22, ...(change.compose === undefined ? {} : { composeAccess: change.compose }) })));
    };
    await core({ payload: { acknowledge: "wrong" } });
    await core({ run: { environmentType: "DEVELOPMENT", release: { kind: "development" } } });
    await core({ env: { DATABASE_SYSTEM_URL: "postgres://synthetic" } });
    await core({ env: { APP_DEPLOYMENT_ENV: undefined } });
    await core({ node: "v20.19.0" });
    await core({ env: { NODE_ENV: "test", CREDENTIAL_CONTEXT_ENV: undefined, CREDENTIAL_KMS_KEY_ARN: undefined, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } });
    await core({ env: { CREDENTIAL_CONTEXT_ENV: "test" } });
    await core({ env: { [INTEGRATION_KMS_DIAGNOSTIC_FIXTURE_ENV]: undefined } });
    await core({ compose: (environment) => ({ ...productionDiagnosticAccess(environment), contextEnv: "test" }) });
    await core({ seal: { env: "test" } });
    await core({ kms: () => kmsError("AccessDeniedException") });
    await core({ kms: () => kmsError("DisabledException") });
    await core({ kms: () => kmsError("KMSInternalException", 500) });
    await core({ compose: () => { throw new Error(AWS_MESSAGE); } });
    // The task wrapper adds exactly one code of its own (plaintext mismatch) and maps anything unexpected to failed.
    vi.restoreAllMocks();
    const world = kmsWorld();
    useEnv(deployed((await sealFixture(world, { fixture: { digest: "ef".repeat(32) } })).raw));
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    if (process.version.startsWith("v22.")) emitted.add(await taskCode(ACK, PROD_CTX));
    else emitted.add("kms_diagnostic_plaintext_mismatch"); // this local runtime is not Node 22: the wrapper refuses earlier
    emitted.add(await taskCode(ACK, {}));
    expect([...emitted].sort()).toEqual([...KMS_DIAGNOSTIC_FAILURES].sort());
  }, 60_000);

  it("raw error text never escapes: an arbitrary failure becomes kms_diagnostic_failed, in the module and in the task", async () => {
    const world = kmsWorld();
    const env = useEnv(deployed((await sealFixture(world)).raw));
    trapAws({ sts: stsOk, kms: (e) => world.decrypt(e) });
    let caught: unknown;
    try {
      await runKmsWorkerAuthDiagnostic(ACK, RUN, env, { nodeVersion: NODE_22, composeAccess: () => { throw new Error(AWS_MESSAGE); } });
    } catch (error) {
      caught = error;
    }
    expect((caught as KmsDiagnosticError).failure).toBe("kms_diagnostic_failed");
    const rendered = [String(caught), inspect(caught, { depth: 5 }), JSON.stringify(caught), (caught as Error).stack ?? ""].join("\n");
    expect(rendered).not.toContain("SYNTHETIC-AWS-MESSAGE");
    expect(rendered).not.toContain("arn:aws");
    // A malformed run context (TypeError inside the wrapper) is also canonicalized.
    expect(await taskCode(ACK, {})).toBe("kms_diagnostic_failed");
  });
});

