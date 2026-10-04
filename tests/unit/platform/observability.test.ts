import { describe, expect, it } from "vitest";
import { parseCorrelationId, parseRequestId } from "@/domain/correlation";
import {
  continueOrStartCorrelation,
  createLogger,
  newCorrelationId,
  newRequestId,
  type LogFields,
} from "@/platform/observability";

/** Synthetic credential-shaped values, assembled at runtime so this file never contains a literal secret. */
const fakeJwt = ["eyJ" + "a".repeat(20), "eyJ" + "b".repeat(20), "c".repeat(20)].join(".");
const fakeAnthropicKey = "sk-" + "ant-" + "d".repeat(32);
const fakeConnectionString = "postgres" + "://app_user:" + "Sup3rS3cretValue" + "@db.example.test:5432/app";

const PROHIBITED_CONTENT = {
  commentText: "¿Cuánto cuesta y hacen envíos a regiones?",
  authorName: "María Pérez",
  authorHandle: "@maria.perez",
  brandContext: "Free shipping over USD 50",
  replyText: "Thanks, we'll send you the details",
  prompt: "Classify the following comment",
  aiResponse: "{\"intent\":\"purchase_question\"}",
  accessToken: fakeJwt,
  password: "Sup3rS3cretValue",
  connectionString: fakeConnectionString,
};

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

const fixedNow = (): Date => new Date("2026-10-04T12:00:00.000Z");

describe("structured logger", () => {
  it("emits one JSON line with the declared fields", () => {
    const { lines, sink } = capture();
    const correlationId = newCorrelationId();
    const logger = createLogger({ sink, now: fixedNow, environment: "test" });
    logger.info("request.completed", {
      module: "platform.observability",
      operation: "logger.test",
      correlationId,
      organizationId: "org_123",
      workspaceId: "ws_456",
      actorType: "user",
      durationMs: 12.5,
      outcome: "error",
      errorCode: "MODE_BLOCKED",
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      timestamp: "2026-10-04T12:00:00.000Z",
      level: "info",
      event: "request.completed",
      environment: "test",
      module: "platform.observability",
      operation: "logger.test",
      correlationId,
      organizationId: "org_123",
      workspaceId: "ws_456",
      actorType: "user",
      durationMs: 12.5,
      outcome: "error",
      errorCode: "MODE_BLOCKED",
    });
  });

  it("drops undeclared fields and never serializes prohibited content", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, now: fixedNow });
    // Spread objects bypass excess-property checks, which is exactly the accident the sanitizer guards against.
    logger.error("reply.failed", { module: "replies", ...PROHIBITED_CONTENT });
    const line = lines[0] ?? "";
    for (const value of Object.values(PROHIBITED_CONTENT)) {
      expect(line).not.toContain(value);
    }
    expect(line).not.toContain("Sup3rS3cretValue");
    for (const key of Object.keys(PROHIBITED_CONTENT)) {
      expect(line).not.toContain(key);
    }
    const record = JSON.parse(line) as { droppedFieldCount: number; module: string };
    expect(record.module).toBe("replies");
    expect(record.droppedFieldCount).toBe(Object.keys(PROHIBITED_CONTENT).length);
  });

  it("never serializes the name of an unknown field, even when the key itself carries personal data", () => {
    const { lines, sink } = capture();
    const personalKey = ["comment", "by", "maria.perez@example.test", "phone", "+56 9 1234 5678"].join(" ");
    const personalValue = "Llegó roto, quiero mi reembolso";
    const fields: Record<string, unknown> = { module: "replies", operation: "send" };
    fields[personalKey] = personalValue;
    fields[["customer", "maria", "perez"].join("_")] = "x";
    createLogger({ sink, now: fixedNow }).info("reply.sent", fields);
    const line = lines[0] ?? "";
    expect(line).not.toContain(personalValue);
    expect(line).not.toContain(personalKey);
    expect(line).not.toContain("maria");
    expect(line).not.toContain("5678");
    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-10-04T12:00:00.000Z",
      level: "info",
      event: "reply.sent",
      module: "replies",
      operation: "send",
      droppedFieldCount: 2,
    });
  });

  it("redacts declared fields whose values are free text or credential-shaped", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, now: fixedNow });
    logger.warn("connection.degraded", {
      module: fakeAnthropicKey,
      operation: "check health of María's page",
      workspaceId: fakeConnectionString,
      organizationId: fakeJwt,
      correlationId: fakeJwt,
      actorType: "María Pérez",
      errorCode: "Database password is wrong",
      durationMs: -1,
    } as unknown as LogFields);
    const line = lines[0] ?? "";
    expect(line).not.toContain(fakeAnthropicKey);
    expect(line).not.toContain(fakeJwt);
    expect(line).not.toContain("Sup3rS3cretValue");
    expect(line).not.toContain("María");
    expect(line).not.toContain("password");
    const record = JSON.parse(line) as { redactedFields: string[] };
    expect(record.redactedFields.sort()).toEqual(
      ["actorType", "correlationId", "durationMs", "errorCode", "module", "operation", "organizationId", "workspaceId"].sort(),
    );
  });

  it("rejects a free-text event name", () => {
    const { lines, sink } = capture();
    createLogger({ sink, now: fixedNow }).info("Comment from María: hello there");
    const line = lines[0] ?? "";
    expect(line).not.toContain("María");
    expect(JSON.parse(line)).toMatchObject({ event: "invalid_event", redactedFields: ["event"] });
  });

  it("applies the minimum level and child context", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, now: fixedNow, minLevel: "warn" }).child({ module: "jobs.outbox", workspaceId: "ws_1" });
    logger.info("skipped.event");
    logger.warn("kept.event", { operation: "dispatch" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "kept.event", module: "jobs.outbox", workspaceId: "ws_1", operation: "dispatch" });
  });
});

describe("correlation IDs", () => {
  it("generates well-formed, unique IDs", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(parseCorrelationId(a)).toBe(a);
    expect(a).not.toBe(b);
    expect(parseRequestId(newRequestId())).toBeDefined();
  });

  it("continues a valid incoming ID and replaces anything else", () => {
    const incoming = newCorrelationId();
    expect(continueOrStartCorrelation(incoming)).toBe(incoming);
    const replaced = continueOrStartCorrelation("not a valid id / with spaces");
    expect(replaced).not.toBe("not a valid id / with spaces");
    expect(parseCorrelationId(replaced)).toBe(replaced);
    expect(parseCorrelationId(undefined)).toBeUndefined();
    expect(parseCorrelationId(fakeConnectionString)).toBeUndefined();
  });
});
