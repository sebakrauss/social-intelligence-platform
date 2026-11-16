// @vitest-environment happy-dom
/**
 * Comments 2.1 (Step 7B-17R) — times in the reader's own time zone. The format is checked with explicit zones (so the
 * test does not depend on the machine's); the component is checked in a real client runtime: the server HTML is the
 * UTC reading (a page without JavaScript), hydration adopts it without a mismatch, and the browser then shows the
 * same instant in the browser's zone. Synthetic instants only.
 */
import { act, createElement as h } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { localFull, localReading, localShort, zoneLabel } from "@/ui/time/local-time-format";
import { LocalTime, LocalTimeStamp } from "@/ui/time/local-time";
import { displayTime } from "@/server/inbox/inbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 01:30 UTC on 14 Nov is still 13 Nov in Santiago (UTC-3) and already 07:00 on 14 Nov in Kolkata (UTC+5:30).
const LATE = new Date("2026-11-14T01:30:00Z");
const EARLIER_SAME_UTC_DAY = new Date("2026-11-14T00:10:00Z");
const NOW = new Date("2026-11-16T12:00:00Z");

describe("the local reading (pure)", () => {
  it("the exact form names the zone and is the same instant", () => {
    expect(localFull(LATE, "UTC")).toBe("14 NOV 2026 · 01:30 UTC");
    expect(localFull(LATE, "America/Santiago")).toBe("13 NOV 2026 · 22:30 GMT-3");
    expect(localFull(LATE, "Asia/Kolkata")).toBe("14 NOV 2026 · 07:00 GMT+5:30");
    // In UTC it is exactly the server's reading: no JavaScript and JavaScript agree there.
    expect(localFull(LATE, "UTC")).toBe(displayTime(LATE));
    expect(zoneLabel(LATE, "Etc/UTC")).toBe("UTC");
  });

  it("the short form drops the date only when the time above was the same LOCAL day, and the year only in the current local year", () => {
    // 21:10 and 22:30 on the 13th in Santiago: the same local day, so only the clock.
    expect(localShort(LATE, NOW, EARLIER_SAME_UTC_DAY, "America/Santiago")).toBe("22:30");
    // Across local midnight the date comes back even though UTC calls it the same day.
    const beforeMidnightSantiago = new Date("2026-11-14T02:59:00Z"); // 23:59 on the 13th in Santiago
    const afterMidnightSantiago = new Date("2026-11-14T03:01:00Z"); //  00:01 on the 14th in Santiago
    expect(localShort(afterMidnightSantiago, NOW, beforeMidnightSantiago, "America/Santiago")).toBe("14 NOV 00:01");
    expect(localShort(afterMidnightSantiago, NOW, beforeMidnightSantiago, "UTC")).toBe("03:01");
    expect(localShort(LATE, NOW, undefined, "Asia/Kolkata")).toBe("14 NOV 07:00");
    expect(localShort(new Date("2025-03-02T10:00:00Z"), NOW, undefined, "UTC")).toBe("02 MAR 2025 10:00");
  });

  it("an instant that cannot be read keeps the server's reading", () => {
    expect(localReading("not-a-time", "short", "13 NOV 22:30", undefined)).toBe("13 NOV 22:30");
    expect(localReading("not-a-time", "full", "fallback", undefined)).toBe("fallback");
  });
});

describe("the component in a real client runtime", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;
  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    root = undefined;
    container?.remove();
  });

  it("server HTML is the UTC reading; hydration adopts it without a mismatch, then shows the browser-zone reading", async () => {
    const iso = "2026-11-14T01:30:00Z";
    const label = "14 NOV 01:30";
    const full = displayTime(LATE);
    const tree = h("div", null, h(LocalTimeStamp, { iso, label, full }), h("p", null, "Published ", h(LocalTime, { iso, form: "full", fallback: full })));
    const html = renderToString(tree);
    expect(html).toContain(`dateTime="${iso}"`);
    expect(html).toContain(`title="${full}"`);
    expect(html).toContain(`<span aria-hidden="true">${label}</span>`);
    expect(html).toContain(full);

    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container as HTMLElement, tree, { onRecoverableError: (error) => recoverable.push(error) });
      await Promise.resolve();
    });
    expect(recoverable).toEqual([]);
    const time = container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(iso);
    // After hydration: the browser's zone (whatever this runtime's is) — the same function the component uses.
    expect(time?.getAttribute("title")).toBe(localFull(LATE));
    expect(time?.querySelector("span.wk-sr-only")?.textContent).toBe(localFull(LATE));
    expect(container.querySelector("p")?.textContent).toBe(`Published ${localFull(LATE)}`);
  });
});
