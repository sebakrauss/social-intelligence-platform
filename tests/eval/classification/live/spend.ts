/**
 * Step H7-D0 — the evaluation-only price descriptor (fixtures/intelligence/evaluation/model-prices.eval-*.json) and the
 * spend ledger that enforces the gate's hard cap (US$15). Conservative by construction:
 *
 *   input tokens (upper bound)   ⌈chars / 2⌉ of system + data (+ 400 chars for the re-ask addendum)
 *   one gateway run (max)        2 attempts × (input bound × input price + output cap × output price)
 *   before every run             spent so far + that run's maximum ≤ cap, else the budget port DENIES (AI_BUDGET, no call)
 *   after every case             actual cost from provider-reported usage (an attempt without usage is charged its max)
 *
 * NOT billing logic and never imported by product runtime; production pricing stays TA-Q-23 (OPEN).
 */
import type { AttemptRecord, BudgetPort } from "@/ai/gateway";

export interface ModelPrice {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  /** OpenAI reports cached tokens inside input_tokens; Anthropic reports cache reads separately. */
  readonly cachedIncludedInInput: boolean;
}

export interface PriceDescriptor {
  readonly pricingVersion: string;
  readonly status: string;
  readonly models: Readonly<Record<string, ModelPrice>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const price = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function parsePriceDescriptor(value: unknown): PriceDescriptor {
  if (!isRecord(value) || typeof value["pricingVersion"] !== "string" || value["status"] !== "VERIFIED_FROM_OFFICIAL_LIST_PRICES" || value["unit"] !== "per_1m_tokens" || value["currency"] !== "USD" || !isRecord(value["models"])) {
    throw new TypeError("price_descriptor_invalid");
  }
  const models: Record<string, ModelPrice> = {};
  for (const [key, entry] of Object.entries(value["models"])) {
    if (!isRecord(entry) || !price(entry["input"]) || !price(entry["cachedInput"]) || !price(entry["output"]) || typeof entry["cachedIncludedInInput"] !== "boolean") throw new TypeError(`price_descriptor_invalid:${key}`);
    models[key] = { input: entry["input"], cachedInput: entry["cachedInput"], output: entry["output"], cachedIncludedInInput: entry["cachedIncludedInInput"] };
  }
  return Object.freeze({ pricingVersion: value["pricingVersion"], status: value["status"], models: Object.freeze(models) });
}

const PER_TOKEN = 1 / 1_000_000;
export const REASK_ADDENDUM_CHARS = 400;
export const inputTokenUpperBound = (chars: number): number => Math.ceil(chars / 2);

/** The most one gateway run (initial + one re-ask) can cost. */
export function runMaxUsd(model: ModelPrice, inputChars: number, maxOutputTokens: number): number {
  const attempt = (chars: number): number => inputTokenUpperBound(chars) * model.input * PER_TOKEN + maxOutputTokens * model.output * PER_TOKEN;
  return attempt(inputChars) + attempt(inputChars + REASK_ADDENDUM_CHARS);
}

/** The actual cost of one attempt from reported usage (null usage ⇒ its conservative maximum). */
export function attemptUsd(model: ModelPrice, attempt: AttemptRecord, maxOutputTokens: number): number {
  const usage = attempt.usage;
  if (usage === null) return attempt.outcome === "accepted" || attempt.outcome === "invalid_output" || attempt.outcome === "refused" ? inputTokenUpperBound(attempt.inputChars) * model.input * PER_TOKEN + maxOutputTokens * model.output * PER_TOKEN : 0;
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = model.cachedIncludedInInput ? Math.max(0, usage.inputTokens - cached) : usage.inputTokens;
  return uncachedInput * model.input * PER_TOKEN + cached * model.cachedInput * PER_TOKEN + usage.outputTokens * model.output * PER_TOKEN;
}

export interface SpendLedger {
  readonly capUsd: number;
  spentUsd(): number;
  /** The budget port of one candidate (denies a run whose maximum would cross the cap). */
  budgetFor(model: ModelPrice, maxOutputTokens: number): BudgetPort;
  record(model: ModelPrice, attempts: readonly AttemptRecord[], maxOutputTokens: number): void;
  denied(): number;
}

export function createSpendLedger(capUsd: number): SpendLedger {
  let spent = 0;
  let denied = 0;
  return {
    capUsd,
    spentUsd: () => spent,
    denied: () => denied,
    budgetFor: (model, maxOutputTokens) => ({
      reserve: ({ inputChars }) => {
        if (spent + runMaxUsd(model, inputChars, maxOutputTokens) > capUsd) {
          denied += 1;
          return Promise.resolve("denied" as const);
        }
        return Promise.resolve("allowed" as const);
      },
    }),
    record: (model, attempts, maxOutputTokens) => {
      for (const attempt of attempts) spent += attemptUsd(model, attempt, maxOutputTokens);
    },
  };
}
