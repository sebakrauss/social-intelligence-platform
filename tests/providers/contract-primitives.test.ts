/**
 * Contract primitives: identity and instant parsing, raw references, secret wrapping and error serialization.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CredentialInvalidError,
  OutcomeUnknownError,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TargetNotEligibleError,
  TargetNotFoundError,
  TransientError,
  WebhookRejectedError,
  isDefiniteFailure,
  parseIsoInstant,
  parsePageCursor,
  parseProviderObjectId,
  providerCredential,
  providerObjectKey,
  providerObjectRef,
  rawReference,
  sameProviderObject,
} from "@/integrations/providers/contract";

describe("identity", () => {
  it("accepts opaque printable ids and rejects whitespace, empties and over-long values", () => {
    for (const id of ["123456789", "17841400000000001_9000", "sim-facebook-int-1", "act:1.2"]) expect(parseProviderObjectId(id)).toBe(id);
    for (const id of ["", " 1", "a b", "x".repeat(129), "../etc", 42, null]) expect(parseProviderObjectId(id)).toBeUndefined();
  });

  it("builds frozen references, compares identity and renders a log-safe key", () => {
    const ref = providerObjectRef("instagram", "interaction", "c_1");
    expect(Object.isFrozen(ref)).toBe(true);
    expect(sameProviderObject(ref, providerObjectRef("instagram", "interaction", "c_1"))).toBe(true);
    expect(sameProviderObject(ref, providerObjectRef("facebook", "interaction", "c_1"))).toBe(false);
    expect(providerObjectKey(ref)).toBe("instagram:interaction:c_1");
    expect(() => providerObjectRef("myspace" as never, "content", "x")).toThrow(TypeError);
  });

  it("accepts only canonical UTC instants with milliseconds", () => {
    expect(parseIsoInstant("2026-09-15T12:00:00.000Z")).toBe("2026-09-15T12:00:00.000Z");
    for (const value of ["2026-09-15T12:00:00Z", "2026-09-15T12:00:00.000+02:00", "2026-02-30T00:00:00.000Z", "yesterday"]) {
      expect(parseIsoInstant(value)).toBeUndefined();
    }
  });

  it("raw references are opaque pointers with a validated shape", () => {
    expect(rawReference("simulator", "simulator-v1", "sim://baseline/content/x")).toEqual({ provider: "simulator", apiVersion: "simulator-v1", ref: "sim://baseline/content/x" });
    expect(() => rawReference("simulator", "", "x")).toThrow(TypeError);
    expect(() => rawReference("simulator", "v1", "has spaces")).toThrow(TypeError);
  });

  it("page cursors are bounded opaque tokens", () => {
    expect(parsePageCursor("sim1.eyJvIjoibGlzdCJ9")).toBe("sim1.eyJvIjoibGlzdCJ9");
    expect(parsePageCursor("bad cursor")).toBeUndefined();
    expect(parsePageCursor("x".repeat(513))).toBeUndefined();
  });
});

describe("credentials", () => {
  it("never render their secret: string, JSON, interpolation and inspection are redacted", () => {
    const credential = providerCredential("cred_1", "synthetic-secret-value");
    expect(credential.secret.expose()).toBe("synthetic-secret-value");
    const renderings = [String(credential.secret), JSON.stringify(credential), [credential.secret].join(""), inspect(credential, { depth: 5 })];
    for (const rendering of renderings) expect(rendering).not.toContain("synthetic-secret-value");
    expect(JSON.stringify(credential)).toBe('{"id":"cred_1","secret":"[redacted]"}');
  });

  it("rejects malformed credential ids and empty secrets", () => {
    expect(() => providerCredential("has space", "s")).toThrow(TypeError);
    expect(() => providerCredential("cred_1", "")).toThrow(TypeError);
  });
});

describe("errors", () => {
  const all = [
    new RateLimitedError("listContent", 30),
    new TransientError("getInteraction", "network"),
    new PermissionMissingError("hide", "hide"),
    new TargetNotFoundError("getContent"),
    new TargetNotEligibleError("hide", "unsupported_for_target"),
    new CredentialInvalidError("describeAccount", "expired"),
    new PermanentRejectedError("replyPublicly", "duplicate"),
    new OutcomeUnknownError("replyPrivately"),
  ];

  it("carry a stable code as message and closed-vocabulary details only", () => {
    for (const error of all) {
      expect(error.message).toBe(`provider_${error.kind}`);
      const json = error.toJSON();
      expect(Object.keys(json).sort()).toEqual(["details", "kind", "operation", "retry"]);
      for (const value of Object.values(json.details)) expect(value === null || typeof value === "string" || typeof value === "number").toBe(true);
    }
  });

  it("make retry semantics explicit, with OutcomeUnknown the only non-definite failure", () => {
    expect(all.map((e) => [e.kind, e.retry])).toEqual([
      ["rate_limited", "after_delay"],
      ["transient", "with_backoff"],
      ["permission_missing", "never"],
      ["target_not_found", "never"],
      ["target_not_eligible", "never"],
      ["credential_invalid", "after_recovery"],
      ["permanent_rejected", "never"],
      ["outcome_unknown", "verify_first"],
    ]);
    expect(all.filter((e) => !isDefiniteFailure(e)).map((e) => e.kind)).toEqual(["outcome_unknown"]);
  });

  it("rate limits keep retry-after explicit, including 'not said'", () => {
    expect(new RateLimitedError("listContent", null).toJSON().details).toEqual({ retryAfterSeconds: null });
    expect(() => new RateLimitedError("listContent", -1)).toThrow(TypeError);
    expect(() => new RateLimitedError("listContent", 1.5)).toThrow(TypeError);
  });

  it("webhook rejections expose a reason code only", () => {
    const error = new WebhookRejectedError("invalid_signature");
    expect(error.message).toBe("webhook_rejected_invalid_signature");
    expect(JSON.stringify(error)).toBe('{"reason":"invalid_signature"}');
  });
});
