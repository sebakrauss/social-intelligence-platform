/**
 * Request a public reply (Step 7B-1; TA §26.3 left column): a member's explicit request to reply, publicly and as
 * the brand, to ONE canonical interaction of the routed workspace. The pipeline enforces `reply.public` (Owner, Admin,
 * Manager, Responder — not grantable) and a STANDARD workspace (Monitor-only is MODE_BLOCKED before anything runs);
 * the request service re-checks the target, the account, the connection, the capability and the provider-action
 * switch, then writes — in THIS transaction — the PENDING intent, its reply text, its first history row, and the
 * IDs-only outbox row that the integration plane's executor consumes. Nothing is sent here; the web deployment holds
 * no execution path. A repeated request with the same idempotency key answers the existing intent (R6).
 *
 * The browser supplies the canonical interaction id, the text and the server-issued idempotency key only: no
 * workspace, account, platform, provider id or topic ever comes from the caller.
 *
 * Step 7B-14G1: an OPTIONAL fourth field, the id of an operator-issued one-time validation authorization (0028). It is a
 * reference, never a permission: the request service admits it only when the database shows it names exactly this
 * member, workspace, account and target, is live and unbound; it can stand in only for a missing provider-action grant
 * and an unvalidated catalog. The Inbox form does not send it (no UI path exists in this step); nobody can issue,
 * revoke or alter an authorization through this command.
 */
import { isUuid } from "@/domain/ids";
import { object, optional, parsed, text } from "@/domain/validation";
import { REPLY_TEXT_MAX_CHARS, executeIntentDispatch, requestPublicReply, type PublicReplyOutcome, type PublicReplyRefusal } from "@/mutations/request";
import type { WorkspaceCommand } from "@/server/pipeline";

const uuid = parsed((value) => (isUuid(value) ? value : undefined));
const flag = parsed((value) => (value === true ? true : undefined));
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface PublicReplyInput {
  readonly targetInteractionId: string;
  readonly text: string;
  readonly idempotencyKey: string;
  /** Step 7B-14G1: absent for every ordinary request. */
  readonly validationAuthorizationId?: string | undefined;
  /** Step 7B-14I2: true → the server resolves the member's ONE live authorization for this exact target (never an id from the browser). */
  readonly validation?: boolean | undefined;
}

/** What the caller learns: the closed outcome and the intent to follow (never the outbox row, never provider data). */
export type PublicReplyResult =
  | { readonly kind: "requested"; readonly intentId: string }
  | { readonly kind: "existing"; readonly intentId: string; readonly status: string }
  | { readonly kind: "refused"; readonly reason: PublicReplyRefusal };

export const requestPublicReplyCommand: WorkspaceCommand<PublicReplyInput, PublicReplyOutcome, PublicReplyResult> = {
  scope: "workspace",
  name: "mutations.reply_public.request",
  permission: "reply.public",
  requiresStandardMode: true,
  validate: object({ targetInteractionId: uuid, text: text({ min: 1, max: REPLY_TEXT_MAX_CHARS }), idempotencyKey: text({ min: 8, max: 128, pattern: IDEMPOTENCY_KEY }), validationAuthorizationId: optional(uuid), validation: optional(flag) }),
  async execute(context, input, tx, env) {
    const outcome = await requestPublicReply(
      tx.mutations,
      { now: () => env.now, newId: env.newId },
      { organizationId: context.organizationId, workspaceId: context.workspaceId, userId: context.userId, correlationId: env.correlationId },
      {
        targetInteractionId: input.targetInteractionId,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
        ...(input.validationAuthorizationId === undefined ? {} : { validationAuthorizationId: input.validationAuthorizationId }),
        ...(input.validation === true ? { resolveValidationAuthorization: true } : {}),
      },
    );
    if (outcome.kind === "created") await tx.outbox.append(executeIntentDispatch({ id: env.newId(), intent: outcome.intent, now: env.now }));
    return outcome;
  },
  audit: (outcome) =>
    outcome.kind === "created"
      ? { action: "mutation_intent.created", targetType: "mutation_intent", targetId: outcome.intent.id }
      : undefined,
  respond: (outcome) =>
    outcome.kind === "created"
      ? { kind: "requested", intentId: outcome.intent.id }
      : outcome.kind === "existing"
        ? { kind: "existing", intentId: outcome.intent.id, status: outcome.intent.status }
        : { kind: "refused", reason: outcome.reason },
};
