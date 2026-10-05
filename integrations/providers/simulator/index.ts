/**
 * Provider simulator (TA §15.4, §52, §53): a fixture-backed, scenario-driven, deterministic implementation of
 * the provider contract for local development and tests. No network, no real credentials.
 *
 * Simulator support means "our architecture can represent this", NOT "the real platform supports this":
 * every platform capability stays VALIDATE (PD OQ-18, OQ-19, OQ-26, OQ-27) until official API validation.
 *
 * The simulator's MUTATION port is not exported here (see `./mutation-port`): only the executor's composition
 * and tests may obtain it.
 */
export { createSimulatorReadPort, type SimulatorReadPortOptions } from "./read-port";
export { SimulatorWorld, SIMULATED_EVENT_TYPES, type JournalEntry, type PrivateReplyRecord, type SimulatedEvent, type SimulatedEventType } from "./world";
export { SIMULATED_RESTRICTIONS, ScenarioError, parseScenario, type SimulatedRestriction, type SimulatorScenario } from "./scenario";
export { FaultConfigError, parseFaultRule, type FaultRule, type FaultSpec } from "./faults";
export {
  SIM_DELIVERY_HEADER,
  SIM_SIGNATURE_HEADER,
  SIM_TIMESTAMP_HEADER,
  signSimulatorDelivery,
  signedDeliveryOf,
  simulatorDeliveryBody,
} from "./webhooks";
