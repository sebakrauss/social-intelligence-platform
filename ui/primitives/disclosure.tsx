/**
 * Disclosure (UI-2): expandable content on the native <details>/<summary> pair, so it works without JavaScript, is
 * keyboard-operable (Enter / Space on the summary) and announces its expanded state by itself. The marker is a CSS
 * triangle that turns when open. `meta` shows a short mono value at the right of the summary (a count, a time).
 * Server component.
 */
import type { ReactNode } from "react";
import styles from "./disclosure.module.css";

export interface DisclosureProps {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly meta?: string;
  readonly id?: string;
  readonly className?: string;
}

export function Disclosure({ summary, children, open = false, meta, id, className }: DisclosureProps) {
  const classes = [styles["disclosure"], className].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  return (
    <details className={classes} {...(open ? { open: true } : {})} {...(id === undefined ? {} : { id })}>
      <summary className={styles["summary"]}>
        {summary}
        {meta !== undefined && meta !== "" ? <span className={styles["meta"]}>{meta}</span> : null}
      </summary>
      <div className={styles["body"]}>{children}</div>
    </details>
  );
}
