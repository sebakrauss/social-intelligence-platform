/**
 * The operator switch command (Step H7-production-kill-switch-tooling): argument parsing and the exact plan, kept apart
 * from the CLI so both are unit-tested with no database. Rules enforced here, before anything is contacted:
 *
 *   --target development|production   mandatory and exactly one (the database tooling fence does the rest: its own
 *                                     configuration file, explicit identity, project reference, region, strict CA)
 *   --apply on production             additionally requires --confirm-production; that flag is refused on development
 *   one change per invocation         exactly one key / qualifier / scope; `show` is read-only
 *
 * The plan reads the current row first, so the operator sees the exact transition (absent → value, value → value,
 * unchanged) and whether the write would be a no-op. Values are switch configuration (JSON shapes), never secrets.
 */
import { parseArgs } from "node:util";
import { resolveSwitch, type SwitchRowInput } from "../../platform/flags/resolver.ts";
import { SWITCHES } from "../../platform/flags/registry.ts";
import { DATABASE_TARGETS, type DatabaseTarget } from "../db/environment.ts";
import { REASON_CODES, SwitchChangeError, validateTarget, type ReasonCode, type SwitchAttribution, type SwitchRow, type SwitchTarget } from "./switches.ts";

export const ACTIONS = ["set", "clear", "show"] as const;
export type SwitchAction = (typeof ACTIONS)[number];

export interface SwitchCommand {
  readonly action: SwitchAction;
  readonly databaseTarget: DatabaseTarget;
  readonly target: SwitchTarget;
  /** `set` only. */
  readonly value?: unknown;
  /** `set` / `clear` only. */
  readonly attribution?: SwitchAttribution;
  readonly apply: boolean;
  readonly confirmProduction: boolean;
}

export type ParsedCommand = { readonly ok: true; readonly command: SwitchCommand } | { readonly ok: false; readonly problem: string };

/** Parses the CLI arguments. Never throws; a refusal names the rule, never a value. */
export function parseSwitchCommand(argv: readonly string[]): ParsedCommand {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        target: { type: "string", multiple: true },
        key: { type: "string" },
        qualifier: { type: "string", default: "*" },
        scope: { type: "string" },
        organization: { type: "string" },
        workspace: { type: "string" },
        value: { type: "string" },
        operator: { type: "string" },
        reason: { type: "string" },
        apply: { type: "boolean", default: false },
        "confirm-production": { type: "boolean", default: false },
      },
    });
  } catch {
    return { ok: false, problem: "unknown or malformed argument" };
  }
  const { positionals, values } = parsed;
  const positional = positionals[0];
  if (positionals.length !== 1 || positional === undefined || !(ACTIONS as readonly string[]).includes(positional)) return { ok: false, problem: `action must be one of ${ACTIONS.join(", ")}` };
  const action = positional as SwitchAction;
  const targets = (values["target"] as string[] | undefined) ?? [];
  if (targets.length !== 1 || !(DATABASE_TARGETS as readonly string[]).includes(targets[0] ?? "")) return { ok: false, problem: `exactly one --target ${DATABASE_TARGETS.join("|")} is required` };
  const databaseTarget = targets[0] as DatabaseTarget;
  const apply = values["apply"] === true;
  const confirmProduction = values["confirm-production"] === true;
  if (action === "show" && (apply || confirmProduction || values["value"] !== undefined || values["operator"] !== undefined || values["reason"] !== undefined)) {
    return { ok: false, problem: "show is read-only: no --apply, --confirm-production, --value, --operator or --reason" };
  }
  if (confirmProduction && databaseTarget !== "production") return { ok: false, problem: "--confirm-production is only meaningful with --target production" };
  if (apply && databaseTarget === "production" && !confirmProduction) return { ok: false, problem: "--apply on --target production requires --confirm-production" };

  let target: SwitchTarget;
  try {
    target = validateTarget({
      key: (values["key"] as string | undefined) ?? "",
      qualifier: (values["qualifier"] as string | undefined) ?? "*",
      scope: (values["scope"] as string | undefined) ?? (action === "show" ? "global" : ""),
      ...(values["organization"] === undefined ? {} : { organizationId: values["organization"] as string }),
      ...(values["workspace"] === undefined ? {} : { workspaceId: values["workspace"] as string }),
    });
  } catch (error) {
    return { ok: false, problem: error instanceof SwitchChangeError ? error.message : "invalid switch target" };
  }

  if (action === "show") return { ok: true, command: { action, databaseTarget, target, apply: false, confirmProduction: false } };

  const reason = (values["reason"] as string | undefined) ?? "";
  if (!(REASON_CODES as readonly string[]).includes(reason)) return { ok: false, problem: `--reason must be one of ${REASON_CODES.join(", ")}` };
  const operator = (values["operator"] as string | undefined) ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/.test(operator)) return { ok: false, problem: "--operator is required (3–128 characters: letters, digits, . _ : @ -)" };
  const attribution: SwitchAttribution = { operator, reason: reason as ReasonCode };

  if (action === "clear") {
    if (values["value"] !== undefined) return { ok: false, problem: "clear takes no --value" };
    return { ok: true, command: { action, databaseTarget, target, attribution, apply, confirmProduction } };
  }
  let value: unknown;
  try {
    value = JSON.parse((values["value"] as string | undefined) ?? "") as unknown;
  } catch {
    return { ok: false, problem: "--value must be JSON" };
  }
  if (SWITCHES[target.key].parse(value) === undefined) return { ok: false, problem: `value shape not valid for ${target.key}` };
  return { ok: true, command: { action, databaseTarget, target, value, attribution, apply, confirmProduction } };
}

export type PlanOutcome = "create" | "replace" | "unchanged" | "clear" | "absent";

export interface SwitchPlan {
  readonly outcome: PlanOutcome;
  /** True when `--apply` would write a row (and therefore a history row). */
  readonly writes: boolean;
  readonly lines: readonly string[];
}

const show = (value: unknown): string => (value === undefined ? "(absent)" : JSON.stringify(value));
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

/** The exact transition `command` would perform given the row currently stored (undefined = none). */
export function planSwitchChange(command: SwitchCommand, current: SwitchRow | undefined): SwitchPlan {
  const where = `${command.target.key} [${command.target.qualifier}] scope=${command.target.scope}`;
  if (command.action === "clear") {
    return current === undefined
      ? { outcome: "absent", writes: false, lines: [`  plan                     clear ${where}: no such override — NOTHING TO DO`] }
      : { outcome: "clear", writes: true, lines: [`  plan                     clear ${where}: ${show(current.value)} → (absent)`] };
  }
  if (command.action === "show") return { outcome: "unchanged", writes: false, lines: [`  stored                   ${where}: ${show(current?.value)}`] };
  if (current === undefined) return { outcome: "create", writes: true, lines: [`  plan                     set ${where}: (absent) → ${show(command.value)}`] };
  if (sameJson(current.value, command.value)) return { outcome: "unchanged", writes: false, lines: [`  plan                     set ${where}: already ${show(current.value)} — NOTHING TO DO (idempotent)`] };
  return { outcome: "replace", writes: true, lines: [`  plan                     set ${where}: ${show(current.value)} → ${show(command.value)}`] };
}

/** How the runtime resolves `target.key` for `target.qualifier` from `rows` (what a reader would see right now). */
export function describeResolution(rows: readonly SwitchRow[], target: SwitchTarget): string {
  const input: SwitchRowInput[] = rows.map((row) => ({
    switchKey: row.switchKey, qualifier: row.qualifier, scope: row.scope, organizationId: row.organizationId, workspaceId: row.workspaceId, value: row.value,
  }));
  const resolved = resolveSwitch(input, target.key, {
    qualifier: target.qualifier,
    ...(target.organizationId === undefined ? {} : { organizationId: target.organizationId }),
    ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
  });
  return `  runtime resolves         ${target.key} [${target.qualifier}] → ${JSON.stringify(resolved.value)} (source: ${resolved.source}${resolved.failSafe ? ", FAIL-SAFE" : ""})`;
}
