/**
 * One task = one named, versioned contract (Step H7-C; TA §22.1, CLAUDE.md §11): prompt version + hash, output schema
 * version, the versions the task's output depends on, a pure data renderer and the task's OWN strict validator. The
 * gateway never interprets a task's output; it only runs the call → validate → (one re-ask) loop.
 *
 * The data block: the task's data object serialized as JSON with `<`, `>` and `&` escaped, between fixed delimiter
 * lines. The escaping makes it impossible for social text to contain the closing delimiter, so data can never "close"
 * its section and continue as instructions (H7-A0 §14).
 */

export const DATA_BLOCK_OPEN = "<<<WRENKIND_UNTRUSTED_DATA_V1>>>";
export const DATA_BLOCK_CLOSE = "<<<END_WRENKIND_UNTRUSTED_DATA_V1>>>";

export interface TaskPrompt {
  readonly version: string;
  /** SHA-256 (hex) of `system`, pinned by a test. */
  readonly hash: string;
  readonly system: string;
}

export type TaskValidation<O> = { readonly ok: true; readonly value: O } | { readonly ok: false; readonly issues: readonly string[] };

export interface GatewayTask<I, O> {
  readonly taskId: string;
  readonly taskVersion: string;
  readonly prompt: TaskPrompt;
  readonly outputSchemaVersion: string;
  /** The output's provider-neutral JSON Schema (mechanically strict-compatible), for native structured output only. */
  readonly outputJsonSchema: { readonly name: string; readonly schema: Readonly<Record<string, unknown>> };
  /** Every other version the output depends on (recorded on each attempt). */
  readonly versions: Readonly<Record<string, string>>;
  /** The task's data object (pure; untrusted fields stay data). */
  readonly data: (input: I) => Readonly<Record<string, unknown>>;
  /** The task's strict validator over the PARSED output (no coercion, no defaults). */
  readonly validate: (parsed: unknown, input: I) => TaskValidation<O>;
}

/** The delimited, escaped data section of one request. */
export function renderDataBlock(data: Readonly<Record<string, unknown>>): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `${DATA_BLOCK_OPEN}\n${json}\n${DATA_BLOCK_CLOSE}`;
}

/** The re-ask addendum: closed issue codes only (never the previous output, never social text). */
export function renderCorrection(issues: readonly string[]): string {
  return `\n\nYOUR PREVIOUS OUTPUT WAS REJECTED BY VALIDATION. Issue codes: ${issues.join(", ")}. Return ONE corrected JSON object that satisfies the schema exactly.`;
}
