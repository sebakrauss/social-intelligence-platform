/**
 * Origin mark (UI-2): which platform a conversation comes from and whether it is paid, with the brand's own
 * monograms (manual §7: IG, FB, TT in an 18px box; no third-party logos or colors) and the AD mark for paid content.
 * The platform keys are the product's (domain/platforms.ts); an "unknown" platform renders a dashed, empty box.
 * The platform name is always present for assistive technology and may be shown next to the box. The paid state is
 * announced through `paidLabel` ("Ad"), translated by the caller. Server component, text only.
 */
import type { PlatformKey } from "@/domain/platforms";
import styles from "./origin-mark.module.css";

export type OriginPlatform = PlatformKey | "unknown";

/** The manual's monograms. */
export const PLATFORM_MONOGRAM: { readonly [P in PlatformKey]: string } = {
  facebook: "FB",
  instagram: "IG",
  tiktok: "TT",
};

export interface OriginMarkProps {
  readonly platform: OriginPlatform;
  /** The platform's display name (domain PLATFORM_DISPLAY_NAMES, or the translated "unknown" wording). */
  readonly name: string;
  readonly paid?: boolean;
  /** The word announced for paid content; rendered visibly as "AD" when `paid`. */
  readonly paidLabel?: string;
  /** Show the name beside the monogram (default: screen readers only). */
  readonly showName?: boolean;
  readonly className?: string;
}

export function OriginMark({ platform, name, paid = false, paidLabel, showName = false, className }: OriginMarkProps) {
  const classes = [styles["origin"], className].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  const monogramClass = [styles["monogram"], platform === "unknown" ? styles["unknown"] : undefined].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  return (
    <span className={classes}>
      <span className={monogramClass} aria-hidden="true">
        {platform === "unknown" ? "–" : PLATFORM_MONOGRAM[platform]}
      </span>
      <span className={showName ? styles["name"] : "wk-sr-only"}>{name}</span>
      {paid ? (
        <>
          <span className={styles["ad"]} aria-hidden="true">
            AD
          </span>
          {paidLabel !== undefined && paidLabel !== "" ? <span className="wk-sr-only">{paidLabel}</span> : null}
        </>
      ) : null}
    </span>
  );
}
