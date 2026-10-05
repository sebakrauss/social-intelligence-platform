/**
 * Switch resolution with a short-lived in-process cache (TA §66.1: "seconds"). Pure given the rows; the
 * loader is whatever scoped read the caller has (web user scope, worker job scope, system scope), so RLS
 * decides which overrides a runtime can even see.
 *
 * Fail-safe: an invalid applicable row, or a store that can't be read, resolves to the switch's declared
 * fail-safe value (kill switches active, gates closed, mutations disabled, ingestion paused, routing on its
 * default route) — never to a permissive guess.
 */
import { SWITCHES, type SwitchDefinition, type SwitchKey, type SwitchScope, type SwitchValue } from "./registry";

export interface SwitchRowInput {
  readonly switchKey: string;
  readonly qualifier: string;
  readonly scope: string;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly value: unknown;
}

export interface SwitchQuery {
  /** "*" when the switch has no qualifier. */
  readonly qualifier?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
}

export interface ResolvedSwitch<V> {
  readonly value: V;
  readonly source: "default" | SwitchScope | "fail_safe";
  /** True when the value is the fail-safe because configuration was invalid or unreadable. */
  readonly failSafe: boolean;
}

const SCOPE_RANK: Readonly<Record<SwitchScope, number>> = { global: 1, organization: 2, workspace: 3 };

function applicable(definition: SwitchDefinition<unknown>, row: SwitchRowInput, query: SwitchQuery): boolean {
  if (row.switchKey !== definition.key) return false;
  const qualifier = query.qualifier ?? "*";
  if (row.qualifier !== "*" && row.qualifier !== qualifier) return false;
  switch (row.scope) {
    case "global":
      return true;
    case "organization":
      return query.organizationId !== undefined && row.organizationId === query.organizationId;
    case "workspace":
      return query.workspaceId !== undefined && row.workspaceId === query.workspaceId;
    default:
      return true; // unknown scope: considered, then rejected as invalid below
  }
}

function rowIsValid(definition: SwitchDefinition<unknown>, row: SwitchRowInput): boolean {
  return (definition.scopes as readonly string[]).includes(row.scope) && definition.qualifier(row.qualifier) && definition.parse(row.value) !== undefined;
}

/** Resolves one switch from the visible rows. */
export function resolveSwitch<K extends SwitchKey>(rows: readonly SwitchRowInput[], key: K, query: SwitchQuery = {}): ResolvedSwitch<SwitchValue<K>> {
  const definition = SWITCHES[key] as unknown as SwitchDefinition<SwitchValue<K>>;
  const generic = definition as unknown as SwitchDefinition<unknown>;
  const relevant = rows.filter((row) => applicable(generic, row, query));
  if (relevant.some((row) => !rowIsValid(generic, row))) {
    return { value: definition.failSafe, source: "fail_safe", failSafe: true };
  }
  if (relevant.length === 0) return { value: definition.defaultValue, source: "default", failSafe: false };

  const parsed = relevant.map((row) => ({ row, value: definition.parse(row.value) as SwitchValue<K> }));
  if (definition.resolution === "any_restrictive") {
    const restrictive = parsed.find((entry) => definition.isRestrictive?.(entry.value) === true);
    return restrictive === undefined
      ? { value: definition.defaultValue, source: "default", failSafe: false }
      : { value: restrictive.value, source: restrictive.row.scope as SwitchScope, failSafe: false };
  }
  const rank = (entry: (typeof parsed)[number]): number =>
    SCOPE_RANK[entry.row.scope as SwitchScope] * 10 + (entry.row.qualifier === "*" ? 1 : 2);
  const best = parsed.reduce((winner, entry) => (rank(entry) > rank(winner) ? entry : winner));
  return { value: best.value, source: best.row.scope as SwitchScope, failSafe: false };
}

export interface SwitchReader {
  get<K extends SwitchKey>(key: K, query?: SwitchQuery): Promise<ResolvedSwitch<SwitchValue<K>>>;
}

/**
 * A cached reader. Rows are reloaded at most once per `ttlMs`; a failed load resolves every switch to its
 * fail-safe value until a later load succeeds.
 */
export function createSwitchReader(options: {
  readonly load: () => Promise<readonly SwitchRowInput[]>;
  readonly ttlMs: number;
  readonly now?: () => number;
}): SwitchReader {
  const now = options.now ?? (() => Date.now());
  let cache: { readonly at: number; readonly rows: readonly SwitchRowInput[] | undefined } | undefined;
  const rows = async (): Promise<readonly SwitchRowInput[] | undefined> => {
    if (cache !== undefined && now() - cache.at < options.ttlMs) return cache.rows;
    try {
      cache = { at: now(), rows: await options.load() };
    } catch {
      cache = { at: now(), rows: undefined };
    }
    return cache.rows;
  };
  return {
    async get(key, query = {}) {
      const loaded = await rows();
      if (loaded === undefined) {
        const definition = SWITCHES[key] as unknown as SwitchDefinition<SwitchValue<typeof key>>;
        return { value: definition.failSafe, source: "fail_safe", failSafe: true };
      }
      return resolveSwitch(loaded, key, query);
    },
  };
}
