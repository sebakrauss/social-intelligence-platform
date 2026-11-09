/**
 * Coverage persistence port (Step H6-B): append-only coverage records. Implemented by ./persistence; composed by
 * server/persistence/ingestion.ts.
 */
import type { SliceCoverage } from "../domain/coverage";

export interface CoverageRecordRow {
  readonly interactionKind: string;
  readonly state: string;
  readonly reason: string;
  readonly limitationCode: string | null;
  readonly sliceOutcome: string;
  readonly intervalStart: Date;
  readonly intervalEnd: Date;
}

export interface CoverageStore {
  /** Persists one slice's intervals; returns how many were new (identical ones are skipped). */
  recordSlice(input: { readonly organizationId: string; readonly workspaceId: string; readonly contentItemId: string | null; readonly coverage: SliceCoverage; readonly correlationId: string; readonly newId: () => string }): Promise<number>;
  forAccount(connectedAccountId: string): Promise<readonly CoverageRecordRow[]>;
}

/** One coverage record with its scope and as-of time (Step 7A Inbox read side). */
export interface CoverageScopedRow extends CoverageRecordRow {
  readonly connectedAccountId: string;
  readonly contentItemId: string | null;
  readonly asOf: Date;
}

/** Read-only Inbox access (Step 7A); runs in the caller's user-scoped transaction (0017 member_read decides). */
export interface CoverageReadStore {
  /**
   * For EACH of the given connected accounts (and no other: the caller decides which accounts are summarized, so no
   * account outside the set consumes the read), the newest read_interactions record (by as-of) per (interaction kind,
   * scope level) — scope level being account-wide (no content item) or one content item. At most four rows per
   * account, whatever the volume of any one account; ordered by account id, then kind. At most 500 accounts per call.
   */
  latestPerAccountAndKind(connectedAccountIds: readonly string[]): Promise<readonly CoverageScopedRow[]>;
}
