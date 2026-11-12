/**
 * The validation-authorization operator command (Step 7B-14I2): argument parsing and the exact plan, kept apart from the
 * CLI so both are unit-tested with no database. Rules enforced here, before anything is contacted:
 *
 *   action                  issue | revoke | status — exactly one, positional
 *   --target development    mandatory and the ONLY accepted target (production is refused: not authorized)
 *   issue                   --workspace --preflight --initiator (UUIDs), --reason live_validation|test,
 *                           [--lifetime-minutes 1..60, default 60], [--accept-token-type-not-verified]
 *   revoke                  --workspace --authorization (UUIDs), --reason incident|rollback|maintenance|superseded|test
 *   status                  --workspace --authorization (UUIDs); read-only, --apply refused
 *   --apply                 issue / revoke only; without it the call runs inside a transaction that is ROLLED BACK
 *
 * There is NO operator-identity argument: the database derives the operator from the authenticated session login.
 * Identifiers are internal UUIDs only — never a provider id, URL, SQL fragment, token or text.
 */
import { parseArgs } from "node:util";

export const VALIDATION_ACTIONS = ["issue", "revoke", "status"] as const;
export type ValidationAction = (typeof VALIDATION_ACTIONS)[number];
export const ISSUE_REASONS = ["live_validation", "test"] as const;
export const REVOCATION_REASONS = ["incident", "rollback", "maintenance", "superseded", "test"] as const;
export const MAX_LIFETIME_MINUTES = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ValidationCommand =
  | { readonly action: "issue"; readonly workspaceId: string; readonly preflightId: string; readonly initiatorUserId: string; readonly reason: (typeof ISSUE_REASONS)[number]; readonly lifetimeMinutes: number; readonly acceptTokenTypeNotVerified: boolean; readonly apply: boolean }
  | { readonly action: "revoke"; readonly workspaceId: string; readonly authorizationId: string; readonly reason: (typeof REVOCATION_REASONS)[number]; readonly apply: boolean }
  | { readonly action: "status"; readonly workspaceId: string; readonly authorizationId: string };

export type ParsedValidationCommand = { readonly ok: true; readonly command: ValidationCommand } | { readonly ok: false; readonly problem: string };

const OPTIONS = {
  target: { type: "string", multiple: true },
  workspace: { type: "string" },
  preflight: { type: "string" },
  initiator: { type: "string" },
  authorization: { type: "string" },
  reason: { type: "string" },
  "lifetime-minutes": { type: "string" },
  "accept-token-type-not-verified": { type: "boolean" },
  apply: { type: "boolean" },
} as const;

const ALLOWED: Readonly<Record<ValidationAction, readonly string[]>> = {
  issue: ["target", "workspace", "preflight", "initiator", "reason", "lifetime-minutes", "accept-token-type-not-verified", "apply"],
  revoke: ["target", "workspace", "authorization", "reason", "apply"],
  status: ["target", "workspace", "authorization"],
};

/** Parses the CLI arguments. Never throws; a refusal names the rule, never a value. */
export function parseValidationCommand(argv: readonly string[]): ParsedValidationCommand {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    const result = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
    parsed = { values: { ...result.values }, positionals: [...result.positionals] };
  } catch {
    return { ok: false, problem: "unknown or malformed argument" };
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || !(VALIDATION_ACTIONS as readonly string[]).includes(positionals[0] ?? "")) return { ok: false, problem: `exactly one action is required: ${VALIDATION_ACTIONS.join(" | ")}` };
  const action = positionals[0] as ValidationAction;
  const extra = Object.keys(values).filter((key) => values[key] !== undefined && !ALLOWED[action].includes(key));
  if (extra.length > 0) return { ok: false, problem: `${action} does not accept --${extra.sort().join(", --")}` };
  const targets = (values["target"] as string[] | undefined) ?? [];
  if (targets.length !== 1) return { ok: false, problem: "--target development is required exactly once" };
  if (targets[0] !== "development") return { ok: false, problem: "--target must be development (no other target is authorized)" };
  const uuid = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === "string" && UUID.test(value) ? value : undefined;
  };
  const workspaceId = uuid("workspace");
  if (workspaceId === undefined) return { ok: false, problem: "--workspace must be a lowercase UUID" };
  const apply = values["apply"] === true;
  const reason = values["reason"];

  if (action === "issue") {
    const preflightId = uuid("preflight");
    const initiatorUserId = uuid("initiator");
    if (preflightId === undefined) return { ok: false, problem: "--preflight must be a lowercase UUID (the recorded preflight evidence id)" };
    if (initiatorUserId === undefined) return { ok: false, problem: "--initiator must be a lowercase UUID" };
    if (typeof reason !== "string" || !(ISSUE_REASONS as readonly string[]).includes(reason)) return { ok: false, problem: `--reason must be one of ${ISSUE_REASONS.join(", ")}` };
    const rawLifetime = values["lifetime-minutes"];
    const lifetimeMinutes = rawLifetime === undefined ? MAX_LIFETIME_MINUTES : typeof rawLifetime === "string" && /^\d{1,2}$/.test(rawLifetime) ? Number(rawLifetime) : Number.NaN;
    if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1 || lifetimeMinutes > MAX_LIFETIME_MINUTES) return { ok: false, problem: `--lifetime-minutes must be an integer between 1 and ${String(MAX_LIFETIME_MINUTES)}` };
    return {
      ok: true,
      command: { action, workspaceId, preflightId, initiatorUserId, reason: reason as (typeof ISSUE_REASONS)[number], lifetimeMinutes, acceptTokenTypeNotVerified: values["accept-token-type-not-verified"] === true, apply },
    };
  }
  const authorizationId = uuid("authorization");
  if (authorizationId === undefined) return { ok: false, problem: "--authorization must be a lowercase UUID" };
  if (action === "revoke") {
    if (typeof reason !== "string" || !(REVOCATION_REASONS as readonly string[]).includes(reason)) return { ok: false, problem: `--reason must be one of ${REVOCATION_REASONS.join(", ")}` };
    return { ok: true, command: { action, workspaceId, authorizationId, reason: reason as (typeof REVOCATION_REASONS)[number], apply } };
  }
  return { ok: true, command: { action, workspaceId, authorizationId } };
}

/** The exact plan, printed before anything is contacted (identifiers and closed values only). */
export function describeValidationCommand(command: ValidationCommand): readonly string[] {
  if (command.action === "issue") {
    return [
      `  action                   issue (${command.apply ? "APPLY: committed" : "DRY RUN: executed then rolled back"})`,
      `  workspace                ${command.workspaceId}`,
      `  preflight evidence       ${command.preflightId}`,
      `  initiator                ${command.initiatorUserId}`,
      `  reason                   ${command.reason}`,
      `  lifetime                 ${String(command.lifetimeMinutes)} minutes`,
      `  token type NOT_VERIFIED  ${command.acceptTokenTypeNotVerified ? "explicitly accepted (recorded in the operator log)" : "not accepted (issuance will be refused)"}`,
      "  operator                 the authenticated session login (never an argument)",
    ];
  }
  if (command.action === "revoke") {
    return [
      `  action                   revoke (${command.apply ? "APPLY: committed" : "DRY RUN: executed then rolled back"})`,
      `  workspace                ${command.workspaceId}`,
      `  authorization            ${command.authorizationId}`,
      `  reason                   ${command.reason}`,
      "  operator                 the authenticated session login (never an argument)",
    ];
  }
  return [`  action                   status (read-only)`, `  workspace                ${command.workspaceId}`, `  authorization            ${command.authorizationId}`];
}
