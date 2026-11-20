/**
 * MESSAGES-UX-01 — reproducible browser verification for the synthetic prototype (final remediation gate).
 *
 * Runs against the isolated preview (default http://localhost:3101) in a real Chrome via playwright-core. Nothing is
 * installed by this script: point PLAYWRIGHT_CORE_FROM at any directory whose node_modules already contains
 * playwright-core, and CHROME_PATH at a Chrome/Chromium binary.
 *
 *   PLAYWRIGHT_CORE_FROM=/path/with/node_modules CHROME_PATH=/path/to/chrome \
 *     node design/messages/ux-01/verify/verify.mjs [remediation|regression|all] [--shots=DIR] [--label=after] [--verbose]
 *
 * Exit code 0 when every check passes, 1 otherwise. Every check is named with the finding it covers (P2-1…P2-8,
 * P3-A…P3-E, R = regression of approved behavior). The preview holds state in memory, so each group reloads the page.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const suite = args.find((a) => !a.startsWith("--")) ?? "all";
const shotsArg = args.find((a) => a.startsWith("--shots="));
const SHOTS = shotsArg === undefined ? null : shotsArg.slice("--shots=".length);
const LABEL = args.find((a) => a.startsWith("--label="))?.slice("--label=".length) ?? "after";
const URL = process.env.VERIFY_URL ?? "http://localhost:3101";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function loadChromium() {
  const from = process.env.PLAYWRIGHT_CORE_FROM;
  try {
    const require = createRequire(from === undefined ? import.meta.url : path.join(from, "noop.js"));
    return require("playwright-core").chromium;
  } catch {
    process.stderr.write("playwright-core not found. Set PLAYWRIGHT_CORE_FROM to a directory whose node_modules contains it.\n");
    process.exit(2);
  }
}

const chromium = loadChromium();
if (SHOTS !== null) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const check = (w, id, name, cond, detail = "") => {
  results.push({ w, id, name, ok: Boolean(cond), detail: cond ? "" : String(detail).slice(0, 220) });
};
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const WIDTHS = { 1440: 900, 1024: 768, 834: 1112, 390: 844, 320: 568 };

/** One fresh page per group: state lives in memory, so a reload is a clean synthetic workspace. */
async function page(w, h = WIDTHS[w], theme = "light") {
  const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  const p = await context.newPage();
  p.setDefaultTimeout(4000);
  p.errors = [];
  p.on("console", (m) => {
    if (m.type() === "error") p.errors.push(m.text());
  });
  p.on("pageerror", (e) => p.errors.push(e.message));
  return p;
}
const go = async (p, route) => {
  await p.goto(`${URL}${route}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(250);
};
const shot = async (p, name) => {
  if (SHOTS !== null) await p.screenshot({ path: path.join(SHOTS, `${name}-${LABEL}.png`) });
};
const wide = (w) => w >= 1024;

/** Geometry + focus snapshot. The timeline's scroll container is found, not assumed. */
const probe = (p) =>
  p.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const rect = (el) => {
      if (el === null || el === undefined || el.getClientRects().length === 0) return null;
      const r = el.getBoundingClientRect();
      return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) };
    };
    const shown = (el) => {
      const r = rect(el);
      if (r === null || r.h === 0 || r.t < -1 || r.b > vh + 1 || r.l < -1 || r.r > vw + 1) return false;
      const hit = document.elementFromPoint((r.l + r.r) / 2, (r.t + r.b) / 2);
      return hit !== null && (el.contains(hit) || hit.contains(el));
    };
    const timeline = document.querySelector("section[aria-label=Conversation]");
    let sc = timeline?.parentElement ?? null;
    while (sc !== null && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    const scroller = sc ?? document.scrollingElement;
    const composer = document.querySelector("section[aria-label=Reply], section[aria-label='Internal note'], section[aria-label='Review before sending']");
    const primary = composer === null ? null : [...composer.querySelectorAll("button")].find((b) => /^(Send \(demo\)|Review & send \(demo\)|Review \(demo\)|Add note|Add an internal note)$/.test(b.innerText.trim()));
    const pane = document.querySelector("[class*=pane]");
    const a = document.activeElement;
    const back = [...document.querySelectorAll("header a")].find((el) => el.textContent.includes("←"));
    return {
      vw,
      vh,
      scrollY: Math.round(scrollY),
      docH: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth - vw,
      independent: sc !== null && sc !== document.scrollingElement,
      scrollerH: Math.round(scroller.clientHeight),
      scrollTop: Math.round(scroller.scrollTop),
      fromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      title: shown(document.getElementById("thread-title")),
      back: back === undefined ? null : shown(back),
      assign: shown(document.querySelector("header button[aria-haspopup=menu]")),
      more: shown(document.querySelector("button[aria-label='More actions for this conversation']")),
      primary: primary === undefined || primary === null ? null : primary.innerText.trim(),
      primaryShown: primary !== undefined && primary !== null && shown(primary),
      primaryInPane: primary !== undefined && primary !== null && pane !== null && primary.getBoundingClientRect().right <= pane.getBoundingClientRect().right + 1,
      composerOverflow: composer === null ? 0 : composer.scrollWidth - composer.clientWidth,
      focusBody: a === null || a === document.body,
      focus: a === null ? "none" : a.id === "thread-title" ? "title" : a.getAttribute("data-row") !== null ? `row:${a.getAttribute("data-row")}` : `${a.tagName}:${(a.getAttribute("aria-label") ?? a.textContent ?? "").trim().slice(0, 40)}`,
      focusRole: a?.getAttribute("role") ?? null,
      path: location.pathname,
      search: location.search,
      body: document.body.innerText,
    };
  });

const ta = (p) => p.locator("section[class*=composer] textarea").first();
const openRow = async (p, id) => {
  await p.locator(`[data-row="${id}"]`).click();
  await p.waitForTimeout(350);
};
const toList = async (p, w) => {
  if (!wide(w)) {
    await p.locator("header a", { hasText: "←" }).click();
    await p.waitForTimeout(300);
  }
};
const more = async (p, item) => {
  await p.getByRole("button", { name: "More actions for this conversation" }).click();
  await p.waitForTimeout(150);
  if (item !== undefined) {
    await p.getByRole("menuitem", { name: item }).click();
    await p.waitForTimeout(250);
  }
};
const unreadCount = (p) => p.locator("[data-row] [class*=unreadDot]").count();

/* ------------------------------------------------------------------------------------------------------------------ */
/* Remediation: the eight P2 findings and the P3 corrections                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

async function remediation() {
  // P2-1 — desktop header stays, the timeline scrolls on its own, the composer stays reachable.
  for (const w of [1440, 1024]) {
    const p = await page(w);
    try {
      await go(p, "/messages?view=open");
      await openRow(p, "c-valen");
      let s = await probe(p);
      check(w, "P2-1", "open: header visible", s.title, JSON.stringify({ scrollY: s.scrollY }));
      check(w, "P2-1", "open: timeline is its own scroll container", s.independent);
      check(w, "P2-1", "open: near the latest message", s.fromBottom < 80, s.fromBottom);
      check(w, "P2-1", "open: page itself does not scroll", s.scrollY === 0 && s.docH <= s.vh + 1, `${s.scrollY} ${s.docH}`);
      for (let i = 1; i <= 5; i += 1) {
        await ta(p).fill(`Long history check ${String(i)} — synthetic demo text to grow the Valentina Cruz conversation.`);
        await p.getByRole("button", { name: "Send (demo)" }).click();
        await p.waitForTimeout(150);
      }
      s = await probe(p);
      check(w, "P2-1", "long history: header still visible", s.title);
      check(w, "P2-1", "long history: composer reachable", s.primaryShown, s.primary);
      check(w, "P2-1", "long history: follows own sends to the bottom", s.fromBottom < 80, s.fromBottom);
      check(w, "P2-1", "long history: page itself does not scroll", s.scrollY === 0, s.scrollY);
      await p.evaluate(() => {
        let sc = document.querySelector("section[aria-label=Conversation]")?.parentElement ?? null;
        while (sc !== null && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
        (sc ?? document.scrollingElement).scrollTo({ top: 0 });
      });
      await p.waitForTimeout(150);
      s = await probe(p);
      check(w, "P2-1", "reading older messages: header + composer stay", s.title && s.primaryShown, JSON.stringify({ title: s.title, composer: s.primaryShown }));
      await shot(p, `p2-1-desktop-header-${String(w)}`);
      await go(p, "/messages/c-valen");
      s = await probe(p);
      check(w, "P2-1", "deep link: header visible, page not scrolled", s.title && s.scrollY === 0, s.scrollY);
    } catch (e) {
      check(w, "P2-1", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P2-2 — phones: Back, identity and management stay; the list position and focus come back.
  for (const w of [390, 320]) {
    const p = await page(w);
    try {
      await go(p, "/messages?view=open");
      const last = await p.locator("[data-row]").last().getAttribute("data-row");
      await p.locator(`[data-row="${last}"]`).scrollIntoViewIfNeeded();
      await p.evaluate(() => window.scrollBy(0, 40));
      const listY = await p.evaluate(() => Math.round(scrollY));
      await openRow(p, last);
      let s = await probe(p);
      check(w, "P2-2", "Back visible", s.back === true, s.back);
      check(w, "P2-2", "participant name visible", s.title);
      check(w, "P2-2", "assignee + More reachable", s.assign && s.more, JSON.stringify({ assign: s.assign, more: s.more }));
      check(w, "P2-2", "composer reachable", s.primaryShown, s.primary);
      check(w, "P2-2", "messages scroll inside their own container", s.independent && s.scrollY === 0, JSON.stringify({ independent: s.independent, scrollY: s.scrollY }));
      check(w, "P2-2", "opens near the latest message", s.fromBottom < 80, s.fromBottom);
      check(w, "P2-2", "focus on the conversation title", s.focus === "title", s.focus);
      await p.goBack();
      await p.waitForTimeout(400);
      s = await probe(p);
      check(w, "P2-2", "browser Back → list, focus on the row", s.path === "/messages" && s.focus === `row:${last}`, `${s.path} ${s.focus}`);
      check(w, "P2-2", "list position restored", Math.abs(s.scrollY - listY) <= 60, `${String(listY)} → ${String(s.scrollY)}`);
      await openRow(p, "c-valen");
      s = await probe(p);
      check(w, "P2-2", "reopening from a scrolled list: header + composer visible, page not scrolled", s.title && s.back === true && s.primaryShown && s.scrollY === 0 && s.docH <= s.vh + 1, JSON.stringify({ title: s.title, back: s.back, composer: s.primaryShown, scrollY: s.scrollY, docH: s.docH }));
      await shot(p, `p2-2-mobile-header-${String(w)}`);
      await p.locator("header a", { hasText: "←" }).click();
      await p.waitForTimeout(300);
      s = await probe(p);
      check(w, "P2-2", "in-app Back → list + focus row", s.path === "/messages" && s.focus === "row:c-valen", `${s.path} ${s.focus}`);
    } catch (e) {
      check(w, "P2-2", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P2-3 — the whole composer fits at 1024 (and the other widths), Send and Review & send included.
  for (const w of [1440, 1024, 834, 390, 320]) {
    const p = await page(w);
    try {
      await go(p, "/messages/c-valen");
      await ta(p).fill("Thanks Valentina — checking the tracking number now.");
      let s = await probe(p);
      check(w, "P2-3", "Send (demo) fully visible inside the pane", s.primary === "Send (demo)" && s.primaryShown && s.primaryInPane, JSON.stringify({ p: s.primary, shown: s.primaryShown, inPane: s.primaryInPane }));
      check(w, "P2-3", "composer has no horizontal overflow", s.composerOverflow <= 0 && s.overflowX <= 0, `${String(s.composerOverflow)} ${String(s.overflowX)}`);
      await go(p, "/messages/c-pablo");
      await ta(p).fill("Lo siento mucho, revisamos el pedido hoy mismo.");
      s = await probe(p);
      check(w, "P2-3", "Review & send fully visible", /^Review/.test(s.primary ?? "") && s.primaryShown && s.primaryInPane, JSON.stringify({ p: s.primary, shown: s.primaryShown, inPane: s.primaryInPane }));
      if (w === 1024) await shot(p, "p2-3-composer-review-and-send-1024");
      await p.getByRole("button", { name: /^Review/ }).click();
      await p.waitForTimeout(200);
      const inside = await p.evaluate(() => {
        const pane = document.querySelector("[class*=pane]")?.getBoundingClientRect();
        return ["Send (demo)", "Back to editing"].map((t) => {
          const b = [...document.querySelectorAll("section[aria-label='Review before sending'] button")].find((x) => x.innerText.trim() === t);
          const r = b?.getBoundingClientRect();
          return r !== undefined && pane !== undefined && r.right <= Math.min(pane.right, innerWidth) + 1 && r.bottom <= innerHeight + 1 && r.top >= 0;
        });
      });
      check(w, "P2-3", "review: Send (demo) + Back to editing visible", inside.every(Boolean), JSON.stringify(inside));
      if (w === 1024) await shot(p, "p2-3-composer-review-panel-1024");
    } catch (e) {
      check(w, "P2-3", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P2-4 — More and Assign menus stay inside the viewport; touch + keyboard operable.
  for (const w of [834, 390, 320]) {
    const p = await page(w);
    try {
      await go(p, "/messages/c-valen");
      await more(p);
      const box = await p.evaluate(() => [...document.querySelectorAll("[role=menu] [role^=menuitem]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, h: Math.round(r.height) };
      }));
      check(w, "P2-4", "More: every action inside the viewport", box.length >= 4 && box.every((b) => b.inside), JSON.stringify(box));
      check(w, "P2-4", "More: touch targets ≥ 44 px", box.every((b) => b.h >= 44), JSON.stringify(box.map((b) => b.h)));
      let s = await probe(p);
      check(w, "P2-4", "More: focus moves into the menu", s.focusRole === "menuitem", s.focus);
      if (w === 320) await shot(p, "p2-4-more-menu-320");
      await p.keyboard.press("ArrowDown");
      const second = (await probe(p)).focus;
      check(w, "P2-4", "More: arrow keys move between actions", second !== s.focus && (await probe(p)).focusRole === "menuitem", `${s.focus} → ${second}`);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(100);
      s = await probe(p);
      check(w, "P2-4", "More: Escape returns focus to its button", s.focus.includes("More actions"), s.focus);
      await p.locator("header button[aria-haspopup=menu]").first().click();
      await p.waitForTimeout(150);
      const assign = await p.evaluate(() => [...document.querySelectorAll("[role=menu] [role^=menuitem]")].every((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }));
      check(w, "P2-4", "Assign menu inside the viewport", assign);
      await p.getByRole("menuitemradio", { name: /Carla/ }).click();
      await p.waitForTimeout(150);
      check(w, "P2-4", "Assign menu operable by touch", /assigned the conversation to Carla/.test((await probe(p)).body));
    } catch (e) {
      check(w, "P2-4", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P2-5 — Mark as unread for you: back to the list, unread restored and kept until reopened; nothing on the platform.
  for (const w of [1440, 834, 390]) {
    const p = await page(w);
    try {
      await go(p, "/messages?view=open");
      const before = await unreadCount(p);
      await openRow(p, "c-valen");
      await more(p, "Mark as unread for you");
      let s = await probe(p);
      check(w, "P2-5", "returns to the list", s.path === "/messages" && s.search === "", `${s.path}${s.search}`);
      await p.waitForTimeout(800);
      const dot = await p.locator('[data-row="c-valen"] [class*=unreadDot]').count();
      check(w, "P2-5", "unread indicator restored and kept", dot === 1, dot);
      check(w, "P2-5", "unread count updated", (await unreadCount(p)) === before + 1, `${String(before)} → ${String(await unreadCount(p))}`);
      if (wide(w)) check(w, "P2-5", "sidebar count updated", (await p.locator("aside [class*=countUnread]").innerText()).startsWith(`${String(before + 1)} new`), await p.locator("aside [class*=countUnread]").innerText());
      check(w, "P2-5", "no platform read receipt (said in words)", /Nothing changes on the platform/.test(s.body));
      check(w, "P2-5", "focus on the row", s.focus === "row:c-valen", s.focus);
      await shot(p, `p2-5-mark-unread-${String(w)}`);
      await openRow(p, "c-valen");
      await toList(p, w);
      check(w, "P2-5", "explicit reopen clears it", (await p.locator('[data-row="c-valen"] [class*=unreadDot]').count()) === 0);
    } catch (e) {
      check(w, "P2-5", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P2-6 — someone replying AND escalated: both visible in the row.
  for (const w of [1440, 390, 320]) {
    const p = await page(w);
    try {
      await go(p, "/messages/c-rafa");
      await more(p, "Escalate…");
      await p.locator("dialog[open]").getByRole("button", { name: "Escalate" }).click();
      await p.waitForTimeout(200);
      if (!wide(w)) await toList(p, w);
      const meta = await p.locator('[data-row="c-rafa"] [class*=rowMeta]').innerText();
      check(w, "P2-6", "row shows replying + escalated together", /Bruno.*replying/.test(meta) && /Escalated/.test(meta), meta);
      const overflow = await p.evaluate(() => { const el = document.querySelector('[data-row="c-rafa"] [class*=rowMeta]'); return el.scrollWidth - el.clientWidth; });
      check(w, "P2-6", "row meta fits (no clipping)", overflow <= 0, overflow);
      await p.locator('[data-row="c-rafa"]').scrollIntoViewIfNeeded();
      await shot(p, `p2-6-replying-and-escalated-${String(w)}`);
    } catch (e) {
      check(w, "P2-6", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P2-7 — Take over: accurate copy, explicit confirmation, auditable synthetic event.
  for (const w of [1440, 390]) {
    const p = await page(w);
    try {
      await go(p, "/messages/c-rafa");
      await p.getByRole("button", { name: "Take over…" }).click();
      await p.waitForTimeout(150);
      const text = await p.locator("dialog[open]").innerText();
      check(w, "P2-7", "no claim that the teammate is notified", !/will see|notif|they’ll know|is told/i.test(text) || /isn’t notified|not notified/i.test(text), text);
      check(w, "P2-7", "says: you become the internal assignee", /internal assignee|assignee in Wrenkind/i.test(text), text);
      check(w, "P2-7", "says: their unsent draft isn’t transferred", /draft/i.test(text) && /isn’t transferred|not transferred|stays with/i.test(text), text);
      check(w, "P2-7", "says: Meta Conversation Routing unchanged", /Conversation Routing/.test(text), text);
      check(w, "P2-7", "says: no real platform action", /no (real )?platform action|nothing is sent/i.test(text), text);
      await shot(p, `p2-7-take-over-${String(w)}`);
      await p.getByRole("button", { name: "Take over in Wrenkind" }).click();
      await p.waitForTimeout(250);
      const s = await probe(p);
      check(w, "P2-7", "auditable event in the timeline", /took over handling from Bruno Díaz/.test(s.body));
      check(w, "P2-8", "take over → focus in the reply field", s.focus.startsWith("TEXTAREA"), s.focus);
    } catch (e) {
      check(w, "P2-7", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P2-8 — focus never falls to <body>.
  for (const w of [1440, 834, 390]) {
    const p = await page(w);
    try {
      await go(p, "/messages/c-pablo");
      await ta(p).fill("Lo siento mucho, revisamos el pedido hoy mismo.");
      await p.getByRole("button", { name: /^Review/ }).click();
      await p.waitForTimeout(200);
      let s = await probe(p);
      check(w, "P2-8", "contextual review → focus on its heading", /Check before sending/.test(s.focus), s.focus);
      await p.getByRole("button", { name: "Back to editing" }).click();
      await p.waitForTimeout(150);
      s = await probe(p);
      check(w, "P2-8", "back to editing → focus in the field", s.focus.startsWith("TEXTAREA"), s.focus);

      await go(p, "/messages?view=open");
      await openRow(p, "c-valen");
      await p.getByRole("link", { name: "Next conversation" }).click();
      await p.waitForTimeout(350);
      s = await probe(p);
      check(w, "P2-8", "Next → focus kept on Next (not body)", !s.focusBody && /Next conversation/.test(s.focus), s.focus);
      check(w, "P2-8", "Next → new conversation announced", await p.locator("[role=status]").filter({ hasText: /of \d+/ }).count() >= 1);
      await p.getByRole("link", { name: "Previous conversation" }).click();
      await p.waitForTimeout(350);
      s = await probe(p);
      check(w, "P2-8", "Previous → focus kept (not body)", !s.focusBody && /Previous conversation/.test(s.focus), s.focus);

      await go(p, "/messages/c-joaquin");
      await p.getByRole("button", { name: "Add an internal note" }).click();
      await p.waitForTimeout(150);
      s = await probe(p);
      check(w, "P2-8", "Add an internal note → focus in the note field", s.focus.startsWith("TEXTAREA") && /Only your team can see this/.test(s.body), s.focus);

      await go(p, "/messages/c-valen");
      await ta(p).fill("/");
      await p.waitForTimeout(150);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(150);
      s = await probe(p);
      check(w, "P2-8", "“/” shortcut + Escape → focus back in the field", s.focus.startsWith("TEXTAREA"), s.focus);

      await p.getByRole("button", { name: "Emoji" }).click();
      await p.waitForTimeout(150);
      await p.getByRole("button", { name: "Close emoji" }).click();
      await p.waitForTimeout(150);
      s = await probe(p);
      check(w, "P2-8", "sheet ✕ → focus back on its tool", s.focus.includes("Emoji"), s.focus);
      await p.getByRole("button", { name: /^Saved/ }).click();
      await p.waitForTimeout(150);
      await p.getByRole("button", { name: "Close saved replies" }).click();
      await p.waitForTimeout(150);
      s = await probe(p);
      check(w, "P2-8", "saved replies ✕ → focus back on its tool", /Saved/.test(s.focus), s.focus);

      await more(p, "Escalate…");
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);
      s = await probe(p);
      check(w, "P2-8", "dialog from a menu → Escape → focus not lost", !s.focusBody, s.focus);
      await more(p, "Who can reply on the platform?");
      await p.locator("dialog[open]").getByRole("button", { name: "Close", exact: true }).first().click();
      await p.waitForTimeout(200);
      s = await probe(p);
      check(w, "P2-8", "routing explainer closed → focus not lost", !s.focusBody, s.focus);
    } catch (e) {
      check(w, "P2-8", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P3-A/B — Mark done leaves a coherent place; filters don't masquerade as views.
  for (const w of [1440, 390]) {
    const p = await page(w);
    try {
      await go(p, "/messages?view=open");
      await openRow(p, "c-valen");
      await p.getByRole("button", { name: "Mark done" }).click();
      await p.waitForTimeout(300);
      let s = await probe(p);
      check(w, "P3-A", "Mark done → back to the Open list, focus on a row", s.path === "/messages" && s.focus.startsWith("row:"), `${s.path} ${s.focus}`);
      check(w, "P3-A", "no “Not in Open” dead end", !/Not in Open/.test(s.body));
      check(w, "P3-A", "Undo offered", (await p.getByRole("button", { name: "Undo" }).count()) === 1);
      await shot(p, `p3-a-mark-done-${String(w)}`);
      await p.getByRole("button", { name: "Undo" }).click();
      await p.waitForTimeout(200);
      check(w, "P3-A", "Undo puts it back in Open", (await p.locator('[data-row="c-valen"]').count()) === 1);
      await p.getByRole("button", { name: "Unread", exact: true }).click();
      await openRow(p, "c-hotel");
      s = await probe(p);
      check(w, "P3-B", "Unread filter: opened conversation keeps a real position", !/Not in Open/.test(s.body) && /\d+ of \d+/.test(s.body), s.body.match(/(Not in \w+|\d+ of \d+)/)?.[0]);
    } catch (e) {
      check(w, "P3", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P3-C/D — touch targets and low-height phones.
  for (const [w, h] of [[390, 844], [320, 568]]) {
    const p = await page(w, h);
    try {
      await go(p, "/messages/c-rafa");
      const links = await p.evaluate(() => [...document.querySelectorAll("[class*=collision] button")].map((b) => Math.round(b.getBoundingClientRect().height)));
      check(w, "P3-C", "collision actions ≥ 44 px", links.length === 2 && links.every((x) => x >= 44), JSON.stringify(links));
      let s = await probe(p);
      check(w, "P3-D", `messages area with the collision warning ≥ 140 px (h ${String(h)}): ${String(s.scrollerH)} px`, s.scrollerH >= 140, s.scrollerH);
      if (w === 320) await shot(p, "p3-d-320x568-collision");
      await go(p, "/messages/c-valen");
      s = await probe(p);
      check(w, "P3-D", `messages area in a normal conversation ≥ 200 px (h ${String(h)}): ${String(s.scrollerH)} px`, s.scrollerH >= 200, s.scrollerH);
    } catch (e) {
      check(w, "P3-C/D", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }

  // P3-E — landmark and dark placeholder contrast.
  {
    const p = await page(1440, 900, "dark");
    try {
      await go(p, "/messages/c-valen");
      check(1440, "P3-E", "one main landmark", (await p.locator("main").count()) === 1);
      const ratio = await p.evaluate(() => {
        const parse = (c) => c.match(/[\d.]+/g).map(Number);
        const lum = ([r, g, b]) => [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
        const out = [];
        for (const el of [document.querySelector("section[class*=composer] textarea"), document.getElementById("message-search")]) {
          const fg = parse(getComputedStyle(el, "::placeholder").color);
          const bg = parse(getComputedStyle(el).backgroundColor);
          const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          out.push(Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100);
        }
        return out;
      });
      check(1440, "P3-E", "dark placeholders ≥ 4.5:1", ratio.every((r) => r >= 4.5), JSON.stringify(ratio));
      await shot(p, "p3-e-dark-1440");
    } catch (e) {
      check(1440, "P3-E", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Regression of approved behavior (critical flows) at the five widths                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

async function regression() {
  for (const w of [1440, 1024, 834, 390, 320]) {
    const p = await page(w);
    const view = async (label, value) => {
      if (wide(w)) await p.locator("aside a", { hasText: new RegExp(`^${label}`) }).first().click();
      else await p.locator("select[aria-label=View]").selectOption(value);
      await p.waitForTimeout(250);
    };
    const controls = async (fn) => {
      await p.getByRole("button", { name: "Prototype controls" }).click();
      await fn(p.locator("dialog[open]"));
      await p.locator("dialog[open]").getByRole("button", { name: "Done" }).click();
      await p.waitForTimeout(150);
    };
    try {
      await go(p, "/messages");
      let s = await probe(p);
      const rows = () => p.locator("[data-row]").count();
      check(w, "R", "Open list by default, nothing selected", (await rows()) === 9 && s.path === "/messages", await rows());
      await view("Done", "done");
      check(w, "R", "Done view", (await rows()) === 2, await rows());
      await view("All", "all");
      check(w, "R", "All view", (await rows()) === 11, await rows());
      await view("Open", "open");
      await p.getByRole("button", { name: "Unread", exact: true }).click();
      check(w, "R", "Unread filter (per user)", (await rows()) === 4, await rows());
      await p.getByRole("button", { name: "Unread", exact: true }).click();
      await p.getByRole("button", { name: "Mine", exact: true }).click();
      check(w, "R", "Mine filter", (await rows()) === 1, await rows());
      await p.getByRole("button", { name: "Mine", exact: true }).click();

      await openRow(p, "c-hotel");
      s = await probe(p);
      check(w, "R", "open conversation (Open/Done independent of unread)", s.path === "/messages/c-hotel" && /\bOpen\b/.test(s.body));
      await p.locator("header button[aria-haspopup=menu]", { hasText: "Unassigned" }).click();
      await p.getByRole("menuitemradio", { name: /Mara Ortiz \(you\)/ }).click();
      await p.waitForTimeout(200);
      check(w, "R", "assign → internal event", /Mara Ortiz took the conversation/.test((await probe(p)).body));

      await ta(p).fill("Reply draft kept");
      await p.getByRole("tab", { name: /Internal note/ }).click();
      check(w, "R", "note tab starts empty (reply text not moved)", (await ta(p).inputValue()) === "");
      await ta(p).fill("Quote 40 kg at wholesale tier B");
      s = await probe(p);
      check(w, "R", "note: “Only your team can see this” + Add note (no Send)", /Only your team can see this/.test(s.body) && (await p.getByRole("button", { name: "Add note" }).count()) === 1 && (await p.getByRole("button", { name: /^Send/ }).count()) === 0);
      const amber = await p.evaluate(() => getComputedStyle(document.querySelector("section[class*=composerNote]")).backgroundColor);
      check(w, "R", "note composer is amber", /rgb\((25[0-5]|24\d), (24\d|23\d), (22\d|21\d)\)/.test(amber), amber);
      await p.getByRole("tab", { name: "Reply" }).click();
      check(w, "R", "reply draft kept separately", (await ta(p).inputValue()) === "Reply draft kept");
      await p.getByRole("tab", { name: /Internal note/ }).click();
      await p.getByRole("button", { name: "Add note" }).click();
      await p.waitForTimeout(200);
      check(w, "R", "published note in the timeline", (await p.locator("li[aria-label^='Internal note by Mara Ortiz']").count()) === 1);
      await p.getByRole("tab", { name: "Reply" }).click();

      await ta(p).fill("/whole");
      await p.waitForTimeout(150);
      await p.getByLabel("Search saved replies").press("Enter");
      check(w, "R", "saved reply → Spanish variant", (await ta(p).inputValue()).startsWith("¡Gracias por tu interés!"));
      await p.getByRole("button", { name: /^Translate$/ }).click();
      await p.getByRole("button", { name: "To Portuguese" }).click();
      check(w, "R", "translate draft ES → PT (fixture)", (await ta(p).inputValue()).startsWith("Obrigado pelo interesse!"));
      await p.getByRole("button", { name: "Restore original" }).click();
      check(w, "R", "restore original", (await ta(p).inputValue()).startsWith("¡Gracias por tu interés!"));
      await p.getByRole("button", { name: "Translate to English" }).first().click();
      check(w, "R", "incoming ES → EN + Show original", await p.getByText("Hi, we are the purchasing team").isVisible());
      await p.getByRole("button", { name: "Send (demo)" }).click();
      await p.waitForTimeout(250);
      s = await probe(p);
      check(w, "R", "human Send (demo) → local demo message, stays Open", /Demo — not sent/i.test(s.body) && /stays Open/.test(s.body) && (await ta(p).inputValue()) === "");

      await go(p, "/messages/c-pablo");
      await ta(p).fill("We'll refund you today.");
      await p.getByRole("button", { name: /^Review/ }).click();
      check(w, "R", "Variant B: high-risk → review with reasons", (await p.getByText("Check before sending").isVisible()) && /Synthetic high-risk example/.test((await probe(p)).body));
      await p.getByRole("button", { name: "Send (demo)" }).click();
      await p.waitForTimeout(200);
      check(w, "R", "Variant B: send after review", /We'll refund you today\./.test((await probe(p)).body));
      await controls(async (d) => {
        await d.getByRole("radio", { name: /A · Fast human send/ }).check();
      });
      await ta(p).fill("Second message, direct.");
      check(w, "R", "Variant A: direct Send (demo)", (await p.getByRole("button", { name: "Send (demo)" }).count()) === 1);
      await ta(p).press(`${MOD}+Enter`);
      await p.waitForTimeout(200);
      check(w, "R", "Variant A: ⌘/Ctrl+Enter sends (demo)", /Second message, direct\./.test((await probe(p)).body));

      await go(p, "/messages/c-rafa");
      await p.getByRole("button", { name: "Take over…" }).click();
      await p.getByRole("button", { name: "Take over in Wrenkind" }).click();
      await p.waitForTimeout(200);
      s = await probe(p);
      check(w, "R", "take over (internal) → warning gone, event", !/is also replying/.test(s.body) && /took over handling/.test(s.body));
      await more(p, "Escalate…");
      await p.locator("dialog[open]").getByRole("button", { name: "Escalate" }).click();
      await p.waitForTimeout(200);
      check(w, "R", "escalate → chip + event", (await p.getByRole("button", { name: /Escalated to Ana/ }).count()) === 1 && /escalated to Ana Torres/.test((await probe(p)).body));

      await go(p, "/messages/c-joaquin");
      check(w, "R", "closed window → reply unavailable, note offered", /24-hour reply window closed/.test((await probe(p)).body));

      await go(p, "/messages?view=open");
      await openRow(p, "c-nina");
      await p.getByRole("button", { name: "Translate to Spanish" }).click();
      check(w, "R", "incoming PT → ES", await p.getByText(/Soy creadora de contenido/).isVisible());
      if (!wide(w)) await toList(p, w);
      await view("Done", "done");
      s = await probe(p);
      check(w, "R", "view switch → list, no selection", s.path === "/messages" && s.search === "?view=done");
      await p.goBack();
      await p.waitForTimeout(300);
      if (!wide(w)) {
        await p.goBack();
        await p.waitForTimeout(300);
      }
      s = await probe(p);
      check(w, "R", "browser Back → conversation", s.path === "/messages/c-nina", s.path);
      if (!wide(w)) {
        await p.goForward();
        await p.waitForTimeout(300);
      }
      await p.goForward();
      await p.waitForTimeout(300);
      s = await probe(p);
      check(w, "R", "browser Forward → Done list", s.search === "?view=done" && s.path === "/messages", `${s.path}${s.search}`);

      await go(p, "/messages/c-valen");
      check(w, "R", "intelligence off by default", (await p.getByText(/Future · not active/).count()) === 0);
      if (!wide(w)) {
        const small = await p.evaluate(() =>
          [...document.querySelectorAll("button, a, select, input, textarea")]
            .filter((el) => el.getClientRects().length > 0 && el.closest("dialog:not([open])") === null && el.closest("[class*=demoBar]") === null && el.closest("[class*=meta]") === null && !String(el.className).includes("infoButton"))
            .map((el) => ({ h: Math.round(el.getBoundingClientRect().height), t: (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 20) }))
            .filter((x) => x.h < 44),
        );
        check(w, "R", "targets ≥ 44 px below 1024", small.length === 0, JSON.stringify(small.slice(0, 6)));
      }
      s = await probe(p);
      check(w, "R", "no horizontal overflow", s.overflowX <= 0, s.overflowX);
      check(w, "R", "no console errors", p.errors.length === 0, p.errors.join(" | "));
    } catch (e) {
      check(w, "R", "group aborted", false, e.message.split("\n")[0]);
    }
    await p.context().close();
  }
}

if (suite === "remediation" || suite === "all") await remediation();
if (suite === "regression" || suite === "all") await regression();
await browser.close();

const failed = results.filter((r) => !r.ok);
const byId = {};
for (const r of results) {
  byId[r.id] ??= { pass: 0, fail: 0 };
  byId[r.id][r.ok ? "pass" : "fail"] += 1;
}
process.stdout.write(`${JSON.stringify(byId)}\n`);
process.stdout.write(`TOTAL ${String(results.length - failed.length)} / ${String(results.length)} passed\n`);
if (args.includes("--verbose")) for (const r of results) process.stdout.write(`${r.ok ? "pass" : "FAIL"} ${String(r.w)} ${r.id} ${r.name}\n`);
for (const r of failed) process.stdout.write(`FAIL ${String(r.w)} ${r.id} ${r.name} :: ${r.detail}\n`);
process.exit(failed.length === 0 ? 0 : 1);
