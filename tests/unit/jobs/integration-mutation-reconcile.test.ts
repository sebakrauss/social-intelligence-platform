/**
 * Step 7B-14I2 — the operator reconciliation task (jobs/integration-mutation-reconcile.ts): a separate, operator-only
 * INTEGRATION task (one attempt, its own queue of one, no schedule); every guard before anything credential- or
 * provider-capable; exactly { acknowledge, workspace_id, mutation_intent_id }; only AUTHORIZED Meta Instagram intents,
 * EXECUTING for 15 minutes or OUTCOME_UNKNOWN; the reconciler's lookup over the Instagram own-reply reader; closed outputs.
 * Nothing here can send: the composition holds a credential access and a READ lookup only.
 */
import { describe, expect, it, vi } from "vitest";
import { providerCredential, providerObjectRef, type ProviderObjectId } from "@/integrations/providers/contract";
import type { InstagramReplyLookup } from "@/integrations/providers/meta/instagram-reply-lookup";
import type { ProviderCredentialAccess } from "@/modules/connections";
import type { JobRelease } from "@/platform/jobs";
import type { ReconciliationCandidate } from "@/server/persistence/mutation-execution";
import {
  MUTATION_RECONCILE_ACKNOWLEDGEMENT,
  MUTATION_RECONCILE_AWS_ATTEMPTS,
  MUTATION_RECONCILE_FAILURES,
  MUTATION_RECONCILE_MIN_EXECUTING_AGE_SECONDS,
  MUTATION_RECONCILE_TASK_ID,
  MutationReconcileError,
  classifyReconciliationCandidate,
  instagramReplyLookupPort,
  runMutationReconcile,
  type MutationReconcileDependencies,
  type MutationReconcileFailure,
} from "@/jobs/integration-mutation-reconcile";

const sdk = vi.hoisted(() => {
  class AbortTaskRunError extends Error {
    override readonly name = "AbortTaskRunError";
  }
  const tasks: Record<string, unknown>[] = [];
  const scheduled: unknown[] = [];
  return {
    AbortTaskRunError,
    tasks,
    scheduled,
    task: (options: Record<string, unknown>) => {
      tasks.push(options);
      return { id: options["id"] };
    },
    queue: (options: Record<string, unknown>) => ({ type: "queue", ...options }),
    schedules: { task: (options: unknown) => scheduled.push(options) },
  };
});
vi.mock("@trigger.dev/sdk", () => sdk);

const WORKSPACE = "5eed0000-d1a9-4000-8000-00000000f301";
const INTENT = "5eed0000-d1a9-4000-8000-00000000f302";
const KEY_A = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
const PINNED: JobRelease = { kind: "pinned", releaseId: "synthetic-release-0000000000000000000000" };
const RUN = { environmentType: "PRODUCTION", release: PINNED, runId: "run_synthetic_reconcile_0001" } as const;
const PAYLOAD = { acknowledge: MUTATION_RECONCILE_ACKNOWLEDGEMENT, workspace_id: WORKSPACE, mutation_intent_id: INTENT };
type Env = Record<string, string | undefined>;
const DEPLOYED: Env = { NODE_ENV: "production", APP_DEPLOYMENT_ENV: "staging", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY_A, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY_A };
const candidate = (over: Partial<ReconciliationCandidate> = {}): ReconciliationCandidate => ({ status: "OUTCOME_UNKNOWN", authorized: true, ageSeconds: 3600, provider: "meta", platform: "instagram", ...over });

/** `null`: the read finds nothing (an absent or foreign intent). */
function harness(found: ReconciliationCandidate | null | "throws" = candidate()) {
  const asked: unknown[] = [];
  const composed: Env[] = [];
  const deps: Partial<MutationReconcileDependencies> = {
    nodeVersion: "v22.16.0",
    candidate: (input) => {
      asked.push(input);
      return found === "throws" ? Promise.reject(new Error("synthetic-db-failure-marker")) : Promise.resolve(found ?? undefined);
    },
    compose: (environment) => {
      composed.push({ ...environment });
      throw new Error("synthetic-compose-marker");
    },
  };
  return { asked, composed, run: (payload: unknown = PAYLOAD, env: Env = DEPLOYED, run: typeof RUN | { environmentType: string; release: JobRelease; runId: string } = RUN) => runMutationReconcile(payload, run, env, deps) };
}

async function refused(promise: Promise<unknown>): Promise<MutationReconcileFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MutationReconcileError);
    const failure = (error as MutationReconcileError).failure;
    expect(MUTATION_RECONCILE_FAILURES).toContain(failure);
    expect((error as Error).message).not.toMatch(/marker/);
    return failure;
  }
  throw new Error("expected a refusal");
}

describe("7B-14I2: the operator reconciliation task's identity", () => {
  it("is integration.mutation_reconcile: one attempt, its own queue of one, bounded, no schedule — and thin", async () => {
    await import("@/jobs/trigger/integration/mutation-reconcile");
    const definition = sdk.tasks.find((task) => task["id"] === MUTATION_RECONCILE_TASK_ID);
    expect(definition?.["retry"]).toEqual({ maxAttempts: 1 });
    expect(definition?.["maxDuration"]).toBe(120);
    expect(definition?.["queue"]).toMatchObject({ name: "integration-mutation-reconcile", concurrencyLimit: 1 });
    expect(Object.keys(definition ?? {}).sort()).toEqual(["id", "maxDuration", "queue", "retry", "run"]);
    expect(sdk.scheduled).toEqual([]);
    expect(MUTATION_RECONCILE_AWS_ATTEMPTS).toEqual({ maxAttempts: 1 });
  });

  it("the task aborts with the fixed code of a refusal, never a message of its own", async () => {
    await import("@/jobs/trigger/integration/mutation-reconcile");
    const run = sdk.tasks.find((task) => task["id"] === MUTATION_RECONCILE_TASK_ID)?.["run"] as (payload: unknown, context: { ctx: unknown }) => Promise<unknown>;
    const ctx = { environment: { type: "PRODUCTION" }, deployment: undefined, run: { id: "run_x" } };
    await expect(run({ ...PAYLOAD, acknowledge: "nope" }, { ctx })).rejects.toThrow(new sdk.AbortTaskRunError("mutation_reconcile_input_refused"));
  });
});

describe("7B-14I2: every refusal happens before the candidate read or any composition", () => {
  const cases: [string, MutationReconcileFailure, { payload?: unknown; env?: Env; run?: { environmentType: string; release: JobRelease; runId: string }; node?: string }][] = [
    ["no payload", "mutation_reconcile_input_refused", { payload: null }],
    ["another task's acknowledgement", "mutation_reconcile_input_refused", { payload: { ...PAYLOAD, acknowledge: "INTEGRATION_INSTAGRAM_REPLY_PREFLIGHT_V1" } }],
    ["a missing intent", "mutation_reconcile_input_refused", { payload: { acknowledge: MUTATION_RECONCILE_ACKNOWLEDGEMENT, workspace_id: WORKSPACE } }],
    ["a provider id as the intent", "mutation_reconcile_input_refused", { payload: { ...PAYLOAD, mutation_intent_id: "17900000000000001" } }],
    ["an extra field (a text)", "mutation_reconcile_input_refused", { payload: { ...PAYLOAD, text: "Hola" } }],
    ["an extra field (resend)", "mutation_reconcile_input_refused", { payload: { ...PAYLOAD, resend: true } }],
    ["a local development run", "mutation_reconcile_release_refused", { run: { environmentType: "DEVELOPMENT", release: { kind: "development" }, runId: "run_x" } }],
    ["a run without a run id", "mutation_reconcile_release_refused", { run: { environmentType: "PRODUCTION", release: PINNED, runId: "" } }],
    ["the main plane's system database credential", "mutation_reconcile_plane_refused", { env: { DATABASE_SYSTEM_URL: "postgres://synthetic" } }],
    ["APP_DEPLOYMENT_ENV=production", "mutation_reconcile_tier_refused", { env: { APP_DEPLOYMENT_ENV: "production" } }],
    ["Node 20", "mutation_reconcile_runtime_refused", { node: "v20.19.0" }],
    ["the staging stub provider mode", "mutation_reconcile_provider_mode_refused", { env: { CAPABILITY_PROVIDER_MODE: "staging_stub" } }],
    ["the local keyring (no KMS)", "mutation_reconcile_keyring_refused", { env: { NODE_ENV: "test", CREDENTIAL_CONTEXT_ENV: undefined, CREDENTIAL_KMS_KEY_ARN: undefined, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: undefined } }],
  ];
  it.each(cases)("%s → %s", async (_name, failure, change) => {
    const h = harness();
    const deps = change.node === undefined ? undefined : change.node;
    const run = deps === undefined ? h.run("payload" in change ? change.payload : PAYLOAD, { ...DEPLOYED, ...change.env }, change.run ?? RUN)
      : runMutationReconcile(PAYLOAD, RUN, DEPLOYED, { nodeVersion: deps, candidate: () => Promise.reject(new Error("never")), compose: () => { throw new Error("never"); } });
    expect(await refused(run)).toBe(failure);
    expect([h.asked, h.composed]).toEqual([[], []]);
  });
});

describe("7B-14I2: only an AUTHORIZED Meta Instagram intent left uncertain is ever looked at", () => {
  it("classifies the candidate (pure)", () => {
    expect(classifyReconciliationCandidate(undefined)).toEqual({ kind: "refuse", failure: "mutation_reconcile_intent_not_found" });
    expect(classifyReconciliationCandidate(candidate({ authorized: false }))).toEqual({ kind: "refuse", failure: "mutation_reconcile_intent_not_authorized" });
    expect(classifyReconciliationCandidate(candidate({ platform: "facebook" }))).toEqual({ kind: "refuse", failure: "mutation_reconcile_intent_not_instagram" });
    expect(classifyReconciliationCandidate(candidate({ provider: "simulator" }))).toEqual({ kind: "refuse", failure: "mutation_reconcile_intent_not_instagram" });
    expect(classifyReconciliationCandidate(candidate())).toEqual({ kind: "proceed" });
    // EXECUTING: its run may still be in flight before 15 minutes — never looked at (and never re-sent either way).
    expect(classifyReconciliationCandidate(candidate({ status: "EXECUTING", ageSeconds: MUTATION_RECONCILE_MIN_EXECUTING_AGE_SECONDS - 1 }))).toEqual({ kind: "refuse", failure: "mutation_reconcile_intent_in_flight" });
    expect(classifyReconciliationCandidate(candidate({ status: "EXECUTING", ageSeconds: MUTATION_RECONCILE_MIN_EXECUTING_AGE_SECONDS }))).toEqual({ kind: "proceed" });
    for (const status of ["PENDING", "CONFIRMED", "FAILED", "BLOCKED"]) expect(classifyReconciliationCandidate(candidate({ status }))).toEqual({ kind: "noop", status });
  });

  it("refusals and no-ops end before any composition; a failed read or composition is one fixed code", async () => {
    for (const [found, failure] of [[null, "mutation_reconcile_intent_not_found"], [candidate({ authorized: false }), "mutation_reconcile_intent_not_authorized"], [candidate({ status: "EXECUTING", ageSeconds: 10 }), "mutation_reconcile_intent_in_flight"], ["throws", "mutation_reconcile_failed"]] as const) {
      const h = harness(found);
      expect(await refused(h.run())).toBe(failure);
      expect(h.composed).toEqual([]);
    }
    const noop = harness(candidate({ status: "CONFIRMED" }));
    expect(await noop.run()).toEqual({ result: "noop", status: "CONFIRMED" });
    expect(noop.composed).toEqual([]);
    const composeFails = harness();
    expect(await refused(composeFails.run())).toBe("mutation_reconcile_failed");
    expect(composeFails.composed).toHaveLength(1);
  });

  it("the reconciler's lookup maps the Instagram reader's answers and refuses any non-Instagram ref (incomplete)", async () => {
    const answers: Parameters<InstagramReplyLookup["find"]>[] = [];
    const reader = (answer: Awaited<ReturnType<InstagramReplyLookup["find"]>>): InstagramReplyLookup => ({ find: (...args) => { answers.push(args); return Promise.resolve(answer); } });
    const access = { credential: providerCredential("cred", "synthetic-token"), account: providerObjectRef("instagram", "asset", "17841400000000001") };
    const target = { parent: providerObjectRef("instagram", "interaction", "17900000000000001"), content: providerObjectRef("instagram", "content", "17800000000000001") };
    const since = new Date();
    expect(await instagramReplyLookupPort(reader({ kind: "unique_match", replyId: "17999000000000001" as ProviderObjectId })).findOwnReply(access, target, "t", since)).toEqual({ kind: "found", providerReplyId: "17999000000000001" });
    for (const kind of ["none", "ambiguous", "incomplete"] as const) expect(await instagramReplyLookupPort(reader({ kind })).findOwnReply(access, target, "t", since)).toEqual({ kind });
    expect(answers[0]?.[1]).toEqual({ instagramAccountId: "17841400000000001", commentId: "17900000000000001" });
    const facebook = { ...access, account: providerObjectRef("facebook", "asset", "1000000000001") };
    const before = answers.length;
    expect(await instagramReplyLookupPort(reader({ kind: "unique_match", replyId: "x" as ProviderObjectId })).findOwnReply(facebook, target, "t", since)).toEqual({ kind: "incomplete" });
    expect(answers.length).toBe(before);
  });

  it("the composition offers a credential access and a READ lookup only — there is no send path to reach", () => {
    const shape: ReturnType<MutationReconcileDependencies["compose"]> = { access: {} as ProviderCredentialAccess, lookup: { find: () => Promise.resolve({ kind: "none" }) } };
    expect(Object.keys(shape).sort()).toEqual(["access", "lookup"]);
  });
});
