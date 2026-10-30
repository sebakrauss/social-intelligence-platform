/**
 * Step H7-D0g / H7-D0i — the ANTHROPIC TRANSPORT SCHEMA: a deterministic projection of the gateway's provider-neutral
 * output schema for Anthropic's constrained decoding. H7-D0f isolated the remaining Sonnet 5.5 400 to the full schema's
 * compiled grammar; H7-D0h isolated it further to UNION branching (0 optional / 7 unions ⇒ 400; 16 optional / 0
 * unions ⇒ 200). v2 therefore contains NO union at all.
 *
 *   CANONICAL schema     the task's strict-dialect JSON Schema (unchanged; OpenAI still receives it as is)
 *   TRANSPORT schema     this projection — sent only to Anthropic, only to keep the grammar compilable
 *   A1 validator         the final authority after the provider answers (unchanged): JSON.parse ⇒ the task's
 *                        strict-dialect bridge (unchanged) ⇒ validator; anything the projection no longer encodes
 *                        fails there — nothing is mapped, filled in or coerced
 *
 * Rules (nothing added or renamed; every object keeps `additionalProperties: false`):
 *   1. a null-only placeholder property (`{type: "null"}`) is dropped: omitted ≡ null once the bridge has run
 *   2. a nullable property (`anyOf` with a `{type: "null"}` branch) — the strict dialect's spelling of an OPTIONAL
 *      field — becomes a non-required property holding its non-null schema; non-nullable properties stay required.
 *      Exception (v2): a nullable ARRAY on an object that is not a merged union object becomes a REQUIRED array — the
 *      empty array is its absence (A1 validates `[]` and an omitted array identically; pinned by test). It keeps the
 *      optional-parameter count within Anthropic's explicit limit of 24
 *   3. (v2) an `anyOf` of object branches (assessed | abstention) is MERGED into one object: the property union in
 *      branch order; a property in several branches must have the same schema, except the branch discriminator — an
 *      enum present in every branch — whose enums are united; required = the properties required in EVERY branch (the
 *      discriminator); branch-specific properties become optional. The cross-field rules the branches encoded
 *      (assessed needs values; an abstention carries nothing but its status) stay in A1. Incompatible shared schemas,
 *      or an `anyOf` that is not mergeable, throw (fail closed) — the output never contains an `anyOf`
 *   4. a multi-value string enum becomes `{type: "string"}` (the closed list moves to A1), except discriminators and
 *      single-value enums, which keep theirs
 */

type Schema = Readonly<Record<string, unknown>>;

export const ANTHROPIC_TRANSPORT_SCHEMA_VERSION = "anthropic-transport-schema.v2" as const;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const isNullOnly = (schema: Schema): boolean => schema["type"] === "null" && Object.keys(schema).length === 1;
const isObjectSchema = (schema: Schema): boolean => schema["type"] === "object" && isSchema(schema["properties"]);
const isStringEnum = (schema: unknown): schema is Schema => isSchema(schema) && schema["type"] === "string" && Array.isArray(schema["enum"]) && (schema["enum"] as unknown[]).every((v) => typeof v === "string");
const unsupported = (reason: string): never => { throw new TypeError(`anthropic_schema_projection_unsupported:${reason}`); };

/** Rule 3: one object from object branches (fail closed on anything not mergeable). */
function mergeBranches(branches: readonly unknown[]): { readonly merged: Schema; readonly discriminators: ReadonlySet<string> } {
  const objects = branches.map((branch) => (isSchema(branch) && isObjectSchema(branch) && branch["additionalProperties"] === false ? branch : unsupported("anyOf_branch_not_a_closed_object")));
  const props = objects.map((branch) => branch["properties"] as Readonly<Record<string, Schema>>);
  const discriminators = new Set(Object.keys(props[0] ?? {}).filter((key) => props.every((p) => isStringEnum(p[key]))));
  if (discriminators.size === 0) unsupported("anyOf_without_discriminator");
  const properties: Record<string, Schema> = {};
  for (const p of props) {
    for (const [key, schema] of Object.entries(p)) {
      const seen = properties[key];
      if (seen === undefined) properties[key] = discriminators.has(key) ? { ...schema, enum: [...(schema["enum"] as string[])] } : schema;
      else if (discriminators.has(key)) properties[key] = { ...seen, enum: [...new Set([...(seen["enum"] as string[]), ...(schema["enum"] as string[])])] };
      else if (JSON.stringify(seen) !== JSON.stringify(schema)) unsupported(`incompatible_shared_property:${key}`);
    }
  }
  const required = Object.keys(properties).filter((key) => objects.every((branch) => (branch["required"] as string[]).includes(key)));
  return { merged: { type: "object", properties, required, additionalProperties: false }, discriminators };
}

function project(schema: Schema, keepEnum: boolean): Schema {
  if (Array.isArray(schema["anyOf"])) {
    const { merged, discriminators } = mergeBranches(schema["anyOf"] as unknown[]);
    return projectObject(merged, discriminators, true);
  }
  if (Array.isArray(schema["enum"])) {
    const values = schema["enum"] as unknown[];
    const relaxable = !keepEnum && values.length > 1 && isStringEnum(schema);
    return relaxable ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "enum")) : { ...schema };
  }
  if (isObjectSchema(schema)) return projectObject(schema, new Set(), false);
  if (schema["type"] === "array" && isSchema(schema["items"])) return { ...schema, items: project(schema["items"], false) };
  return { ...schema };
}

function projectObject(schema: Schema, discriminators: ReadonlySet<string>, merged: boolean): Schema {
  const properties: Record<string, Schema> = {};
  const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []);
  for (const [key, value] of Object.entries(schema["properties"] as Schema)) {
    if (!isSchema(value)) unsupported(`property:${key}`);
    const child = value as Schema;
    if (isNullOnly(child)) {
      required.delete(key);
      continue;
    }
    const branches = Array.isArray(child["anyOf"]) ? (child["anyOf"] as unknown[]) : null;
    if (branches !== null && branches.some((b) => isSchema(b) && isNullOnly(b))) {
      const nonNull = branches.filter((b) => !(isSchema(b) && isNullOnly(b)));
      const single = nonNull.length === 1 ? nonNull[0] : undefined;
      const inner = isSchema(single) ? single : { anyOf: nonNull };
      if (!merged && inner["type"] === "array") required.add(key);
      else required.delete(key);
      properties[key] = project(inner, false);
      continue;
    }
    properties[key] = project(child, discriminators.has(key));
  }
  const kept = Object.keys(properties).filter((key) => required.has(key));
  return { ...schema, properties, required: kept };
}

const containsAnyOf = (node: unknown): boolean => (Array.isArray(node) ? node.some(containsAnyOf) : isSchema(node) && (Object.hasOwn(node, "anyOf") || Object.values(node).some(containsAnyOf)));
const cache = new WeakMap<object, Schema>();

/** The Anthropic transport schema of a canonical strict-dialect schema (pure, deterministic; memoized per object). */
export function projectSchemaForAnthropic(canonical: Schema): Schema {
  const hit = cache.get(canonical);
  if (hit !== undefined) return hit;
  const projected = project(canonical, false);
  if (containsAnyOf(projected)) unsupported("union_remains");
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
