/**
 * WORKFLOW-WF-2D: the Comments Workflow harness outside development. Vitest runs with NODE_ENV=test, which is not
 * development, exactly like a production build: the simulated action answers `unavailable` and changes nothing, and the
 * page is a 404 before it reads or changes anything.
 */
import { describe, expect, it } from "vitest";
import { simulateWorkflowAction } from "@/app/dev/ui-reference/comments-workflow/actions";
import CommentsWorkflowHarnessPage from "@/app/dev/ui-reference/comments-workflow/page";
import { HARNESS_WORKSPACE, harnessState } from "@/app/dev/ui-reference/comments-workflow/store";

describe("Comments Workflow harness outside development", () => {
  it("runs under a non-development NODE_ENV", () => {
    expect(process.env.NODE_ENV).not.toBe("development");
  });

  it("the simulated action answers unavailable and changes no item", async () => {
    const before = JSON.stringify(harnessState().items);
    const form = new FormData();
    form.set("workspaceId", HARNESS_WORKSPACE);
    form.set("conversationId", harnessState().items[0]?.id ?? "");
    form.set("expectedVersion", "1");
    form.set("to", "done");
    form.set("resolution", "");
    await expect(simulateWorkflowAction({ kind: "idle" }, form)).resolves.toEqual({ kind: "unavailable" });
    expect(JSON.stringify(harnessState().items)).toBe(before);
  });

  it("the page is a 404 and applies no command (seed, role, mode)", async () => {
    const state = harnessState();
    const before = JSON.stringify({ role: state.role, mode: state.mode, items: state.items });
    await expect(CommentsWorkflowHarnessPage({ searchParams: Promise.resolve({ seed: "open", role: "OWNER", mode: "fail-once" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(JSON.stringify({ role: state.role, mode: state.mode, items: state.items })).toBe(before);
  });
});
