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
import { types } from "node:util";
import { parseRequestId, type CorrelationId } from "@/domain/correlation";
import { AppError, isAppError } from "@/domain/errors";
import { parseWorkspaceId } from "@/domain/ids";
import { recordAuditEvent } from "@/modules/audit";
import type { IdentityPort } from "@/platform/auth/port";
import type { OutboxNotice } from "@/platform/outbox";
import { UnexpectedServerError, continueOrStartCorrelation, describeUnexpectedError, isTrustedAppError, newRequestId, type Logger } from "@/platform/observability";
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

/**
 * Next.js control-flow signals the framework must receive unchanged (W12-LOG-HARDEN-03 F-1): redirect /
 * permanentRedirect, notFound / forbidden / unauthorized, dynamic usage, CSR bailout and prerender interrupted. A value
 * passes through only if BOTH hold in Next 16.4.5: its own `unstable_rethrow` predicates accept it (redirect-error.js,
 * http-access-fallback.js, hooks-server-context.js, bailout-to-csr.js, app-render/dynamic-rendering.js), replicated
 * here predicate by predicate, AND Next's server error handler consumes it without printing it
 * (app-render/create-error-handler.js `getDigestForWellKnownError`). So nothing Next would log is let through raw.
 * Stricter than Next on purpose:
 *   - the value must be an Error instance, as every signal Next itself creates is (a plain object with a well-formed
 *     digest is sanitized);
 *   - HANGING_PROMISE_REJECTION is NOT passed: Next's error handler does not exempt it from logging, and it only
 *     arises after a prerender completes, which this fully dynamic app never runs through the pipeline;
 *   - React postpone is NOT passed: Next 16.4.5 and its bundled React builds no longer recognize it.
 * A digest cannot be authenticated (Next trusts it the same way); a forged but well-formed one only changes control
 * flow, never what gets printed. The framework is not imported here; tests check parity against Next's own functions,
 * and this list must be re-checked on every Next upgrade.
 */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([303, 307, 308]);
const HTTP_ACCESS_FALLBACK_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
const EXACT_CONTROL_DIGESTS: ReadonlySet<string> = new Set(["DYNAMIC_SERVER_USAGE", "BAILOUT_TO_CLIENT_SIDE_RENDERING", "NEXT_PRERENDER_INTERRUPTED"]);

/** isRedirectError: `NEXT_REDIRECT;<replace|push>;<destination>;<303|307|308>;…`. */
function isRedirectDigest(digest: string): boolean {
  const parts = digest.split(";");
  const status = Number(parts.at(-2));
  return parts[0] === "NEXT_REDIRECT" && (parts[1] === "replace" || parts[1] === "push") && !Number.isNaN(status) && REDIRECT_STATUS_CODES.has(status);
}

/** isHTTPAccessFallbackError: `NEXT_HTTP_ERROR_FALLBACK;<401|403|404>`. */
function isHttpAccessFallbackDigest(digest: string): boolean {
  const [prefix, status] = digest.split(";");
  return prefix === "NEXT_HTTP_ERROR_FALLBACK" && HTTP_ACCESS_FALLBACK_STATUSES.has(Number(status));
}

/**
 * The digest must be an OWN DATA property of a non-proxy Error (as Next sets it), read once: an accessor or a proxy
 * could show a valid digest here and a different one when Next reads it again.
 */
export function isFrameworkControlFlow(error: unknown): boolean {
  try {
    if (types.isProxy(error) || !(error instanceof Error)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(error, "digest");
    if (descriptor === undefined || !("value" in descriptor)) return false;
    const digest: unknown = descriptor.value;
    if (typeof digest !== "string") return false;
    return EXACT_CONTROL_DIGESTS.has(digest) || isRedirectDigest(digest) || isHttpAccessFallbackDigest(digest);
  } catch {
    return false;
  }
}

/**
 * The error the pipeline lets escape (W12-SEC-01 L-1). A genuine AppError is returned unchanged (its contract: a code
 * and validated params, never free text), and so is a framework control-flow signal. Anything else is logged by kind
 * only and replaced with an UnexpectedServerError: the original message, stack, cause and properties are dropped.
 * Throwing still rolls back the unit of work and still reaches the caller as a rejection, exactly as before.
 *
 * Fail closed (W12-LOG-HARDEN-03 F-2): if recognizing, describing or logging the value itself throws (a hostile
 * proxy, a throwing getter, a broken sink), the result is a fixed `unexpected_error:unknown`; neither the original
 * value nor the helper's own exception ever escapes.
 */
function unexpectedFailure(error: unknown, log: Logger): unknown {
  try {
    if (!types.isProxy(error) && (isTrustedAppError(error) || isFrameworkControlFlow(error))) return error;
    const description = describeUnexpectedError(error);
    log.error("pipeline.command.failed", { outcome: "error", actorType: "user", ...description });
    return new UnexpectedServerError(description);
  } catch {
    return new UnexpectedServerError({ errorKind: "unknown" });
  }
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

      // Every step below runs inside this guard (W12-SEC-01 L-1): an error that is not a normalized AppError (nor a
      // Next.js control-flow signal) never leaves the pipeline with its own message, stack or cause.
      try {
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

            // 7. Audit, in the same unit of work as the change: one event per consequential change. A command audited by
            // its database boundary has had its event written already, in this transaction: the pipeline adds none.
            const audited = command.audit(result);
            if (command.auditedBy !== undefined && audited !== undefined) throw new Error("boundary_audited_command_returned_a_draft");
            const drafts: readonly AuditDraft[] = audited === undefined || command.auditedBy !== undefined ? [] : [audited].flat();
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
      } catch (error) {
        throw unexpectedFailure(error, log);
      }
    },
  };
}
