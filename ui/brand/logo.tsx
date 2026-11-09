/**
 * Wrenkind logo (UI-1; Manual de Marca v1.1 §1). The four approved pieces, with the kit's exact geometry
 * (02-logo/svg, brand kit v1.1):
 *
 *   lockup          Loop + wordmark — web, header, documents (minimum 96px wide)
 *   wordmark        V3 "Firma": the fine cut in the k — product sidebar and legal text only (minimum 140px wide)
 *   wordmark-small  V2: the same letters without the cut — below 140px (minimum 64px wide)
 *   symbol          the Loop alone — favicon, app icon, avatar, loading (minimum 16px)
 *
 * Tones, from the kit's color variants: `color` paints the letters and the Loop in the theme's primary text color
 * (the kit's color-on-dark / color-on-light files) and the dot in Electric Blue through the human token; `mono` paints
 * everything in `currentColor`, the kit's one-tint black / white files, for the parent to color. The wordmark is never
 * recolored otherwise, the dot never changes color, the Loop never rotates (opening top right) and nothing is added.
 *
 * Accessibility: `title` names the image ("wrenkind"); without it the logo is decorative (aria-hidden). Rendered as
 * inline SVG on the server; the mask id is unique per render.
 */
import { useId } from "react";
import styles from "./logo.module.css";
import { WORDMARK_PATH } from "./wordmark-path";

export type LogoVariant = "lockup" | "wordmark" | "wordmark-small" | "symbol";
export type LogoTone = "color" | "mono";

/** Kit viewBoxes, verbatim. */
export const LOGO_VIEW_BOX: { readonly [V in LogoVariant]: string } = {
  lockup: "-20 -790 5115 830",
  wordmark: "-20 -790 4125 830",
  "wordmark-small": "-20 -790 4125 830",
  symbol: "0 0 256 256",
};

/** The Loop: an open ring (opening top right) and its dot, on the kit's 256 grid. */
function Loop({ dot }: { readonly dot: string }) {
  return (
    <>
      <path d="M190.00,128.00 A62,62 0 1 1 128.00,66.00" fill="none" stroke="currentColor" strokeWidth="30" strokeLinecap="round" />
      <circle cx="171.84" cy="84.16" r="21" fill={dot} />
    </>
  );
}

/** The letters (Outfit 600 outlines, kit path) with the dot of the i; V3 adds the mask that cuts the k. */
function Wordmark({ dot, cut, maskId }: { readonly dot: string; readonly cut: boolean; readonly maskId: string }) {
  const letters = <path d={WORDMARK_PATH} fill="currentColor" />;
  return (
    <>
      {cut ? (
        <>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="-50" y="-900" width="4185" height="1100">
            <rect x="-50" y="-900" width="4185" height="1100" fill="white" />
            <rect x="2406.0" y="-503" width="34" height="523" fill="black" />
          </mask>
          <g mask={`url(#${maskId})`}>{letters}</g>
        </>
      ) : (
        letters
      )}
      <circle cx="2838.5" cy="-633.0" r="86" fill={dot} />
    </>
  );
}

export function Logo({ variant, tone = "color", title, className }: { readonly variant: LogoVariant; readonly tone?: LogoTone; readonly title?: string; readonly className?: string }) {
  const maskId = useId();
  const dot = tone === "color" ? "var(--wk-human-dot)" : "currentColor";
  const labelled = title !== undefined && title !== "";
  const classes = [styles["logo"], tone === "color" ? styles["color"] : undefined, className].filter((value): value is string => value !== undefined && value !== "").join(" ");
  return (
    <svg viewBox={LOGO_VIEW_BOX[variant]} className={classes} focusable="false" {...(labelled ? { role: "img" } : { "aria-hidden": true })}>
      {labelled ? <title>{title}</title> : null}
      {variant === "symbol" ? <Loop dot={dot} /> : null}
      {variant === "lockup" ? (
        <>
          <g transform="translate(-251.7,-993.2) scale(4.9351)">
            <Loop dot={dot} />
          </g>
          <g transform="translate(990,0)">
            <Wordmark dot={dot} cut maskId={maskId} />
          </g>
        </>
      ) : null}
      {variant === "wordmark" ? <Wordmark dot={dot} cut maskId={maskId} /> : null}
      {variant === "wordmark-small" ? <Wordmark dot={dot} cut={false} maskId={maskId} /> : null}
    </svg>
  );
}
