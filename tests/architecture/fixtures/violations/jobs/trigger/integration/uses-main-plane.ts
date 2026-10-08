/** Violation (Step 7E.4B.3): an integration-plane task file never reaches the main runtime, delivery or main tasks. */
import { systemDatabase } from "../../main-runtime";
import { relay } from "../main/delivery";
export const leaked: unknown[] = [systemDatabase, relay];
