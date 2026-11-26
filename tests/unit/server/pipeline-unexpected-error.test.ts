/**
 * W12-SEC-01 L-1: the action pipeline never lets an unexpected (non-AppError) error escape with its own message,
 * stack, cause or properties: it logs the failure's kind only and throws an UnexpectedServerError. AppError results,
 * authorization, rollback and post-commit semantics are unchanged, and Next.js control-flow signals pass through.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { object } from "@/domain/validation";
import { UnexpectedServerError, createLogger } from "@/platform/observability";
import { createActionPipeline, type AuditDraft, type WorkspaceCommand } from "@/server/pipeline";
import { isFrameworkControlFlow } from "@/server/pipeline/pipeline";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { FakeIdentity, FixedClock, InMemoryUnitOfWork, emailOf, sequentialIds, userId, verifiedUser } from "../../support/in-memory";

const OWNER = userId(1);
const INVITEE = userId(5);

/** Synthetic sensitive values, assembled at runtime. */
const SECRET_TOKEN = "tok_" + "q".repeat(40);
const SYNTHETIC_EMAIL = ["leaky.person", "example.test"].join("@");
const SYNTHETIC_COMMENT = "Texto de comentario sintético que no debe salir";

async function setup() {
  const h = createHarness();
  h.as(OWNER);
  const organizationId = await h.createOrganization(OWNER);
  const workspaceId = await h.createWorkspace(OWNER, organizationId);
  h.steps.length = 0;
  h.logLines.length = 0;
  return { ...h, organizationId, workspaceId };
}

function throwingCommand(failure: () => unknown): WorkspaceCommand<object, string, string> {
  return {
    scope: "workspace",
    name: "test.throwing_action",
    permission: "workflow.internal",
    requiresStandardMode: false,
    validate: object({}),
    // Deliberately rejects with arbitrary (also non-Error) values.
    execute: () => Promise.resolve().then(() => {
      throw failure();
    }),
    audit: (): AuditDraft | undefined => undefined,
    respond: (value) => value,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function expectNoLeak(texts: readonly string[], values: readonly string[]): void {
  for (const text of texts) for (const value of values) expect(text).not.toContain(value);
}

function failedLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record["event"] === "pipeline.command.failed");
}

describe("unexpected error inside the unit of work (execute)", () => {
  it("throws a sanitized error, logs only the kind, and rolls the unit of work back", async () => {
    const h = await setup();
    const rollbacks = h.unitOfWork.rollbacks;
    const commits = h.unitOfWork.commits;
    const original = Object.assign(new Error(`failed for ${SYNTHETIC_EMAIL}: ${SYNTHETIC_COMMENT}`), { token: SECRET_TOKEN });
    const thrown = await rejection(h.pipeline.run(throwingCommand(() => original), { workspaceId: h.workspaceId, input: {} }));

    expect(thrown).toBeInstanceOf(UnexpectedServerError);
    expect(thrown).not.toBe(original);
    expect((thrown as Error).message).toBe("unexpected_error:unknown");
    expect("cause" in (thrown as Error)).toBe(false);
    expect(h.unitOfWork.rollbacks).toBe(rollbacks + 1);
    expect(h.unitOfWork.commits).toBe(commits);
    expectNoLeak([String((thrown as Error).stack), inspect(thrown, { showHidden: true }), JSON.stringify(thrown), ...h.logLines], [SYNTHETIC_EMAIL, SYNTHETIC_COMMENT, SECRET_TOKEN]);

    // The existing finish line is unchanged (outcome error, no code); one new line carries the kind only.
    const records = h.logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record["event"] === "pipeline.command.finished")).toEqual([expect.objectContaining({ outcome: "error" })]);
    expect(records.find((record) => record["event"] === "pipeline.command.finished")).not.toHaveProperty("errorCode");
    expect(failedLines(h.logLines)).toEqual([
      expect.objectContaining({ level: "error", operation: "test.throwing_action", outcome: "error", errorKind: "unknown" }),
    ]);
    expect(failedLines(h.logLines)[0]).not.toHaveProperty("droppedFieldCount");
    expect(typeof failedLines(h.logLines)[0]?.["correlationId"]).toBe("string");
  });

  it("keeps a database failure's SQLSTATE (only) for diagnosis", async () => {
    const h = await setup();
    const driver = Object.assign(new Error(`Key (email)=(${SYNTHETIC_EMAIL}) already exists`), { code: "23505", detail: SECRET_TOKEN });
    const thrown = await rejection(h.pipeline.run(throwingCommand(() => new Error("Failed query", { cause: driver })), { workspaceId: h.workspaceId, input: {} }));
    expect((thrown as Error).message).toBe("unexpected_error:database:23505");
    expect(failedLines(h.logLines)).toEqual([expect.objectContaining({ errorKind: "database", sqlState: "23505" })]);
    expectNoLeak([String((thrown as Error).stack), ...h.logLines], [SYNTHETIC_EMAIL, SECRET_TOKEN]);
  });

  it("sanitizes a thrown non-Error value too", async () => {
    const h = await setup();
    const thrown = await rejection(h.pipeline.run(throwingCommand(() => ({ message: SYNTHETIC_COMMENT, email: SYNTHETIC_EMAIL })), { workspaceId: h.workspaceId, input: {} }));
    expect(thrown).toBeInstanceOf(UnexpectedServerError);
    expectNoLeak([String((thrown as Error).stack), ...h.logLines], [SYNTHETIC_EMAIL, SYNTHETIC_COMMENT]);
  });
});

describe("AppError behaviour is unchanged", () => {
  it("7: an AppError from the command is still a normalized error result, with no failure line", async () => {
    const h = await setup();
    const rollbacks = h.unitOfWork.rollbacks;
    const result = await h.pipeline.run(throwingCommand(() => new AppError("CONFLICT", {})), { workspaceId: h.workspaceId, input: {} });
    expect(errorCode(result)).toBe("CONFLICT");
    expect(result.status === "error" ? result.error.message : "").toBe("CONFLICT");
    expect(h.unitOfWork.rollbacks).toBe(rollbacks + 1);
    expect(failedLines(h.logLines)).toEqual([]);
    expect(h.logLines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ event: "pipeline.command.finished", outcome: "error", errorCode: "CONFLICT" }),
    ]);
  });

  it("authorization is unchanged: a non-member is NOT_FOUND, a member without the permission is PERMISSION_DENIED", async () => {
    const h = await setup();
    h.as(userId(9));
    const outsider = await h.pipeline.run(throwingCommand(() => new Error("never reached")), { workspaceId: h.workspaceId, input: {} });
    expect(errorCode(outsider)).toBe("NOT_FOUND");
    await h.addMember(OWNER, h.workspaceId, userId(3), "ANALYST_VIEWER");
    h.as(userId(3));
    h.logLines.length = 0;
    h.steps.length = 0;
    const denied = await h.pipeline.run({ ...throwingCommand(() => new Error("never reached")), permission: "members.manage" }, { workspaceId: h.workspaceId, input: {} });
    expect(errorCode(denied)).toBe("PERMISSION_DENIED");
    expect(h.steps).not.toContain("execute");
    expect(failedLines(h.logLines)).toEqual([]);
  });

  it("an AppError thrown outside the unit of work still escapes unchanged (same instance)", async () => {
    const h = await setup();
    const appError = new AppError("CONFLICT", {});
    h.identity.getVerifiedUser = () => Promise.reject(appError);
    const thrown = await rejection(h.pipeline.run(throwingCommand(() => new Error("x")), { workspaceId: h.workspaceId, input: {} }));
    expect(thrown).toBe(appError);
    expect(failedLines(h.logLines)).toEqual([]);
  });
});

describe("8: an unexpected error in getVerifiedUser", () => {
  it("is sanitized before any tenant work, and nothing is committed or rolled back", async () => {
    const h = await setup();
    const commits = h.unitOfWork.commits;
    const rollbacks = h.unitOfWork.rollbacks;
    h.identity.getVerifiedUser = () => Promise.reject(new Error(`auth server said: session ${SECRET_TOKEN} for ${SYNTHETIC_EMAIL}`));
    const thrown = await rejection(h.pipeline.run(throwingCommand(() => new Error("x")), { workspaceId: h.workspaceId, input: {} }));
    expect(thrown).toBeInstanceOf(UnexpectedServerError);
    expect(h.steps).toEqual(["authenticate"]);
    expect(h.unitOfWork.commits).toBe(commits);
    expect(h.unitOfWork.rollbacks).toBe(rollbacks);
    expect(failedLines(h.logLines)).toEqual([expect.objectContaining({ errorKind: "unknown" })]);
    expectNoLeak([String((thrown as Error).stack), inspect(thrown), ...h.logLines], [SECRET_TOKEN, SYNTHETIC_EMAIL]);
  });
});

describe("9: an unexpected error in afterCommit (invitation delivery)", () => {
  it("is sanitized; the committed invitation stays committed exactly as before; email and token never surface", async () => {
    const h = await setup();
    const seen: { email?: string; token?: string } = {};
    h.delivery.deliver = (message) => {
      seen.email = message.recipientEmail;
      seen.token = message.rawToken;
      return Promise.reject(new Error(`SMTP 550 rejected ${message.recipientEmail} link token=${message.rawToken}`));
    };
    const commits = h.unitOfWork.commits;
    const before = h.unitOfWork.state.invitations.size;
    const thrown = await rejection(h.pipeline.run(h.commands.inviteToWorkspace, { workspaceId: h.workspaceId, input: { recipientEmail: emailOf(INVITEE), role: "RESPONDER" } }));

    expect(thrown).toBeInstanceOf(UnexpectedServerError);
    expect(h.steps.at(-1)).toBe("after_commit");
    // Post-commit semantics unchanged: the transaction had committed before delivery ran.
    expect(h.unitOfWork.commits).toBe(commits + 1);
    expect(h.unitOfWork.state.invitations.size).toBe(before + 1);
    expect(seen.email).toBe(emailOf(INVITEE));
    expect(typeof seen.token).toBe("string");
    expectNoLeak(
      [(thrown as Error).message, String((thrown as Error).stack), inspect(thrown, { showHidden: true }), JSON.stringify(thrown), ...h.logLines],
      [seen.email ?? "", seen.token ?? ""],
    );
    expect(failedLines(h.logLines)).toEqual([expect.objectContaining({ operation: "tenancy.invitation.create_workspace", errorKind: "unknown" })]);
  });

  it("a delivery that succeeds is unchanged", async () => {
    const h = await setup();
    expectOk(await h.pipeline.run(h.commands.inviteToWorkspace, { workspaceId: h.workspaceId, input: { recipientEmail: emailOf(INVITEE), role: "RESPONDER" } }));
    expect(h.delivery.delivered).toHaveLength(1);
    expect(failedLines(h.logLines)).toEqual([]);
  });
});

describe("Next.js control-flow signals pass through unchanged", () => {
  it.each([
    ["redirect", "NEXT_REDIRECT;replace;/onboarding;307;"],
    ["notFound", "NEXT_HTTP_ERROR_FALLBACK;404"],
    ["dynamic usage", "DYNAMIC_SERVER_USAGE"],
    ["bailout to CSR", "BAILOUT_TO_CLIENT_SIDE_RENDERING"],
  ])("%s", async (_label, digest) => {
    const h = await setup();
    const signal = Object.assign(new Error(digest), { digest });
    expect(isFrameworkControlFlow(signal)).toBe(true);
    const thrown = await rejection(h.pipeline.run(throwingCommand(() => signal), { workspaceId: h.workspaceId, input: {} }));
    expect(thrown).toBe(signal);
    expect(failedLines(h.logLines)).toEqual([]);
  });

  it("an arbitrary digest is not a control-flow signal", () => {
    for (const digest of ["NEXT_REDIRECT", "NEXT_REDIRECTX;", SYNTHETIC_EMAIL, "123"]) expect(isFrameworkControlFlow(Object.assign(new Error("x"), { digest }))).toBe(false);
    for (const value of [undefined, null, "DYNAMIC_SERVER_USAGE", { digest: 1 }]) expect(isFrameworkControlFlow(value)).toBe(false);
  });
});

/** W12-LOG-HARDEN-03 F-2/F-5: hostile values, thrown where the guard is the only protection (outside the unit of work). */
function hostileValues(): readonly (readonly [string, () => unknown])[] {
  const sensitive = (): Error => Object.assign(new Error(`${SYNTHETIC_EMAIL} ${SECRET_TOKEN}`), { token: SECRET_TOKEN });
  return [
    ["a revoked proxy", () => {
      const { proxy, revoke } = Proxy.revocable(sensitive(), {});
      revoke();
      return proxy;
    }],
    ["a proxy whose getPrototypeOf throws", () => new Proxy(sensitive(), { getPrototypeOf: () => { throw sensitive(); } })],
    ["a proxy over a genuine AppError", () => new Proxy(new AppError("CONFLICT", {}, { cause: sensitive() }), {})],
    ["an error whose name getter throws", () => Object.defineProperty(sensitive(), "name", { get: () => { throw sensitive(); } })],
    ["an error whose digest getter throws", () => Object.defineProperty(sensitive(), "digest", { get: () => { throw sensitive(); } })],
    ["an error with an accessor digest that looks valid", () => Object.defineProperty(sensitive(), "digest", { get: () => "NEXT_REDIRECT;replace;/x;307;" })],
    ["a plain object forging a prerender signal", () => ({ digest: "NEXT_PRERENDER_INTERRUPTED", message: SYNTHETIC_EMAIL, token: SECRET_TOKEN })],
    ["a non-Error value", () => ({ message: SYNTHETIC_COMMENT, email: SYNTHETIC_EMAIL })],
    ["an error with a cyclic cause", () => {
      const error = sensitive();
      (error as { cause?: unknown }).cause = error;
      return error;
    }],
    ["a forged AppError (prototype only)", () => Object.assign(Object.create(AppError.prototype) as object, { name: "AppError", code: "CONFLICT", message: SYNTHETIC_EMAIL, cause: sensitive() })],
    ["a genuine AppError carrying an extra sensitive field", () => Object.assign(new AppError("CONFLICT", {}), { leaked: SECRET_TOKEN })],
    ["an AppError whose message was rewritten", () => Object.assign(new AppError("CONFLICT", {}), { message: SYNTHETIC_COMMENT })],
  ];
}

describe("F-2: fail-closed guard against hostile values", () => {
  it.each(hostileValues())("%s thrown by getVerifiedUser reaches the caller only as the sanitized error", async (_label, make) => {
    const h = await setup();
    h.identity.getVerifiedUser = () => Promise.resolve().then(() => {
      throw make();
    });
    const thrown = await rejection(h.pipeline.run(throwingCommand(() => new Error("never reached")), { workspaceId: h.workspaceId, input: {} }));
    expect(thrown).toBeInstanceOf(UnexpectedServerError);
    expect((thrown as Error).message).toBe("unexpected_error:unknown");
    expect("cause" in (thrown as Error)).toBe(false);
    expectNoLeak([String((thrown as Error).stack), inspect(thrown, { showHidden: true }), JSON.stringify(thrown), ...h.logLines], [SYNTHETIC_EMAIL, SECRET_TOKEN, SYNTHETIC_COMMENT]);
  });

  it.each(hostileValues())("%s thrown by execute is rolled back and reaches the caller sanitized or as the unchanged AppError result", async (_label, make) => {
    const h = await setup();
    const rollbacks = h.unitOfWork.rollbacks;
    let outcome: unknown;
    try {
      outcome = await h.pipeline.run(throwingCommand(make), { workspaceId: h.workspaceId, input: {} });
    } catch (error) {
      outcome = error;
    }
    expect(h.unitOfWork.rollbacks).toBe(rollbacks + 1);
    if (outcome instanceof UnexpectedServerError) {
      expectNoLeak([String(outcome.stack), inspect(outcome, { showHidden: true }), JSON.stringify(outcome), ...h.logLines], [SYNTHETIC_EMAIL, SECRET_TOKEN, SYNTHETIC_COMMENT]);
    } else {
      // Unchanged inner AppError branch (instanceof AppError): the normalized result, RE-CREATED from code and params
      // by withCorrelationId: a rewritten message or an extra field does not survive. (Its cause does: N-1.)
      expect(errorCode(outcome as never)).toBe("CONFLICT");
      const returned = (outcome as { readonly error: AppError }).error;
      expect(returned.message).toBe("CONFLICT");
      expect(Object.keys(returned).sort()).toEqual(["code", "correlationId", "messageKey", "name", "params", "retry"]);
      expectNoLeak([returned.message, JSON.stringify(returned), ...h.logLines], [SYNTHETIC_EMAIL, SECRET_TOKEN, SYNTHETIC_COMMENT]);
    }
  });

  it("an internal failure of the guard itself (a throwing log sink) still yields only the fixed fallback", async () => {
    const identity = new FakeIdentity();
    const pipeline = createActionPipeline({
      identity,
      unitOfWork: new InMemoryUnitOfWork(),
      clock: new FixedClock().read,
      newId: sequentialIds(),
      logger: createLogger({ sink: () => { throw new Error(`sink failed for ${SYNTHETIC_EMAIL}`); } }),
    });
    identity.getVerifiedUser = () => Promise.reject(Object.assign(new Error(SECRET_TOKEN), { code: "23505" }));
    const thrown = await rejection(pipeline.run(throwingCommand(() => new Error("never reached")), { workspaceId: "w", input: {} }));
    expect(thrown).toBeInstanceOf(UnexpectedServerError);
    // The fallback: no SQLSTATE survives (the description was lost with the sink failure), and nothing original.
    expect((thrown as Error).message).toBe("unexpected_error:unknown");
    expectNoLeak([String((thrown as Error).stack), inspect(thrown, { showHidden: true })], [SYNTHETIC_EMAIL, SECRET_TOKEN]);
  });

  it("a genuine AppError keeps its contract: same instance outside the unit of work, normalized result inside", async () => {
    const h = await setup();
    const appError = new AppError("CONFLICT", {});
    h.identity.getVerifiedUser = () => Promise.reject(appError);
    expect(await rejection(h.pipeline.run(throwingCommand(() => new Error("x")), { workspaceId: h.workspaceId, input: {} }))).toBe(appError);
    h.identity.getVerifiedUser = () => Promise.resolve(verifiedUser(OWNER));
    expect(errorCode(await h.pipeline.run(throwingCommand(() => new AppError("STALE_STATE", {})), { workspaceId: h.workspaceId, input: {} }))).toBe("STALE_STATE");
  });

  it("a genuine redirect thrown by execute still passes through unchanged (same instance)", async () => {
    const h = await setup();
    const signal = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/onboarding;307;" });
    expect(await rejection(h.pipeline.run(throwingCommand(() => signal), { workspaceId: h.workspaceId, input: {} }))).toBe(signal);
  });
});
