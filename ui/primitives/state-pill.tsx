/**
 * State pill (UI-2): "round is state" (manual §7). A 24px pill with a soft background and a dot or icon on the left,
 * in one of five tones: `neutral` (grey), `human` (the blue reserved for where a person decides), `success`, `warning`
 * (needs review) and `danger` (a system failure). The pill names no product state of its own: callers map the states
 * that exist (Open / Done, coverage states, account status…) to a tone and pass the translated label. Server
 * component, text only.
 */
import { Icon, type IconName } from "@/ui/icons/icon";
import styles from "./state-pill.module.css";

export type StateTone = "neutral" | "human" | "success" | "warning" | "danger";

export interface StatePillProps {
  readonly children: string;
  readonly tone?: StateTone;
  /** Replaces the dot with one of the kit icons (14px look: rendered at 16 on the 24px pill). */
  readonly icon?: IconName;
  readonly className?: string;
}

export function StatePill({ children, tone = "neutral", icon, className }: StatePillProps) {
  const classes = [styles["pill"], tone === "neutral" ? undefined : styles[tone], className].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  return (
    <span className={classes}>
      {icon === undefined ? (
        <span className={styles["dot"]} aria-hidden="true" />
      ) : (
        <span className={styles["icon"]}>
          <Icon name={icon} size={16} />
        </span>
      )}
      {children}
    </span>
  );
}
