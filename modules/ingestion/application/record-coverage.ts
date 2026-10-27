/**
 * Ingestion coverage recording (Step H6-B; TL decision 4). The coverage one slice establishes (coverage module's pure
 * `coverageForSlice`) is persisted in the caller's transaction as append-only records; an identical record is written
 * once. Coverage is never a count: a scope with no record stays UNKNOWN, and a count over it is NOT_AVAILABLE.
 */
import type { CorrelationId } from "@/domain/correlation";
import type { Instant } from "@/domain/instant";
import { coverageForSlice, type AvailabilityInput, type SliceCoverage, type SliceReadResult } from "@/modules/coverage";
import type { IngestionClock, IngestionStores } from "./ports";

export interface RecordCoverageInput {
  readonly workspaceId: string;
  readonly connectedAccountId: string;
  /** The canonical content row the slice read (null for an account-level slice). */
  readonly contentItemId: string | null;
  readonly from: Instant;
  readonly to: Instant;
  readonly asOf: Instant;
  readonly availability: AvailabilityInput;
  readonly result: SliceReadResult;
  readonly correlationId: CorrelationId;
}

export async function recordIngestionCoverage(stores: IngestionStores, clock: IngestionClock, input: RecordCoverageInput): Promise<{ readonly coverage: SliceCoverage; readonly written: number }> {
  const coverage = coverageForSlice({
    scope: { connectedAccountId: input.connectedAccountId, capability: "read_interactions", contentId: input.contentItemId },
    from: input.from,
    to: input.to,
    asOf: input.asOf,
    availability: input.availability,
    result: input.result,
  });
  const written = await stores.coverage.recordSlice({ organizationId: await stores.organizationId(), workspaceId: input.workspaceId, contentItemId: input.contentItemId, coverage, correlationId: input.correlationId, newId: clock.newId });
  return { coverage, written };
}
