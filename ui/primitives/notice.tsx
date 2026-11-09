/**
 * Notice (UI-2): an inline message in one of four tones. Each tone carries its own icon (information: comment bubble;
 * success: check; warning: triangle; danger: cross), so color is never the only cue, and the tone word can be given
 * to screen readers through `toneLabel` (translated by the caller). Live semantics are the caller's choice:
 * `live: "polite"` renders role="status" (default), `"assertive"` role="alert", `"off"` nothing. Server component.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/ui/icons/icon";
import styles from "./notice.module.css";

export type NoticeTone = "info" | "success" | "warning" | "danger";

export const NOTICE_ICON: { readonly [T in NoticeTone]: IconName } = {
  info: "conv-comment",
  success: "decision-approve",
  warning: "estado-alert",
  danger: "decision-reject",
};

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly live?: "polite" | "assertive" | "off";
  /** The tone as a word for assistive technology ("Warning"), translated; visually hidden. */
  readonly toneLabel?: string;
  readonly className?: string;
}

export function Notice({ tone = "info", title, children, live = "polite", toneLabel, className }: NoticeProps) {
  const classes = [styles["notice"], tone === "info" ? undefined : styles[tone], className].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  const role = live === "polite" ? "status" : live === "assertive" ? "alert" : undefined;
  return (
    <div className={classes} {...(role === undefined ? {} : { role })}>
      <span className={styles["icon"]}>
        <Icon name={NOTICE_ICON[tone]} size={20} />
      </span>
      <div className={styles["body"]}>
        {toneLabel !== undefined && toneLabel !== "" ? <span className="wk-sr-only">{toneLabel}</span> : null}
        {title !== undefined && title !== "" ? <p className={styles["title"]}>{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
