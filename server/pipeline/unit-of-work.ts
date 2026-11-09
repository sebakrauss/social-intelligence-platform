/**
 * Unit-of-work port for the action pipeline (TA §10.6 steps 6–8; §13.1).
 * One unit covers tenant resolution, execution, the audit record and any outbox rows: it commits only if
 * the work resolves and rolls back if it rejects. The production implementation is the tenant-scoped
 * PostgreSQL transaction (server/persistence): web login role, fixed-literal role switch, transaction-local
 * claims and, for workspace commands, the sealed workspace binding. Tests also use in-memory adapters.
 */
import type { UserId, WorkspaceId } from "@/domain/ids";
import type { AuditLog } from "@/modules/audit";
import type { CapabilityReadStore } from "@/modules/capability";
import type { SignalReadStore } from "@/modules/classification";
import type { ConnectionStore } from "@/modules/connections";
import type { ContentItemReadStore } from "@/modules/content";
import type { ConversationReadStore } from "@/modules/conversations";
import type { CoverageReadStore } from "@/modules/coverage";
import type { ReconciliationRequestPort } from "@/modules/ingestion";
import type { InteractionReadStore } from "@/modules/interactions";
import type { TenancyStore } from "@/modules/tenancy";
import type { MutationRequestSources } from "@/mutations/request";
import type { OutboxWriter } from "@/platform/outbox";

/** A managed account as the Inbox names it (identifier, platform, lifecycle status only). */
export interface InboxAccountRow {
  readonly id: string;
  readonly platform: string;
  readonly status: string;
}

/**
 * Step 7A: the Inbox's READ-ONLY sources — each owner module's read port over its own tables, plus the managed accounts
 * of the bound workspace. RLS (member_read of 0007, 0017, 0024) admits the bound workspace's non-guest members only;
 * nothing here writes.
 */
export interface InboxReadSources {
  readonly conversations: ConversationReadStore;
  readonly interactions: InteractionReadStore;
  readonly content: ContentItemReadStore;
  readonly coverage: CoverageReadStore;
  readonly signals: SignalReadStore;
  readonly accounts: () => Promise<readonly InboxAccountRow[]>;
}

export interface Transaction {
  readonly tenancy: TenancyStore;
  readonly audit: AuditLog;
  readonly outbox: OutboxWriter;
  readonly connections: ConnectionStore;
  /** Read only: capability profiles are written by the job runtime (no web write grant exists). */
  readonly capability: CapabilityReadStore;
  /**
   * Step H6-C4: the 0019 reconciliation request boundary ONLY (requestRun). The web holds no other reconciliation
   * primitive; the boundary writes the run, its audit event and its planner row itself.
   */
  readonly reconciliation: ReconciliationRequestPort;
  /** Step 7A: the Inbox read side (no write path). */
  readonly inbox: InboxReadSources;
  /**
   * Step 7B-1: the executor's REQUEST side only (TA §26.3 left column): the member's PENDING intent, its reply text
   * and the request-time guards. The web holds no execution path, no transition and no provider mutation port.
   */
  readonly mutations: MutationRequestSources;
}

/**
 * Who the transaction runs for. The user comes from the server-validated session; the workspace (for
 * workspace commands) is the routed one, bound before any query and verified by live membership inside.
 */
export interface TransactionScope {
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
}

export interface UnitOfWork {
  run<T>(scope: TransactionScope, work: (tx: Transaction) => Promise<T>): Promise<T>;
}
