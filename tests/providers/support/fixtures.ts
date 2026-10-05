/**
 * Provider fixture helpers for tests: load synthetic scenario/webhook fixtures, serialize deterministically,
 * and compare against small golden files (`UPDATE_GOLDEN=1` rewrites them locally; CI never sets it).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { parseScenario, type SimulatorScenario } from "@/integrations/providers/simulator";

export const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(ROOT, "fixtures/providers");

/** The scenario fixture exactly as committed (unparsed JSON). */
export function rawScenario(name: "baseline" | "unreported-budget"): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, "simulator", `${name}.scenario.json`), "utf8")) as Record<string, unknown>;
}

export function loadScenario(name: "baseline" | "unreported-budget"): SimulatorScenario {
  return parseScenario(rawScenario(name));
}

interface WebhookFixtures {
  readonly deliveries: Readonly<Record<string, { readonly deliveryId: string }>>;
  readonly rawBodies: Readonly<Record<string, string>>;
}

const webhookFixtures = (): WebhookFixtures =>
  JSON.parse(readFileSync(path.join(FIXTURES, "simulator", "webhook-deliveries.json"), "utf8")) as WebhookFixtures;

/** The raw JSON body of a named fixture delivery, exactly as the simulated provider would send it. */
export function deliveryBody(name: string): { readonly deliveryId: string; readonly body: string } {
  const delivery = webhookFixtures().deliveries[name];
  if (delivery === undefined) throw new Error(`unknown delivery fixture ${name}`);
  return { deliveryId: delivery.deliveryId, body: JSON.stringify(delivery) };
}

export function rawBody(name: string): string {
  const body = webhookFixtures().rawBodies[name];
  if (body === undefined) throw new Error(`unknown raw body fixture ${name}`);
  return body;
}

/** JSON with object keys sorted at every level: stable across runs and machines. */
export function stableSerialize(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      const json = JSON.parse(JSON.stringify(input)) as unknown;
      if (json === null || typeof json !== "object" || Array.isArray(json)) return json;
      return Object.fromEntries(
        Object.keys(json)
          .sort()
          .map((key) => [key, normalize((json as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

/** Asserts `value` serializes exactly to the reviewed golden file `fixtures/providers/golden/<name>.json`. */
export function expectGolden(name: string, value: unknown): void {
  const file = path.join(FIXTURES, "golden", `${name}.json`);
  const actual = stableSerialize(value);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    writeFileSync(file, actual);
    return;
  }
  expect(existsSync(file), `missing golden file ${name}.json`).toBe(true);
  expect(actual).toBe(readFileSync(file, "utf8"));
}
