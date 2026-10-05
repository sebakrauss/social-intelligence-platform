/**
 * T-27 managed leg (Trigger.dev DEVELOPMENT + Supabase development project). Proves the validated TA-Q-04
 * crash behavior end to end through the production foundation:
 *
 *   committed outbox row → system relay → Trigger.dev run (GLOBAL idempotency key = dispatch key)
 *   → run commits its effect, then its worker process dies → CRASHED (not retried by the vendor)
 *   → R7 outcome sweeper sees CRASHED → re-dispatch under the SAME dispatch key → a NEW run
 *   → domain claim says "already_applied" → COMPLETED → exactly one durable effect
 *
 * Runs only through `npm run test:jobs:managed` (which starts the ephemeral dev session).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { isUuid, type UserId } from "@/domain/ids";
import { object, parsed } from "@/domain/validation";
import type { RuntimeDatabase } from "@/platform/db";
import { createTriggerDevRuntime } from "@/platform/jobs/trigger-dev";
import { createLogger } from "@/platform/observability";
import { relayPass, sweepRunOutcomes, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type WorkspaceCommand } from "@/server/pipeline";
import { privilegedPool, runtimeDatabase } from "../../db/support/target";
import { cleanupWorld, seedWorld, type World } from "../../db/support/world";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { expectOk } from "../../support/harness";
import { CRASH_TASK, MANAGED_TEST_TASKS } from "./registry";

const POLL_MS = 5_000;
const DEADLINE_MS = 8 * 60_000;

describe("T-27 managed · Trigger.dev crash recovery (R6 + R7)", () => {
  const target = inject("dbTarget");
  let privileged: ReturnType<typeof privilegedPool>;
  let world: World;
  let web: RuntimeDatabase<"web">;
  let system: RuntimeDatabase<"system">;
  const identity = new FakeIdentity();
  const logger = createLogger({ sink: () => undefined });

  beforeAll(async () => {
    const secretKey = process.env["TRIGGER_SECRET_KEY"] ?? "";
    if (!secretKey.startsWith("tr_dev_")) throw new Error("managed job suite refused: a DEVELOPMENT key is required");
    privileged = privilegedPool(target);
    world = await seedWorld(privileged);
    web = runtimeDatabase(target, "web", 2);
    system = runtimeDatabase(target, "system", 2);
  });

  afterAll(async () => {
    await Promise.all([web.end(), system.end()]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
  });

  it("CRASHED → R7 detects → re-dispatch → new run → domain effect exactly once", async () => {
    const runtime = createTriggerDevRuntime({ secretKey: process.env["TRIGGER_SECRET_KEY"] ?? "" });
    const deps: DeliveryDependencies = { system, runtime, registry: MANAGED_TEST_TASKS, logger, clock: () => new Date() };
    const command: WorkspaceCommand<{ readonly itemId: string }, string, string> = {
      scope: "workspace",
      name: "test.managed_crash_enqueue",
      permission: "workflow.internal",
      requiresStandardMode: false,
      validate: object({ itemId: parsed((value) => (isUuid(value) ? value : undefined)) }),
      async execute(context, input, tx, env) {
        const id = randomUUID();
        await tx.outbox.append({
          id, topic: CRASH_TASK, organizationId: context.organizationId, workspaceId: context.workspaceId,
          subjectIds: { item_id: input.itemId }, correlationId: env.correlationId,
          initiator: { type: "user", userId: context.userId }, dispatchKey: `${CRASH_TASK}:${input.itemId}`, createdAt: env.now,
        });
        return id;
      },
      audit: () => undefined,
      respond: (id) => id,
    };
    const pipeline = createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock: () => new Date(), newId: randomUUID, logger });
    identity.user = verifiedUser(world.users.ownerA as UserId, "owner-a@example.test");
    const itemId = randomUUID();
    const outboxId = expectOk(await pipeline.run(command, { workspaceId: world.A1, input: { itemId } }));

    expect(await relayPass(deps)).toMatchObject({ dispatched: 1 });
    const deadline = Date.now() + DEADLINE_MS;
    let outcome: string | null = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      await sweepRunOutcomes(deps);
      outcome = (await privileged.query<{ run_outcome: string | null }>("select run_outcome from system.outbox where id = $1", [outboxId])).rows[0]?.run_outcome ?? null;
      if (outcome !== null) break;
    }

    const row = (await privileged.query<{ run_outcome: string; recovery_count: number; last_failure_class: string | null }>(
      "select run_outcome, recovery_count, last_failure_class from system.outbox where id = $1", [outboxId])).rows[0];
    const runs = (await privileged.query<{ run_id: string; last_status: string; recovery_generation: number }>(
      "select run_id, last_status, recovery_generation from system.outbox_runs where outbox_id = $1 order by dispatched_at", [outboxId])).rows;
    const effects = (await privileged.query<{ n: number }>("select count(*)::int as n from t26_fixture.conversations where title = $1", [`managed effect ${itemId}`])).rows[0]?.n;
    const claims = (await privileged.query<{ n: number }>("select count(*)::int as n from idempotency.effect_keys where workspace_id = $1 and effect_key = $2", [world.A1, `managedtest.effect:${itemId}`])).rows[0]?.n;

    // Observations, printed without secrets or content (vendor run IDs are identifiers).
    process.stdout.write(`${JSON.stringify({ outcome: row?.run_outcome, recoveryCount: row?.recovery_count, runs: runs.map((run) => ({ status: run.last_status, generation: run.recovery_generation })), effects, claims })}\n`);

    expect(row).toMatchObject({ run_outcome: "COMPLETED", recovery_count: 1 });
    expect(runs.map((run) => run.last_status)).toEqual(["CRASHED", "COMPLETED"]);
    expect(new Set(runs.map((run) => run.run_id)).size).toBe(2); // the recovery got a NEW run under the same key
    expect(effects).toBe(1);
    expect(claims).toBe(1);
  });
});
