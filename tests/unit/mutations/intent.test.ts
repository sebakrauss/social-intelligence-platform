/**
 * Step 7B-1 — the mutation intent state machine (mutations/domain/intent): the closed transitions, the terminal
 * statuses, the one executable status, and the status each outcome code belongs to.
 */
import { describe, expect, it } from "vitest";
import {
  INTENT_OUTCOME_CODES,
  INTENT_STATUSES,
  IntentTransitionError,
  MUTATION_KINDS,
  MUTATION_REQUEST_TYPES,
  OUTCOME_STATUS,
  REPLY_TEXT_MAX_CHARS,
  assertTransition,
  isExecutable,
  isIntentOutcomeCode,
  isIntentStatus,
  isTerminal,
  type IntentStatus,
} from "@/mutations/domain/intent";

const ALLOWED: readonly [IntentStatus, IntentStatus][] = [
  ["PENDING", "EXECUTING"],
  ["PENDING", "BLOCKED"],
  ["EXECUTING", "CONFIRMED"],
  ["EXECUTING", "FAILED"],
  ["EXECUTING", "BLOCKED"],
  ["EXECUTING", "OUTCOME_UNKNOWN"],
  ["OUTCOME_UNKNOWN", "CONFIRMED"],
  ["OUTCOME_UNKNOWN", "FAILED"],
];

describe("7B-1: the intent vocabulary is closed", () => {
  it("one kind (reply_public), one request type (human), six statuses, 2200 characters", () => {
    expect([...MUTATION_KINDS]).toEqual(["reply_public"]);
    expect([...MUTATION_REQUEST_TYPES]).toEqual(["human"]);
    expect([...INTENT_STATUSES]).toEqual(["PENDING", "EXECUTING", "CONFIRMED", "FAILED", "BLOCKED", "OUTCOME_UNKNOWN"]);
    expect(REPLY_TEXT_MAX_CHARS).toBe(2200);
    expect(isIntentStatus("PENDING")).toBe(true);
    expect(isIntentStatus("RETRYABLE")).toBe(false);
    expect(isIntentOutcomeCode("RESPONSE_LOST")).toBe(true);
    expect(isIntentOutcomeCode("anything")).toBe(false);
  });

  it("exactly the eight transitions exist; every other pair is refused, including every self-transition", () => {
    for (const [from, to] of ALLOWED) {
      expect(() => {
        assertTransition(from, to);
      }, `${from} → ${to}`).not.toThrow();
    }
    for (const from of INTENT_STATUSES) {
      for (const to of INTENT_STATUSES) {
        if (ALLOWED.some(([a, b]) => a === from && b === to)) continue;
        expect(() => {
          assertTransition(from, to);
        }, `${from} → ${to}`).toThrow(IntentTransitionError);
      }
    }
    // Never back to PENDING, never out of a terminal status, never a second EXECUTING (one provider call per intent).
    for (const [from, to] of [["OUTCOME_UNKNOWN", "EXECUTING"], ["FAILED", "EXECUTING"], ["CONFIRMED", "PENDING"]] as const) {
      expect(() => {
        assertTransition(from, to);
      }).toThrow(IntentTransitionError);
    }
  });

  it("CONFIRMED, FAILED and BLOCKED are terminal; only PENDING executes", () => {
    expect(INTENT_STATUSES.filter(isTerminal)).toEqual(["CONFIRMED", "FAILED", "BLOCKED"]);
    expect(INTENT_STATUSES.filter(isExecutable)).toEqual(["PENDING"]);
  });

  it("every outcome code belongs to exactly one non-success status; CONFIRMED and EXECUTING carry none", () => {
    for (const code of INTENT_OUTCOME_CODES) expect(["BLOCKED", "FAILED", "OUTCOME_UNKNOWN"], code).toContain(OUTCOME_STATUS[code]);
    expect(INTENT_OUTCOME_CODES.filter((code) => OUTCOME_STATUS[code] === "OUTCOME_UNKNOWN")).toEqual(["RESPONSE_LOST", "RUN_INTERRUPTED", "PROVIDER_ERROR_UNCLASSIFIED", "REPLY_IDENTITY_CONFLICT"]);
    // No code ever turns an unknown outcome into a failure: there is no "reconciled not found".
    expect((INTENT_OUTCOME_CODES as readonly string[]).some((code) => /RECONCILED/.test(code))).toBe(false);
    expect(OUTCOME_STATUS.TARGET_ACCOUNT_MISMATCH).toBe("BLOCKED");
    expect(OUTCOME_STATUS.PROVIDER_UNAVAILABLE).toBe("FAILED");
    expect(OUTCOME_STATUS.MODE_NOT_STANDARD).toBe("BLOCKED");
  });
});
