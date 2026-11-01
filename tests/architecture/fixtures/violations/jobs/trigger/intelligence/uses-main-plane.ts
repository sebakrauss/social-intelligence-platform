/** Violation (Step H7-D1d): an intelligence-plane task file never reaches delivery, the MAIN runtime, the Move saga or another plane's tasks. */
import { relay } from "../main/delivery";
import { systemDatabase } from "../../main-runtime";
import { leaked as leakedMove } from "../../moves";
export const leaked: unknown[] = [relay, systemDatabase, leakedMove];
