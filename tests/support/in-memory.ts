/**
 * Deterministic in-memory adapters for TESTS ONLY. Production persistence is the tenant-scoped
 * PostgreSQL unit of work of Step 2; nothing here is wired into the application.
 *
 * The unit of work copies state, runs the work against the copy, and commits only if the work
 * resolves — so tests observe real rollback semantics.
 */
import { asVerifiedEmail } from "@/domain/email";
import type { UserId } from "@/domain/ids";
import { parseUserId } from "@/domain/ids";
import type { AuditEvent, AuditLog } from "@/modules/audit";
import type { OutboxMessage, OutboxWriter } from "@/platform/outbox";
import type {
  Invitation,
  InvitationDelivery,
  Organization,
  OrganizationMembership,
  TenancyStore,
  Workspace,
  WorkspaceMembership,
} from "@/modules/tenancy";
import type { AuthUser, IdentityPort } from "@/platform/auth/port";
import type { Transaction, TransactionScope, UnitOfWork } from "@/server/pipeline";

export interface InMemoryState {
  organizations: Map<string, Organization>;
  workspaces: Map<string, Workspace>;
  organizationMemberships: Map<string, OrganizationMembership>;
  workspaceMemberships: Map<string, WorkspaceMembership>;
  invitations: Map<string, Invitation>;
  audit: AuditEvent[];
  outbox: OutboxMessage[];
}

export function emptyState(): InMemoryState {
  return {
    organizations: new Map(),
    workspaces: new Map(),
    organizationMemberships: new Map(),
    workspaceMemberships: new Map(),
    invitations: new Map(),
    audit: [],
    outbox: [],
  };
}

const key = (a: string, b: string): string => `${a}:${b}`;
const done = <T>(value: T): Promise<T> => Promise.resolve(value);

function storeFor(state: InMemoryState): TenancyStore {
  return {
    organizations: {
      get: (id) => done(state.organizations.get(id)),
      insert: (organization) => done(void state.organizations.set(organization.id, organization)),
    },
    workspaces: {
      get: (id) => done(state.workspaces.get(id)),
      insert: (workspace) => done(void state.workspaces.set(workspace.id, workspace)),
      update: (workspace) => done(void state.workspaces.set(workspace.id, workspace)),
    },
    organizationMemberships: {
      find: (organizationId, userId) => done(state.organizationMemberships.get(key(organizationId, userId))),
      insert: (membership) => {
        const id = key(membership.organizationId, membership.userId);
        if (state.organizationMemberships.has(id)) return Promise.reject(new Error("unique violation: organization membership"));
        return done(void state.organizationMemberships.set(id, membership));
      },
      update: (membership) => done(void state.organizationMemberships.set(key(membership.organizationId, membership.userId), membership)),
      remove: (organizationId, userId) => done(void state.organizationMemberships.delete(key(organizationId, userId))),
      countWithRole: (organizationId, role) =>
        done([...state.organizationMemberships.values()].filter((m) => m.organizationId === organizationId && m.role === role).length),
    },
    workspaceMemberships: {
      find: (workspaceId, userId) => done(state.workspaceMemberships.get(key(workspaceId, userId))),
      insert: (membership) => {
        const id = key(membership.workspaceId, membership.userId);
        if (state.workspaceMemberships.has(id)) return Promise.reject(new Error("unique violation: workspace membership"));
        return done(void state.workspaceMemberships.set(id, membership));
      },
      update: (membership) => done(void state.workspaceMemberships.set(key(membership.workspaceId, membership.userId), membership)),
      remove: (workspaceId, userId) => done(void state.workspaceMemberships.delete(key(workspaceId, userId))),
      countWithRole: (workspaceId, role) =>
        done([...state.workspaceMemberships.values()].filter((m) => m.workspaceId === workspaceId && m.role === role).length),
      listForUser: (organizationId, userId) =>
        done([...state.workspaceMemberships.values()].filter((m) => m.organizationId === organizationId && m.userId === userId)),
    },
    invitations: {
      get: (id) => done(state.invitations.get(id)),
      findByTokenDigest: (digest) => done([...state.invitations.values()].find((invitation) => invitation.tokenDigest === digest)),
      insert: (invitation) => done(void state.invitations.set(invitation.id, invitation)),
      update: (invitation) => done(void state.invitations.set(invitation.id, invitation)),
    },
  };
}

/** Simulated failures for rollback tests: the Nth call (1-based, per unit of work) rejects. */
export interface InMemoryFaults {
  readonly failAuditAppendAt?: number;
  readonly failWorkspaceMembershipRemovalAt?: number;
}

const simulatedFailure = (operation: string): Promise<never> => Promise.reject(new Error(`simulated failure: ${operation}`));

export class InMemoryUnitOfWork implements UnitOfWork {
  state: InMemoryState;
  commits = 0;
  rollbacks = 0;
  faults: InMemoryFaults = {};

  constructor(state: InMemoryState = emptyState()) {
    this.state = state;
  }

  /** The scope of the most recent unit of work (tests assert what the pipeline asked to bind). */
  lastScope: TransactionScope | undefined;

  async run<T>(scope: TransactionScope, work: (tx: Transaction) => Promise<T>): Promise<T> {
    this.lastScope = scope;
    const draft = structuredClone(this.state);
    const faults = this.faults;
    let appends = 0;
    let workspaceRemovals = 0;
    const audit: AuditLog = {
      append: (event) => (++appends === faults.failAuditAppendAt ? simulatedFailure("audit append") : done(void draft.audit.push(event))),
    };
    const store = storeFor(draft);
    const tenancy: TenancyStore = {
      ...store,
      workspaceMemberships: {
        ...store.workspaceMemberships,
        remove: (workspaceId, userId) =>
          ++workspaceRemovals === faults.failWorkspaceMembershipRemovalAt
            ? simulatedFailure("workspace membership removal")
            : store.workspaceMemberships.remove(workspaceId, userId),
      },
    };
    try {
      const outbox: OutboxWriter = { append: (message) => done(void draft.outbox.push(message)) };
      const result = await work({ tenancy, audit, outbox });
      this.state = draft;
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }

  /** Direct store access for seeding and assertions (outside any unit of work). */
  get store(): TenancyStore {
    return storeFor(this.state);
  }
}

export class FakeIdentity implements IdentityPort {
  user: AuthUser | undefined;
  calls = 0;

  constructor(user?: AuthUser) {
    this.user = user;
  }

  getVerifiedUser(): Promise<AuthUser | undefined> {
    this.calls += 1;
    return done(this.user);
  }
}

/** Deterministic UUIDv4-shaped identifiers: 00000000-0000-4000-8000-000000000001, … */
export function sequentialIds(start = 1): () => string {
  let next = start;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

export function userId(n: number): UserId {
  const id = parseUserId(`10000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  if (id === undefined) throw new Error("bad test user id");
  return id;
}

/** Deterministic, distinct verified email per test user. */
export function emailOf(id: UserId): string {
  return `user-${id.slice(-4)}@example.test`;
}

export function verifiedUser(id: UserId, email: string = emailOf(id)): AuthUser {
  const verifiedEmail = asVerifiedEmail(email);
  return verifiedEmail === undefined ? { id, emailVerified: true } : { id, emailVerified: true, verifiedEmail };
}

export class CapturingDelivery implements InvitationDelivery {
  readonly delivered: { readonly invitationId: string; readonly recipientEmail: string; readonly rawToken: string }[] = [];

  deliver(message: { readonly invitationId: string; readonly recipientEmail: string; readonly rawToken: string }): Promise<void> {
    this.delivered.push(message);
    return done(undefined);
  }
}

export class FixedClock {
  now: Date;

  constructor(iso = "2026-10-05T12:00:00.000Z") {
    this.now = new Date(iso);
  }

  readonly read = (): Date => new Date(this.now.getTime());

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }
}
