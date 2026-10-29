/**
 * The provider-neutral JSON Schema of `understanding-output.v1` for NATIVE structured output (Step H7-D0). Generated
 * from the frozen taxonomy (it cannot drift from it) and written in the strict-mode dialect every candidate accepts:
 * every property required, `additionalProperties: false`, an absent value expressed as `null`. The SAME schema goes to
 * every provider (prompt / schema equality).
 *
 * It is a generation aid, never the authority: the output still passes the A1 validator (`validateUnderstandingOutput`),
 * which alone decides. The only bridge is `fromStructuredOutput`: it removes exactly the `null`s the strict dialect forces
 * for OPTIONAL fields (an omitted dimension, summary, evidence, score or reason codes) — nothing else is touched, no
 * value is mapped, defaulted or coerced; any other `null` or shape still fails the A1 validator.
 */
import { CONFIDENCE_LEVELS } from "../../domain/confidence";
import { TAXONOMY, TAXONOMY_VERSION, type ClosedDimension, type ClosedDimensionDefinition } from "../../domain/taxonomy";
import { UNDERSTANDING_DIMENSIONS, UNDERSTANDING_OUTPUT_SCHEMA_VERSION } from "../../domain/understanding-output";

export const UNDERSTANDING_JSON_SCHEMA_NAME = "wrenkind_understanding_output_v1";

type Schema = Readonly<Record<string, unknown>>;
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Readonly<Record<string, Schema>>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const enumOf = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
const ABSTENTION = object({ status: enumOf(["none_fits", "insufficient_evidence"]) });

function closedDimension(dimension: ClosedDimension): Schema {
  const definition = TAXONOMY[dimension] as ClosedDimensionDefinition;
  const assessed = object({
    status: enumOf(["assessed"]),
    values: { type: "array", items: object({ key: enumOf(definition.values), confidence: enumOf(CONFIDENCE_LEVELS), score: nullable({ type: "number" }) }) },
    reasonCodes: definition.reasonCodes.length > 0 ? nullable({ type: "array", items: enumOf(definition.reasonCodes) }) : { type: "null" },
  });
  return { anyOf: [assessed, ABSTENTION, { type: "null" }] };
}

const LANGUAGE = {
  anyOf: [object({ status: enumOf(["assessed"]), languages: { type: "array", items: { type: "string" } }, certainty: enumOf(["certain", "uncertain"]), confidence: enumOf(CONFIDENCE_LEVELS) }), ABSTENTION, { type: "null" }],
};

export const UNDERSTANDING_OUTPUT_JSON_SCHEMA: Schema = Object.freeze(object({
  schemaVersion: enumOf([UNDERSTANDING_OUTPUT_SCHEMA_VERSION]),
  taxonomyVersion: enumOf([TAXONOMY_VERSION]),
  dimensions: object(Object.fromEntries(UNDERSTANDING_DIMENSIONS.map((dimension) => [dimension, dimension === "language" ? LANGUAGE : closedDimension(dimension)]))),
  summary: nullable({ type: "string" }),
  evidence: nullable({ type: "array", items: object({ quote: { type: "string" } }) }),
}));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const withoutNull = (record: Record<string, unknown>, key: string): void => {
  if (Object.hasOwn(record, key) && record[key] === null) Reflect.deleteProperty(record, key);
};

/** Removes the strict-dialect `null`s of OPTIONAL fields only (a copy; anything unexpected is left for the A1 validator). */
export function fromStructuredOutput(parsed: unknown): unknown {
  if (!isRecord(parsed)) return parsed;
  const out: Record<string, unknown> = { ...parsed };
  withoutNull(out, "summary");
  withoutNull(out, "evidence");
  const dimensions = out["dimensions"];
  if (isRecord(dimensions)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dimensions)) {
      if (value === null) continue;
      if (isRecord(value) && value["status"] === "assessed") {
        const dimension: Record<string, unknown> = { ...value };
        withoutNull(dimension, "reasonCodes");
        if (Array.isArray(dimension["values"])) {
          dimension["values"] = dimension["values"].map((entry: unknown) => {
            if (!isRecord(entry)) return entry;
            const copy: Record<string, unknown> = { ...entry };
            withoutNull(copy, "score");
            return copy;
          });
        }
        normalized[key] = dimension;
      } else normalized[key] = value;
    }
    out["dimensions"] = normalized;
  }
  return out;
}
