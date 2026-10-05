// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
// Violation: UI never wires persistence adapters; composition roots (server/, jobs/) do.
import { createStore } from "../modules/tenancy/persistence/index";

export const store = createStore();