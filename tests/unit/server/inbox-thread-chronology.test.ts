/**
 * Step 7B-15Q (review 7B-15P, P2-1) — the drawn thread: when things happened AND under whom, from the read model's own
 * shape (members FLAT, oldest first by platform time, undated last; parent ids as read). The checks here are stated as
 * properties of the OUTPUT — computed from the input by this file's own small helpers, never by calling into or copying
 * the ordering code — and are run on the audit's exact example, on hand-written cases and on seeded random threads.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@/server/inbox/inbox";
import { t } from "@/server/i18n";

// Step 7B-15U: short times depend on the current UTC year — the clock is frozen so these tests never age.
vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/server/inbox/runtime", () => ({ currentInboxPage: () => Promise.resolve(undefined), currentConversation: () => Promise.resolve(undefined), currentReplyDraftScope: () => Promise.resolve(undefined), inboxPipeline: () => undefined }));

const { ConversationView, threadEntries, shortTime } = await import("@/app/workspaces/[workspaceId]/inbox/views");
const { displayTime } = await import("@/server/inbox/inbox");

type Member = ConversationDetail["thread"][number];
type Request = ConversationDetail["outbound"][number];
const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const at = (minutes: number | null): Date | null => (minutes === null ? null : new Date(T0 + minutes * 60_000));
const uuid = (n: number): string => `a${String(n).padStart(7, "0")}-1111-4111-8111-111111111111`;

const member = (n: number, parent: number | null, minutes: number | null, over: Partial<Member> = {}): Member => ({
  interactionId: uuid(n),
  parentInteractionId: parent === null ? null : uuid(parent),
  kind: parent === null ? "comment" : "reply",
  observed: true,
  author: "audience",
  authorLabel: `person-${String(n)}`,
  text: `text-${String(n)}`,
  presence: "present",
  providerCreatedAt: at(minutes),
  providerEditedAt: null,
  textObservedAt: null,
  earlierVersions: [],
  olderVersionsOmitted: false,
  facts: [],
  ...over,
});
const request = (id: string, parent: number, minutes: number, state: Request["state"] = "sent"): Request => ({ intentId: id, parentInteractionId: uuid(parent), text: `request-${id}`, state, outcomeCode: null, createdAt: at(minutes) as Date, confirmedAt: null });
const detail = (thread: readonly Member[], outbound: readonly Request[], platform: ConversationDetail["platform"] = "facebook"): ConversationDetail => ({
  conversationId: "11111111-1111-4111-8111-111111111111",
  workflowState: "open",
  platform,
  source: "organic",
  contentKind: "post",
  anchorInteractionId: thread[0]?.interactionId ?? uuid(0),
  truncated: false,
  reply: { kind: "hidden" },
  outbound,
  thread,
});
/** The read model's order: platform time ascending, undated last, then id (modules/interactions read-store `thread`). */
const asRead = (members: readonly Member[]): Member[] => [...members].sort((a, b) => (a.providerCreatedAt === null ? 1 : 0) - (b.providerCreatedAt === null ? 1 : 0) || (a.providerCreatedAt?.getTime() ?? 0) - (b.providerCreatedAt?.getTime() ?? 0) || a.interactionId.localeCompare(b.interactionId));

const idOf = (entry: ReturnType<typeof threadEntries>[number]): string => (entry.kind === "member" ? entry.item.interactionId : entry.item.intentId);
const order = (d: ConversationDetail): string[] => threadEntries(d).map(idOf);
const short = (ids: readonly string[]): string[] => ids.map((id) => (id.startsWith("a0") ? `m${String(Number(id.slice(1, 8)))}` : id));

/* ── This file's own reading of the INPUT (independent of the code under test) ── */
function blockHeadOf(thread: readonly Member[], id: string): string | undefined {
  const byId = new Map(thread.map((item) => [item.interactionId, item]));
  const start = byId.get(id);
  if (start === undefined) return undefined;
  let current: Member = start;
  for (let steps = 0; steps <= thread.length; steps += 1) {
    const parent = current.parentInteractionId === null ? undefined : byId.get(current.parentInteractionId);
    if (parent === undefined) break;
    current = parent;
  }
  return current.interactionId;
}

/** Every property the drawn thread must have, whatever the input; returns the violations found. */
function violations(d: ConversationDetail, timeSorted: boolean): string[] {
  const entries = threadEntries(d);
  const ids = entries.map(idOf);
  const found: string[] = [];
  const byId = new Map(d.thread.map((item) => [item.interactionId, item]));
  // 1. Nothing dropped, nothing drawn twice.
  const expected = [...d.thread.map((item) => item.interactionId), ...d.outbound.map((item) => item.intentId)].sort();
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(expected)) found.push("not exactly once");
  // 2. Association: an entry sits in the block of the comment it descends from; blocks are contiguous and start with their head.
  const headOfEntry = entries.map((entry) => (entry.kind === "member" ? blockHeadOf(d.thread, entry.item.interactionId) : blockHeadOf(d.thread, entry.item.parentInteractionId)));
  const closed = new Set<string>();
  headOfEntry.forEach((head, index) => {
    if (head === undefined) return;
    if (index > 0 && headOfEntry[index - 1] !== head) {
      if (closed.has(head)) found.push(`block ${head} is split`);
      if (ids[index] !== head) found.push(`block ${head} does not start with its head`);
      const previous = headOfEntry[index - 1];
      if (previous !== undefined) closed.add(previous);
    }
    if (index === 0 && ids[0] !== head) found.push("first block does not start with its head");
  });
  // A request whose comment was not read comes after every block.
  const firstUnplaced = headOfEntry.findIndex((head) => head === undefined);
  if (firstUnplaced !== -1 && headOfEntry.slice(firstUnplaced).some((head) => head !== undefined)) found.push("an unplaced request is not last");
  // 3. Parent ids are the input's own, and "replying to" is said exactly when the parent is not the block's head.
  entries.forEach((entry, index) => {
    const parentId = entry.item.parentInteractionId;
    const head = headOfEntry[index];
    const named = entry.replyingTo?.interactionId;
    const shouldName = parentId !== null && byId.has(parentId) && parentId !== head && idOf(entry) !== head ? parentId : undefined;
    if (named !== shouldName) found.push(`${idOf(entry)} names ${String(named)} instead of ${String(shouldName)}`);
    if (entry.kind === "member" && entry.item !== byId.get(entry.item.interactionId)) found.push("a member was rewritten");
    const detached = entry.kind === "member" && entry.detached === true;
    const orphanHead = entry.kind === "member" && parentId !== null && !byId.has(parentId);
    if (detached !== orphanHead) found.push(`${idOf(entry)} detached=${String(detached)}`);
  });
  // 4. The members keep the read model's relative order inside their block.
  for (const head of new Set(headOfEntry)) {
    if (head === undefined) continue;
    const drawn = entries.filter((entry, index) => entry.kind === "member" && headOfEntry[index] === head && idOf(entry) !== head).map(idOf);
    const input = d.thread.filter((item) => blockHeadOf(d.thread, item.interactionId) === head && item.interactionId !== head).map((item) => item.interactionId);
    if (JSON.stringify(drawn) !== JSON.stringify(input)) found.push(`members of ${head} reordered`);
  }
  // 5. A request comes after the comment it answers.
  entries.forEach((entry, index) => {
    if (entry.kind !== "outbound" || headOfEntry[index] === undefined) return;
    if (ids.indexOf(entry.item.parentInteractionId) > index) found.push(`${entry.item.intentId} is drawn before its parent`);
  });
  // 6. Chronology (on read-model-ordered input): among the dated members of its block that come after its own parent,
  //    none dated LATER is drawn before the request, and none dated earlier-or-equal is drawn after it.
  if (timeSorted) {
    entries.forEach((entry, index) => {
      if (entry.kind !== "outbound" || headOfEntry[index] === undefined) return;
      const parentAt = ids.indexOf(entry.item.parentInteractionId);
      entries.forEach((other, otherIndex) => {
        if (other.kind !== "member" || headOfEntry[otherIndex] !== headOfEntry[index] || otherIndex <= parentAt || other.item.providerCreatedAt === null) return;
        const later = other.item.providerCreatedAt.getTime() > entry.item.createdAt.getTime();
        if (later && otherIndex < index) found.push(`${entry.item.intentId} is drawn after a later reply`);
        if (!later && otherIndex > index) found.push(`${entry.item.intentId} is drawn before an earlier reply`);
      });
    });
    // Requests to the SAME comment are in request order (then id). (Requests to different comments of a block may
    // not be: each must also come after the comment it answers.)
    const requests = entries.flatMap((entry) => (entry.kind === "outbound" ? [entry] : []));
    for (let i = 0; i < requests.length; i += 1) for (let j = i + 1; j < requests.length; j += 1) {
      const a = requests[i];
      const b = requests[j];
      if (a === undefined || b === undefined) continue;
      if (a.item.parentInteractionId !== b.item.parentInteractionId) continue;
      if (a.item.createdAt.getTime() > b.item.createdAt.getTime() || (a.item.createdAt.getTime() === b.item.createdAt.getTime() && a.item.intentId > b.item.intentId)) found.push("requests out of request order");
    }
  }
  return found;
}

describe("the audit's example (7B-15P P2-1)", () => {
  // Anchor A; A1 at t10 under A; A1a at t20 under A1; a Wrenkind reply R to A requested at t15.
  const example = detail(asRead([member(0, null, 0), member(1, 0, 10), member(2, 1, 20)]), [request("R", 0, 15)]);

  it("is drawn A → A1 → R → A1a: in the order things happened", () => {
    expect(short(order(example))).toEqual(["m0", "m1", "R", "m2"]);
    expect(violations(example, true)).toEqual([]);
  });

  it("and no reply is attributed to the wrong parent: A1a, now after R, says in words that it answers A1 — R and A1 (which answer A, the block's comment) say nothing", () => {
    const entries = threadEntries(example);
    expect(entries.map((entry) => entry.replyingTo?.interactionId ?? null)).toEqual([null, null, null, uuid(1)]);
    expect(entries.map((entry) => entry.item.parentInteractionId)).toEqual([null, uuid(0), uuid(0), uuid(1)]);
    const html = renderToStaticMarkup(ConversationView({ workspaceId: WS, detail: example, cursor: undefined }));
    const afterR = html.slice(html.indexOf("request-R"));
    const label = t("inbox.reply.to", { author: "person-1" });
    expect(afterR).toContain(label);
    expect(html.split(label)).toHaveLength(2);
    expect(html).not.toContain(t("inbox.reply.to", { author: "person-0" }));
    // The one that answers A1 is A1a's own entry.
    const a1a = html.slice(html.indexOf(`id="member-${uuid(2)}"`));
    expect(a1a.indexOf(label)).toBeLessThan(a1a.indexOf("text-2"));
  });
});

describe("hand-written cases", () => {
  it("Instagram (one level): a request sits among the replies by time; nobody needs naming", () => {
    const d = detail(asRead([member(0, null, 0), member(1, 0, 10), member(2, 0, 20), member(3, 0, 30)]), [request("R", 0, 15), request("S", 0, 40)], "instagram");
    expect(short(order(d))).toEqual(["m0", "m1", "R", "m2", "m3", "S"]);
    expect(threadEntries(d).every((entry) => entry.replyingTo === undefined)).toBe(true);
    expect(violations(d, true)).toEqual([]);
  });

  it("depth three and more: every reply stays in its comment's block and names the reply it answers", () => {
    const d = detail(asRead([member(0, null, 0), member(1, 0, 10), member(2, 1, 20), member(3, 2, 30), member(4, 3, 40)]), [request("R", 2, 35), request("S", 0, 5)]);
    expect(short(order(d))).toEqual(["m0", "S", "m1", "m2", "m3", "R", "m4"]);
    expect(threadEntries(d).map((entry) => (entry.replyingTo === undefined ? "-" : short([entry.replyingTo.interactionId])[0]))).toEqual(["-", "-", "-", "m1", "m2", "m2", "m3"]);
    expect(violations(d, true)).toEqual([]);
  });

  it("several comments in one conversation, replies interleaved in time by the read model: each reply is drawn under ITS comment, never under the other", () => {
    // Read order: A(0) B(5) A1(10→A) B1(12→B) A2(20→A); requests to A (15) and to B (30).
    const d = detail(asRead([member(0, null, 0), member(5, null, 5), member(1, 0, 10), member(6, 5, 12), member(2, 0, 20)]), [request("RA", 0, 15), request("RB", 5, 30)]);
    expect(short(order(d))).toEqual(["m0", "m1", "RA", "m2", "m5", "m6", "RB"]);
    expect(violations(d, true)).toEqual([]);
  });

  it("equal times: the platform's reply first; requests at the same time by id — whatever order they arrive in", () => {
    const thread = asRead([member(0, null, 0), member(1, 0, 10), member(2, 1, 10), member(3, 0, 11)]);
    const requests = [request("b", 0, 10), request("a", 0, 10), request("c", 1, 10)];
    const expected = ["m0", "m1", "m2", "a", "b", "c", "m3"];
    expect(short(order(detail(thread, requests)))).toEqual(expected);
    expect(short(order(detail(thread, [...requests].reverse())))).toEqual(expected);
    expect(violations(detail(thread, requests), true)).toEqual([]);
  });

  it("undated replies (the read model lists them last) move nothing and get no invented time: a request goes before what is KNOWN to be later, otherwise to the end of its block", () => {
    const d = detail(asRead([member(0, null, 0), member(1, 0, 10), member(2, 0, 30), member(3, 0, null), member(4, 3, null)]), [request("R", 0, 20), request("S", 0, 99)]);
    expect(short(order(d))).toEqual(["m0", "m1", "R", "m2", "m3", "m4", "S"]);
    expect(threadEntries(d).every((entry) => entry.kind !== "member" || entry.item.providerCreatedAt === d.thread.find((item) => item.interactionId === entry.item.interactionId)?.providerCreatedAt)).toBe(true);
    expect(violations(d, true)).toEqual([]);
  });

  it("a reply whose parent was not read heads its own, detached block (under no one shown); a request to a comment not read is listed last — nothing is dropped", () => {
    const d = detail(asRead([member(0, null, 0), member(1, 0, 10), member(7, 99, 12), member(8, 7, 14)]), [request("R", 7, 13), request("X", 42, 1)]);
    expect(short(order(d))).toEqual(["m0", "m1", "m7", "R", "m8", "X"]);
    const entries = threadEntries(d);
    expect(entries.map((entry) => entry.kind === "member" && entry.detached === true)).toEqual([false, false, true, false, false, false]);
    expect(entries.map((entry) => entry.replyingTo)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(violations(d, true)).toEqual([]);
    const html = renderToStaticMarkup(ConversationView({ workspaceId: WS, detail: d, cursor: undefined }));
    expect(html).toMatch(new RegExp(`<li id="member-${uuid(7)}" class="[^"]*detached`));
    expect(html).toContain("request-X");
  });

  it("a parent cycle in the data (never expected) still draws every member once and terminates", () => {
    const d = detail([member(0, null, 0), member(1, 2, 10), member(2, 1, 20)], [request("R", 1, 15)]);
    const ids = order(d);
    expect([...ids].sort()).toEqual([uuid(0), uuid(1), uuid(2), "R"].sort());
  });

  it("an empty thread with requests, and a thread without requests", () => {
    expect(order(detail([], [request("R", 0, 1)]))).toEqual(["R"]);
    expect(short(order(detail(asRead([member(0, null, 0), member(1, 0, 1)]), [])))).toEqual(["m0", "m1"]);
  });
});

describe("seeded random threads", () => {
  /** A small deterministic generator (mulberry32): the cases are the same on every run. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = <V,>(values: readonly V[], next: () => number): V[] => {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j] as V, out[i] as V];
    }
    return out;
  };
  function generate(seed: number, maxDepth: number): { members: Member[]; requests: Request[]; next: () => number } {
    const next = random(seed);
    const size = 1 + Math.floor(next() * 12);
    const members: Member[] = [];
    const depth: number[] = [];
    for (let n = 0; n < size; n += 1) {
      const candidates = members.map((_, index) => index).filter((index) => (depth[index] ?? 0) < maxDepth);
      const top = n === 0 || next() < 0.2 || candidates.length === 0;
      const parent = top ? null : (candidates[Math.floor(next() * candidates.length)] as number);
      const orphan = !top && next() < 0.05;
      // A reply is never dated before its parent; some are undated; ties are common (whole minutes on a small range).
      const parentMinutes = parent === null ? 0 : (members[parent]?.providerCreatedAt === null ? 0 : ((members[parent]?.providerCreatedAt?.getTime() ?? T0) - T0) / 60_000);
      const minutes = next() < 0.12 ? null : parentMinutes + Math.floor(next() * 6);
      members.push(member(n, orphan ? 900 + n : parent, minutes));
      depth.push(parent === null ? 0 : (depth[parent] ?? 0) + 1);
    }
    const requests: Request[] = [];
    const count = Math.floor(next() * 5);
    for (let r = 0; r < count; r += 1) {
      const missing = next() < 0.08;
      // On Instagram (one level) a reply can only be requested for a top-level comment.
      const tops = members.map((item, index) => (item.parentInteractionId === null ? index : -1)).filter((index) => index >= 0);
      const parent = missing ? 800 + r : maxDepth === 1 ? (tops[Math.floor(next() * tops.length)] as number) : Math.floor(next() * size);
      requests.push(request(`r${String(r)}`, parent, Math.floor(next() * 40)));
    }
    return { members, requests, next };
  }

  it("2000 read-model-ordered threads (depth up to 4): every property holds, and the result does not depend on the order the requests arrive in", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 2000 && failures.length < 5; seed += 1) {
      const { members, requests, next } = generate(seed, 4);
      const d = detail(asRead(members), requests);
      const found = violations(d, true);
      if (found.length > 0) failures.push(`seed ${String(seed)}: ${found.join("; ")}`);
      const again = order(detail(asRead(members), shuffled(requests, next)));
      if (JSON.stringify(again) !== JSON.stringify(order(d))) failures.push(`seed ${String(seed)}: depends on the order of the requests`);
      if (JSON.stringify(order(d)) !== JSON.stringify(order(d))) failures.push(`seed ${String(seed)}: not stable`);
    }
    expect(failures).toEqual([]);
  });

  it("1000 Instagram-shaped threads (one level): the same properties, and nobody is ever named", () => {
    const failures: string[] = [];
    for (let seed = 5001; seed <= 6000 && failures.length < 5; seed += 1) {
      const { members, requests } = generate(seed, 1);
      const d = detail(asRead(members), requests, "instagram");
      const found = violations(d, true);
      if (found.length > 0) failures.push(`seed ${String(seed)}: ${found.join("; ")}`);
      if (threadEntries(d).some((entry) => entry.replyingTo !== undefined)) failures.push(`seed ${String(seed)}: named someone`);
    }
    expect(failures).toEqual([]);
  });

  it("1000 threads given in ANY order (not the read model's): nothing is dropped or repeated, every reply stays in its comment's block and names its real parent", () => {
    const failures: string[] = [];
    for (let seed = 9001; seed <= 10000 && failures.length < 5; seed += 1) {
      const { members, requests, next } = generate(seed, 4);
      const found = violations(detail(shuffled(members, next), requests), false);
      if (found.length > 0) failures.push(`seed ${String(seed)}: ${found.join("; ")}`);
    }
    expect(failures).toEqual([]);
  });

  it("the drawn page agrees with the entries: one list item per entry, in that order, each 'Replying to' naming the real parent's author", () => {
    for (const seed of [3, 17, 256, 1024, 4096]) {
      const { members, requests } = generate(seed, 4);
      const d = detail(asRead(members), requests);
      const html = renderToStaticMarkup(ConversationView({ workspaceId: WS, detail: d, cursor: undefined }));
      const entries = threadEntries(d);
      const positions = entries.map((entry) => html.indexOf(entry.kind === "member" ? `id="member-${entry.item.interactionId}"` : `request-${entry.item.intentId}<`));
      expect(positions.every((position) => position >= 0), `seed ${String(seed)}`).toBe(true);
      expect([...positions].sort((a, b) => a - b), `seed ${String(seed)}`).toEqual(positions);
      // Step 7B-15S: a detached reply (its parent was not read) also says so in words — never naming a parent.
      const labels = entries.filter((entry) => entry.replyingTo !== undefined).length;
      const detached = entries.filter((entry) => entry.kind === "member" && entry.detached === true).length;
      expect([...html.matchAll(/class="[^"]*replyingTo[^"]*"/g)]).toHaveLength(labels + detached);
      expect(html.split(t("inbox.thread.parent_not_shown").replaceAll("'", "&#x27;"))).toHaveLength(detached + 1);
      for (const entry of entries) if (entry.replyingTo !== undefined) expect(html).toContain(t("inbox.reply.to", { author: entry.replyingTo.authorLabel ?? "" }));
    }
  });
});

describe("Step 7B-15S — naming the parent and reading times (presentation only; the order above is unchanged)", () => {
  it("'Replying to' adds the parent's time when its author wrote more than one entry here — so it is clear WHICH of theirs", () => {
    // A by person-0; A1 by Marta (t10) under A; A1a by Marta again (t20) under A1; A1b by Lucas (t30) under A1a.
    const thread = [member(0, null, 0), member(1, 0, 10, { authorLabel: "Marta" }), member(2, 1, 20, { authorLabel: "Marta" }), member(3, 2, 30, { authorLabel: "Lucas" })];
    const html = renderToStaticMarkup(ConversationView({ workspaceId: WS, detail: detail(thread, []), cursor: undefined }));
    const named = (time: string): string => t("inbox.reply.to_at", { author: "Marta", time });
    expect(html).toContain(named("13 NOV 12:10")); // A1a answers Marta's FIRST reply
    expect(html).toContain(named("13 NOV 12:20")); // A1b answers Marta's SECOND reply
    expect(html).not.toContain(`${t("inbox.reply.to", { author: "Marta" })}<`);
    // An author with one entry is named alone, as before.
    const single = renderToStaticMarkup(ConversationView({ workspaceId: WS, detail: detail(asRead([member(0, null, 0), member(1, 0, 10), member(2, 1, 20)]), []), cursor: undefined }));
    expect(single).toContain(`${t("inbox.reply.to", { author: "person-1" })}<`);
  });

  it("a reply whose parent was not read says so in words, and names no one", () => {
    const html = renderToStaticMarkup(ConversationView({ workspaceId: WS, detail: detail([member(0, null, 0), member(5, 9, 10)], []), cursor: undefined }));
    const orphan = html.slice(html.indexOf(`id="member-${uuid(5)}"`));
    expect(orphan.indexOf(t("inbox.thread.parent_not_shown").replaceAll("'", "&#x27;"))).toBeGreaterThan(-1);
    expect(orphan.indexOf(t("inbox.thread.parent_not_shown").replaceAll("'", "&#x27;"))).toBeLessThan(orphan.indexOf("text-5"));
    expect(html).not.toContain(t("inbox.reply.to", { author: "person-0" }));
  });

  it("shortTime is the SAME absolute UTC instant as displayTime, only shortened: the year unless it is the current UTC year, the date when the day changes", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const date = new Date("2026-11-13T12:10:00Z");
    expect(displayTime(date)).toBe("13 NOV 2026 · 12:10 UTC");
    expect(shortTime(date, now)).toBe("13 NOV 12:10");
    expect(shortTime(date, now, new Date("2026-11-13T00:00:00Z"))).toBe("12:10");
    expect(shortTime(date, now, new Date("2026-11-12T23:59:00Z"))).toBe("13 NOV 12:10");
    expect(shortTime(new Date("2025-12-31T23:59:00Z"), now)).toBe("31 DEC 2025 23:59");
    // Never local: a UTC day boundary is the UTC day, whatever the machine's zone.
    expect(shortTime(new Date("2026-11-13T23:30:00Z"), now, new Date("2026-11-14T00:10:00Z"))).toBe("13 NOV 23:30");
  });
});
