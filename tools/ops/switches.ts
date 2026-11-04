/**
 * Operator writes to the operational switches (TA §66: "changed by the team through an audited tool").
 * Runtime roles can only READ switches; writes happen here, with the privileged tooling credential, in one
 * transaction that declares who and why (transaction-local settings). The database trigger refuses any
 * change without them and appends the history row in the same transaction.
 *
 * The change is validated against the typed registry first (scope, qualifier, value shape), so the tool
 * can't write a value the runtime would reject. If an invalid row reaches the table anyway, readers resolve
 * the switch to its fail-safe value.
 *
 * Writes are idempotent (Step H7-production-kill-switch-tooling): setting a value the row already holds, or
 * clearing an override that doesn't exist, writes nothing — no row, no history — and reports "unchanged".
 */
import { SWITCHES, type SwitchKey, type SwitchScope } from "../../platform/flags/registry.ts";

export const REASON_CODES = ["incident", "release", "rollout", "rollback", "maintenance", "test"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SwitchTarget {
  readonly key: SwitchKey;
  readonly qualifier: string;
  readonly scope: SwitchScope;
  readonly organizationId?: string;
  readonly workspaceId?: string;
}

export interface SwitchAttribution {
  readonly operator: string;
  readonly reason: ReasonCode;
}

/** The subset of pg.Client / pg.PoolClient the tool needs. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ readonly rowCount: number | null; readonly rows: readonly Record<string, unknown>[] }>;
}

export class SwitchChangeError extends Error {
  override readonly name = "SwitchChangeError";
}

/** One stored override, as the runtime reads it (identifiers and the JSON value: never a secret). */
export interface SwitchRow {
  readonly switchKey: string;
  readonly qualifier: string;
  readonly scope: string;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly value: unknown;
}

function isSwitchKey(value: string): value is SwitchKey {
  return Object.hasOwn(SWITCHES, value);
}

/** Validates a target against the registry. Throws SwitchChangeError (messages carry no values). */
export function validateTarget(target: { readonly key: string; readonly qualifier: string; readonly scope: string; readonly organizationId?: string; readonly workspaceId?: string }): SwitchTarget {
  if (!isSwitchKey(target.key)) throw new SwitchChangeError("unknown switch key");
  const definition = SWITCHES[target.key];
  if (!(definition.scopes as readonly string[]).includes(target.scope)) throw new SwitchChangeError(`scope not allowed for ${target.key}`);
  if (!definition.qualifier(target.qualifier)) throw new SwitchChangeError(`qualifier not valid for ${target.key}`);
  const scope = target.scope as SwitchScope;
  const organizationId = scope === "organization" ? target.organizationId : undefined;
  const workspaceId = scope === "workspace" ? target.workspaceId : undefined;
  if (scope === "organization" && (organizationId === undefined || !UUID.test(organizationId))) throw new SwitchChangeError("organization scope needs an organization id");
  if (scope === "workspace" && (workspaceId === undefined || !UUID.test(workspaceId))) throw new SwitchChangeError("workspace scope needs a workspace id");
  if (scope !== "organization" && target.organizationId !== undefined) throw new SwitchChangeError("organization id given for a non-organization scope");
  if (scope !== "workspace" && target.workspaceId !== undefined) throw new SwitchChangeError("workspace id given for a non-workspace scope");
  return {
    key: target.key,
    qualifier: target.qualifier,
    scope,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

function validateAttribution(attribution: SwitchAttribution): void {
  if (!OPERATOR.test(attribution.operator)) throw new SwitchChangeError("operator id is not valid");
  if (!(REASON_CODES as readonly string[]).includes(attribution.reason)) throw new SwitchChangeError("reason code is not valid");
}

async function inAuditedTransaction<T>(client: Queryable, attribution: SwitchAttribution, work: () => Promise<T>): Promise<T> {
  validateAttribution(attribution);
  await client.query("begin");
  try {
    await client.query("select pg_catalog.set_config('app.operator_id', $1, true), pg_catalog.set_config('app.change_reason', $2, true)", [attribution.operator, attribution.reason]);
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

const ROW_COLUMNS = "switch_key, qualifier, scope, organization_id, workspace_id, value";
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);
const rowOf = (raw: Record<string, unknown>): SwitchRow => ({
  switchKey: text(raw["switch_key"]), qualifier: text(raw["qualifier"]), scope: text(raw["scope"]),
  organizationId: optionalText(raw["organization_id"]), workspaceId: optionalText(raw["workspace_id"]), value: raw["value"],
});
const targetValues = (checked: SwitchTarget): unknown[] => [checked.key, checked.qualifier, checked.scope, checked.organizationId ?? null, checked.workspaceId ?? null];
const TARGET_WHERE = "switch_key = $1 and qualifier = $2 and scope = $3 and organization_id is not distinct from $4::uuid and workspace_id is not distinct from $5::uuid";

/** Read-only: the stored override for exactly `target`, if any (no transaction of its own). */
export async function readSwitchRow(client: Queryable, target: SwitchTarget): Promise<SwitchRow | undefined> {
  const checked = validateTarget(target);
  const result = await client.query(`select ${ROW_COLUMNS} from system.operational_switches where ${TARGET_WHERE}`, targetValues(checked));
  const raw = result.rows[0];
  return raw === undefined ? undefined : rowOf(raw);
}

/** Read-only: every stored override, in a stable order (the "nothing else changed" oracle). */
export async function snapshotSwitches(client: Queryable): Promise<readonly SwitchRow[]> {
  const result = await client.query(`select ${ROW_COLUMNS} from system.operational_switches order by switch_key, qualifier, scope, organization_id, workspace_id`);
  return result.rows.map(rowOf);
}

const identityOf = (row: SwitchRow): string => JSON.stringify([row.switchKey, row.qualifier, row.scope, row.organizationId, row.workspaceId]);
const isTarget = (row: SwitchRow, target: SwitchTarget): boolean =>
  row.switchKey === target.key && row.qualifier === target.qualifier && row.scope === target.scope
  && row.organizationId === (target.organizationId ?? null) && row.workspaceId === (target.workspaceId ?? null);

/** The identities of every row that differs between two snapshots, EXCLUDING the intended target (empty = nothing else moved). */
export function unexpectedChanges(before: readonly SwitchRow[], after: readonly SwitchRow[], target: SwitchTarget): readonly string[] {
  const index = (rows: readonly SwitchRow[]): Map<string, string> => new Map(rows.filter((row) => !isTarget(row, target)).map((row) => [identityOf(row), JSON.stringify(row.value)]));
  const left = index(before);
  const right = index(after);
  const changed = new Set<string>();
  for (const [identity, value] of left) if (right.get(identity) !== value) changed.add(identity);
  for (const [identity, value] of right) if (left.get(identity) !== value) changed.add(identity);
  return [...changed].sort();
}

/** Sets (inserts or replaces) one override, audited. Idempotent: an identical stored value writes nothing. */
export async function setSwitch(client: Queryable, target: SwitchTarget, value: unknown, attribution: SwitchAttribution): Promise<{ readonly changed: boolean }> {
  const checked = validateTarget(target);
  if (SWITCHES[checked.key].parse(value) === undefined) throw new SwitchChangeError(`value shape not valid for ${checked.key}`);
  const encoded = JSON.stringify(value);
  return inAuditedTransaction(client, attribution, async () => {
    const current = await client.query(`select (value = $6::jsonb) as same from system.operational_switches where ${TARGET_WHERE} for update`, [...targetValues(checked), encoded]);
    if (current.rows[0]?.["same"] === true) return { changed: false };
    await client.query(
      `insert into system.operational_switches (switch_key, qualifier, scope, organization_id, workspace_id, value)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (switch_key, qualifier, scope, organization_id, workspace_id)
       do update set value = excluded.value, updated_at = pg_catalog.now()`,
      [...targetValues(checked), encoded],
    );
    return { changed: true };
  });
}

/** Clears one override (back to the next applicable level or the default), audited. Returns whether a row existed. */
export async function clearSwitch(client: Queryable, target: SwitchTarget, attribution: SwitchAttribution): Promise<boolean> {
  const checked = validateTarget(target);
  const result = await inAuditedTransaction(client, attribution, () =>
    client.query(`delete from system.operational_switches where ${TARGET_WHERE}`, targetValues(checked)),
  );
  return (result.rowCount ?? 0) > 0;
}
