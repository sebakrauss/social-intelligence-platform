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
