import { describe, expect, it } from "vitest";
import { parseCorrelationId } from "@/domain/correlation";
import {
  AppError,
  ERROR_CODES,
  ERROR_DEFINITIONS,
  ERROR_PARAM_NAMES,
  RETRY_CLASSES,
  errorCodeOf,
  isAppError,
  isErrorCode,
  type ErrorCode,
  type ErrorParamsByCode,
  type SafeParamValue,
} from "@/domain/errors";
import { MESSAGE_KEY_PATTERN, isMessageKey } from "@/domain/i18n/message-keys";

// Compile-time guard: every code's parameters are flat, primitive and safe to interpolate.
const paramsAreSafe = (params: ErrorParamsByCode[ErrorCode]): Readonly<Record<string, SafeParamValue | undefined>> =>
  params;

const APPROVED_CODES = [
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "MODE_BLOCKED",
  "CAPABILITY_UNSUPPORTED",
  "CAPABILITY_UNKNOWN",
  "CONNECTION_PROBLEM",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TRANSIENT",
  "PROVIDER_PERMANENT",
  "OUTCOME_UNKNOWN",
  "INVALID_INPUT",
  "CONFLICT",
  "STALE_STATE",
  "PROTECTION_VETO",
  "AI_INVALID_OUTPUT",
  "AI_UNAVAILABLE",
  "AI_REFUSED",
  "AI_BUDGET_EXCEEDED",
  "JOB_FAILED",
];

describe("error taxonomy (TA §44)", () => {
  it("contains exactly the approved codes", () => {
    expect([...ERROR_CODES].sort()).toEqual([...APPROVED_CODES].sort());
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("maps every code to a unique, well-formed message key and a retry class", () => {
    const keys = ERROR_CODES.map((code) => ERROR_DEFINITIONS[code].messageKey);
    for (const code of ERROR_CODES) {
      const definition = ERROR_DEFINITIONS[code];
      expect(isMessageKey(definition.messageKey)).toBe(true);
      expect(definition.messageKey).toMatch(MESSAGE_KEY_PATTERN);
      expect(RETRY_CLASSES).toContain(definition.retry);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("classifies retries per TA §44.1", () => {
    expect(ERROR_DEFINITIONS.PROVIDER_RATE_LIMITED.retry).toBe("retryable");
    expect(ERROR_DEFINITIONS.PROVIDER_TRANSIENT.retry).toBe("retryable");
    expect(ERROR_DEFINITIONS.AI_UNAVAILABLE.retry).toBe("retryable");
    expect(ERROR_DEFINITIONS.CONNECTION_PROBLEM.retry).toBe("after_recovery");
    expect(ERROR_DEFINITIONS.OUTCOME_UNKNOWN.retry).toBe("verify_first");
    expect(ERROR_DEFINITIONS.STALE_STATE.retry).toBe("user_decides");
    expect(ERROR_DEFINITIONS.AI_INVALID_OUTPUT.retry).toBe("limited");
    expect(ERROR_DEFINITIONS.JOB_FAILED.retry).toBe("redrive");
    for (const code of [
      "PERMISSION_DENIED",
      "NOT_FOUND",
      "MODE_BLOCKED",
      "CAPABILITY_UNSUPPORTED",
      "CAPABILITY_UNKNOWN",
      "PROVIDER_PERMANENT",
      "INVALID_INPUT",
      "CONFLICT",
      "PROTECTION_VETO",
      "AI_REFUSED",
      "AI_BUDGET_EXCEEDED",
    ] as const) {
      expect(ERROR_DEFINITIONS[code].retry).toBe("not_retryable");
    }
  });

  it("declares runtime parameter names for every code", () => {
    expect(Object.keys(ERROR_PARAM_NAMES).sort()).toEqual([...ERROR_CODES].sort());
  });

  it("recognizes codes and rejects anything else", () => {
    expect(isErrorCode("MODE_BLOCKED")).toBe(true);
    expect(isErrorCode("mode_blocked")).toBe(false);
    expect(isErrorCode("SOMETHING_ELSE")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});

describe("AppError", () => {
  const correlationId = parseCorrelationId("5f0c1c1e-8d1a-4e43-9a43-2f2ad1f8e8a1");

  it("carries code, message key, params, retry class and correlation ID", () => {
    expect(correlationId).toBeDefined();
    if (correlationId === undefined) return;
    const error = new AppError("CONNECTION_PROBLEM", { platform: "instagram" }, { correlationId });
    expect(error.code).toBe("CONNECTION_PROBLEM");
    expect(error.messageKey).toBe("error.connection_problem");
    expect(error.retry).toBe("after_recovery");
    expect(error.params).toEqual({ platform: "instagram" });
    expect(error.correlationId).toBe(correlationId);
    expect(paramsAreSafe(error.params)).toEqual({ platform: "instagram" });
  });

  it("uses the stable code as message, never implementation prose", () => {
    const error = new AppError("MODE_BLOCKED", {});
    expect(error.message).toBe("MODE_BLOCKED");
    expect(error.name).toBe("AppError");
  });

  it("serializes safely: no stack, no cause", () => {
    const cause = new Error("upstream detail with internal text");
    const error = new AppError("PROVIDER_TRANSIENT", { platform: "tiktok" }, { cause });
    const json = JSON.stringify(error);
    expect(JSON.parse(json)).toEqual({
      code: "PROVIDER_TRANSIENT",
      messageKey: "error.provider_transient",
      params: { platform: "tiktok" },
      retry: "retryable",
    });
    expect(json).not.toContain("upstream detail");
    expect(json).not.toContain("stack");
    expect(error.cause).toBe(cause);
  });

  it("associates a correlation ID without mutating the original", () => {
    if (correlationId === undefined) throw new Error("fixture correlation ID must parse");
    const original = new AppError("NOT_FOUND", {});
    const correlated = original.withCorrelationId(correlationId);
    expect(original.correlationId).toBeUndefined();
    expect(correlated.correlationId).toBe(correlationId);
    expect(correlated.toJSON().correlationId).toBe(correlationId);
  });

  it("freezes params", () => {
    const error = new AppError("PROTECTION_VETO", { excludedCount: 3 });
    expect(Object.isFrozen(error.params)).toBe(true);
  });

  it("identifies taxonomy errors", () => {
    expect(isAppError(new AppError("CONFLICT", {}))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(errorCodeOf(new AppError("JOB_FAILED", {}))).toBe("JOB_FAILED");
    expect(errorCodeOf(new Error("x"))).toBeUndefined();
    expect(errorCodeOf("JOB_FAILED")).toBeUndefined();
  });
});

describe("error params typing", () => {
  it("rejects parameters on codes that declare none (compile-time)", () => {
    // @ts-expect-error MODE_BLOCKED declares no parameters (and the runtime check rejects it too)
    expect(() => new AppError("MODE_BLOCKED", { platform: "instagram" })).toThrow(TypeError);
  });

  it("requires declared parameters (compile-time)", () => {
    // @ts-expect-error CONNECTION_PROBLEM requires { platform } (and the runtime check rejects it too)
    expect(() => new AppError("CONNECTION_PROBLEM", {})).toThrow(TypeError);
  });
});

describe("error params runtime safety (TypeScript bypassed)", () => {
  /** Construct as untyped code would: every value below defeats the compile-time mapping. */
  const construct = (code: ErrorCode, params: unknown): AppError =>
    new AppError(code, params as ErrorParamsByCode[typeof code]);

  const fakeJwt = ["eyJ" + "a".repeat(20), "eyJ" + "b".repeat(20), "c".repeat(20)].join(".");
  const fakeKey = "sk-" + "ant-" + "z".repeat(32);

  it("accepts valid tokens, identifiers and counts", () => {
    expect(construct("CAPABILITY_UNSUPPORTED", { platform: "tiktok" }).params).toEqual({ platform: "tiktok" });
    expect(construct("INVALID_INPUT", {}).params).toEqual({});
    expect(construct("INVALID_INPUT", { field: "brandContext.contactChannel" }).params).toEqual({
      field: "brandContext.contactChannel",
    });
    expect(construct("PROTECTION_VETO", { excludedCount: 0 }).params).toEqual({ excludedCount: 0 });
  });

  it.each([
    ["platform prose instead of a token", "PROVIDER_TRANSIENT", { platform: "Instagram" }],
    ["unknown platform", "PROVIDER_TRANSIENT", { platform: "myspace" }],
    ["comment text as platform", "CONNECTION_PROBLEM", { platform: "ESTAFA. Pagué y no llegó" }],
    ["undeclared extra key", "CONNECTION_PROBLEM", { platform: "facebook", authorName: "María Pérez" }],
    ["params on a code without params", "NOT_FOUND", { commentText: "hola" }],
    ["missing required param", "PROTECTION_VETO", {}],
    ["field value instead of identifier", "INVALID_INPUT", { field: "maria.perez@example.test" }],
    ["field label with spaces", "INVALID_INPUT", { field: "Contact phone number" }],
    ["field as URL", "INVALID_INPUT", { field: "https://example.test/x" }],
    ["field as JWT", "INVALID_INPUT", { field: fakeJwt }],
    ["field as API key", "INVALID_INPUT", { field: fakeKey }],
    ["field as number", "INVALID_INPUT", { field: 42 }],
    ["negative count", "PROTECTION_VETO", { excludedCount: -1 }],
    ["fractional count", "PROTECTION_VETO", { excludedCount: 1.5 }],
    ["non-finite count", "PROTECTION_VETO", { excludedCount: Number.POSITIVE_INFINITY }],
    ["count as text", "PROTECTION_VETO", { excludedCount: "3 complaints from María" }],
    ["params not an object", "NOT_FOUND", "free text"],
    ["params null", "NOT_FOUND", null],
    ["params array", "NOT_FOUND", ["x"]],
  ] as const)("rejects %s", (_label, code, params) => {
    expect(() => construct(code, params)).toThrow(TypeError);
  });

  it("never echoes the offending value or undeclared key in the programming error", () => {
    const probe = (params: unknown): string => {
      try {
        construct("INVALID_INPUT", params);
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
      return "";
    };
    expect(probe({ field: "maria.perez@example.test" })).not.toContain("maria");
    expect(probe({ field: "brandContext", authorHandle: "@maria" })).not.toContain("authorHandle");
    expect(probe({ field: fakeKey })).not.toContain(fakeKey);
  });
});
