/**
 * MESSAGES-UX-01 — small shared pieces of the prototype. Wrenkind's own primitives are reused read-only
 * (ui/primitives, ui/icons, ui/brand); nothing in the product is modified for this prototype.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { ACCOUNTS, TEAM } from "./data";
import { PLATFORM_NAMES, type Account, type Platform } from "./model";
import styles from "./messages.module.css";

/** Class names from the prototype's CSS module. */
export function cx(...names: readonly (string | false | null | undefined)[]): string {
  return names
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => styles[name] ?? "")
    .filter((name) => name !== "")
    .join(" ");
}

export const accountOf = (id: string): Account => ACCOUNTS.find((a) => a.id === id) ?? { id, platform: "instagram", name: "Unknown account", handle: "" };
/** How an account is named in lists: "@handle" on Instagram, "Messenger · Page name" on Messenger. */
export const accountLabel = (a: Account): string => (a.platform === "messenger" ? `Messenger · ${a.handle}` : a.handle);
/** The receiving account inside a conversation, where the platform is already named: "@handle" or "Page name Page". */
export const accountTarget = (a: Account): string => (a.platform === "messenger" ? `${a.name} Page` : a.handle);
export const teammate = (id: string | null): { readonly name: string; readonly initials: string } | null => (id === null ? null : (TEAM.find((t) => t.id === id) ?? null));
export const firstName = (name: string): string => name.split(" ")[0] ?? name;

export function PlatformMark({ platform }: { readonly platform: Platform }) {
  return <OriginMark platform={platform === "instagram" ? "instagram" : "facebook"} name={PLATFORM_NAMES[platform]} />;
}

export function Avatar({ initials, size = "md", tone = "person", badge }: { readonly initials: string; readonly size?: "xs" | "sm" | "md" | "lg"; readonly tone?: "person" | "team"; readonly badge?: boolean }) {
  return (
    <span className={cx("avatar", `avatar-${size}`, tone === "team" && "avatarTeam")} aria-hidden="true">
      {initials}
      {badge === true ? <span className={cx("avatarBadge")} /> : null}
    </span>
  );
}

/** Demo / future / later markers: always in words, never only a color. */
export function Marker({ kind, children }: { readonly kind: "future" | "demo" | "provider" | "later"; readonly children: ReactNode }) {
  return <span className={cx("marker", `marker-${kind}`)}>{children}</span>;
}

/**
 * Closes a popover on Escape or a pointer press outside it. Escape gives the focus back to its trigger (or to the
 * fallback when there is no trigger, e.g. a panel opened by typing "/"), so it never falls to <body>.
 */
export function useDismiss(open: boolean, close: () => void, panel: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>, fallback?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      (trigger.current ?? fallback?.current ?? null)?.focus();
      close();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panel.current?.contains(target) === true || trigger.current?.contains(target) === true) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, panel, trigger, fallback]);
}

const ITEMS = "[role^='menuitem']";

/**
 * Menu keyboard behavior (WAI-ARIA menu button): focus moves into the menu when it opens (the checked item first),
 * ↑ ↓ Home End move between items, Tab closes it. Escape is handled by useDismiss.
 */
export function useMenuKeys(open: boolean, panel: RefObject<HTMLElement | null>, close: () => void): (event: ReactKeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    if (!open) return;
    const root = panel.current;
    (root?.querySelector<HTMLElement>("[aria-checked='true']") ?? root?.querySelector<HTMLElement>(ITEMS))?.focus({ preventScroll: true });
  }, [open, panel]);
  return (event) => {
    if (event.key === "Tab") {
      close();
      return;
    }
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };
}

/** A quiet ⓘ that explains a provider-dependent or prototype-only detail on demand (instead of a permanent marker). */
export function Info({ label, children, align = "start" }: { readonly label: string; readonly children: ReactNode; readonly align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismiss(open, close, panel, trigger);
  return (
    <span className={cx("info")}>
      <button
        ref={trigger}
        type="button"
        className={cx("infoButton")}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open ? (
        <div ref={panel} id={id} role="note" className={cx("infoPanel", align === "end" && "infoPanelEnd")}>
          {children}
        </div>
      ) : null}
    </span>
  );
}

/**
 * A modal dialog on the native <dialog> element: focus is trapped by the browser, Escape closes it and the browser
 * returns focus to the element that opened it. When that element is gone (e.g. the warning that offered the action),
 * focus goes to the conversation title instead of falling to <body>.
 */
export function Dialog({ open, title, onClose, children, footer, side = false }: { readonly open: boolean; readonly title: string; readonly onClose: () => void; readonly children: ReactNode; readonly footer: ReactNode; readonly side?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closing) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) document.getElementById("thread-title")?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx("dialog", side && "dialogSide")}
      aria-label={title}
      onClose={() => {
        onClose();
      }}
    >
      <div className={cx("dialogHead")}>
        <h2 className={cx("dialogTitle")}>{title}</h2>
        <button
          type="button"
          className={cx("iconButton")}
          aria-label="Close"
          onClick={() => {
            onClose();
          }}
        >
          ✕
        </button>
      </div>
      <div className={cx("dialogBody")}>{children}</div>
      <div className={cx("dialogFoot")}>{footer}</div>
    </dialog>
  );
}

/** The header of a composer tool panel; on phones the panel is a bottom sheet and this is its title bar. */
export function SheetHead({ title, onClose }: { readonly title: string; readonly onClose: () => void }) {
  return (
    <div className={cx("sheetHead")}>
      <p className={cx("popoverTitle")}>{title}</p>
      <button
        type="button"
        className={cx("iconButton", "sheetClose")}
        aria-label={`Close ${title.toLowerCase()}`}
        onClick={() => {
          onClose();
        }}
      >
        ✕
      </button>
    </div>
  );
}
