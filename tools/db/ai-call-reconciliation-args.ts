/**
 * Arguments of the READ-ONLY AI call reconciliation (tools/db/ai-call-reconciliation.ts), parsed apart from the CLI so
 * they are unit-tested: `--target development|production` is mandatory (the fence does the rest), `--stale-minutes N`
 * (1–1440, default 15) and `--rows` are the only other arguments; anything else is refused before any connection.
 */
import { parseTargetArgument, type DatabaseTarget } from "./environment.ts";

export interface ReconciliationArguments {
  readonly target: DatabaseTarget;
  readonly staleMinutes: number;
  readonly rows: boolean;
}

export type ParsedReconciliationArguments = { readonly ok: true; readonly value: ReconciliationArguments } | { readonly ok: false; readonly problem: string };

export function parseReconciliationArguments(args: readonly string[]): ParsedReconciliationArguments {
  const target = parseTargetArgument(args);
  if ("error" in target) return { ok: false, problem: target.error };
  let staleMinutes = 15;
  let rows = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--target" || arg.startsWith("--target=")) {
      if (arg === "--target") index += 1;
      continue;
    }
    if (arg === "--rows") {
      rows = true;
      continue;
    }
    if (arg === "--stale-minutes" || arg.startsWith("--stale-minutes=")) {
      const raw = arg === "--stale-minutes" ? args[++index] : arg.slice("--stale-minutes=".length);
      const minutes = Number(raw);
      if (raw === undefined || !/^\d+$/.test(raw) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return { ok: false, problem: "--stale-minutes must be an integer from 1 to 1440" };
      staleMinutes = minutes;
      continue;
    }
    return { ok: false, problem: "unknown argument" };
  }
  return { ok: true, value: { target: target.target, staleMinutes, rows } };
}
