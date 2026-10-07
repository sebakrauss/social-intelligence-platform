/**
 * Test harness: an action pipeline wired to in-memory adapters, plus helpers that set up tenants
 * through the real commands (so every test exercises the same paths production code will).
 */
import type { WorkspaceRole } from "@/domain/access";
import type { OrganizationId, UserId, WorkspaceId } from "@/domain/ids";
import { opaqueTokens } from "@/platform/crypto";
import { createLogger } from "@/platform/observability";
import { createTenancyCommands } from "@/server/commands/tenancy";
import type { OutboxNotice } from "@/platform/outbox";
import { createActionPipeline, type PipelineResult, type PipelineStep } from "@/server/pipeline";
import { CapturingDelivery, FakeIdentity, FixedClock, InMemoryUnitOfWork, emailOf, sequentialIds, verifiedUser } from "./in-memory";

export function createHarness(options: { readonly outboxCommitted?: (notices: readonly OutboxNotice[]) => Promise<void> } = {}) {
  const unitOfWork = new InMemoryUnitOfWork();
  const identity = new FakeIdentity();
  const clock = new FixedClock();
  const delivery = new CapturingDelivery();
  const logLines: string[] = [];
  const steps: PipelineStep[] = [];
  const commands = createTenancyCommands({ tokens: opaqueTokens, delivery });
  const pipeline = createActionPipeline({
    identity,
    unitOfWork,
    clock: clock.read,
    newId: sequentialIds(),
    logger: createLogger({ sink: (line) => logLines.push(line), now: clock.read }),
    onStep: (step) => steps.push(step),
    ...(options.outboxCommitted === undefined ? {} : { outboxCommitted: options.outboxCommitted }),
  });

  const as = (user: UserId): void => {
    identity.user = verifiedUser(user);
  };

  async function createOrganization(owner: UserId): Promise<OrganizationId> {
    as(owner);
    const result = await pipeline.run(commands.createOrganization, { input: { name: "Organization A" } });
    return expectOk(result).organizationId;
  }

  async function createWorkspace(owner: UserId, organizationId: OrganizationId, mode?: "STANDARD" | "MONITOR_ONLY"): Promise<WorkspaceId> {
    as(owner);
    const result = await pipeline.run(commands.createWorkspace, {
      organizationId,
      input: mode === undefined ? { name: "Workspace" } : { name: "Workspace", mode },
    });
    return expectOk(result).workspaceId;
  }

  /** Invites `user` with `role` (and grants) as `inviter`, then accepts as `user`. */
  async function addMember(
    inviter: UserId,
    workspaceId: WorkspaceId,
    user: UserId,
    role: WorkspaceRole,
    grants?: readonly string[],
  ): Promise<void> {
    as(inviter);
    expectOk(
      await pipeline.run(commands.inviteToWorkspace, {
        workspaceId,
        input: grants === undefined ? { recipientEmail: emailOf(user), role } : { recipientEmail: emailOf(user), role, grants },
      }),
    );
    const token = delivery.delivered.at(-1)?.rawToken;
    as(user);
    expectOk(await pipeline.run(commands.acceptInvitation, { input: { token } }));
  }

  return { unitOfWork, identity, clock, delivery, logLines, steps, commands, pipeline, as, createOrganization, createWorkspace, addMember };
}

export function expectOk<R>(result: PipelineResult<R>): R {
  if (result.status !== "ok") {
    throw new Error(`expected ok, got ${result.status}${result.status === "error" ? ` (${result.error.code})` : ""}`);
  }
  return result.value;
}

export function errorCode(result: PipelineResult<unknown>): string {
  return result.status === "error" ? result.error.code : result.status;
}
