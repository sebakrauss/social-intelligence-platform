/**
 * The provider simulator as a LOCAL runtime provider (Step 5D; D9). Development and test only: refused in any
 * other environment, so a deployed runtime can never "connect" to synthetic data. The world is process-local:
 * the web callback and a separate job process each hold their own copy, so a credential issued in one process
 * is unknown in the other (cross-process end-to-end runs are Step 5J). Simulator behavior is never evidence about
 * Meta or TikTok (PD OQ-18, OQ-19, OQ-26, OQ-27 VALIDATE).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderAuthorizationPort, ProviderReadPort } from "@/integrations/providers/contract";
import { SimulatorWorld, createSimulatorAuthorizationPort, createSimulatorReadPort, parseScenario } from "@/integrations/providers/simulator";

const ALLOWED: readonly string[] = ["development", "test"];
const SCENARIO = "fixtures/providers/simulator/baseline.scenario.json";
/** Synthetic signing key for simulated webhooks (never a production secret). */
const SIMULATED_WEBHOOK_KEY = "local-simulator-webhook-signing-key";

export interface LocalSimulator {
  readonly world: SimulatorWorld;
  readonly authorization: ProviderAuthorizationPort;
  readonly read: ProviderReadPort;
}

export function createLocalSimulator(world: SimulatorWorld): LocalSimulator {
  return {
    world,
    authorization: createSimulatorAuthorizationPort(world),
    read: createSimulatorReadPort(world, { webhookSigningKey: SIMULATED_WEBHOOK_KEY }),
  };
}

let simulator: LocalSimulator | undefined;

/** The process's simulator, built once from the synthetic baseline scenario; refused outside development/test. */
export function localSimulator(environment: Readonly<Record<string, string | undefined>> = process.env): LocalSimulator {
  if (!ALLOWED.includes(environment["NODE_ENV"] ?? "")) throw new Error("provider simulator is local/test only");
  simulator ??= createLocalSimulator(new SimulatorWorld(parseScenario(JSON.parse(readFileSync(path.join(process.cwd(), SCENARIO), "utf8")))));
  return simulator;
}
