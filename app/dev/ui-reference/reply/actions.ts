"use server";
/**
 * Reply harness action — DEVELOPMENT ONLY. Simulates the closed outcomes of the real publish action without a session,
 * a database, a provider or a job, so the composer's write → review → publish → state walk can be exercised end to end
 * in `next dev`. The scenario is chosen by the text's first word (`deny`, `monitor`, `refuse`, `gone`, `again`, `fail`,
 * `out`); anything else is a successful request. Outside development it answers `unavailable` and does nothing else.
 * It never reaches the pipeline: the real path is server/inbox/actions.ts.
 */
import type { ReplyActionState } from "@/server/inbox/reply-state";

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";

export async function simulateReplyAction(_previous: ReplyActionState, form: FormData): Promise<ReplyActionState> {
  if (!IS_DEVELOPMENT) return { kind: "unavailable" };
  const raw = form.get("text");
  const text = typeof raw === "string" ? raw : "";
  const key = form.get("idempotencyKey");
  if (typeof key !== "string" || key === "") return { kind: "blocked", code: "INVALID_INPUT" };
  // A visible, deliberate delay so the pending state (and a second click during it) can be observed.
  await new Promise((resolve) => setTimeout(resolve, 900));
  const word = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (word) {
    case "deny":
      return { kind: "blocked", code: "PERMISSION_DENIED" };
    case "monitor":
      return { kind: "blocked", code: "MODE_BLOCKED" };
    case "refuse":
      return { kind: "refused", reason: "CAPABILITY_UNAVAILABLE" };
    case "gone":
      return { kind: "refused", reason: "TARGET_NOT_PRESENT" };
    case "again":
      return { kind: "existing", intentId: "b1111111-1111-4111-8111-111111111111" };
    case "fail":
      return { kind: "unavailable" };
    case "out":
      return { kind: "signed_out" };
    default:
      return { kind: "requested", intentId: "b9999999-9999-4999-8999-999999999999" };
  }
}
