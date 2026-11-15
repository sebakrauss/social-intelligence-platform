/**
 * Text link (UI-2). A native <a> in the brand's link blue, underlined. `external` opens in a new tab with the
 * "open outside" icon and `rel="noopener noreferrer"`; `quiet` keeps the text color until hover (dense lists).
 * `inPage` (Step 7B-15F) follows the link as an in-app navigation (the framework's <Link>, still an <a href> without
 * scripts; never prefetched), so the page keeps what the person was doing — e.g. an unsent reply draft.
 * Never used for links found inside audience text: those stay inert (TA §38.7). Server component.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/ui/icons/icon";
import styles from "./text-link.module.css";

export interface TextLinkProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly external?: boolean;
  readonly quiet?: boolean;
  /** Accessible suffix for external links ("opens in a new tab"), already translated; rendered for screen readers only. */
  readonly externalLabel?: string;
  readonly className?: string;
  readonly ariaCurrent?: "page" | "step" | "location" | "true";
  /** In-app navigation (no full page load, no prefetch). Internal links only; never with `external`. */
  readonly inPage?: boolean;
}

export function TextLink({ href, children, external = false, quiet = false, externalLabel, className, ariaCurrent, inPage = false }: TextLinkProps) {
  const classes = [styles["link"], quiet ? styles["quiet"] : undefined, className].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  if (inPage && !external) {
    return (
      <Link href={href} prefetch={false} className={classes} {...(ariaCurrent === undefined ? {} : { "aria-current": ariaCurrent })}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      className={classes}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...(ariaCurrent === undefined ? {} : { "aria-current": ariaCurrent })}
    >
      {children}
      {external ? <Icon name="util-external" size={16} /> : null}
      {external && externalLabel !== undefined && externalLabel !== "" ? <span className="wk-sr-only">{externalLabel}</span> : null}
    </a>
  );
}
