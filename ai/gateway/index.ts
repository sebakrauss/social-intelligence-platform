/**
 * Public API of the AI Gateway (Step H7-C; TA §6.2 `ai/gateway`, §22). Provider-neutral and task-agnostic: approved
 * modules (classification, replies, insights) define their tasks and call `run`; provider adapters implement
 * `ModelProvider` inside `ai/providers/*`. No SDK, credential, environment, database or network is reachable here.
 */
export * from "./attempt";
export * from "./failures";
export * from "./gateway";
export * from "./provider-port";
export * from "./registry";
export * from "./task";
