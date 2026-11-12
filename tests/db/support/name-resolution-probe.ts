/**
 * Step 7B-14P1 (TA §11 R4a) — the privileged name-resolution probe, shared by T-26 (which requires it to find nothing)
 * and the 0031 upgrade test (which requires it to find the class before 0031 and nothing after).
 *
 * Under `search_path = ''` PostgreSQL searches the session's temporary schema FIRST for relation and type names. A
 * session that may create temporary objects (every runtime role: PUBLIC holds TEMP) can define, e.g., a domain
 * pg_temp.uuid whose CHECK calls its own function. Any privileged function that then resolves `uuid` runs that code as
 * its owner. The probe arms a session exactly that way — a domain over EVERY builtin base type, a `record` composite,
 * look-alike tables for the relation names application code uses — and calls every application function the session
 * can execute (and, in the privileged variant, fires every trigger function and evaluates every CHECK predicate as
 * app_owner). Every armed function announces where it runs; anything that runs as another identity is an escalation.
 *
 * Safety: everything happens inside ONE transaction that is always rolled back (no temporary object survives on a pooled
 * backend), each call inside its own savepoint. The probe never reads, prints or returns a credential, envelope or
 * token: the "demonstrate" payload returns only COUNTS and a boolean (and only on a disposable local cluster).
 */
import type pg from "pg";

/** What an armed function does when it finds itself running as app_owner. */
export type ProbePayload =
  /** Announce only (safe anywhere). */
  | "observe"
  /** Local disposable cluster only: try to turn FORCE RLS off on the credential envelopes and count the rows then visible. */
  | "demonstrate";

const MARK = "R4A-PROBE";

const evil = (payload: ProbePayload): string => `create function pg_temp.r4a_evil(v pg_catalog.text) returns pg_catalog.bool language plpgsql as $probe$
declare
  n pg_catalog.int8 := -1;
  f pg_catalog.bool;
begin
  ${payload === "demonstrate" ? `if current_user::pg_catalog.text = 'app_owner' then
    begin
      alter table credentials.provider_credentials no force row level security;
    exception when others then null;
    end;
    select c.relforcerowsecurity into f from pg_catalog.pg_class c where c.oid = 'credentials.provider_credentials'::pg_catalog.regclass;
    begin
      select pg_catalog.count(*) into n from credentials.provider_credentials;
    exception when others then n := -1;
    end;
  end if;` : ""}
  raise notice '${MARK} user=% via=% forced=% visible=%', current_user, v, coalesce(f::pg_catalog.text, '-'), n;
  return true;
end $probe$`;

/** Catalog relations privileged code reads: shadowed too (they must always resolve to pg_catalog). */
const CATALOG_LOOKALIKES = [
  "pg_roles", "pg_authid", "pg_auth_members", "pg_class", "pg_namespace", "pg_type", "pg_proc", "pg_database", "pg_shdepend", "pg_db_role_setting", "pg_policy", "pg_trigger",
  "pg_attribute", "pg_constraint", "pg_operator", "pg_settings", "pg_stat_activity",
];

/** Typed literals per argument type (every cast schema-qualified, so the CALLER's own text never resolves pg_temp). */
const literal = (type: string, uuid: string): string =>
  ({
    uuid: `'${uuid}'`, text: "'x'", _text: "'{}'", int4: "1", int8: "1", int2: "1", bool: "true", timestamptz: "pg_catalog.now()", date: "pg_catalog.current_date",
    jsonb: "'{}'", bytea: "'\\x00'", _numeric: "'{}'", _int4: "'{}'", numeric: "1",
  })[type] ?? "null";

export interface ProbeResult {
  /** The fixture is live: an unqualified cast in the session's OWN statement resolved the armed domain. */
  readonly armed: boolean;
  /** Application functions exercised (signature). */
  readonly exercised: readonly string[];
  /** Functions in which armed code ran as an identity other than the session's own (signature → identities). */
  readonly escalated: Readonly<Record<string, readonly string[]>>;
  /** "demonstrate" only: FORCE RLS was seen OFF on the envelopes table, and the most envelope rows visible as app_owner. */
  readonly forcedRlsTurnedOff: boolean;
  readonly maxEnvelopesVisible: number;
}

interface Collector {
  readonly notices: string[];
}

function collector(client: pg.Client): Collector {
  const notices: string[] = [];
  client.on("notice", (notice) => {
    const text = String(notice.message);
    if (text.startsWith(MARK)) notices.push(text);
  });
  return { notices };
}

async function arm(client: pg.Client, payload: ProbePayload): Promise<void> {
  await client.query(evil(payload));
  const types = (await client.query<{ name: string }>(
    `select t.typname::pg_catalog.text as name from pg_catalog.pg_type t
      where t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace and t.typtype = 'b' and t.typname !~ '^_' and t.typisdefined order by 1`)).rows.map((row) => row.name);
  for (const name of types) {
    // Some base types cannot carry a domain (a caller could not shadow them either): skip those only.
    await client.query("savepoint r4a_arm");
    try {
      await client.query(`create domain pg_temp."${name}" as pg_catalog."${name}" check (pg_temp.r4a_evil('${name}'))`);
      await client.query("release savepoint r4a_arm");
    } catch {
      await client.query("rollback to savepoint r4a_arm");
    }
  }
  await client.query("create type pg_temp.record as (a pg_catalog.int4)");
  // Look-alike VIEWS (a view runs the caller's code when scanned) for EVERY application relation name and the catalogs
  // privileged code reads, column for column, so an unqualified reference would bind to it and run the armed function.
  const relations = (await client.query<{ name: string; columns: string }>(
    `select distinct on (c.relname) c.relname::pg_catalog.text as name,
            pg_catalog.string_agg(
              -- A pseudo-type column (e.g. anyarray in a catalog) cannot be a view column: text stands in for it.
              case when t.typtype = 'p' then 'null::pg_catalog.text' else 'null::' || pg_catalog.quote_ident(tn.nspname) || '.' || pg_catalog.quote_ident(t.typname) end
              || ' as ' || pg_catalog.quote_ident(a.attname), ', ' order by a.attnum) as columns
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       join pg_catalog.pg_type t on t.oid = a.atttypid join pg_catalog.pg_namespace tn on tn.oid = t.typnamespace
      where c.relkind in ('r', 'p', 'v') and (n.nspowner = 'app_owner'::pg_catalog.regrole or (n.nspname = 'pg_catalog' and c.relname = any($1::pg_catalog.text[])))
      group by c.oid, c.relname, n.nspname order by c.relname, n.nspname`, [CATALOG_LOOKALIKES])).rows;
  for (const relation of relations) {
    await client.query(`create temporary view "${relation.name}" as select ${relation.columns} from (values (1)) as r4a(x) where pg_temp.r4a_evil('rel:${relation.name}')`);
    // As an attacker would: readable by the privileged identity that might resolve it.
    await client.query(`grant select on pg_temp."${relation.name}" to public`);
  }
}

function record(collected: Collector, from: number, self: string, signature: string, escalated: Map<string, Set<string>>, totals: { off: boolean; max: number }): void {
  for (const notice of collected.notices.slice(from)) {
    const match = /^R4A-PROBE user=(\S+) via=\S+ forced=(\S+) visible=(-?\d+)$/.exec(notice);
    if (match === null || match[1] === self) continue;
    const identities = escalated.get(signature) ?? new Set<string>();
    identities.add(match[1] ?? "?");
    escalated.set(signature, identities);
    if (match[2] === "f" || match[2] === "false") totals.off = true;
    totals.max = Math.max(totals.max, Number(match[3]));
  }
}

/**
 * A runtime session (connected as a login, `setup` switching to its fixed role and binding its context) arms its pg_temp
 * and calls EVERY application function it can EXECUTE, twice (typed values; typed NULLs). Rolled back at the end.
 */
export async function probeRuntimeSession(client: pg.Client, options: { readonly setup: readonly string[]; readonly uuid: string; readonly payload?: ProbePayload }): Promise<ProbeResult> {
  const collected = collector(client);
  const escalated = new Map<string, Set<string>>();
  const totals = { off: false, max: 0 };
  await client.query("begin");
  try {
    for (const statement of options.setup) await client.query(statement);
    const self = (await client.query<{ role: string }>("select current_user::pg_catalog.text as role")).rows[0]?.role ?? "";
    await arm(client, options.payload ?? "observe");
    const before = collected.notices.length;
    await client.query("select 'x'::text");
    const armed = collected.notices.slice(before).some((notice) => notice.startsWith(`${MARK} user=${self} via=text`));
    const functions = (await client.query<{ signature: string; call: string; types: string[] }>(
      `select p.oid::pg_catalog.regprocedure::pg_catalog.text as signature, pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname) as call,
              array(select t.typname::pg_catalog.text from pg_catalog.unnest(p.proargtypes) with ordinality a(oid, i) join pg_catalog.pg_type t on t.oid = a.oid order by a.i) as types
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspowner = 'app_owner'::pg_catalog.regrole and p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
          and pg_catalog.has_function_privilege(p.oid, 'EXECUTE') order by 1`)).rows;
    for (const fn of functions) {
      for (const nulls of [false, true]) {
        const args = fn.types.map((type) => `${nulls ? "null" : literal(type, options.uuid)}::pg_catalog."${type}"`).join(", ");
        const from = collected.notices.length;
        await client.query("savepoint r4a_call");
        // Refusals are expected (wrong context, invalid arguments): only WHERE armed code ran matters.
        await client.query(`select ${fn.call}(${args})`).catch(() => undefined);
        await client.query("rollback to savepoint r4a_call");
        record(collected, from, self, fn.signature, escalated, totals);
      }
    }
    return {
      armed, exercised: functions.map((fn) => fn.signature),
      escalated: Object.fromEntries([...escalated].map(([signature, identities]) => [signature, [...identities].sort()])),
      forcedRlsTurnedOff: totals.off, maxEnvelopesVisible: totals.max,
    };
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}

/**
 * The privileged context itself (LOCAL disposable cluster only; the migration role's session): armed, then
 * `SET LOCAL ROLE app_owner`, then EVERY application function runs as app_owner — each callable function called (typed
 * values; typed NULLs), and each trigger function fired on a scratch temporary copy of a table it guards (INSERT,
 * UPDATE, DELETE). This is exactly where an invoker helper, a CHECK predicate or a trigger runs when a definer's write
 * reaches it. The probe's own statements are schema-qualified, so armed code that runs comes from a function body.
 */
export async function probePrivilegedContext(client: pg.Client, options: { readonly uuid: string }): Promise<ProbeResult & { readonly triggersFired: readonly string[] }> {
  const collected = collector(client);
  const escalated = new Map<string, Set<string>>();
  const totals = { off: false, max: 0 };
  await client.query("begin");
  try {
    await arm(client, "observe");
    await client.query("set local role app_owner");
    const before = collected.notices.length;
    await client.query("select 'x'::text");
    const armed = collected.notices.slice(before).some((notice) => notice.startsWith(`${MARK} user=app_owner via=text`));
    // Here the session's own identity IS app_owner: any armed code that runs inside a function body counts.
    const functions = (await client.query<{ signature: string; call: string; types: string[]; trigger: boolean }>(
      `select p.oid::pg_catalog.regprocedure::pg_catalog.text as signature, pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname) as call,
              array(select t.typname::pg_catalog.text from pg_catalog.unnest(p.proargtypes) with ordinality a(oid, i) join pg_catalog.pg_type t on t.oid = a.oid order by a.i) as types,
              p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype as trigger
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspowner = 'app_owner'::pg_catalog.regrole order by 1`)).rows;
    const fired: string[] = [];
    let scratch = 0;
    for (const fn of functions) {
      if (!fn.trigger) {
        for (const nulls of [false, true]) {
          const args = fn.types.map((type) => `${nulls ? "null" : literal(type, options.uuid)}::pg_catalog."${type}"`).join(", ");
          const from = collected.notices.length;
          await client.query("savepoint r4a_call");
          await client.query(`select ${fn.call}(${args})`).catch(() => undefined);
          await client.query("rollback to savepoint r4a_call");
          record(collected, from, "", fn.signature, escalated, totals);
        }
        continue;
      }
      const tables = (await client.query<{ name: string }>(
        `select t.tgrelid::pg_catalog.regclass::pg_catalog.text as name from pg_catalog.pg_trigger t
          where not t.tgisinternal and t.tgfoid = $1::pg_catalog.regprocedure order by 1`, [fn.signature])).rows.map((row) => row.name);
      for (const table of tables) {
        scratch += 1;
        const copy = `pg_temp.r4a_scratch_${String(scratch)}`;
        // A column-for-column copy of the guarded table (no constraints), one all-NULL row, then the trigger function
        // attached to it and fired by each operation.
        await client.query(`create table ${copy} as select * from ${table} with no data`);
        await client.query(`insert into ${copy} default values`);
        await client.query(`create trigger r4a_before before insert or update or delete on ${copy} for each row execute function ${fn.call}()`);
        await client.query(`create trigger r4a_after after insert or update or delete on ${copy} for each row execute function ${fn.call}()`);
        const first = (await client.query<{ column: string }>(
          "select pg_catalog.quote_ident(a.attname) as column from pg_catalog.pg_attribute a where a.attrelid = $1::pg_catalog.regclass and a.attnum > 0 and not a.attisdropped order by a.attnum limit 1", [copy])).rows[0]?.column;
        for (const operation of [`insert into ${copy} default values`, `update ${copy} set ${first ?? "oid"} = ${first ?? "oid"}`, `delete from ${copy}`]) {
          const from = collected.notices.length;
          await client.query("savepoint r4a_call");
          await client.query(operation).catch(() => undefined);
          await client.query("rollback to savepoint r4a_call");
          record(collected, from, "", fn.signature, escalated, totals);
        }
        fired.push(`${fn.signature} on ${table}`);
      }
    }
    return {
      armed, exercised: functions.map((fn) => fn.signature), triggersFired: fired,
      escalated: Object.fromEntries([...escalated].map(([signature, identities]) => [signature, [...identities].sort()])),
      forcedRlsTurnedOff: totals.off, maxEnvelopesVisible: totals.max,
    };
  } finally {
    await client.query("rollback").catch(() => undefined);
  }
}
