/**
 * Step H7-D0g — the ANTHROPIC TRANSPORT SCHEMA: a deterministic projection of the gateway's provider-neutral output
 * schema for Anthropic's constrained decoding. H7-D0f isolated the remaining Sonnet 5.5 400 to the full schema's
 * compiled grammar (same request, a trivial schema ⇒ 200), although it is inside every documented explicit limit.
 *
 *   CANONICAL schema     the task's strict-dialect JSON Schema (unchanged; OpenAI still receives it as is)
 *   TRANSPORT schema     this projection — sent only to Anthropic, only to keep the grammar compilable
 *   A1 validator         the final authority after the provider answers (unchanged): JSON.parse ⇒ the task's
 *                        strict-dialect bridge ⇒ validator; anything the projection no longer encodes fails there
 *
 * Rules (structure-preserving; nothing is added, no key is renamed, objects keep `additionalProperties: false`):
 *   1. a property whose schema is `{type: "null"}` only (a strict-dialect placeholder that can only be null) is
 *      dropped: omitted and null are the same thing once the strict-dialect bridge has run
 *   2. a nullable property (`anyOf` with a `{type: "null"}` branch) becomes a NON-required property holding its
 *      non-null schema (a single branch is unwrapped). In the strict dialect a nullable property is how an OPTIONAL
 *      field is spelled (all properties required, absent = null), so this is Anthropic's native spelling of the same
 *      optionality — never applied to a non-nullable property, which stays required
 *   3. a multi-value string enum becomes `{type: "string"}` (the closed value list moves to A1, which rejects any
 *      other value; nothing is mapped or coerced) — EXCEPT a discriminator: an enum property present in every object
 *      branch of an `anyOf` keeps its enum, so each branch stays recognizable. Single-value enums are kept
 *   everything else (types, arrays, items, object boundaries, required non-nullable fields) is copied unchanged
 */

type Schema = Readonly<Record<string, unknown>>;

export const ANTHROPIC_TRANSPORT_SCHEMA_VERSION = "anthropic-transport-schema.v1" as const;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const isNullOnly = (schema: Schema): boolean => schema["type"] === "null" && Object.keys(schema).length === 1;
const isObjectSchema = (schema: Schema): boolean => schema["type"] === "object" && isSchema(schema["properties"]);
const hasEnum = (schema: unknown): boolean => isSchema(schema) && Array.isArray(schema["enum"]);

/** Properties present in EVERY object branch with an enum in each: the branches' discriminators. */
function discriminatorsOf(branches: readonly unknown[]): ReadonlySet<string> {
  const objects = branches.filter(isSchema).filter(isObjectSchema);
  const first = objects[0];
  if (first === undefined || objects.length < 2 || objects.length !== branches.filter((b) => !(isSchema(b) && isNullOnly(b))).length) return new Set();
  return new Set(Object.keys(first["properties"] as Schema).filter((key) => objects.every((branch) => hasEnum((branch["properties"] as Schema)[key]))));
}

function project(schema: Schema, keepEnum: boolean): Schema {
  if (Array.isArray(schema["anyOf"])) {
    const branches = schema["anyOf"] as unknown[];
    const discriminators = discriminatorsOf(branches);
    return { ...schema, anyOf: branches.map((branch) => (isSchema(branch) ? projectBranch(branch, discriminators) : branch)) };
  }
  if (Array.isArray(schema["enum"])) {
    const values = schema["enum"] as unknown[];
    const relaxable = !keepEnum && values.length > 1 && schema["type"] === "string" && values.every((v) => typeof v === "string");
    return relaxable ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "enum")) : { ...schema };
  }
  if (isObjectSchema(schema)) return projectObject(schema, new Set());
  if (schema["type"] === "array" && isSchema(schema["items"])) return { ...schema, items: project(schema["items"], false) };
  return { ...schema };
}

function projectBranch(branch: Schema, discriminators: ReadonlySet<string>): Schema {
  return isObjectSchema(branch) ? projectObject(branch, discriminators) : project(branch, false);
}

function projectObject(schema: Schema, discriminators: ReadonlySet<string>): Schema {
  const properties: Record<string, Schema> = {};
  const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []);
  for (const [key, value] of Object.entries(schema["properties"] as Schema)) {
    if (!isSchema(value)) throw new TypeError(`anthropic_schema_projection_unsupported:${key}`);
    if (isNullOnly(value)) {
      required.delete(key);
      continue;
    }
    const branches = Array.isArray(value["anyOf"]) ? (value["anyOf"] as unknown[]) : null;
    if (branches !== null && branches.some((b) => isSchema(b) && isNullOnly(b))) {
      const nonNull = branches.filter((b) => !(isSchema(b) && isNullOnly(b)));
      required.delete(key);
      const single = nonNull.length === 1 ? nonNull[0] : undefined;
      properties[key] = isSchema(single) ? project(single, false) : project({ ...value, anyOf: nonNull }, false);
      continue;
    }
    properties[key] = project(value, discriminators.has(key));
  }
  const kept = Object.keys(schema["properties"] as Schema).filter((key) => required.has(key) && Object.hasOwn(properties, key));
  return { ...schema, properties, required: kept };
}

const cache = new WeakMap<object, Schema>();

/** The Anthropic transport schema of a canonical strict-dialect schema (pure, deterministic; memoized per object). */
export function projectSchemaForAnthropic(canonical: Schema): Schema {
  const hit = cache.get(canonical);
  if (hit !== undefined) return hit;
  const projected = project(canonical, false);
  cache.set(canonical, projected);
  return projected;
}

export interface SchemaComplexity {
  readonly bytes: number;
  readonly objects: number;
  readonly properties: number;
  readonly requiredProperties: number;
  readonly optionalProperties: number;
  readonly enums: number;
  readonly enumValues: number;
  readonly anyOf: number;
  readonly anyOfBranches: number;
  readonly unionParameters: number;
  readonly nullTypes: number;
  readonly arrays: number;
  readonly maxDepth: number;
}

/** Deterministic grammar-complexity metrics of a JSON Schema (properties, anyOf branches and array items walked). */
export function measureSchemaComplexity(schema: Schema): SchemaComplexity {
  const m = { bytes: JSON.stringify(schema).length, objects: 0, properties: 0, requiredProperties: 0, optionalProperties: 0, enums: 0, enumValues: 0, anyOf: 0, anyOfBranches: 0, unionParameters: 0, nullTypes: 0, arrays: 0, maxDepth: 0 };
  const walk = (node: unknown, depth: number): void => {
    if (!isSchema(node)) return;
    m.maxDepth = Math.max(m.maxDepth, depth);
    if (Array.isArray(node["enum"])) {
      m.enums += 1;
      m.enumValues += (node["enum"] as unknown[]).length;
    }
    if (node["type"] === "null") m.nullTypes += 1;
    if (node["type"] === "array") m.arrays += 1;
    if (Array.isArray(node["anyOf"])) {
      m.anyOf += 1;
      m.anyOfBranches += (node["anyOf"] as unknown[]).length;
      for (const branch of node["anyOf"] as unknown[]) walk(branch, depth + 1);
    }
    if (isObjectSchema(node)) {
      m.objects += 1;
      const required = new Set(Array.isArray(node["required"]) ? (node["required"] as string[]) : []);
      for (const [key, child] of Object.entries(node["properties"] as Schema)) {
        m.properties += 1;
        if (required.has(key)) m.requiredProperties += 1;
        else m.optionalProperties += 1;
        if (isSchema(child) && (Array.isArray(child["anyOf"]) || Array.isArray(child["type"]))) m.unionParameters += 1;
        walk(child, depth + 1);
      }
    }
    if (isSchema(node["items"])) walk(node["items"], depth + 1);
  };
  walk(schema, 0);
  return Object.freeze(m);
}
