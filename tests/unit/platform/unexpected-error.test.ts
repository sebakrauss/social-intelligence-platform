/**
 * W12-SEC-01 L-1/L-2: unexpected errors are reduced to a closed-vocabulary kind (plus a validated SQLSTATE). Nothing
 * of the original error (message, stack, detail, constraint, cause, own properties) survives in the sanitized error,
 * in any of the ways a runtime or vendor can print or serialize it.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ERROR_KINDS,
  UnexpectedJobError,
  UnexpectedServerError,
  describeUnexpectedError,
  isSqlState,
  isTrustedAppError,
  newCorrelationId,
} from "@/platform/observability";
import { AppError } from "@/domain/errors";

/** Synthetic sensitive values, assembled at runtime so this file holds no literal credential or address. */
const SYNTHETIC = {
  jwt: ["eyJ" + "h".repeat(24), "eyJ" + "p".repeat(24), "s".repeat(24)].join("."),
  email: ["synthetic.person", "example.test"].join("@"),
  phone: "+56 9 " + "1234 5678",
  comment: "Mi pedido sintético nunca llegó y nadie responde",
  token: "tok_" + "z".repeat(40),
};
const ALL_VALUES = Object.values(SYNTHETIC);

/** Every way the sanitized error can be rendered: none of them may contain a synthetic value. */
function renderings(error: Error): string[] {
  return [error.message, String(error.stack), JSON.stringify(error), String(error), inspect(error, { depth: 10, showHidden: true }), error.name];
}

function expectClean(error: Error): void {
  for (const rendering of renderings(error)) {
    for (const value of ALL_VALUES) expect(rendering).not.toContain(value);
    expect(rendering).not.toMatch(/example\.test|eyJ|tok_|sintético|5678/);
  }
  expect("cause" in error).toBe(false);
  expect(Object.keys(error)).toEqual([]);
}

/** A driver-like PostgreSQL error carrying values in message, detail, constraint and a nested cause. */
function pgLikeError(code: string): Error {
  const error = new Error(`duplicate key value violates unique constraint: Key (email)=(${SYNTHETIC.email}) ${SYNTHETIC.comment}`);
  Object.assign(error, {
    code,
    severity: "ERROR",
    detail: `Key (token)=(${SYNTHETIC.jwt}) already exists.`,
    constraint: `idx_${SYNTHETIC.token}`,
    hint: SYNTHETIC.phone,
  });
  return error;
}

describe("describeUnexpectedError", () => {
  it("1: an unknown error whose message simulates a token yields only `unknown`", () => {
    const error = new Error(`refresh failed for Bearer ${SYNTHETIC.jwt}`);
    expect(describeUnexpectedError(error)).toEqual({ errorKind: "unknown" });
    expectClean(new UnexpectedServerError(describeUnexpectedError(error)));
    expectClean(new UnexpectedJobError(describeUnexpectedError(error)));
  });

  it("2: an unknown error with an email and personal data yields only `unknown`", () => {
    const error = Object.assign(new Error(`delivery to ${SYNTHETIC.email} (${SYNTHETIC.phone}) failed`), {
      recipient: SYNTHETIC.email,
      payload: { text: SYNTHETIC.comment },
    });
    const description = describeUnexpectedError(error);
    expect(description).toEqual({ errorKind: "unknown" });
    expectClean(new UnexpectedServerError(description));
  });

  it("3: a nested cause is followed for its kind only; its text never surfaces", () => {
    const driver = pgLikeError("23505");
    const wrapped = new Error(`Failed query: insert ... params: ${SYNTHETIC.email},${SYNTHETIC.token}`, { cause: driver });
    const outer = new Error(`command failed: ${SYNTHETIC.comment}`, { cause: wrapped });
    expect(describeUnexpectedError(outer)).toEqual({ errorKind: "database", sqlState: "23505" });
    const sanitized = new UnexpectedServerError(describeUnexpectedError(outer));
    expect(sanitized.message).toBe("unexpected_error:database:23505");
    expectClean(sanitized);
  });

  it("4: a stack holding a sensitive string is never copied", () => {
    const error = new Error("boom");
    error.stack = `Error: boom\n    at handler (/srv/${SYNTHETIC.token}/${SYNTHETIC.email}.ts:1:1)`;
    const sanitized = new UnexpectedServerError(describeUnexpectedError(error));
    expect(sanitized.stack).toBe("UnexpectedServerError: unexpected_error:unknown");
    expectClean(sanitized);
  });

  it("5: a PostgreSQL error with a valid SQLSTATE yields `database` and that SQLSTATE only", () => {
    for (const code of ["23505", "23503", "42501", "40001", "57014", "08006", "P0001", "XX000"]) {
      const description = describeUnexpectedError(pgLikeError(code));
      expect(description).toEqual({ errorKind: "database", sqlState: code });
      const sanitized = new UnexpectedServerError(description);
      expect(sanitized.message).toBe(`unexpected_error:database:${code}`);
      expectClean(sanitized);
    }
  });

  it("6: a malformed or non-SQLSTATE code is never reported as a SQLSTATE", () => {
    for (const code of ["2350", "235055", "23-05", "abcde", "EPIPE", "ZZ999", "23505 ", SYNTHETIC.email]) {
      expect(describeUnexpectedError(Object.assign(new Error("x"), { code })).sqlState).toBeUndefined();
      expect(isSqlState(code)).toBe(false);
    }
    // EPIPE is a socket error code, not a SQLSTATE (its class "EP" does not exist).
    expect(describeUnexpectedError(Object.assign(new Error("x"), { code: "EPIPE" }))).toEqual({ errorKind: "network" });
    // A description forged with an invalid SQLSTATE still renders without it.
    expect(new UnexpectedServerError({ errorKind: "database", sqlState: SYNTHETIC.email }).message).toBe("unexpected_error:database");
    expect(new UnexpectedServerError({ errorKind: "forged" as never }).message).toBe("unexpected_error:unknown");
  });

  it("classifies network, timeout, abort and type errors by code, name or class; anything else is unknown", () => {
    expect(describeUnexpectedError(Object.assign(new Error(SYNTHETIC.email), { code: "ECONNREFUSED" }))).toEqual({ errorKind: "network" });
    expect(describeUnexpectedError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }))).toEqual({ errorKind: "network" });
    expect(describeUnexpectedError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toEqual({ errorKind: "timeout" });
    expect(describeUnexpectedError(new DOMException("t", "TimeoutError"))).toEqual({ errorKind: "timeout" });
    expect(describeUnexpectedError(new DOMException("a", "AbortError"))).toEqual({ errorKind: "aborted" });
    expect(describeUnexpectedError(new TypeError(SYNTHETIC.comment))).toEqual({ errorKind: "type_error" });
    for (const value of [undefined, null, 42, SYNTHETIC.email, { message: SYNTHETIC.jwt }, Symbol("s")]) {
      expect(describeUnexpectedError(value)).toEqual({ errorKind: "unknown" });
    }
  });

  it("fails closed on hostile shapes (throwing getters, proxies, cycles)", () => {
    const throwing = Object.defineProperty(new Error("x"), "code", { get: () => { throw new Error(SYNTHETIC.token); } });
    expect(describeUnexpectedError(throwing)).toEqual({ errorKind: "unknown" });
    const proxy = new Proxy({}, { get: () => { throw new Error(SYNTHETIC.token); }, getPrototypeOf: () => { throw new Error(SYNTHETIC.token); } });
    expect(describeUnexpectedError(proxy)).toEqual({ errorKind: "unknown" });
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(describeUnexpectedError(cyclic)).toEqual({ errorKind: "unknown" });
  });

  it("only ever returns a kind of the closed vocabulary", () => {
    const inputs: unknown[] = [new Error("x"), pgLikeError("23505"), new TypeError("x"), Object.assign(new Error("x"), { code: "ENOTFOUND" })];
    for (const input of inputs) expect(ERROR_KINDS).toContain(describeUnexpectedError(input).errorKind);
  });
});

describe("sanitized error classes", () => {
  it("carry a fixed name, a fixed-shape message, a frame-less stack, no cause and no enumerable property", () => {
    const server = new UnexpectedServerError({ errorKind: "database", sqlState: "23505" });
    expect(server).toBeInstanceOf(Error);
    expect(server.name).toBe("UnexpectedServerError");
    expect(server.stack).toBe("UnexpectedServerError: unexpected_error:database:23505");
    expect(JSON.stringify(server)).toBe("{}");
    expect(String(server)).toBe("UnexpectedServerError: unexpected_error:database:23505");
    const job = new UnexpectedJobError({ errorKind: "network" });
    expect(job.name).toBe("UnexpectedJobError");
    expect(job.message).toBe("unexpected_error:network");
    expect(job.stack).toBe("UnexpectedJobError: unexpected_error:network");
    // The vendor's executor treats only these names as non-retryable: the sanitized job error is not one of them.
    expect(["AbortTaskRunError", "TaskPayloadParsedError", "TriggerInternalError"]).not.toContain(job.name);
  });
});

describe("W12-LOG-HARDEN-03 F-2: hostile values and AppError authenticity", () => {
  it("a revoked proxy and a proxy with throwing traps describe as unknown", () => {
    const { proxy, revoke } = Proxy.revocable(pgLikeError("23505"), {});
    revoke();
    expect(describeUnexpectedError(proxy)).toEqual({ errorKind: "unknown" });
    expect(describeUnexpectedError(new Proxy(pgLikeError("23505"), { get: () => { throw new Error(SYNTHETIC.token); } }))).toEqual({ errorKind: "unknown" });
  });

  it("accepts AppErrors exactly as the constructor builds them (with or without cause and correlation id)", () => {
    expect(isTrustedAppError(new AppError("CONFLICT", {}))).toBe(true);
    expect(isTrustedAppError(new AppError("PROVIDER_TRANSIENT", { platform: "instagram" }, { cause: new Error("x") }))).toBe(true);
    expect(isTrustedAppError(new AppError("NOT_FOUND", {}).withCorrelationId(newCorrelationId()))).toBe(true);
  });

  it("rejects forged, mutated or proxied AppErrors, and never throws", () => {
    const forged = Object.assign(Object.create(AppError.prototype) as object, { name: "AppError", code: "CONFLICT", message: "CONFLICT" });
    const rewritten = Object.assign(new AppError("CONFLICT", {}), { message: SYNTHETIC.comment });
    const extra = Object.assign(new AppError("CONFLICT", {}), { leaked: SYNTHETIC.token });
    const wrongCode = Object.assign(new AppError("CONFLICT", {}), { code: SYNTHETIC.email });
    const proxied = new Proxy(new AppError("CONFLICT", {}), {});
    const hostile = new Proxy(new AppError("CONFLICT", {}), { getPrototypeOf: () => { throw new Error(SYNTHETIC.token); } });
    const { proxy: revoked, revoke } = Proxy.revocable(new AppError("CONFLICT", {}), {});
    revoke();
    for (const value of [forged, rewritten, extra, wrongCode, proxied, hostile, revoked, new Error("CONFLICT"), { code: "CONFLICT" }, null]) {
      expect(isTrustedAppError(value)).toBe(false);
    }
  });
});
