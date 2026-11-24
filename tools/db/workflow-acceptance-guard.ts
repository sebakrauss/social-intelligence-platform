/**
 * W12-PREP-01 — the argument guard of the shared-dev Comments Workflow acceptance tooling (tools/db/workflow-acceptance.ts
 * and its vitest global setup both call it; neither connects anywhere before it passes). Pure: no I/O.
 *
 * Target identity is NOT re-implemented here: both callers use devFixtureTargetProblems (tools/db/dev-fixture-guard.ts),
 * which proves every URL is on the project whose reference hashes to the PINNED social-intelligence-dev-v2 digest, in
 * sa-east-1, migration on the managed direct/session endpoint and the worker on the transaction pooler.
 *
 * Mutation is never the default. Every command plans (read-only) unless `--apply --confirm <phrase>` is given, and each
 * command has its OWN phrase, so a phrase copied for one operation can never apply another. Any other argument, a typo,
 * a repeated flag or a missing value is refused with nothing connected.
 *
 *   fixture                                    hierarchy (org, workspaces A/B/M, inert simulator connections) + 7 roots
 *   reply   --kind audience|account            one synthetic reply into C2 (A-10), through the same ingestion path
 *   members --u1 <uuid> --u2 <uuid>            attach two EXISTING auth users: U1 OWNER of A and M; U2 RESPONDER of A, MANAGER of B
 *   role    --u2 <uuid> --from <R> --to <R>    one audited role change of U2 in A, only along RESPONDER → ANALYST_VIEWER → CLIENT_GUEST
 *   verify  --u1 <uuid> --u2 <uuid>            read-only: identity, memberships, negative access, containment (never applies)
 */

export const WORKFLOW_ACCEPTANCE_COMMANDS = ["fixture", "reply", "members", "role", "verify"] as const;
export type WorkflowAcceptanceCommand = (typeof WORKFLOW_ACCEPTANCE_COMMANDS)[number];

/** One phrase per mutating command (verify never mutates and has none). */
export const WORKFLOW_ACCEPTANCE_CONFIRMATIONS = Object.freeze({
  fixture: "create-w12-workflow-acceptance-fixture-in-dev-v2",
  reply: "ingest-w12-synthetic-c2-reply-in-dev-v2",
  members: "attach-w12-acceptance-members-in-dev-v2",
  role: "change-w12-acceptance-u2-role-in-dev-v2",
} as const);

/** The ONLY role changes the tool can make: U2 in workspace A, one step at a time (DEV-PREFLIGHT-01 §8, A-03). */
export const U2_ROLE_SEQUENCE = ["RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;
export type U2Role = (typeof U2_ROLE_SEQUENCE)[number];
export const REPLY_KINDS = ["audience", "account"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

/** The CLI hands the validated argument vector to the vitest run, which parses it AGAIN (never trusted on its own). */
export const WORKFLOW_ACCEPTANCE_ARGS_VARIABLE = "WRENKIND_W12_ACCEPTANCE_ARGS";

export type WorkflowAcceptanceMode = "plan" | "apply";
export type WorkflowAcceptanceOperation =
  | { readonly command: "fixture"; readonly mode: WorkflowAcceptanceMode }
  | { readonly command: "reply"; readonly mode: WorkflowAcceptanceMode; readonly kind: ReplyKind }
  | { readonly command: "members"; readonly mode: WorkflowAcceptanceMode; readonly u1: string; readonly u2: string }
  | { readonly command: "role"; readonly mode: WorkflowAcceptanceMode; readonly u2: string; readonly from: U2Role; readonly to: U2Role }
  | { readonly command: "verify"; readonly mode: "plan"; readonly u1: string; readonly u2: string };

/** Canonical lower-case UUID (any version): auth user ids are never shortened, padded or case-folded silently. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isCanonicalUuid = (value: string): boolean => UUID.test(value);

/** Exactly one step forward in U2_ROLE_SEQUENCE; anything else (backwards, skipping, staying, another role) is refused. */
export function isAllowedU2Transition(from: string, to: string): boolean {
  const index = (U2_ROLE_SEQUENCE as readonly string[]).indexOf(from);
  return index >= 0 && index + 1 < U2_ROLE_SEQUENCE.length && U2_ROLE_SEQUENCE[index + 1] === to;
}

type Parsed = { readonly operation: WorkflowAcceptanceOperation } | { readonly error: string };

const FLAGS: Readonly<Record<WorkflowAcceptanceCommand, readonly string[]>> = {
  fixture: [],
  reply: ["--kind"],
  members: ["--u1", "--u2"],
  role: ["--u2", "--from", "--to"],
  verify: ["--u1", "--u2"],
};

/** `<command> [value flags] [--apply --confirm <phrase>]` — every flag exactly once, nothing unknown. */
export function parseWorkflowAcceptanceArguments(args: readonly string[]): Parsed {
  const [command, ...rest] = args;
  if (command === undefined || !(WORKFLOW_ACCEPTANCE_COMMANDS as readonly string[]).includes(command)) {
    return { error: `the first argument must be one of: ${WORKFLOW_ACCEPTANCE_COMMANDS.join(", ")}` };
  }
  const cmd = command as WorkflowAcceptanceCommand;
  const values = new Map<string, string>();
  let apply = false;
  let phrase: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] ?? "";
    if (flag === "--apply") {
      if (apply) return { error: "--apply is repeated" };
      apply = true;
      continue;
    }
    if (flag === "--confirm") {
      if (phrase !== undefined) return { error: "--confirm is repeated" };
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: "--confirm needs the confirmation phrase" };
      phrase = value;
      index += 1;
      continue;
    }
    if (!FLAGS[cmd].includes(flag)) return { error: `unknown argument for ${cmd}: ${flag}` };
    if (values.has(flag)) return { error: `${flag} is repeated` };
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
    values.set(flag, value);
    index += 1;
  }
  for (const flag of FLAGS[cmd]) if (!values.has(flag)) return { error: `${cmd} needs ${flag}` };
  if (phrase !== undefined && !apply) return { error: "--confirm is only valid with --apply" };
  let mode: WorkflowAcceptanceMode = "plan";
  if (apply) {
    if (cmd === "verify") return { error: "verify is read-only: --apply is refused" };
    if (phrase !== WORKFLOW_ACCEPTANCE_CONFIRMATIONS[cmd]) return { error: `--apply needs --confirm with the exact ${cmd} confirmation phrase` };
    mode = "apply";
  }
  const uuid = (flag: string): string | { readonly error: string } => {
    const value = values.get(flag) ?? "";
    return isCanonicalUuid(value) ? value : { error: `${flag} must be a canonical lower-case UUID` };
  };
  switch (cmd) {
    case "fixture":
      return { operation: { command: "fixture", mode } };
    case "reply": {
      const kind = values.get("--kind") ?? "";
      if (!(REPLY_KINDS as readonly string[]).includes(kind)) return { error: "--kind must be audience or account" };
      return { operation: { command: "reply", mode, kind: kind as ReplyKind } };
    }
    case "members":
    case "verify": {
      const u1 = uuid("--u1");
      const u2 = uuid("--u2");
      if (typeof u1 !== "string") return u1;
      if (typeof u2 !== "string") return u2;
      if (u1 === u2) return { error: "--u1 and --u2 must be two different users" };
      return cmd === "members" ? { operation: { command: "members", mode, u1, u2 } } : { operation: { command: "verify", mode: "plan", u1, u2 } };
    }
    case "role": {
      const u2 = uuid("--u2");
      if (typeof u2 !== "string") return u2;
      const from = values.get("--from") ?? "";
      const to = values.get("--to") ?? "";
      if (!isAllowedU2Transition(from, to)) return { error: `only ${U2_ROLE_SEQUENCE.join(" → ")}, one step at a time, is allowed` };
      return { operation: { command: "role", mode, u2, from: from as U2Role, to: to as U2Role } };
    }
  }
}

/** The vitest run re-parses the CLI's validated vector; a missing, malformed or different vector is refused. */
export function workflowAcceptanceOperationFromEnvironment(env: Readonly<Record<string, string | undefined>>): Parsed {
  const raw = env[WORKFLOW_ACCEPTANCE_ARGS_VARIABLE];
  if (raw === undefined || raw === "") return { error: `${WORKFLOW_ACCEPTANCE_ARGS_VARIABLE} is absent: run through npm run db:workflow-acceptance` };
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    return { error: `${WORKFLOW_ACCEPTANCE_ARGS_VARIABLE} is not JSON` };
  }
  if (!Array.isArray(args) || !args.every((item): item is string => typeof item === "string")) return { error: `${WORKFLOW_ACCEPTANCE_ARGS_VARIABLE} must be a string array` };
  return parseWorkflowAcceptanceArguments(args);
}
