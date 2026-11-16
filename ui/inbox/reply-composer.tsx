"use client";
/**
 * The contextual reply composer (Step 7B-3): opens INSIDE the thread, under the comment it answers, and walks one
 * person through write → review → publish without leaving the conversation. Only the review stage posts, and it
 * posts exactly the text shown in the review (the same state string is the hidden field). The browser supplies the
 * text and the server-issued form key; the workspace, conversation and target ids are the page's, and the account is
 * resolved on the server. Nothing here is optimistic: after a request the composer says the reply is on its way and
 * the thread, re-rendered from the database, shows its real state.
 *
 * Every label arrives translated from the server page (client components hold no catalog).
 */
import { useActionState, useId, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ReplyAction, ReplyActionState } from "@/server/inbox/reply-state";
import { Button } from "@/ui/primitives/button";
import { Notice, type NoticeTone } from "@/ui/primitives/notice";
import { forgetReplyDraft, keepReplyDraft, replyDraftKey, restoreReplyDraft, settleReplyDraft } from "./reply-drafts";
import styles from "./reply-composer.module.css";

export type ComposerStage = "closed" | "write" | "review" | "done";

export interface ReplyComposerLabels {
  readonly open: string;
  readonly heading: string;
  readonly to: string;
  readonly as: string;
  readonly note?: string;
  /**
   * Step 7B-14I2: present ONLY for an exceptional, operator-authorized validation reply (never general availability).
   * Comments 2.1 (Step 7B-17T): drawn by the server with its expiry as a local-time element (ui/time/local-time.tsx), so
   * it reads in the browser's zone like every other time; UTC without JavaScript.
   */
  readonly validationNotice?: ReactNode;
  readonly fieldLabel: string;
  readonly fieldHelp: string;
  /** Templates with a literal `{count}` placeholder: only plain strings cross the server → client boundary. */
  readonly remaining: string;
  readonly overLimit: string;
  readonly empty: string;
  readonly cancel: string;
  readonly review: string;
  readonly edit: string;
  readonly reviewHeading: string;
  readonly reviewTextLabel: string;
  readonly reviewNote: string;
  readonly publish: string;
  readonly publishing: string;
  /** Step 7B-15F: shown in the write stage while the text is a draft kept from earlier in this tab. */
  readonly restored?: string;
}

/** Outcome copy by closed state, resolved on the server: `requested`, `existing`, `unavailable`, `signed_out`, `refused.<reason>`, `blocked.<code>`. */
export type ReplyOutcomeMessages = Readonly<Record<string, string>>;

export interface ReplyComposerProps {
  readonly action: ReplyAction;
  readonly fields: { readonly workspaceId: string; readonly conversationId: string; readonly targetInteractionId: string; readonly idempotencyKey: string; readonly validation?: true };
  readonly maxChars: number;
  readonly labels: ReplyComposerLabels;
  /** Outcome copy by closed state (see ReplyOutcomeMessages); the development harness overrides it to say "demo". */
  readonly outcomes: ReplyOutcomeMessages;
  /**
   * The stage the composer starts at (default "closed": behind its Reply button).
   *
   * Production callers may pass ONLY "write" (Step 7B-15B: the Inbox opens the ONE composer under the comment the
   * address names, `?reply=`, ready to type). That skips nothing: the write stage has no form — only the review stage
   * posts, after the person pressed Review and then the explicit Publish confirmation — so navigation alone can never
   * publish or bypass the review. "review", "done" and `initialText` are for tests and the development reference only
   * (to draw a stage without interaction); no production caller is authorized to pass them
   * (tests/architecture/inbox-composer-guards.test.ts).
   */
  readonly initialStage?: ComposerStage;
  readonly initialText?: string;
  /**
   * Step 7B-15F: the opaque per-person scope of this tab's in-memory drafts (reply-drafts.ts), from the server's
   * verified identity. Without it, no draft is kept or restored.
   */
  readonly draftScope?: string;
}

const IDLE: ReplyActionState = { kind: "idle" };
const counted = (template: string, count: number): string => template.replaceAll("{count}", String(count));

function outcomeKey(state: ReplyActionState): string | undefined {
  switch (state.kind) {
    case "idle":
      return undefined;
    case "refused":
      return `refused.${state.reason}`;
    case "blocked":
      return `blocked.${state.code}`;
    case "requested":
    case "existing":
    case "unavailable":
    case "signed_out":
      return state.kind;
  }
}

/** A request is not a delivery: neutral until the thread shows the platform's confirmation (green is for Sent only). */
const OUTCOME_TONE: { readonly [K in Exclude<ReplyActionState["kind"], "idle">]: NoticeTone } = { requested: "info", existing: "info", refused: "warning", blocked: "warning", unavailable: "danger", signed_out: "warning" };

/**
 * Step 7B-15H: Edit is unavailable while the publication is in flight — the reviewed text cannot be reopened (and then
 * kept as a draft) while the request that carries it may still be accepted.
 */
function EditButton({ label, onEdit }: { readonly label: string; readonly onEdit: () => void }) {
  const { pending } = useFormStatus();
  return (
    <Button variant="ghost" size="sm" disabled={pending} onClick={onEdit}>
      {label}
    </Button>
  );
}

function PublishButton({ label, pendingLabel }: { readonly label: string; readonly pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" pending={pending} pendingLabel={pendingLabel}>
      {label}
    </Button>
  );
}

export function ReplyComposer({ action, fields, maxChars, labels, outcomes, initialStage = "closed", initialText = "", draftScope }: ReplyComposerProps) {
  // Step 7B-15F: this composer's unsent text kept in this tab's memory, if any. It seeds the WRITE stage only (whatever
  // the start stage); never the review stage, a mode or a target — those are the server's render.
  const draftKey = draftScope === undefined ? undefined : replyDraftKey(draftScope, fields);
  const [restored] = useState(() => restoreReplyDraft(draftKey));
  const [stage, setStage] = useState<ComposerStage>(restored !== undefined ? "write" : initialStage);
  const [text, setText] = useState(restored ?? initialText);
  const [state, formAction] = useActionState<ReplyActionState, FormData>(settleReplyDraft(action, draftKey), IDLE);
  const id = useId();
  const length = text.length;
  const remaining = maxChars - length;
  const empty = text.trim().length === 0;
  const settled = state.kind === "requested" || state.kind === "existing";
  const shownStage: ComposerStage = settled ? "done" : stage;
  const key = outcomeKey(state);
  const outcome = key === undefined ? undefined : (outcomes[key] ?? outcomes["unavailable"]);

  if (shownStage === "closed") {
    return (
      <div className={styles["slot"]}>
        <Button
          variant="ghost"
          size="sm"
          icon="conv-reply"
          onClick={() => {
            setStage("write");
          }}
        >
          {labels.open}
        </Button>
      </div>
    );
  }

  return (
    <section className={styles["composer"]} aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className={styles["heading"]}>
        {labels.heading}
      </h3>
      <p className={styles["destination"]}>
        <span>{labels.to}</span>
        <span className={styles["as"]}>{labels.as}</span>
      </p>
      {labels.note === undefined ? null : <p className={styles["note"]}>{labels.note}</p>}
      {labels.validationNotice === undefined ? null : (
        <Notice tone="warning" live="off">
          {labels.validationNotice}
        </Notice>
      )}

      {shownStage === "write" ? (
        <div className={styles["stage"]}>
          <label htmlFor={`${id}-text`} className={styles["label"]}>
            {labels.fieldLabel}
          </label>
          <textarea
            id={`${id}-text`}
            className={styles["textarea"]}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              keepReplyDraft(draftKey, event.target.value);
            }}
            rows={4}
            maxLength={maxChars * 2}
            aria-describedby={`${id}-help ${id}-count`}
            aria-invalid={remaining < 0}
            autoFocus
          />
          <p id={`${id}-help`} className={styles["help"]}>
            {labels.fieldHelp}
          </p>
          {restored !== undefined && text === restored && labels.restored !== undefined ? <p className={styles["help"]}>{labels.restored}</p> : null}
          <p id={`${id}-count`} className={remaining < 0 ? styles["countOver"] : styles["count"]} aria-live="polite">
            {remaining < 0 ? counted(labels.overLimit, -remaining) : counted(labels.remaining, remaining)}
          </p>
          <div className={styles["actions"]}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStage("closed");
                forgetReplyDraft(draftKey);
              }}
            >
              {labels.cancel}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={empty || remaining < 0}
              onClick={() => {
                setStage("review");
              }}
            >
              {labels.review}
            </Button>
          </div>
        </div>
      ) : null}

      {shownStage === "review" ? (
        <form action={formAction} className={styles["stage"]}>
          <p className={styles["reviewHeading"]}>{labels.reviewHeading}</p>
          <p className={styles["label"]}>{labels.reviewTextLabel}</p>
          <blockquote className={styles["preview"]}>{text}</blockquote>
          <p className={styles["note"]}>{labels.reviewNote}</p>
          <input type="hidden" name="workspaceId" value={fields.workspaceId} />
          <input type="hidden" name="conversationId" value={fields.conversationId} />
          <input type="hidden" name="targetInteractionId" value={fields.targetInteractionId} />
          <input type="hidden" name="idempotencyKey" value={fields.idempotencyKey} />
          {fields.validation === true ? <input type="hidden" name="validation" value="1" /> : null}
          <input type="hidden" name="text" value={text} />
          {outcome === undefined ? null : (
            <Notice tone={OUTCOME_TONE[state.kind as Exclude<ReplyActionState["kind"], "idle">]} live="polite">
              {outcome}
            </Notice>
          )}
          <div className={styles["actions"]}>
            <EditButton
              label={labels.edit}
              onEdit={() => {
                setStage("write");
              }}
            />
            <PublishButton label={labels.publish} pendingLabel={labels.publishing} />
          </div>
        </form>
      ) : null}

      {shownStage === "done" && outcome !== undefined ? (
        <div className={styles["stage"]}>
          <Notice tone={OUTCOME_TONE[state.kind as Exclude<ReplyActionState["kind"], "idle">]} live="polite">
            {outcome}
          </Notice>
        </div>
      ) : null}
    </section>
  );
}
