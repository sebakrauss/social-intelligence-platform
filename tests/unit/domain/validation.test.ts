import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { email, list, object, oneOf, optional, text } from "@/domain/validation";

const shape = object({ name: text({ max: 10 }), kind: oneOf(["A", "B"] as const), tags: optional(list(oneOf(["x", "y"] as const), { max: 2 })) });

function failure(run: () => unknown): AppError | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
  return undefined;
}

describe("input validation", () => {
  it("returns typed, trimmed values", () => {
    expect(shape({ name: "  hi ", kind: "A" })).toEqual({ name: "hi", kind: "A", tags: undefined });
    expect(email("  Person@Example.Test ", "email")).toBe("person@example.test");
  });

  it("rejects unknown fields without echoing their names or values", () => {
    const error = failure(() => shape({ name: "hi", kind: "A", isAdmin: "yes, María" }));
    expect(error?.code).toBe("INVALID_INPUT");
    expect(error?.params).toEqual({});
    expect(JSON.stringify(error)).not.toMatch(/isAdmin|María/);
  });

  it("names only the declared field on a bad value", () => {
    const error = failure(() => shape({ name: "x".repeat(11), kind: "A" }));
    expect(error?.toJSON()).toMatchObject({ code: "INVALID_INPUT", params: { field: "name" } });
  });

  it.each([
    ["non-object input", "text"],
    ["array input", []],
    ["null input", null],
    ["wrong enum", { name: "hi", kind: "C" }],
    ["duplicate list entries", { name: "hi", kind: "A", tags: ["x", "x"] }],
    ["too many list entries", { name: "hi", kind: "A", tags: ["x", "y", "x"] }],
    ["empty text", { name: "   ", kind: "A" }],
  ])("rejects %s", (_label, input) => {
    expect(failure(() => shape(input))?.code).toBe("INVALID_INPUT");
  });
});
