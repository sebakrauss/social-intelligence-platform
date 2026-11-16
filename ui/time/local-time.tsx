"use client";
/**
 * Comments 2.1 (Step 7B-17R) — a time in the reader's own time zone. The server renders the UTC reading (`fallback`)
 * and that is what the HTML carries, so the page reads correctly without JavaScript; in the browser the same instant is
 * read in the browser's zone (ui/time/local-time-format.ts). React's external-store hook gives the server reading during
 * hydration and the local one right after (no mismatch), and the local one directly when the time is first drawn in
 * the browser (an in-app move: no UTC flash). It reads only the instant it is given and the browser's clock and zone;
 * it fetches, stores and sends nothing.
 */
import { useSyncExternalStore } from "react";
import { localReading } from "./local-time-format";

export type LocalTimeForm = "short" | "full";

const noSubscription = (): (() => void) => () => undefined;

/** The server's reading while hydrating (identical HTML), the browser-zone reading from then on. */
function useLocalReading(iso: string, form: LocalTimeForm, fallback: string, previous: string | undefined): string {
  return useSyncExternalStore(
    noSubscription,
    () => localReading(iso, form, fallback, previous),
    () => fallback,
  );
}

/** The reading alone, as text (inside a sentence such as "Published {time}"). */
export function LocalTime({ iso, form, fallback, previous }: { readonly iso: string; readonly form: LocalTimeForm; readonly fallback: string; readonly previous?: string | undefined }) {
  return useLocalReading(iso, form, fallback, previous);
}

/**
 * A <time>: the short reading for the eye, the exact one for assistive technology and on hover — the structure the
 * page used for UTC (ui/inbox/inbox.tsx TimeStamp), with both readings local.
 */
export function LocalTimeStamp({ iso, label, full, previous, className }: { readonly iso: string; readonly label: string; readonly full: string; readonly previous?: string | undefined; readonly className?: string | undefined }) {
  const short = useLocalReading(iso, "short", label, previous);
  const exact = useLocalReading(iso, "full", full, undefined);
  return (
    <time className={className} dateTime={iso} title={exact}>
      <span aria-hidden="true">{short}</span>
      <span className="wk-sr-only">{exact}</span>
    </time>
  );
}
