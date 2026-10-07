/**
 * The action pipeline (TA §10.6), Step 1 form. Every consequential command passes through:
 *
 *   1 authenticate → 2 resolve tenant → 3 authorize → 4 validate input → 5 mode guard
 *   → 6 execute (unit of work) → 7 audit (same unit of work; commands may also append outbox rows)
 *   → 8 respond
 *
 * Identity always comes from the server-validated session; tenant, role, grants and mode always come
 * from a live lookup. A failing step stops the pipeline: nothing after it runs and the unit of work
 * rolls back. Results carry normalized errors only.
 */
import { parseRequestId, type CorrelationId } from "@/domain/correlation";
import { AppError, isAppError } from "@/domain/errors";
import { parseWorkspaceId } from "@/domain/ids";
import { recordAuditEvent } from "@/modules/audit";
import type { IdentityPort } from "@/platform/auth/port";
import type { OutboxNotice } from "@/platform/outbox";
import { continueOrStartCorrelation, newRequestId, type Logger } from "@/platform/observability";
import type { AuditDraft, Command, CommandEnvironment } from "./command";
import { OrganizationContext, UserContext, WorkspaceContext } from "./context";
import type { Transaction, TransactionScope, UnitOfWork } from "./unit-of-work";

export const PIPELINE_STEPS = [
  "authenticate",
  "resolve_tenant",
  "authorize",
  "validate",
  "mode_guard",
  "execute",
  "audit",
  "after_commit",
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export interface PipelineDependencies {
  readonly identity: IdentityPort;
  readonly unitOfWork: UnitOfWork;
  readonly clock: () => Date;
  readonly newId: () => string;
  readonly logger: Logger;
  /** Optional observer of step order (diagnostics and tests). */
  readonly onStep?: (step: PipelineStep) => void;
  /**
   * Post-commit outbox notification (TA §5, §10.6 step 9): told which outbox rows a committed command
   * appended or routed through a reviewed definer, e.g. to nudge the system relay. Best effort: a failure is logged, never surfaced, because
   * the scheduled dispatch sweeper delivers the rows anyway.
   */
  readonly outboxCommitted?: (notices: readonly OutboxNotice[]) => Promise<void>;
}

/** Everything here is untrusted request data: only routing IDs and the command input. */
export interface PipelineRequest {
  readonly input: unknown;
  readonly workspaceId?: unknown;
  readonly organizationId?: unknown;
  readonly correlationId?: unknown;
  readonly requestId?: unknown;
}

export type PipelineResult<R> =
  | { readonly status: "ok"; readonly value: R; readonly correlationId: CorrelationId }
  | { readonly status: "unauthenticated"; readonly correlationId: CorrelationId }
  | { readonly status: "verification_required"; readonly correlationId: CorrelationId }
  | { readonly status: "error"; readonly error: AppError; readonly correlationId: CorrelationId };

export interface ActionPipeline {
  run<I, O, R>(command: Command<I, O, R>, request: PipelineRequest): Promise<PipelineResult<R>>;
}

export function createActionPipeline(deps: PipelineDependencies): ActionPipeline {
  const step = (name: PipelineStep): void => deps.onStep?.(name);

  return {
    async run<I, O, R>(command: Command<I, O, R>, request: PipelineRequest): Promise<PipelineResult<R>> {
      const startedAt = deps.clock();
      const correlationId = continueOrStartCorrelation(request.correlationId);
      const requestId = parseRequestId(request.requestId) ?? newRequestId();
      const log = deps.logger.child({ module: "server.pipeline", operation: command.name, correlationId, requestId });
      const finish = (outcome: "ok" | "error", extra: { readonly errorCode?: AppError["code"] } = {}): void => {
        log.info("pipeline.command.finished", {
          outcome,
          actorType: "user",
          durationMs: deps.clock().getTime() - startedAt.getTime(),
          ...extra,
        });
      };

      // 1. Authenticate: server-validated session only.
      step("authenticate");
      const identity = await deps.identity.getVerifiedUser();
      if (identity === undefined) {
        finish("error");
        return { status: "unauthenticated", correlationId };
      }
      if (!identity.emailVerified) {
        finish("error");
        return { status: "verification_required", correlationId };
      }
      const user = UserContext.fromVerifiedIdentity(identity);
      const env: CommandEnvironment = { now: deps.clock(), newId: deps.newId, correlationId, requestId };

      // The routed workspace is bound to the transaction up front (sealed, R2); membership is still
      // verified live inside it. An unparseable ID binds nothing and resolves to NOT_FOUND below.
      const routedWorkspace = command.scope === "workspace" ? parseWorkspaceId(request.workspaceId) : undefined;
      const transactionScope: TransactionScope =
        routedWorkspace === undefined ? { userId: user.userId } : { userId: user.userId, workspaceId: routedWorkspace };

      let output: O;
      const appended: OutboxNotice[] = [];
      let scope: { organizationId?: string; workspaceId?: string } = {};
      try {
        output = await deps.unitOfWork.run(transactionScope, async (base: Transaction) => {
          // Record what the command appends (or routes through a definer), for the post-commit notification only.
          const tx: Transaction = {
            ...base,
            outbox: {
              append: (message) => {
                appended.push(message);
                return base.outbox.append(message);
              },
              routed: (notice) => {
                appended.push(notice);
                base.outbox.routed(notice);
              },
            },
          };
          let result: O;
          if (command.scope === "workspace") {
            // 2. Resolve tenant (live) → 3. authorize → 4. validate → 5. mode guard.
            step("resolve_tenant");
            const context = await WorkspaceContext.resolve(tx.tenancy, user, request.workspaceId);
            scope = { organizationId: context.organizationId, workspaceId: context.workspaceId };
            step("authorize");
            if (!context.permissions.has(command.permission)) throw new AppError("PERMISSION_DENIED", {});
            step("validate");
            const input = command.validate(request.input);
            step("mode_guard");
            if (command.requiresStandardMode && context.mode !== "STANDARD") throw new AppError("MODE_BLOCKED", {});
            step("execute");
            result = await command.execute(context, input, tx, env);
          } else if (command.scope === "organization") {
            step("resolve_tenant");
            const context = await OrganizationContext.resolve(tx.tenancy, user, request.organizationId);
            scope = { organizationId: context.organizationId };
            step("authorize");
            if (!context.permissions.has(command.permission)) throw new AppError("PERMISSION_DENIED", {});
            step("validate");
            const input = command.validate(request.input);
            step("execute");
            result = await command.execute(context, input, tx, env);
          } else {
            step("validate");
            const input = command.validate(request.input);
            step("execute");
            result = await command.execute(user, input, tx, env);
          }

          // 7. Audit, in the same unit of work as the change: one event per consequential change.
          const audited = command.audit(result);
          const drafts: readonly AuditDraft[] = audited === undefined ? [] : [audited].flat();
          if (drafts.length > 0) step("audit");
          for (const draft of drafts) {
            await recordAuditEvent(tx.audit, {
              id: deps.newId(),
              occurredAt: env.now,
              action: draft.action,
              actorType: "user",
              actorUserId: user.userId,
              organizationId: scope.organizationId ?? draft.organizationId,
              workspaceId: scope.workspaceId ?? draft.workspaceId,
              targetType: draft.targetType,
              targetId: draft.targetId,
              correlationId,
              requestId,
              outcome: "succeeded",
              change: draft.change,
            });
          }
          return result;
        });
      } catch (error) {
        if (isAppError(error)) {
          finish("error", { errorCode: error.code });
          return { status: "error", error: error.withCorrelationId(correlationId), correlationId };
        }
        finish("error");
        throw error;
      }

      if (appended.length > 0 && deps.outboxCommitted !== undefined) {
        try {
          await deps.outboxCommitted(appended);
        } catch {
          log.warn("outbox.nudge.failed", { outcome: "error", count: appended.length });
        }
      }

      if (command.afterCommit !== undefined) {
        step("after_commit");
        await command.afterCommit(output);
      }
      finish("ok");
      return { status: "ok", value: command.respond(output), correlationId };
    },
  };
}
