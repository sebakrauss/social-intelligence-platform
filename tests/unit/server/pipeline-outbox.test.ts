/**
 * Post-commit outbox notification (TA §5 web-invoked dispatch): the pipeline nudges the system relay only
 * after the unit of work COMMITTED, never for a rolled-back one, and a failed nudge never fails the action
 * (the dispatch sweeper delivers the rows later).
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { object, oneOf } from "@/domain/validation";
import type { JobRuntime } from "@/platform/jobs";
import { RELAY_TASK, type OutboxNotice } from "@/platform/outbox";
import type { WorkspaceCommand } from "@/server/pipeline";
import { createOutboxNotifier } from "@/server/jobs/outbox-notifier";
import { createHarness, errorCode, expectOk } from "../../support/harness";
import { userId } from "../../support/in-memory";

const OWNER = userId(1);

/** A command whose row was inserted by a reviewed definer in its transaction (e.g. a routed Move saga step). */
function routingCommand(fail: boolean): WorkspaceCommand<Record<string, never>, string, string> {
  return {
    scope: "workspace",
    name: "test.route_outbox",
    permission: "workflow.internal",
    requiresStandardMode: false,
    validate: object({}),
    execute(_context, _input, tx, env) {
      const id = env.newId();
      tx.outbox.routed({ id, correlationId: env.correlationId });
      return fail ? Promise.reject(new AppError("CONFLICT", {})) : Promise.resolve(id);
    },
    audit: () => undefined,
    respond: (id) => id,
  };
}

function appendingCommand(): WorkspaceCommand<{ readonly fail: "yes" | "no"; readonly append: "yes" | "no" }, string, string> {
  return {
    scope: "workspace",
    name: "test.append_outbox",
    permission: "workflow.internal",
    requiresStandardMode: false,
    validate: object({ fail: oneOf(["yes", "no"] as const), append: oneOf(["yes", "no"] as const) }),
    async execute(context, input, tx, env) {
      const id = env.newId();
      if (input.append === "yes") {
        await tx.outbox.append({
          id,
          topic: "workflow.example_task",
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
          subjectIds: {},
          correlationId: env.correlationId,
          initiator: { type: "user", userId: context.userId },
          dispatchKey: `workflow.example_task:${id}`,
          createdAt: env.now,
        });
      }
      if (input.fail === "yes") throw new AppError("CONFLICT", {});
      return id;
    },
    audit: () => undefined,
    respond: (id) => id,
  };
}

async function setup(notify: (notices: readonly OutboxNotice[]) => Promise<void>) {
  const harness = createHarness({ outboxCommitted: notify });
  const organizationId = await harness.createOrganization(OWNER);
  const workspaceId = await harness.createWorkspace(OWNER, organizationId);
  harness.as(OWNER);
  return { ...harness, workspaceId };
}

describe("post-commit outbox notification", () => {
  it("is called once, after the commit, with the appended messages", async () => {
    const calls: { ids: string[]; commitsAtCall: number }[] = [];
    const h = await setup((messages) => {
      calls.push({ ids: messages.map((message) => message.id), commitsAtCall: h.unitOfWork.commits });
      return Promise.resolve();
    });
    const commitsBefore = h.unitOfWork.commits;
    const id = expectOk(await h.pipeline.run(appendingCommand(), { workspaceId: h.workspaceId, input: { fail: "no", append: "yes" } }));
    expect(calls).toEqual([{ ids: [id], commitsAtCall: commitsBefore + 1 }]);
  });

  it("rows routed through a definer get the same post-commit wake-up, and none after a rollback (G5)", async () => {
    const calls: { ids: string[]; commitsAtCall: number }[] = [];
    const h = await setup((notices) => {
      calls.push({ ids: notices.map((notice) => notice.id), commitsAtCall: h.unitOfWork.commits });
      return Promise.resolve();
    });
    const commitsBefore = h.unitOfWork.commits;
    const id = expectOk(await h.pipeline.run(routingCommand(false), { workspaceId: h.workspaceId, input: {} }));
    expect(calls).toEqual([{ ids: [id], commitsAtCall: commitsBefore + 1 }]);
    expect(errorCode(await h.pipeline.run(routingCommand(true), { workspaceId: h.workspaceId, input: {} }))).toBe("CONFLICT");
    expect(calls).toHaveLength(1);
  });

  it("is never called for a rolled-back unit of work, or when nothing was appended", async () => {
    let calls = 0;
    const h = await setup(() => {
      calls += 1;
      return Promise.resolve();
    });
    expect(errorCode(await h.pipeline.run(appendingCommand(), { workspaceId: h.workspaceId, input: { fail: "yes", append: "yes" } }))).toBe("CONFLICT");
    expectOk(await h.pipeline.run(appendingCommand(), { workspaceId: h.workspaceId, input: { fail: "no", append: "no" } }));
    expect(calls).toBe(0);
    expect(h.unitOfWork.state.outbox).toHaveLength(0);
  });

  it("a failed nudge never fails the committed action; it is logged without content", async () => {
    const h = await setup(() => Promise.reject(new Error("job runtime down")));
    const result = await h.pipeline.run(appendingCommand(), { workspaceId: h.workspaceId, input: { fail: "no", append: "yes" } });
    expect(result.status).toBe("ok");
    expect(h.unitOfWork.state.outbox).toHaveLength(1);
    const line = h.logLines.find((entry) => entry.includes("outbox.nudge.failed"));
    expect(line).toBeDefined();
    expect(line).not.toContain("job runtime down");
  });

  it("the web notifier only asks the job runtime to run the system relay (IDs-only payload, per-row key)", async () => {
    const enqueued: Parameters<JobRuntime["enqueue"]>[0][] = [];
    const runtime: JobRuntime = {
      enqueue: (request) => {
        enqueued.push(request);
        return Promise.resolve({ runId: "run_1" });
      },
      getRun: () => Promise.reject(new Error("not used")),
    };
    const message: OutboxNotice = { id: "7f1c0a52-3d0e-4c39-9d0a-0d1f5f7b2c11", correlationId: "corr-notify-1" };
    await createOutboxNotifier(runtime)([message]);
    await createOutboxNotifier(runtime)([]);
    expect(enqueued).toEqual([
      {
        task: RELAY_TASK,
        payload: { v: 1, scope: "system", task: RELAY_TASK, correlationId: "corr-notify-1", initiator: { type: "system" } },
        dispatchKey: `outbox.relay:${message.id}`,
        lane: "system",
      },
    ]);
  });
});
