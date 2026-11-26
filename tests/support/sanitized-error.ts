/**
 * W12-LOG-HARDEN-03 F-3: the exact contract of an error the action pipeline lets escape in place of an unexpected
 * one (W12-SEC-01 L-1). A test that injects a failure asserts, through this helper, that the caller receives exactly
 * `UnexpectedServerError` with the expected sanitized message, a frame-less stack, no cause, no own enumerable
 * property, and none of the given original texts in any rendering (String, JSON, util.inspect with hidden fields).
 * What failed is asserted separately by the caller (the step reached, or the injected fault's own counter).
 */
import { inspect } from "node:util";
import { expect } from "vitest";
import { UnexpectedServerError } from "@/platform/observability";

export async function expectSanitizedRejection(promise: Promise<unknown>, message: string, absent: readonly string[] = []): Promise<void> {
  let rejected = false;
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    thrown = error;
  }
  expect(rejected, "expected the pipeline to reject").toBe(true);
  expect(thrown).toBeInstanceOf(UnexpectedServerError);
  const error = thrown as Error;
  expect(error.message).toBe(message);
  expect(error.stack).toBe(`UnexpectedServerError: ${message}`);
  expect("cause" in error).toBe(false);
  expect(Object.keys(error)).toEqual([]);
  const renderings = [String(error), JSON.stringify(error), inspect(error, { showHidden: true, depth: 5 })].join("\n");
  for (const value of absent) expect(renderings).not.toContain(value);
}
