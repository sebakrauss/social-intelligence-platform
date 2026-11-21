/**
 * Comments Workflow harness — DEVELOPMENT ONLY, synthetic. The local state adapter behind the harness: the work items of
 * one synthetic workspace, kept in this server process's memory (no database, no session, no provider) so Mark done,
 * Reopen and Undo can be exercised in `next dev`. It holds nothing real: every name, text and id below is invented.
 * Reset with `?seed=default` (two Done, six Open) or `?seed=open` (none Done: the empty Done view).
 */
import type { WorkspaceRole } from "@/domain/access";
import type { WorkItemResolution } from "@/domain/workflow";

export const HARNESS_PATH = "/dev/ui-reference/comments-workflow";
export const HARNESS_WORKSPACE = "3b241101-e2bb-4255-8caf-4136c566a962";

export interface HarnessItem {
  readonly id: string;
  readonly anchorId: string;
  readonly author: string;
  readonly text: string;
  readonly platform: "facebook" | "instagram";
  readonly source: "organic" | "paid";
  readonly contentKind: "post" | "reel";
  readonly latestActivityAt: Date;
  readonly members: number;
  state: "OPEN" | "DONE";
  resolution: WorkItemResolution | null;
  version: number;
}

/** normal · slow (a visible pending state) · fail-once (the next action fails; the one after it succeeds). */
export type HarnessMode = "normal" | "slow" | "fail-once";

interface HarnessState {
  items: HarnessItem[];
  role: WorkspaceRole;
  mode: HarnessMode;
}

const id = (n: number, tail: string): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${tail}`;
const at = (iso: string): Date => new Date(iso);

function seed(kind: "default" | "open"): HarnessItem[] {
  const rows: Omit<HarnessItem, "state" | "resolution" | "version">[] = [
    { id: id(1, "000000000001"), anchorId: id(1, "0000000000a1"), author: "caro.m", text: "Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder?", platform: "instagram", source: "paid", contentKind: "post", latestActivityAt: at("2026-11-08T23:14:00Z"), members: 3 },
    { id: id(2, "000000000002"), anchorId: id(2, "0000000000a2"), author: "Marta P.", text: "¿Abren el domingo por la mañana? Quiero pasar con mi familia.", platform: "facebook", source: "organic", contentKind: "post", latestActivityAt: at("2026-11-08T21:02:00Z"), members: 1 },
    { id: id(3, "000000000003"), anchorId: id(3, "0000000000a3"), author: "lucas_mz", text: "O preço subiu de novo? Achei caro demais para o que entrega.", platform: "instagram", source: "organic", contentKind: "reel", latestActivityAt: at("2026-11-08T19:40:00Z"), members: 2 },
    { id: id(4, "000000000004"), anchorId: id(4, "0000000000a4"), author: "Ana Lima", text: "Thanks for the quick fix on my order, everything arrived today!", platform: "facebook", source: "organic", contentKind: "post", latestActivityAt: at("2026-11-07T15:00:00Z"), members: 2 },
    { id: id(5, "000000000005"), anchorId: id(5, "0000000000a5"), author: "joaquin.r", text: "¿Tienen la versión sin azúcar en Montevideo?", platform: "instagram", source: "organic", contentKind: "post", latestActivityAt: at("2026-11-07T15:00:00Z"), members: 1 },
    { id: id(6, "000000000006"), anchorId: id(6, "0000000000a6"), author: "Pedro S.", text: "Vocês entregam no sábado?", platform: "facebook", source: "paid", contentKind: "post", latestActivityAt: at("2026-11-06T10:12:00Z"), members: 4 },
    { id: id(7, "000000000007"), anchorId: id(7, "0000000000a7"), author: "lena_k", text: "Love the new packaging 😍", platform: "instagram", source: "organic", contentKind: "reel", latestActivityAt: at("2026-11-05T18:30:00Z"), members: 1 },
    { id: id(8, "000000000008"), anchorId: id(8, "0000000000a8"), author: "Diego F.", text: "Mi cupón no funciona en la tienda online.", platform: "facebook", source: "organic", contentKind: "post", latestActivityAt: at("2026-11-04T09:00:00Z"), members: 2 },
  ];
  return rows.map((row, n) => {
    const done = kind === "default" && (n === 3 || n === 6);
    return { ...row, state: done ? "DONE" : "OPEN", resolution: done ? (n === 3 ? "replied_publicly" : "no_reply_needed") : null, version: done ? 2 : 1 };
  });
}

const KEY = Symbol.for("wrenkind.dev.comments-workflow-harness");

/** The harness state of this dev server process (shared by the page and its simulated action). */
export function harnessState(): HarnessState {
  const holder = globalThis as unknown as Record<symbol, HarnessState | undefined>;
  const existing = holder[KEY];
  if (existing !== undefined) return existing;
  const created: HarnessState = { items: seed("default"), role: "MANAGER", mode: "normal" };
  holder[KEY] = created;
  return created;
}

export function resetHarness(kind: "default" | "open"): void {
  const state = harnessState();
  state.items = seed(kind);
  state.mode = "normal";
}
