/**
 * Command definitions for the action pipeline (TA §10.6). A command declares its scope, required
 * permission and whether it needs a Standard-mode workspace; the pipeline enforces all of it before
 * `execute` runs. Handlers only ever receive the context the pipeline resolved.
 */
import type { PermissionKey } from "@/domain/access";
import type { CorrelationId, RequestId } from "@/domain/correlation";
import type { OrganizationId, WorkspaceId } from "@/domain/ids";
import type { AuditAction, AuditChange, AuditTargetType } from "@/modules/audit";
import type { OrganizationContext, UserContext, WorkspaceContext } from "./context";
import type { Transaction } from "./unit-of-work";

/** Per-execution services. Clock and ID generation are injected so tests are deterministic. */
export interface CommandEnvironment {
  readonly now: Date;
  readonly newId: () => string;
  readonly correlationId: CorrelationId;
  readonly requestId: RequestId;
}

/** What a command contributes to its audit event. Everything else is filled in by the pipeline. */
export interface AuditDraft {
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  /**
   * The resolved scope always wins. User-scoped commands name both; organization-scoped commands may name
   * a workspace inside the resolved organization (e.g. a cascaded workspace membership removal).
   */
  readonly organizationId?: OrganizationId;
  readonly workspaceId?: WorkspaceId;
  /** Minimal previous/current state (TA §41); required for state changes, validated by the audit module. */
  readonly change?: AuditChange;
}

interface CommandBase<I, O, R> {
  /** Stable identifier, e.g. "tenancy.workspace.change_mode". Used in logs, never shown to users. */
  readonly name: string;
  /** Server-side validation of untrusted input; must reject unknown fields (INVALID_INPUT). */
  readonly validate: (input: unknown) => I;
  /**
   * The audit record(s) for the consequential changes, or undefined when nothing changed. A command that
   * makes several consequential changes (e.g. a cascade) returns one draft per change, never a blob;
   * all of them are appended in the same unit of work as the changes.
   */
  readonly audit: (output: O) => AuditDraft | readonly AuditDraft[] | undefined;
  /** Maps the internal output to the caller-facing result (e.g. drops single-use secrets). */
  readonly respond: (output: O) => R;
  /** Side effects that must only happen after commit (e.g. invitation delivery). */
  readonly afterCommit?: (output: O) => Promise<void>;
}

export interface UserCommand<I, O, R> extends CommandBase<I, O, R> {
  readonly scope: "user";
  readonly execute: (context: UserContext, input: I, tx: Transaction, env: CommandEnvironment) => Promise<O>;
}

export interface OrganizationCommand<I, O, R> extends CommandBase<I, O, R> {
  readonly scope: "organization";
  readonly permission: OrganizationScopedPermission;
  readonly execute: (context: OrganizationContext, input: I, tx: Transaction, env: CommandEnvironment) => Promise<O>;
}

/**
 * Organization-level permissions are resolved only from live organization membership: a workspace role
 * (even Workspace Owner) never authorizes them, so workspace commands can't declare them.
 */
export type OrganizationScopedPermission = "organization.manage" | "billing.manage";
export type WorkspaceScopedPermission = Exclude<PermissionKey, OrganizationScopedPermission>;

export interface WorkspaceCommand<I, O, R> extends CommandBase<I, O, R> {
  readonly scope: "workspace";
  readonly permission: WorkspaceScopedPermission;
  /** True for platform mutations and platform-changing automation; internal workflow actions are false. */
  readonly requiresStandardMode: boolean;
  readonly execute: (context: WorkspaceContext, input: I, tx: Transaction, env: CommandEnvironment) => Promise<O>;
}

export type Command<I, O, R> = UserCommand<I, O, R> | OrganizationCommand<I, O, R> | WorkspaceCommand<I, O, R>;
