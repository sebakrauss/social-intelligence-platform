/**
 * The action pipeline (TA §10.6), Step 1 form. Every consequential command passes through:
 *
 *   1 authenticate → 2 resolve tenant → 3 authorize → 4 validate input → 5 mode guard
 *   → 6 execute (unit of work) → 7 audit (same unit of work) → 8 respond
 *
 * Identity always comes from the server-validated session; tenant, role, grants and mode always come
 * from a live lookup. A failing step stops the pipeline: nothing after it runs and the unit of work
 * rolls back. Results carry normalized errors only.
 */
import { parseRequestId, type CorrelationId } from "@/domain/correlation";
import { AppError, isAppError } from "@/domain/errors";
import { recordAuditEvent } from "@/modules/audit";
import type { IdentityPort } from "@/platform/auth/port";
import { continueOrStartCorrelation, newRequestId, type Logger } from "@/platform/observability";
import type { AuditDraft, Command, CommandEnvironment } from "./command";
import { OrganizationContext, UserContext, WorkspaceContext } from "./context";
import type { Transaction, UnitOfWork } from "./unit-of-work";

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

      let output: O;
      let scope: { organizationId?: string; workspaceId?: string } = {};
      try {
        output = await deps.unitOfWork.run(async (tx: Transaction) => {
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

      if (command.afterCommit !== undefined) {
        step("after_commit");
        await command.afterCommit(output);
      }
      finish("ok");
      return { status: "ok", value: command.respond(output), correlationId };
    },
  };
}
