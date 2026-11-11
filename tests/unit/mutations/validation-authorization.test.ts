/**
 * Step 7B-14F1 — the pure model of a one-time LIVE validation authorization (0028): the closed operation, the lifetime
 * limits and the state a reader derives (consumption is final and wins; revocation precedes expiry; a bound one is
 * never bindable again).
 */
import { describe, expect, it } from "vitest";
import {
  VALIDATION_AUTHORIZATION_DEFAULT_LIFETIME_MINUTES,
  VALIDATION_AUTHORIZATION_MAX_LIFETIME_MINUTES,
  VALIDATION_AUTHORIZATION_OPERATION,
  isValidationAuthorizationIssueReason,
  isValidationAuthorizationRevocationReason,
  validationAuthorizationState,
  type ValidationAuthorization,
} from "@/mutations/domain/validation-authorization";

const issuedAt = new Date("2026-11-11T12:00:00.000Z");
const base: ValidationAuthorization = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
  connectedAccountId: "00000000-0000-4000-8000-000000000004",
  targetInteractionId: "00000000-0000-4000-8000-000000000005",
  initiatorUserId: "00000000-0000-4000-8000-000000000006",
  ...VALIDATION_AUTHORIZATION_OPERATION,
  preflightRunReference: "run_synthetic",
  preflightCompletedAt: new Date("2026-11-11T11:55:00.000Z"),
  issuedBy: "ops.synthetic",
  issueReason: "test",
  issuedAt,
  expiresAt: new Date(issuedAt.getTime() + 60 * 60_000),
  revokedAt: null,
  revokedBy: null,
  revocationReason: null,
  intentId: null,
  boundAt: null,
  consumedAt: null,
};
const at = (minutes: number) => new Date(issuedAt.getTime() + minutes * 60_000);

describe("validation authorization model", () => {
  it("names exactly meta + instagram + reply_public; 60 minutes operational, 120 the hard ceiling", () => {
    expect(VALIDATION_AUTHORIZATION_OPERATION).toEqual({ provider: "meta", platform: "instagram", kind: "reply_public" });
    expect(VALIDATION_AUTHORIZATION_DEFAULT_LIFETIME_MINUTES).toBe(60);
    expect(VALIDATION_AUTHORIZATION_MAX_LIFETIME_MINUTES).toBe(120);
  });

  it("derives ISSUED → BOUND → CONSUMED, and REVOKED / EXPIRED", () => {
    expect(validationAuthorizationState(base, at(1))).toBe("ISSUED");
    const bound = { ...base, intentId: "00000000-0000-4000-8000-000000000007", boundAt: at(2) };
    expect(validationAuthorizationState(bound, at(3))).toBe("BOUND");
    expect(validationAuthorizationState({ ...bound, consumedAt: at(4) }, at(5))).toBe("CONSUMED");
    expect(validationAuthorizationState({ ...base, revokedAt: at(1), revokedBy: "ops.synthetic", revocationReason: "superseded" }, at(2))).toBe("REVOKED");
    expect(validationAuthorizationState(base, at(60))).toBe("EXPIRED");
    expect(validationAuthorizationState(bound, at(61))).toBe("EXPIRED");
  });

  it("consumption is final: it wins over expiry; revocation wins over expiry", () => {
    const consumed = { ...base, intentId: "00000000-0000-4000-8000-000000000007", boundAt: at(2), consumedAt: at(3) };
    expect(validationAuthorizationState(consumed, at(500))).toBe("CONSUMED");
    expect(validationAuthorizationState({ ...base, revokedAt: at(1), revokedBy: "ops.synthetic", revocationReason: "incident" }, at(500))).toBe("REVOKED");
  });

  it("closed reason vocabularies", () => {
    expect(isValidationAuthorizationIssueReason("live_validation")).toBe(true);
    expect(isValidationAuthorizationIssueReason("release")).toBe(false);
    expect(isValidationAuthorizationRevocationReason("superseded")).toBe(true);
    expect(isValidationAuthorizationRevocationReason("live_validation")).toBe(false);
  });
});
