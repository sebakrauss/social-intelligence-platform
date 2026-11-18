/**
 * The Inbox's read-only presentation pieces (extracted in COMMENTS-INT-03A-FIX, audit M-1): time readings, the closed
 * states and the "what has been read" block. NOTHING here imports the reply composer, its Server Action, the drafts
 * module or any command — so a page that only reads (the redesigned Comments route) can draw them without the
 * composer's action being registered for it. app/…/inbox/views.tsx imports these and re-exports them unchanged; the
 * rendering is byte-for-byte what it was.
 */
import { cache } from "react";
import type { MessageKey } from "@/domain/i18n/message-keys";
import { t } from "@/server/i18n";
import {
  CONTENT_KIND_FALLBACK,
  CONTENT_KIND_MESSAGES,
  COVERAGE_REASON_FALLBACK,
  COVERAGE_REASON_MESSAGES,
  COVERAGE_STATE_MESSAGES,
  displayTime,
  platformName,
  when,
  type AccountCoverageView,
  type ConversationViewState,
  type CoverageKindView,
  type InboxPage,
} from "@/server/inbox/inbox";
import type { IconName } from "@/ui/icons/icon";
import { CoverageAccount, CoverageAccounts, CoverageBlock, CoverageSummaryLabel, NoticeSlot, PaneMessage, type ShownTime } from "@/ui/inbox/inbox";
import { DataTag } from "@/ui/primitives/data-tag";
import { Disclosure } from "@/ui/primitives/disclosure";
import { Notice } from "@/ui/primitives/notice";
import { OriginMark } from "@/ui/primitives/origin-mark";
import { StatePill, type StateTone } from "@/ui/primitives/state-pill";
import { LocalTime, type LocalTimeForm } from "@/ui/time/local-time";

const sameUtcDay = (a: Date, b: Date): boolean => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();

/**
 * Step 7B-15U — ONE render-time reference for "this year" (UTC), shared by everything drawn for the same request: the
 * list, the open conversation and every entry in it compare against the same instant, never each against its own clock
 * reading. (Outside a server render there is nothing to share, and it is simply the current time.)
 */
export const renderNow = cache((): Date => new Date());

/**
 * Step 7B-15S/15U — the short form of the SAME absolute UTC instant displayTime() shows ("08 NOV 2026 · 23:14 UTC"),
 * for reading (Manual §7 mono-s: "08 NOV 23:14"). Derived from displayTime itself, so the two never disagree. The year
 * is left out ONLY for a date in the current UTC calendar year (`now`: the render-time reference) — a date from any
 * other year always shows its year, even when everything on the page is from that year (Step 7B-15T P2: comparing
 * against the latest time on the page hid the year of a wholly historical conversation). The date is left out when
 * `previous` (the time shown just above, in reading order) already said the same UTC day — whose own label carries the
 * year whenever one is due. Never relative, never a local zone; the exact form stays available (TimeStamp / TimedText).
 */
export function shortTime(date: Date, now: Date, previous?: Date): string {
  const [day = "", month = "", year = "", , clock = ""] = displayTime(date).split(" ");
  if (previous !== undefined && sameUtcDay(date, previous)) return clock;
  if (now.getUTCFullYear() === date.getUTCFullYear()) return `${day} ${month} ${clock}`;
  return `${day} ${month} ${year} ${clock}`;
}

export const shown = (date: Date, now: Date, previous?: Date): ShownTime => ({ iso: when(date), label: shortTime(date, now, previous), full: displayTime(date), ...(previous === undefined ? {} : { previous: when(previous) }) });

/** Where a catalog sentence carries its time ("Published {time}"): split around it, so the time can be drawn on its own. */
const TIME_SLOT = "\u0000time\u0000";

/**
 * Comments 2.1 (Step 7B-17R) — a catalog sentence whose `{time}` is read in the reader's own time zone in the browser
 * (ui/time/local-time.tsx); the server's UTC reading is what the page says without JavaScript. `short` follows the
 * thread's short form (with `previous`: the time shown just above); `full` is the exact reading with its zone.
 * `values` fills the sentence's other slots ("{kind} by {author}, {time}").
 */
export function timed(key: MessageKey, date: Date, form: LocalTimeForm, timing?: { readonly now: Date; readonly previous?: Date | undefined }, values: Readonly<Record<string, string>> = {}): React.ReactNode {
  const [before = "", after = ""] = t(key, { ...values, time: TIME_SLOT }).split(TIME_SLOT);
  const fallback = form === "full" ? displayTime(date) : shortTime(date, timing?.now ?? renderNow(), timing?.previous);
  return (
    <>
      {before}
      <LocalTime iso={when(date)} form={form} fallback={fallback} previous={timing?.previous === undefined ? undefined : when(timing.previous)} />
      {after}
    </>
  );
}

export const kindOf = (contentKind: string | null): string => t(contentKind === null ? CONTENT_KIND_FALLBACK : (CONTENT_KIND_MESSAGES[contentKind] ?? CONTENT_KIND_FALLBACK));

/** Manual §7 tones for what has been read: success when complete, amber when partial, red when the last read failed. */
export const COVERAGE_TONES: { readonly [S in CoverageKindView["state"]]: { readonly tone: StateTone; readonly icon?: IconName } } = {
  complete: { tone: "success", icon: "decision-approve" },
  importing: { tone: "neutral", icon: "estado-sync" },
  partial: { tone: "warning" },
  failed: { tone: "danger", icon: "estado-alert" },
  unavailable: { tone: "neutral", icon: "estado-lock" },
  not_requested: { tone: "neutral", icon: "estado-lock" },
  unknown: { tone: "neutral" },
};

const CLOSED_MESSAGES: { readonly [K in Exclude<ConversationViewState["kind"], "ready" | "signed_out">]: MessageKey } = {
  verification_required: "auth.status.verification_required",
  workspace_not_found: "inbox.workspace_not_found",
  conversation_not_found: "inbox.conversation.not_found",
  not_allowed: "inbox.not_allowed",
  unavailable: "inbox.unavailable",
};

/** A closed state: a red notice when the Inbox could not be read, neutral text otherwise (not an error). */
export function ClosedState({ kind }: { readonly kind: keyof typeof CLOSED_MESSAGES }) {
  if (kind === "unavailable") {
    return (
      <NoticeSlot>
        <Notice tone="danger" live="assertive">
          {t(CLOSED_MESSAGES[kind])}
        </Notice>
      </NoticeSlot>
    );
  }
  if (kind === "verification_required") {
    return (
      <NoticeSlot>
        <Notice tone="info">{t(CLOSED_MESSAGES[kind])}</Notice>
      </NoticeSlot>
    );
  }
  return <PaneMessage>{t(CLOSED_MESSAGES[kind])}</PaneMessage>;
}
/** What has been read, per account and kind, as a disclosure (open when the list is empty). */
export function CoverageSummary({ page, open }: { readonly page: InboxPage; readonly open: boolean }) {
  const incomplete = page.coverage.some((account) => account.comments.state === "failed" || account.comments.state === "partial" || account.comments.state === "unknown");
  return (
    <CoverageBlock>
      <Disclosure
        open={open}
        summary={<CoverageSummaryLabel title={t("inbox.coverage.heading")} meta={page.asOf === null ? t("inbox.coverage.never") : timed("inbox.coverage.as_of", page.asOf, "full")} {...(incomplete ? { incomplete: t("inbox.coverage.incomplete") } : {})} />}
      >
        {page.coverageOmitted ? (
          <NoticeSlot>
            <Notice tone="info">{t("inbox.coverage.omitted")}</Notice>
          </NoticeSlot>
        ) : null}
        {page.coverage.length === 0 ? <p>{t("inbox.coverage.never")}</p> : <CoverageAccounts>{page.coverage.map((account) => <Account key={account.connectedAccountId} account={account} />)}</CoverageAccounts>}
      </Disclosure>
    </CoverageBlock>
  );
}

function Account({ account }: { readonly account: AccountCoverageView }) {
  const platform = platformName(account.platform);
  const name = platform === undefined ? t("inbox.coverage.account.unknown_platform") : t("inbox.coverage.account", { platform });
  return (
    <CoverageAccount
      head={
        <>
          <OriginMark platform={account.platform} name={name} showName />
          {account.active ? null : <DataTag>{t("inbox.coverage.inactive")}</DataTag>}
          {account.asOf === null ? null : <span className="wk-sr-only">{timed("inbox.coverage.as_of", account.asOf, "full")}</span>}
        </>
      }
      kinds={[kindView("comments", "inbox.coverage.comments", account.comments), kindView("replies", "inbox.coverage.replies", account.replies)]}
    />
  );
}

function kindView(key: string, messageKey: "inbox.coverage.comments" | "inbox.coverage.replies", view: CoverageKindView) {
  const { tone, icon } = COVERAGE_TONES[view.state];
  const captions: string[] = [];
  if (view.state !== "complete" && view.state !== "unknown" && view.reason !== null) captions.push(t(COVERAGE_REASON_MESSAGES[view.reason] ?? COVERAGE_REASON_FALLBACK));
  if (view.scope === "content") captions.push(t("inbox.coverage.content_scope"));
  return {
    key,
    pill: (
      <StatePill tone={tone} {...(icon === undefined ? {} : { icon })}>
        {t(messageKey, { state: t(COVERAGE_STATE_MESSAGES[view.state]) })}
      </StatePill>
    ),
    captions,
    ...(view.coveredUntil === null ? {} : { until: timed("inbox.coverage.until", view.coveredUntil, "full") }),
  };
}
