/**
 * Data tag (UI-2): "square is data" (manual §7). A 20px bordered box with no fill for what describes and does not
 * change: a content type, organic or paid, a count, a time. Optional 12px icon. `mono` sets the data typeface for
 * numbers and identifiers. The `positive` / `negative` tones exist for the manual's sentiment boxes (green / red,
 * border only, never a fill, so they can't be mistaken for a system error) and are not used by any surface yet.
 * Server component, text only.
 */
import { Icon, type IconName } from "@/ui/icons/icon";
import styles from "./data-tag.module.css";

export type DataTagTone = "neutral" | "positive" | "negative";

export interface DataTagProps {
  readonly children: string;
  readonly icon?: IconName;
  readonly tone?: DataTagTone;
  readonly mono?: boolean;
  /** The full accessible name when the visible text is an abbreviation ("3 read" → "3 comments and replies read"). */
  readonly srLabel?: string;
  readonly className?: string;
}

export function DataTag({ children, icon, tone = "neutral", mono = false, srLabel, className }: DataTagProps) {
  const classes = [styles["tag"], tone === "neutral" ? undefined : styles[tone], mono ? styles["mono"] : undefined, className].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  return (
    <span className={classes}>
      {icon === undefined ? null : (
        <span className={styles["icon"]}>
          <Icon name={icon} size={16} />
        </span>
      )}
      {srLabel === undefined || srLabel === "" ? (
        children
      ) : (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="wk-sr-only">{srLabel}</span>
        </>
      )}
    </span>
  );
}
