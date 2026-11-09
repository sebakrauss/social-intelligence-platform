/**
 * Brand icon (UI-1; Manual de Marca v1.1 §9). Renders one of the kit's 42 icons from ./catalog.ts as inline SVG so it
 * takes `currentColor` from its text: line only, no fills, stroke 1.75 on the 24px grid, thinner (1.5) at 16px and
 * heavier (2) at 32px or more, as the manual asks. Only the Persona icon carries color, the blue dot, through the
 * `human` token; nothing else here may be blue. One kit icon (util-more, three dots drawn as zero-length strokes)
 * carries its own stroke width in the catalog; it scales with the same per-size factor.
 *
 * Accessibility: decorative by default (aria-hidden, the adjacent text carries the meaning). With `label` the icon is
 * an image with that accessible name. Labels arrive already translated: this component has no catalog of its own.
 * Server component, no client JavaScript.
 */
import { ICONS, type IconName } from "./catalog";

export type { IconName } from "./catalog";
export { ICON_NAMES } from "./catalog";

/** Manual §9: 16 · 20 · 24 · 32. */
export type IconSize = 16 | 20 | 24 | 32;

/** Manual §9: at 16px the stroke drops to 1.5; at 32px or more it rises to 2. */
export function strokeWidthFor(size: IconSize): 1.5 | 1.75 | 2 {
  if (size <= 16) return 1.5;
  if (size >= 32) return 2;
  return 1.75;
}

export function Icon({ name, size = 20, label, className }: { readonly name: IconName; readonly size?: IconSize; readonly label?: string; readonly className?: string }) {
  const labelled = label !== undefined && label !== "";
  const icon = ICONS[name];
  const strokeWidth = icon.strokeWidth === undefined ? strokeWidthFor(size) : Math.round(((icon.strokeWidth * strokeWidthFor(size)) / 1.75) * 100) / 100;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(labelled ? { role: "img" } : { "aria-hidden": true })}
      {...(className === undefined ? {} : { className })}
    >
      {labelled ? <title>{label}</title> : null}
      {icon.shapes.map((shape, index) => {
        if (shape.kind === "path") return <path key={index} d={shape.d} />;
        if (shape.kind === "rect") return <rect key={index} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />;
        return <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} {...(shape.fill === "human" ? { fill: "var(--wk-human-dot)", stroke: "none" } : {})} />;
      })}
    </svg>
  );
}
