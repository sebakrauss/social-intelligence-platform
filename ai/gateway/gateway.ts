/**
 * The in-process AI Gateway (Step H7-C; TA §22; H7-A0 §10, §11.3). Provider-neutral: it runs ONE named, versioned task
 * through the routed provider and returns either the task's validated output or a typed failure — never a provider
 * object, never raw output, never reasoning.
 *
 *   1. route   the task's route from server-side configuration (never from the input); disabled ⇒ AI_UNAVAILABLE
 *   2. switch  kill switch ⇒ AI_UNAVAILABLE, no call
 *   3. model   registered, enabled, structured output, provider composed ⇒ otherwise AI_UNAVAILABLE, no call
 *   4. size    system + data over the model's input bound ⇒ AI_INPUT_TOO_LARGE, no call (never truncated)
 *   5. budget  the budget port denies ⇒ AI_BUDGET, no call
 *   6. call    refusal ⇒ AI_REFUSED · transport ⇒ AI_UNAVAILABLE (retryable, by the LATER runtime only) ·
 *              provider input limit ⇒ AI_INPUT_TOO_LARGE
 *   7. parse   strict JSON.parse of the output text, then the task's validator; the FIRST invalid output gets ONE
 *              re-ask carrying only the closed issue codes; a second invalid output ⇒ AI_INVALID_OUTPUT
 *
 * No loop beyond the one re-ask; no transport retry inside a call; no tools; no network of its own; no environment.
 */
import type { AttemptOutcome, AttemptRecord, GatewaySubject } from "./attempt";
import { gatewayFailure, type AiFailureCause, type GatewayFailure } from "./failures";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "./provider-port";
import type { ModelDescriptor, ModelRegistry, RouteTable } from "./registry";
import { renderCorrection, renderDataBlock, type GatewayTask } from "./task";

export interface BudgetPort {
  /** Whether one call of this size may be made now (numbers are a later policy; OPEN). */
  reserve(request: { readonly workspaceId: string; readonly taskId: string; readonly inputChars: number }): Promise<"allowed" | "denied">;
}

export interface GatewayDependencies {
  readonly registry: ModelRegistry;
  readonly routes: RouteTable;
  readonly providers: readonly ModelProvider[];
  readonly budget: BudgetPort;
  /** Fail-safe kill switch (true = killed). */
  readonly killed: () => boolean;
  readonly now: () => Date;
}

export interface GatewayCallContext {
  readonly workspaceId: string;
  readonly subject: GatewaySubject;
  readonly pipelineVersion: string;
  /** Opaque call reference (tracing; the simulator's script key). Never derived from social text. */
  readonly reference: string;
}

export interface GatewayProvenance {
  readonly providerKey: string;
  readonly modelKey: string;
  readonly modelVersion: string | null;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly outputSchemaVersion: string;
  readonly versions: Readonly<Record<string, string>>;
}

export type GatewayOutcome<O> =
  | { readonly kind: "succeeded"; readonly value: O; readonly provenance: GatewayProvenance; readonly attempts: readonly AttemptRecord[] }
  | { readonly kind: "failed"; readonly failure: GatewayFailure; readonly attempts: readonly AttemptRecord[] };

export interface AiGateway {
  run<I, O>(task: GatewayTask<I, O>, input: I, context: GatewayCallContext): Promise<GatewayOutcome<O>>;
}

type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const parseJson = (text: string): Parsed => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

export function createAiGateway(deps: GatewayDependencies): AiGateway {
  const providers = new Map(deps.providers.map((provider) => [provider.providerKey, provider]));
  return {
    async run<I, O>(task: GatewayTask<I, O>, input: I, context: GatewayCallContext): Promise<GatewayOutcome<O>> {
      const failed = (cause: AiFailureCause, attempts: readonly AttemptRecord[] = [], options: Parameters<typeof gatewayFailure>[1] = {}): GatewayOutcome<O> =>
        ({ kind: "failed", failure: gatewayFailure(cause, options), attempts: Object.freeze([...attempts]) });

      const route = deps.routes[task.taskId];
      if (route === undefined || route.kind === "disabled") return failed("task_disabled");
      if (deps.killed()) return failed("kill_switch");
      const model: ModelDescriptor | undefined = deps.registry.get(route.model);
      const provider = providers.get(route.model.providerKey);
      if (model === undefined || !model.enabled || model.structuredOutput === "none" || provider === undefined) return failed("model_unavailable");

      const data = renderDataBlock(task.data(input));
      const responseFormat = { kind: "json" as const, schemaVersion: task.outputSchemaVersion, schemaName: task.outputJsonSchema.name, jsonSchema: task.outputJsonSchema.schema };
      const base = { model: route.model, data, responseFormat, maxOutputChars: model.maxOutputChars };
      const initial: ProviderRequest = { ...base, system: task.prompt.system };
      const inputChars = initial.system.length + initial.data.length;
      if (inputChars > model.maxInputChars) return failed("input_limit");
      if ((await deps.budget.reserve({ workspaceId: context.workspaceId, taskId: task.taskId, inputChars })) !== "allowed") return failed("budget_exhausted");

      const attempts: AttemptRecord[] = [];
      const record = (attemptNumber: 1 | 2, request: ProviderRequest, startedAt: Date, response: ProviderResponse, outcome: AttemptOutcome, issueCodes: readonly string[]): void => {
        attempts.push(Object.freeze({
          workspaceId: context.workspaceId,
          subject: Object.freeze({ ...context.subject }),
          pipelineVersion: context.pipelineVersion,
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          providerKey: route.model.providerKey,
          modelKey: route.model.modelKey,
          modelVersion: response.kind === "completed" ? response.modelVersion : null,
          promptVersion: task.prompt.version,
          promptHash: task.prompt.hash,
          outputSchemaVersion: task.outputSchemaVersion,
          versions: Object.freeze({ ...task.versions }),
          attemptNumber,
          kind: attemptNumber === 1 ? "initial" as const : "reask" as const,
          startedAt,
          completedAt: deps.now(),
          inputChars: request.system.length + request.data.length,
          usage: response.kind === "completed" ? response.usage : null,
          costEstimate: null,
          outcome,
          failureClass: outcome === "accepted" ? null : gatewayFailure(OUTCOME_CAUSE[outcome]).class,
          issueCodes: Object.freeze([...issueCodes]),
        }));
      };

      let request = initial;
      for (const attemptNumber of [1, 2] as const) {
        const startedAt = deps.now();
        const response = await provider.complete(request, { reference: context.reference, attempt: attemptNumber });
        if (response.kind === "refused") {
          record(attemptNumber, request, startedAt, response, "refused", []);
          return failed("refused", attempts);
        }
        if (response.kind === "failed") {
          record(attemptNumber, request, startedAt, response, response.cause === "provider_input_limit" ? "input_too_large" : "unavailable", []);
          return failed(response.cause, attempts, { retryAfterSeconds: response.retryAfterSeconds });
        }
        const parsed = parseJson(response.text);
        const validation = parsed.ok ? task.validate(parsed.value, input) : { ok: false as const, issues: ["MALFORMED_JSON"] };
        if (validation.ok) {
          record(attemptNumber, request, startedAt, response, "accepted", []);
          return {
            kind: "succeeded",
            value: validation.value,
            provenance: Object.freeze({
              providerKey: route.model.providerKey,
              modelKey: route.model.modelKey,
              modelVersion: response.modelVersion,
              taskId: task.taskId,
              taskVersion: task.taskVersion,
              promptVersion: task.prompt.version,
              promptHash: task.prompt.hash,
              outputSchemaVersion: task.outputSchemaVersion,
              versions: Object.freeze({ ...task.versions }),
            }),
            attempts: Object.freeze([...attempts]),
          };
        }
        record(attemptNumber, request, startedAt, response, "invalid_output", validation.issues);
        if (attemptNumber === 2) return failed("invalid_output", attempts, { issues: validation.issues });
        // The one re-ask: the same data, the policy plus the closed issue codes — never the rejected output.
        request = { ...base, system: task.prompt.system + renderCorrection(validation.issues) };
      }
      return failed("invalid_output", attempts);
    },
  };
}

const OUTCOME_CAUSE: Readonly<Record<Exclude<AttemptOutcome, "accepted">, AiFailureCause>> = Object.freeze({
  invalid_output: "invalid_output",
  refused: "refused",
  unavailable: "provider_unavailable",
  input_too_large: "provider_input_limit",
});
