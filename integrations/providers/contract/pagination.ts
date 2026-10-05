/**
 * Pagination and rate-budget primitives (TA §15.1, §45).
 *
 * Pages end explicitly: `next.kind === "end"` is the only terminal signal. An empty page is not an end unless
 * it says so, and an end is never inferred from a short page. Cursors are opaque and provider-defined; a
 * cursor is valid only for the operation and scope that produced it. Ordering is provider-defined but stable
 * for a given cursor; consumers deduplicate by provider identity (TA §18.2).
 */
import type { IsoInstant } from "./identity";

declare const cursorBrand: unique symbol;
export type PageCursor = string & { readonly [cursorBrand]: true };

const CURSOR = /^[A-Za-z0-9_.:=-]{1,512}$/;

export function parsePageCursor(value: unknown): PageCursor | undefined {
  return typeof value === "string" && CURSOR.test(value) ? (value as PageCursor) : undefined;
}

export type PageNext = { readonly kind: "more"; readonly cursor: PageCursor } | { readonly kind: "end" };

export interface Page<T> {
  readonly items: readonly T[];
  readonly next: PageNext;
}

/** A half-open time window [from, to) in provider time. */
export interface TimeWindow {
  readonly from: IsoInstant;
  readonly to: IsoInstant;
}

/**
 * Normalized rate-budget signal, translated from provider usage information where the provider gives any
 * (TA §15.2, §45). Parity across providers is not assumed: when a provider reports nothing usable the signal
 * is `not_reported`, never an invented budget. Consumed later by scheduling (Step 6); nothing here throttles.
 */
export type RateBudgetSignal =
  | { readonly kind: "not_reported" }
  | {
      readonly kind: "reported";
      /** Which budget the provider reported on. */
      readonly scope: "app" | "account" | "endpoint" | "unknown";
      /** Share of the budget used, 0..1, where reported. */
      readonly usedRatio: number | null;
      /** Calls remaining in the current window, where reported. */
      readonly remainingCalls: number | null;
      /** When the window resets, where reported. */
      readonly resetAt: IsoInstant | null;
    };

export const BUDGET_NOT_REPORTED: RateBudgetSignal = Object.freeze({ kind: "not_reported" });

/** Every provider call returns its data together with the rate-budget signal observed on that call. */
export interface ProviderResult<T> {
  readonly data: T;
  readonly budget: RateBudgetSignal;
}
