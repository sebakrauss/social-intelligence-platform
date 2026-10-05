export {
  MUTATION_ACTIONS,
  PLATFORMS,
  POLICY_TYPES,
  SWITCHES,
  SWITCH_KEYS,
  SWITCH_SCOPES,
  type AiRoute,
  type SwitchDefinition,
  type SwitchKey,
  type SwitchScope,
  type SwitchValue,
} from "./registry";
export { createSwitchReader, resolveSwitch, type ResolvedSwitch, type SwitchQuery, type SwitchReader, type SwitchRowInput } from "./resolver";
