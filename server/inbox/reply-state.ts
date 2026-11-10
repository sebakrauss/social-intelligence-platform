/**
 * The closed, serializable result of the public-reply Server Action (Step 7B-3), shared by the server action and the
 * client composer. Outcome language only: never a provider detail, an internal error or a payload echo.
 */
import type { PublicReplyRefusal } from "@/mutations/request";

export type ReplyBlockedCode = "PERMISSION_DENIED" | "MODE_BLOCKED" | "NOT_FOUND" | "INVALID_INPUT";

export type ReplyActionState =
  | { readonly kind: "idle" }
  /** The intent exists (new or already requested with the same form): its state is shown in the thread, never here. */
  | { readonly kind: "requested"; readonly intentId: string }
  | { readonly kind: "existing"; readonly intentId: string }
  | { readonly kind: "refused"; readonly reason: PublicReplyRefusal }
  | { readonly kind: "blocked"; readonly code: ReplyBlockedCode }
  | { readonly kind: "unavailable" }
  | { readonly kind: "signed_out" };

export type ReplyAction = (previous: ReplyActionState, formData: FormData) => Promise<ReplyActionState>;

export const REPLY_FORM_FIELDS = ["workspaceId", "conversationId", "targetInteractionId", "idempotencyKey", "text"] as const;
