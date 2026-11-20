"use client";
/**
 * COMMENTS-INT-03C-2 (M-1) — the app shell's OPT-IN view navigation: a section whose views are one query parameter of
 * its own address (Comments: `?view=`). The shell sits in the section's layout, which never sees the address's query,
 * so the current view is read here from the address itself — the URL is the only state:
 *
 *   - the current entry is the one whose value the address names (exactly once); anything else is the default entry —
 *     the same rule the server applies to the same parameter;
 *   - each entry leads to the section's own list (`base`, built by the server from its route helper — never from the
 *     address on screen) with only this parameter set: a switch always opens the chosen view's list at its start — no
 *     list position, and no conversation selected, even when one is open in the address (COMMENTS-INT-03C-2 S-1);
 *   - entries not built yet keep their place, as text: never a link, never focusable, never current;
 *   - wide (1024 px and up) it is the sidebar's list; narrower, one native select (the approved prototype's picker),
 *     which moves with the app's own navigation. Both live in the layout, so neither is redrawn by the move: the
 *     control used keeps the keyboard focus.
 *
 * Nothing else: no reading, no effect, no timer, no listener; the only local value is the select's optimistic choice
 * while its move is under way (it falls back to the address by itself). Sections without views never render this.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useOptimistic, useTransition } from "react";
import { AppLink } from "@/ui/navigation/app-link";
import styles from "./app-shell.module.css";

/**
 * A view of the section: `value` is the parameter's value, or undefined for the default view (no parameter). Values are
 * the server's own identifiers, URL-safe as they are (lower-case letters; pinned in comments-views-guards): the address
 * is built from them without encoding, and never from anything a person typed.
 */
export interface ShellViewChoice {
  readonly kind: "view";
  readonly label: string;
  readonly value: string | undefined;
  /** Set apart from the views before it. */
  readonly apart?: boolean;
}

/** A view that is planned but not built: its place is kept, as text only. */
export interface ShellViewLater {
  readonly kind: "later";
  readonly label: string;
}

export interface ShellViews {
  /** The navigation landmark's name. */
  readonly label: string;
  readonly heading: string;
  /**
   * The section's list address, built by the server (Comments: workspaceCommentsPath): every view leads there — the
   * default view to it as it is, the others with the parameter set. Never derived from the address on screen.
   */
  readonly base: string;
  /** The query parameter the views are values of. */
  readonly param: string;
  /** The narrow picker's (visually hidden) label. */
  readonly pickerLabel: string;
  /** Said of a view that is not built yet (read aloud, and in the narrow picker). */
  readonly laterNote: string;
  /** The same, shortened for the sidebar's tag (seen only; the full note is what is read aloud). */
  readonly laterTag: string;
  readonly items: readonly (ShellViewChoice | ShellViewLater)[];
}

const DEFAULT_KEY = "";
const keyOf = (choice: ShellViewChoice): string => choice.value ?? DEFAULT_KEY;

export function ShellViewNav({ views }: { readonly views: ShellViews }) {
  const query = useSearchParams();
  const router = useRouter();
  const pickerId = useId();
  const choices = views.items.filter((item): item is ShellViewChoice => item.kind === "view");
  const named = query.getAll(views.param);
  const current = (named.length === 1 ? choices.find((choice) => choice.value === named[0]) : undefined) ?? choices.find((choice) => choice.value === undefined);
  const hrefOf = (choice: ShellViewChoice): string => (choice.value === undefined ? views.base : `${views.base}?${views.param}=${choice.value}`);
  const [shown, show] = useOptimistic(current === undefined ? DEFAULT_KEY : keyOf(current));
  const [, startMove] = useTransition();
  // The entries from the first one set apart onwards sit in a list of their own (All conversations, below the work).
  const split = views.items.findIndex((item) => item.kind === "view" && item.apart === true);
  const before = split < 0 ? views.items : views.items.slice(0, split);
  const apart = split < 0 ? [] : views.items.slice(split);
  const entry = (item: ShellViewChoice | ShellViewLater) =>
    item.kind === "later" ? (
      <li key={item.label}>
        <span className={styles["sideItemLater"]}>
          <span className={styles["sideItemName"]}>{item.label}</span>
          <span className={styles["laterTag"]} aria-hidden="true">
            {views.laterTag}
          </span>
          <span className="wk-sr-only">{`(${views.laterNote})`}</span>
        </span>
      </li>
    ) : (
      <li key={keyOf(item)}>
        <AppLink href={hrefOf(item)} className={styles["sideItem"]} pendingClassName={styles["linkPending"]} current={item === current}>
          {item.label}
        </AppLink>
      </li>
    );
  return (
    <nav className={`${styles["sideNav"] ?? ""} ${styles["viewNav"] ?? ""}`} aria-label={views.label}>
      <p className={styles["sideHeading"]}>{views.heading}</p>
      <div className={styles["viewLists"]}>
        <ul className={styles["sideList"]}>{before.map(entry)}</ul>
        {apart.length === 0 ? null : <ul className={`${styles["sideList"] ?? ""} ${styles["sideListApart"] ?? ""}`}>{apart.map(entry)}</ul>}
      </div>
      <div className={styles["viewPicker"]}>
        <label htmlFor={pickerId} className="wk-sr-only">
          {views.pickerLabel}
        </label>
        <select
          id={pickerId}
          className={styles["viewSelect"]}
          value={shown}
          onChange={(event) => {
            const choice = choices.find((candidate) => keyOf(candidate) === event.target.value);
            if (choice === undefined || choice === current) return;
            startMove(() => {
              show(keyOf(choice));
              router.push(hrefOf(choice));
            });
          }}
        >
          {views.items.map((item) =>
            item.kind === "later" ? (
              <option key={item.label} value={`later:${item.label}`} disabled>
                {`${item.label} (${views.laterNote})`}
              </option>
            ) : (
              <option key={keyOf(item)} value={keyOf(item)}>
                {item.label}
              </option>
            ),
          )}
        </select>
      </div>
    </nav>
  );
}
