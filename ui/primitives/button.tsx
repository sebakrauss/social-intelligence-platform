/**
 * Button (UI-2). A native <button> in the three approved looks: `primary` (neutral, action.primary-* — never blue),
 * `secondary` (outlined) and `ghost` (text only). `type` defaults to "button" so a stray click never submits a form.
 * `pending` marks an operation in flight the honest way: the control is disabled, `aria-busy`, and shows the pending
 * label the caller passes (already translated). No spinner is drawn: the brand loader (Spin) is a kit asset not yet
 * incorporated, and nothing here simulates progress. Server component; labels arrive translated.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/ui/icons/icon";
import styles from "./button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "sm";

export interface ButtonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly type?: "button" | "submit" | "reset";
  readonly disabled?: boolean;
  /** An operation is in flight: disabled + aria-busy, showing `pendingLabel` (or the children when none is given). */
  readonly pending?: boolean;
  readonly pendingLabel?: string;
  /** Leading icon, decorative (the text carries the meaning). */
  readonly icon?: IconName;
  readonly name?: string;
  readonly value?: string;
  readonly form?: string;
  readonly id?: string;
  readonly className?: string;
}

const join = (...classes: readonly (string | undefined | false)[]): string => classes.filter((value): value is string => typeof value === "string" && value !== "").join(" ");

export function Button({ children, variant = "secondary", size = "md", type = "button", disabled = false, pending = false, pendingLabel, icon, name, value, form, id, className }: ButtonProps) {
  const inactive = disabled || pending;
  return (
    <button
      type={type}
      className={join(styles["button"], styles[variant], size === "sm" ? styles["small"] : undefined, className)}
      disabled={inactive}
      {...(pending ? { "aria-busy": true } : {})}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...(form === undefined ? {} : { form })}
      {...(id === undefined ? {} : { id })}
    >
      {icon === undefined ? null : <Icon name={icon} size={16} />}
      {pending && pendingLabel !== undefined && pendingLabel !== "" ? pendingLabel : children}
    </button>
  );
}
