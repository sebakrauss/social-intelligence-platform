/**
 * W12-SEC-01 L-2: what crosses the job → vendor boundary. The execution wrapper's retry classification is unchanged
 * (classify(): permanent failures become NonRetryableJobError, anything else stays retryable) and its `job.failed`
 * line gains only the closed-vocabulary kind of an unexpected error. toVendorError hands the vendor an abort for a
 * permanent failure, a vendor control error unchanged, a cause-less AppError, or an UnexpectedJobError: never the
 * original message, stack or cause (the vendor stores name, message, stack and causes in its run record).
 */
import { inspect } from "node:util";
import { AbortTaskRunError, ApiError, CompleteTaskWithOutput } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { toVendorError } from "@/jobs/trigger/define";
import type { RuntimeDatabase } from "@/platform/db";
import { NonRetryableJobError, RETRY_POLICIES, defineTaskRegistry, runSystemJob } from "@/platform/jobs";
import { UnexpectedJobError, createLogger } from "@/platform/observability";

/** Synthetic sensitive values, assembled at runtime. */
const SYNTHETIC_EMAIL = ["job.person", "example.test"].join("@");
const SYNTHETIC_TOKEN = "tok_" + "w".repeat(40);
const SYNTHETIC_TEXT = "Comentario sintético de un trabajo";
const VALUES = [SYNTHETIC_EMAIL, SYNTHETIC_TOKEN, SYNTHETIC_TEXT];

const TASK = "outbox.dispatch_sweep";
const registry = defineTaskRegistry([{ name: TASK, scope: "system", executionPlane: "main", retry: RETRY_POLICIES.transient }]);
const payload = { v: 1, scope: "system", task: TASK, correlationId: "sched-0f8c8f4e-6a55-4d55-9a3b-3a1f2a4b5c6d", initiator: { type: "system" } };
const NO_SYSTEM_DATABASE = {} as RuntimeDatabase<"system">;

/** The fields the vendor's executor serializes from a thrown Error (name, message, stack, causes). */
function vendorView(error: unknown): string {
  const causes: string[] = [];
  let current: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    causes.push(inspect(current));
    current = typeof current === "object" && current !== null ? (current as { cause?: unknown }).cause : undefined;
  }
  const e = error as Error;
  return [e.name, e.message, String(e.stack), JSON.stringify(e), ...causes].join("\n");
}

function expectNoLeak(text: string): void {
  for (const value of VALUES) expect(text).not.toContain(value);
}

async function runFailing(failure: unknown): Promise<{ thrown: unknown; lines: Record<string, unknown>[] }> {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });
  let thrown: unknown;
  try {
    await runSystemJob({ registry, system: NO_SYSTEM_DATABASE, logger }, TASK, payload, { runId: "run_test_1", attempt: 1 }, () => Promise.reject(failure as Error));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  for (const line of lines) expectNoLeak(line);
  return { thrown, lines: lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe("10: an unexpected error inside a job", () => {
  it("keeps the wrapper's classification (retryable), logs its kind only, and reaches the vendor sanitized", async () => {
    const original = Object.assign(new Error(`provider said ${SYNTHETIC_TEXT} for ${SYNTHETIC_EMAIL}`), { token: SYNTHETIC_TOKEN });
    const { thrown, lines } = await runFailing(original);
    // classify() unchanged: the wrapper still rethrows the original, retryable error.
    expect(thrown).toBe(original);
    expect(lines.find((line) => line["event"] === "job.failed")).toMatchObject({ level: "warn", failureClass: "retryable", errorKind: "unknown", task: TASK, runId: "run_test_1" });
    const handed = toVendorError(thrown);
    expect(handed).toBeInstanceOf(UnexpectedJobError);
    expect((handed as Error).message).toBe("unexpected_error:unknown");
    expectNoLeak(vendorView(handed));
  });

  it("a database failure keeps only its SQLSTATE, in the log and for the vendor", async () => {
    const driver = Object.assign(new Error(`Key (email)=(${SYNTHETIC_EMAIL})`), { code: "40001", detail: SYNTHETIC_TOKEN });
    const { thrown, lines } = await runFailing(new Error(`Failed query params: ${SYNTHETIC_TEXT}`, { cause: driver }));
    expect(lines.find((line) => line["event"] === "job.failed")).toMatchObject({ failureClass: "retryable", errorKind: "database", sqlState: "40001" });
    const handed = toVendorError(thrown);
    expect((handed as Error).message).toBe("unexpected_error:database:40001");
    expectNoLeak(vendorView(handed));
  });
});

describe("11: a retryable error", () => {
  it("a retryable AppError stays retryable; the vendor gets it re-created from its code, without the cause", async () => {
    const appError = new AppError("STALE_STATE", {}, { cause: new Error(`${SYNTHETIC_EMAIL} ${SYNTHETIC_TOKEN}`) });
    const { thrown, lines } = await runFailing(appError);
    expect(thrown).toBe(appError);
    const failed = lines.find((line) => line["event"] === "job.failed");
    expect(failed).toMatchObject({ failureClass: "retryable" });
    expect(failed).not.toHaveProperty("errorKind");
    const handed = toVendorError(thrown);
    expect(handed).toBeInstanceOf(AppError);
    expect(handed).not.toBeInstanceOf(AbortTaskRunError);
    expect((handed as AppError).code).toBe("STALE_STATE");
    expect((handed as Error).message).toBe("STALE_STATE");
    expect("cause" in (handed as Error) && (handed as Error).cause !== undefined).toBe(false);
    expectNoLeak(vendorView(handed));
  });
});

describe("12: a non-retryable error", () => {
  it("a non-retryable AppError is still a NonRetryableJobError and still the vendor's abort with the same class", async () => {
    const { thrown, lines } = await runFailing(new AppError("CONFLICT", {}, { cause: new Error(SYNTHETIC_EMAIL) }));
    expect(thrown).toBeInstanceOf(NonRetryableJobError);
    expect((thrown as NonRetryableJobError).failureClass).toBe("CONFLICT");
    const failed = lines.find((line) => line["event"] === "job.failed");
    expect(failed).toMatchObject({ failureClass: "non_retryable" });
    expect(failed).not.toHaveProperty("errorKind");
    const handed = toVendorError(thrown);
    expect(handed).toBeInstanceOf(AbortTaskRunError);
    expect((handed as Error).message).toBe("CONFLICT");
    expectNoLeak(vendorView(handed));
  });

  it("an invalid payload is still rejected before the handler, as a non-retryable abort", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    let thrown: unknown;
    try {
      await runSystemJob({ registry, system: NO_SYSTEM_DATABASE, logger }, TASK, { ...payload, note: SYNTHETIC_TEXT }, { runId: "run_test_2", attempt: 1 }, () => Promise.resolve());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NonRetryableJobError);
    expect(toVendorError(thrown)).toBeInstanceOf(AbortTaskRunError);
    for (const line of lines) expectNoLeak(line);
  });
});

describe("13: toVendorError", () => {
  it("maps each class of error exactly once", () => {
    const abort = toVendorError(new NonRetryableJobError("unknown_task"));
    expect(abort).toBeInstanceOf(AbortTaskRunError);
    expect((abort as Error).message).toBe("unknown_task");

    // A genuine vendor abort stays an abort with its code (re-created: no cause, no frames). W12-LOG-HARDEN-03 F-2.
    const vendorAbort = new AbortTaskRunError("fixed_code");
    const handedAbort = toVendorError(vendorAbort);
    expect(handedAbort).toBeInstanceOf(AbortTaskRunError);
    expect((handedAbort as Error).message).toBe("fixed_code");
    // A plain Error that only CLAIMS a vendor name is not a vendor error: it is sanitized (and retried, not aborted).
    const forgedApi = Object.assign(new Error(`vendor api ${SYNTHETIC_EMAIL}`), { name: "TriggerApiError", status: 400 });
    const handedForged = toVendorError(forgedApi);
    expect(handedForged).toBeInstanceOf(UnexpectedJobError);
    expectNoLeak(vendorView(handedForged));

    for (const unknown of [new TypeError(SYNTHETIC_TEXT), SYNTHETIC_EMAIL, { token: SYNTHETIC_TOKEN }, undefined, null]) {
      const handed = toVendorError(unknown);
      expect(handed).toBeInstanceOf(UnexpectedJobError);
      expect((handed as Error).name).toBe("UnexpectedJobError");
      expectNoLeak(vendorView(handed));
    }
    expect((toVendorError(new TypeError("x")) as Error).message).toBe("unexpected_error:type_error");
    expect((toVendorError(Object.assign(new Error("x"), { code: "ECONNRESET" })) as Error).message).toBe("unexpected_error:network");
  });

  it("the sanitized job error is not one the vendor treats as non-retryable", () => {
    const handed = toVendorError(new Error("x")) as Error;
    expect(["AbortTaskRunError", "TaskPayloadParsedError", "TriggerInternalError", "TriggerApiError", "CompleteTaskWithOutput"]).not.toContain(handed.name);
  });
});

/**
 * The retry-decision inputs of Trigger.dev 4.7.2 `taskExecutor.#handleError` (early exits; core/dist/commonjs/v3/
 * workers/taskExecutor.js): what the vendor does with the error a task hands it. @trigger.dev/core is not a declared
 * dependency, so the predicate is transcribed here; it reads only instanceof Error, name, status, skipRetrying and
 * millisecondsUntilReset.
 */
function vendorDecision(error: unknown): string {
  if (!(error instanceof Error)) return "retry";
  const fields = error as { readonly status?: unknown; readonly skipRetrying?: unknown; readonly millisecondsUntilReset?: unknown };
  if (error.name === "TriggerInternalError" && fields.skipRetrying === true) return "skip";
  if (error.name === "AbortTaskRunError" || error.name === "TaskPayloadParsedError") return "skip";
  if (error.name === "TriggerApiError" && typeof fields.status === "number") {
    if (fields.status >= 400 && fields.status < 500 && fields.status !== 408 && fields.status !== 429) return "skip";
    if (fields.status === 429 && typeof fields.millisecondsUntilReset === "number" && fields.millisecondsUntilReset > 0) return "retry_after_reset";
  }
  return "retry";
}

function sensitiveError(): Error {
  return Object.assign(new Error(`${SYNTHETIC_TEXT} ${SYNTHETIC_EMAIL}`), { token: SYNTHETIC_TOKEN });
}

describe("F-2/F-5: the vendor boundary, adversarially", () => {
  it("a genuine AbortTaskRunError stays an abort (same code, re-created without cause); an unsafe code becomes fixed", () => {
    const genuine = new AbortTaskRunError("fixed_code");
    (genuine as { cause?: unknown }).cause = sensitiveError();
    const handed = toVendorError(genuine) as Error;
    expect(handed).toBeInstanceOf(AbortTaskRunError);
    expect(handed.message).toBe("fixed_code");
    expect(vendorDecision(handed)).toBe(vendorDecision(genuine));
    expect("cause" in handed && handed.cause !== undefined).toBe(false);
    const unsafe = toVendorError(new AbortTaskRunError(`refused for ${SYNTHETIC_EMAIL}`)) as Error;
    expect(unsafe).toBeInstanceOf(AbortTaskRunError);
    expect(unsafe.message).toBe("aborted");
    expectNoLeak(vendorView(handed) + vendorView(unsafe));
  });

  it("a permanent failure with an unsafe failure class is still an abort, with a fixed code", () => {
    const handed = toVendorError(new NonRetryableJobError(`bad ${SYNTHETIC_EMAIL}`)) as Error;
    expect(handed).toBeInstanceOf(AbortTaskRunError);
    expect(handed.message).toBe("non_retryable");
    expect(vendorDecision(handed)).toBe("skip");
  });

  it("errors that only CLAIM a vendor control name are not trusted: sanitized, never passed on", () => {
    for (const name of ["AbortTaskRunError", "TaskPayloadParsedError", "TriggerInternalError", "TriggerApiError", "CompleteTaskWithOutput"]) {
      const forged = Object.assign(sensitiveError(), { name, status: 400, skipRetrying: true, output: { leaked: SYNTHETIC_TOKEN } });
      const handed = toVendorError(forged);
      expect(handed, name).toBeInstanceOf(UnexpectedJobError);
      expect(handed).not.toBe(forged);
      expectNoLeak(vendorView(handed));
    }
  });

  it("a genuine vendor API error keeps the vendor's retry decision; message, body, headers and cause are dropped", () => {
    const body = { error: `rejected ${SYNTHETIC_EMAIL}` };
    const cases = [
      ApiError.generate(400, body, `bad request ${SYNTHETIC_TOKEN}`, { "x-request-id": SYNTHETIC_TOKEN }),
      ApiError.generate(404, body, SYNTHETIC_TEXT, {}),
      ApiError.generate(408, body, SYNTHETIC_TEXT, {}),
      ApiError.generate(500, body, SYNTHETIC_TEXT, {}),
      ApiError.generate(429, body, SYNTHETIC_TEXT, { "x-ratelimit-reset": String(Date.now() + 60_000) }),
    ];
    for (const genuine of cases) {
      expect(genuine).toBeInstanceOf(ApiError);
      const handed = toVendorError(genuine) as Error & { readonly status: number };
      expect(handed.name).toBe("TriggerApiError");
      expect(handed.status).toBe(genuine.status);
      expect(handed.message).toBe(`vendor_api_error:${String(handed.status)}`);
      expect(vendorDecision(handed)).toBe(vendorDecision(genuine));
      expectNoLeak(vendorView(handed) + JSON.stringify(handed));
    }
  });

  it("a genuine CompleteTaskWithOutput is the vendor's completion signal and passes unchanged", () => {
    const complete = new CompleteTaskWithOutput({ outcome: "applied" });
    expect(toVendorError(complete)).toBe(complete);
  });

  it("a retryable AppError with a sensitive cause stays retryable and reaches the vendor without the cause", () => {
    const appError = new AppError("PROVIDER_TRANSIENT", { platform: "instagram" }, { cause: sensitiveError() });
    const handed = toVendorError(appError) as AppError;
    expect(handed).toBeInstanceOf(AppError);
    expect(handed.code).toBe("PROVIDER_TRANSIENT");
    expect(handed.cause).toBeUndefined();
    expect(vendorDecision(handed)).toBe("retry");
    expectNoLeak(vendorView(handed));
  });

  it("an unknown error stays retryable and carries nothing original", () => {
    const original = sensitiveError();
    const handed = toVendorError(original);
    expect(vendorDecision(handed)).toBe("retry");
    expect(vendorDecision(original)).toBe("retry");
    expectNoLeak(vendorView(handed));
  });

  it.each([
    ["a revoked proxy", () => {
      const { proxy, revoke } = Proxy.revocable(sensitiveError(), {});
      revoke();
      return proxy;
    }],
    ["a proxy whose getPrototypeOf throws", () => new Proxy(sensitiveError(), { getPrototypeOf: () => { throw sensitiveError(); } })],
    ["a proxy over a genuine AbortTaskRunError", () => new Proxy(new AbortTaskRunError("fixed_code"), {})],
    ["a proxy over a genuine CompleteTaskWithOutput", () => new Proxy(new CompleteTaskWithOutput({ leaked: SYNTHETIC_TOKEN }), {})],
    ["an error whose name getter throws", () => Object.defineProperty(sensitiveError(), "name", { get: () => { throw sensitiveError(); } })],
    ["a forged AppError (prototype only)", () => Object.assign(Object.create(AppError.prototype) as object, { name: "AppError", code: "CONFLICT", message: "CONFLICT", cause: sensitiveError() })],
    ["a forged AppError with a hostile code", () => Object.assign(Object.create(AppError.prototype) as object, { name: "AppError", code: SYNTHETIC_EMAIL, message: SYNTHETIC_EMAIL })],
    ["an error with a cyclic cause", () => {
      const error = sensitiveError();
      (error as { cause?: unknown }).cause = error;
      return error;
    }],
    ["a non-Error value", () => ({ message: SYNTHETIC_TEXT, email: SYNTHETIC_EMAIL })],
  ])("%s fails closed to a retryable sanitized error", (_label, make) => {
    const handed = toVendorError(make());
    expect(handed).toBeInstanceOf(UnexpectedJobError);
    expect((handed as Error).message).toBe("unexpected_error:unknown");
    expect(vendorDecision(handed)).toBe("retry");
    expectNoLeak(vendorView(handed));
  });
});
