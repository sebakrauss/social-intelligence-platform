/**
 * Field (UI-2): a labelled native control with optional help and error. The label is tied to the control by id, the
 * help and error texts are announced through aria-describedby, an error sets aria-invalid and is rendered with an
 * icon so color is never the only signal. `required` sets the native attribute (announced by assistive technology)
 * and shows the marker. Texts arrive translated. Server component: works in plain HTML forms and server actions.
 */
import { Icon } from "@/ui/icons/icon";
import styles from "./field.module.css";

export interface FieldProps {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly type?: "text" | "email" | "password" | "search" | "url" | "number";
  readonly help?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly multiline?: boolean;
  readonly rows?: number;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly autoComplete?: string;
  readonly maxLength?: number;
  /** Visible marker for required fields ("*"), already translated if a word is preferred. */
  readonly requiredMarker?: string;
}

export function Field({ id, name, label, type = "text", help, error, required = false, disabled = false, multiline = false, rows = 3, defaultValue, placeholder, autoComplete, maxLength, requiredMarker = "*" }: FieldProps) {
  const hasHelp = help !== undefined && help !== "";
  const hasError = error !== undefined && error !== "";
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [hasHelp ? helpId : undefined, hasError ? errorId : undefined].filter((value): value is string => value !== undefined).join(" ");
  const controlClass = [styles["control"], multiline ? styles["multiline"] : undefined, hasError ? styles["invalid"] : undefined].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
  const shared = {
    id,
    name,
    className: controlClass,
    required,
    disabled,
    ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
    ...(hasError ? { "aria-invalid": true } : {}),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(autoComplete === undefined ? {} : { autoComplete }),
    ...(maxLength === undefined ? {} : { maxLength }),
  };
  return (
    <div className={styles["field"]}>
      <label htmlFor={id} className={styles["label"]}>
        {label}
        {required ? (
          <span className={styles["required"]} aria-hidden="true">
            {requiredMarker}
          </span>
        ) : null}
      </label>
      {multiline ? <textarea {...shared} rows={rows} /> : <input {...shared} type={type} />}
      {hasHelp ? (
        <p id={helpId} className={styles["help"]}>
          {help}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className={styles["error"]} role="alert">
          <Icon name="decision-reject" size={16} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
